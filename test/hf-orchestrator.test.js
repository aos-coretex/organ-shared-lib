/**
 * Unit tests for hf-orchestrator.js — MP-CONFIG-1 relay l9m-10.
 *
 * Covers:
 *   - validateHFConfig — accepts valid Cortex AWQ fixture; rejects main/HEAD; rejects bad quantization
 *   - checkVramFit — 32B-AWQ fits 32GB; 72B-AWQ does not
 *   - ensureModelDeployed — mocked lifecycle (reachable / started)
 *   - Cortex fixture YAML parses + validates through R1 schema
 *   - 72B reject fixture passes R1 schema but fails VRAM gate
 *   - Live end-to-end (`describe.skip`) — activate when hardware provisioned
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

import {
  ensureModelDeployed,
  validateHFConfig,
  checkVramFit,
  VRAM_TABLE,
} from '../lib/hf-orchestrator.js';
import { validateSettings } from '../lib/llm-settings-schema.js';
import { LLMSettingsInvalid } from '../lib/llm-errors.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(__dirname, 'fixtures');

// -----------------------------------------------------------------------------
// validateHFConfig
// -----------------------------------------------------------------------------

describe('hf-orchestrator: validateHFConfig', () => {
  const valid = { repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ', revision: 'v1.0.0', quantization: 'awq' };

  it('accepts a valid AWQ block', () => {
    assert.equal(validateHFConfig(valid), valid);
  });

  it('accepts a SHA-pinned revision', () => {
    const shaBlock = { ...valid, revision: 'abcdef0123456789' };
    assert.doesNotThrow(() => validateHFConfig(shaBlock));
  });

  it('rejects revision="main" with LLMSettingsInvalid', () => {
    assert.throws(
      () => validateHFConfig({ ...valid, revision: 'main' }),
      (err) =>
        err instanceof LLMSettingsInvalid &&
        err.field === 'huggingface_autoprovision.revision' &&
        /un-pinned/.test(err.reason),
    );
  });

  it('rejects revision="HEAD"', () => {
    assert.throws(
      () => validateHFConfig({ ...valid, revision: 'HEAD' }),
      (err) => err instanceof LLMSettingsInvalid && err.field === 'huggingface_autoprovision.revision',
    );
  });

  it('rejects unknown quantization "int8"', () => {
    assert.throws(
      () => validateHFConfig({ ...valid, quantization: 'int8' }),
      (err) =>
        err instanceof LLMSettingsInvalid &&
        err.field === 'huggingface_autoprovision.quantization',
    );
  });

  it('rejects bf16 as "raw precision, not quantization"', () => {
    assert.throws(
      () => validateHFConfig({ ...valid, quantization: 'bf16' }),
      (err) => err instanceof LLMSettingsInvalid && /raw precision/.test(err.reason),
    );
  });

  it('rejects malformed repo (missing slash)', () => {
    assert.throws(
      () => validateHFConfig({ ...valid, repo: 'Qwen2.5-32B' }),
      (err) => err instanceof LLMSettingsInvalid && err.field === 'huggingface_autoprovision.repo',
    );
  });
});

// -----------------------------------------------------------------------------
// checkVramFit
// -----------------------------------------------------------------------------

describe('hf-orchestrator: checkVramFit', () => {
  it('Qwen2.5-32B-AWQ fits in 32GB (table hit)', () => {
    const r = checkVramFit({
      model: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      quantization: 'awq',
      target_vram_gb: 32,
    });
    assert.equal(r.fits, true);
    assert.equal(r.source, 'table');
    assert.equal(r.estimated_vram_gb, 19);
  });

  it('Qwen2.5-72B-AWQ does NOT fit in 32GB', () => {
    const r = checkVramFit({
      model: 'Qwen/Qwen2.5-72B-Instruct-AWQ',
      quantization: 'awq',
      target_vram_gb: 32,
    });
    assert.equal(r.fits, false);
    assert.equal(r.estimated_vram_gb, 40);
  });

  it('falls back to name-based inference for unknown repos', () => {
    const r = checkVramFit({
      model: 'SomeOrg/CustomModel-13B-AWQ',
      quantization: 'awq',
      target_vram_gb: 32,
    });
    assert.equal(r.source, 'inferred');
    assert.ok(r.estimated_vram_gb > 0);
    assert.equal(r.fits, true);
  });

  it('returns unknown source when param count can\'t be inferred', () => {
    const r = checkVramFit({
      model: 'weird/no-param-count',
      quantization: 'awq',
      target_vram_gb: 32,
    });
    assert.equal(r.source, 'unknown');
    assert.equal(r.fits, false);
  });

  it('VRAM_TABLE is frozen', () => {
    assert.ok(Object.isFrozen(VRAM_TABLE));
  });
});

// -----------------------------------------------------------------------------
// ensureModelDeployed — mocked lifecycle
// -----------------------------------------------------------------------------

describe('hf-orchestrator: ensureModelDeployed (mocked)', () => {
  it('returns ready:true when deployment_target already serves the repo', async () => {
    const result = await ensureModelDeployed({
      repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      revision: 'v1.0.0',
      quantization: 'awq',
      deployment_target: 'localhost:8000',
      deps: {
        fetch: async () => ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 'Qwen/Qwen2.5-32B-Instruct-AWQ' }] }),
        }),
      },
    });
    assert.equal(result.ready, true);
    assert.equal(result.source, 'reachable');
    assert.equal(result.served_at, 'localhost:8000');
  });

  it('refuses to start when deployment_target already serves a DIFFERENT model', async () => {
    await assert.rejects(
      ensureModelDeployed({
        repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
        revision: 'v1.0.0',
        quantization: 'awq',
        deployment_target: 'localhost:8000',
        deps: {
          fetch: async () => ({
            ok: true,
            status: 200,
            json: async () => ({ data: [{ id: 'meta-llama/Llama-3.1-8B' }] }),
          }),
        },
      }),
      (err) => err.code === 'PORT_OCCUPIED_BY_OTHER_MODEL',
    );
  });

  it('downloads + starts when cache is empty and target is unreachable', async () => {
    const downloads = [];
    const client = {
      listSnapshot: async () => ['config.json', 'model.safetensors'],
      downloadFile: async (repo, rev, filename, targetDir) => {
        downloads.push({ repo, rev, filename, targetDir });
        return { path: `${targetDir}/${filename}`, bytes: 10 };
      },
    };
    let startArgs = null;
    const result = await ensureModelDeployed({
      repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      revision: 'v1.0.0',
      quantization: 'awq',
      deployment_target: 'localhost:8000',
      deps: {
        fetch: async () => {
          throw new Error('ECONNREFUSED');
        },
        client,
        exists: async () => false,
        cacheDir: () => '/fake/cache/dir',
        startServer: async (args) => {
          startArgs = args;
          return { pid: 99, ready: true, served_at: `${args.host}:${args.port}`, engine: args.engine };
        },
      },
    });
    assert.equal(downloads.length, 2);
    assert.equal(result.ready, true);
    assert.equal(result.source, 'started');
    assert.equal(startArgs.engine, 'vllm');
  });

  it('rejects invalid config before touching network', async () => {
    await assert.rejects(
      ensureModelDeployed({
        repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
        revision: 'main', // un-pinned
        quantization: 'awq',
        deployment_target: 'localhost:8000',
      }),
      LLMSettingsInvalid,
    );
  });
});

// -----------------------------------------------------------------------------
// Cortex fixtures
// -----------------------------------------------------------------------------

describe('hf-orchestrator: Cortex Qwen2.5-32B-AWQ fixture', () => {
  const raw = readFileSync(path.join(FIXTURE_DIR, 'cortex-qwen2-5-32b-awq.yaml'), 'utf8');
  const parsed = yaml.load(raw);

  it('fixture validates through R1 schema (with R10 huggingface_autoprovision block)', () => {
    assert.doesNotThrow(() => validateSettings(parsed, 'cortex-qwen2-5-32b-awq.yaml'));
  });

  it('validateHFConfig accepts the fixture\'s huggingface_autoprovision block', () => {
    assert.doesNotThrow(() => validateHFConfig(parsed.huggingface_autoprovision));
  });

  it('32B-AWQ fits 32GB VRAM target', () => {
    const r = checkVramFit({
      model: parsed.huggingface_autoprovision.repo,
      quantization: parsed.huggingface_autoprovision.quantization,
      target_vram_gb: 32,
    });
    assert.equal(r.fits, true);
  });
});

describe('hf-orchestrator: Cortex 72B rejection fixture', () => {
  const raw = readFileSync(path.join(FIXTURE_DIR, 'cortex-qwen2-5-72b-awq-reject.yaml'), 'utf8');
  const parsed = yaml.load(raw);

  it('passes R1 schema validation (syntax is valid)', () => {
    assert.doesNotThrow(() => validateSettings(parsed, 'cortex-qwen2-5-72b-awq-reject.yaml'));
  });

  it('FAILS VRAM-budget check on 32GB target (72B-AWQ ≈ 40GB)', () => {
    const r = checkVramFit({
      model: parsed.huggingface_autoprovision.repo,
      quantization: parsed.huggingface_autoprovision.quantization,
      target_vram_gb: 32,
    });
    assert.equal(r.fits, false);
    assert.ok(r.estimated_vram_gb > 32);
  });
});

// -----------------------------------------------------------------------------
// Live end-to-end — HARDWARE GATED
// -----------------------------------------------------------------------------

describe('hf-orchestrator: live end-to-end', { skip: true }, () => {
  // ACTIVATION TRIGGER: "activate when local Qwen2.5-32B-AWQ deployed at deployment_target"
  // Requires: RTX 5090 (32GB VRAM), vLLM installed, HF model downloaded.
  it('TODO: download Qwen2.5-32B-AWQ from real HF and start vLLM', () => {});
  it('TODO: probe /v1/models and assert 200 within readiness timeout', () => {});
});
