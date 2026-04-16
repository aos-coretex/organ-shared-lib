/**
 * HuggingFace auto-provisioning orchestrator — MP-CONFIG-1 relay l9m-10.
 *
 * Public API:
 *   - ensureModelDeployed({repo, revision, quantization, deployment_target}) → {ready, served_at, model_path}
 *   - validateHFConfig(hfBlock)                                               → parsed block (throws on invalid)
 *   - checkVramFit({model, quantization, target_vram_gb})                     → {fits, estimated_vram_gb}
 *   - VRAM_TABLE                                                              → frozen static estimates
 *
 * Lifecycle of `ensureModelDeployed`:
 *   1. Probe the deployment_target's /v1/models endpoint. If it responds with
 *      200 and the served model matches `repo`, return immediately.
 *   2. Else, ensure the pinned revision is present in the local cache (download
 *      via hf-client if missing).
 *   3. Start the inference server (vLLM for AWQ/GPTQ; llama.cpp for "none"+GGUF).
 *   4. Wait for the /v1/models endpoint to become ready.
 *
 * Scope (D7/D8):
 *   - First cut: single-model-per-deployment-target. No multi-model multiplexing.
 *   - HF autoprovisioning is opt-in; manual deployment path stays default.
 *
 * Subpath import: `@coretex/organ-boot/hf-orchestrator`
 */

import path from 'node:path';
import os from 'node:os';
import { stat } from 'node:fs/promises';

import { LLMSettingsInvalid } from './llm-errors.js';
import { validateQuantization, diagnoseQuantization } from './quantization-validator.js';
import { createHFClient } from './hf-client.js';
import { startInferenceServer } from './inference-server-bootstrap.js';

const UNPINNED = new Set(['main', 'HEAD', 'master', 'head']);
const REVISION_OK_RE = /^([0-9a-f]{7,40}|v?\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?)$/i;

/**
 * Static VRAM estimation table for known Qwen/Llama/Mistral variants at AWQ/GPTQ/none.
 * Values are conservative steady-state footprints (weights + KV cache headroom at 4k ctx).
 * This is a *heuristic gate* — the authoritative check is the runtime health probe (R12).
 */
export const VRAM_TABLE = Object.freeze({
  // Qwen 2.5 family
  'Qwen/Qwen2.5-7B-Instruct-AWQ':   { awq: 6,  gptq: 6,  none: 16 },
  'Qwen/Qwen2.5-14B-Instruct-AWQ':  { awq: 10, gptq: 10, none: 30 },
  'Qwen/Qwen2.5-32B-Instruct-AWQ':  { awq: 19, gptq: 19, none: 64 },
  'Qwen/Qwen2.5-72B-Instruct-AWQ':  { awq: 40, gptq: 40, none: 144 },
  // Llama 3 family (representative)
  'meta-llama/Llama-3.1-8B-Instruct':  { awq: 6,  gptq: 6,  none: 18 },
  'meta-llama/Llama-3.1-70B-Instruct': { awq: 38, gptq: 38, none: 140 },
  // Mistral
  'mistralai/Mistral-7B-Instruct-v0.3': { awq: 6, gptq: 6, none: 16 },
});

/**
 * Linear interpolation fallback for unknown repos: infer from parameter count
 * parsed from the repo name (e.g., "...-32B-..."). Returns `null` if the repo
 * string has no parseable parameter count.
 */
function inferVramFromRepoName(repo, quantization) {
  const m = /-(\d+(?:\.\d+)?)B-/i.exec(repo) || /-(\d+(?:\.\d+)?)b(?:-|$)/i.exec(repo);
  if (!m) return null;
  const params = parseFloat(m[1]);
  if (!Number.isFinite(params)) return null;
  // Rough bytes-per-parameter: AWQ/GPTQ ≈ 0.6 GB/B; none (bf16) ≈ 2 GB/B; plus ~30% KV/overhead.
  const bytesPerB = quantization === 'awq' || quantization === 'gptq' ? 0.6 : 2.0;
  return Math.ceil(params * bytesPerB * 1.3);
}

/**
 * @param {object} args
 * @param {string} args.model                — HF repo id (e.g., "Qwen/Qwen2.5-32B-Instruct-AWQ")
 * @param {string} args.quantization
 * @param {number} args.target_vram_gb
 * @returns {{fits:boolean, estimated_vram_gb:number|null, source:'table'|'inferred'|'unknown'}}
 */
export function checkVramFit({ model, quantization, target_vram_gb }) {
  if (!Number.isFinite(target_vram_gb) || target_vram_gb <= 0) {
    throw new Error('checkVramFit: target_vram_gb must be a positive number');
  }
  const row = VRAM_TABLE[model];
  if (row && row[quantization] !== undefined) {
    const est = row[quantization];
    return { fits: est <= target_vram_gb, estimated_vram_gb: est, source: 'table' };
  }
  const inferred = inferVramFromRepoName(model, quantization);
  if (inferred !== null) {
    return { fits: inferred <= target_vram_gb, estimated_vram_gb: inferred, source: 'inferred' };
  }
  return { fits: false, estimated_vram_gb: null, source: 'unknown' };
}

/**
 * Validate the standalone `huggingface_autoprovision` block. This mirrors the
 * check in `llm-settings-schema.js` but is exposed as a library-level helper
 * so callers (operator scripts, R12 conformance scans) can validate without
 * re-invoking the full settings validator.
 *
 * @param {object} hfBlock
 * @returns {object} the validated block (same reference)
 * @throws {LLMSettingsInvalid}
 */
export function validateHFConfig(hfBlock) {
  if (hfBlock === null || typeof hfBlock !== 'object' || Array.isArray(hfBlock)) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision',
      expected_pattern: '{ repo, revision, quantization }',
      actual_value: hfBlock,
      reason: 'huggingface_autoprovision must be a plain object',
    });
  }
  if (typeof hfBlock.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(hfBlock.repo)) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision.repo',
      expected_pattern: '<org>/<name>',
      actual_value: hfBlock.repo,
      reason: 'repo must be a HuggingFace "<org>/<name>" identifier',
    });
  }
  if (typeof hfBlock.revision !== 'string' || hfBlock.revision.length === 0) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'pinned SHA or tag',
      actual_value: hfBlock.revision,
      reason: 'revision is required and must be a pinned reference',
    });
  }
  if (UNPINNED.has(hfBlock.revision)) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'pinned SHA or tag (not main/HEAD/master)',
      actual_value: hfBlock.revision,
      reason: 'un-pinned revisions (main/HEAD/master) are rejected — pin to a SHA or tag',
    });
  }
  if (!REVISION_OK_RE.test(hfBlock.revision)) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'SHA (7-40 hex) or tag (v1.2.3)',
      actual_value: hfBlock.revision,
      reason: 'revision must resemble a commit SHA or a release tag',
    });
  }
  const q = diagnoseQuantization(hfBlock.quantization);
  if (!q.ok) {
    throw new LLMSettingsInvalid({
      field: 'huggingface_autoprovision.quantization',
      expected_pattern: 'awq|gptq|none',
      actual_value: hfBlock.quantization,
      reason: q.reason,
    });
  }
  return hfBlock;
}

function parseDeploymentTarget(deployment_target) {
  const m = /^([^:]+):(\d+)$/.exec(deployment_target || '');
  if (!m) {
    throw new Error(`hf-orchestrator: deployment_target "${deployment_target}" not host:port`);
  }
  return { host: m[1], port: parseInt(m[2], 10) };
}

/**
 * Probe an OpenAI-compatible /v1/models endpoint and return the first model id,
 * or `null` if unreachable / non-200.
 */
async function probeServedModel({ host, port, fetch: fetchImpl = globalThis.fetch }) {
  try {
    const res = await fetchImpl(`http://${host}:${port}/v1/models`, { method: 'GET' });
    if (!res || !res.ok) return null;
    const data = await res.json();
    if (Array.isArray(data?.data) && data.data.length > 0) {
      return data.data[0].id || null;
    }
    return null;
  } catch {
    return null;
  }
}

function defaultCacheDir(repo, revision) {
  // HF-hub-style cache path: ~/.cache/huggingface/hub/models--<org>--<name>/snapshots/<revision>
  const safe = repo.replace('/', '--');
  return path.join(os.homedir(), '.cache', 'huggingface', 'hub', `models--${safe}`, 'snapshots', revision);
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a HF-hosted model is live at `deployment_target`.
 *
 * @param {object} args
 * @param {string} args.repo
 * @param {string} args.revision
 * @param {string} args.quantization
 * @param {string} args.deployment_target     — host:port
 * @param {object} [args.deps]                — injected dependencies for tests
 * @param {ReturnType<createHFClient>} [args.deps.client]
 * @param {typeof fetch}               [args.deps.fetch]
 * @param {typeof startInferenceServer}[args.deps.startServer]
 * @param {(repo:string, revision:string)=>string} [args.deps.cacheDir]
 * @param {(p:string)=>Promise<boolean>} [args.deps.exists]
 * @param {'vllm'|'tgi'|'llama-cpp'}   [args.engine]    — override engine selection
 * @param {number}                     [args.timeoutMs]
 * @returns {Promise<{ready:true, served_at:string, model_path:string, source:'reachable'|'started'}>}
 */
export async function ensureModelDeployed(args) {
  const { repo, revision, quantization, deployment_target, engine, timeoutMs } = args;
  validateHFConfig({ repo, revision, quantization });
  const { host, port } = parseDeploymentTarget(deployment_target);

  const deps = args.deps || {};
  const fetchImpl = deps.fetch || globalThis.fetch;
  const cacheDirFn = deps.cacheDir || defaultCacheDir;
  const exists = deps.exists || pathExists;
  const model_path = cacheDirFn(repo, revision);

  // 1. Probe for reachability. If the target already serves this repo, we're done.
  const servedModel = await probeServedModel({ host, port, fetch: fetchImpl });
  if (servedModel === repo) {
    return { ready: true, served_at: deployment_target, model_path, source: 'reachable' };
  }
  // If something else is already on the port, fail loudly rather than stomp it.
  if (servedModel && servedModel !== repo) {
    const err = new Error(
      `hf-orchestrator: ${deployment_target} already serves "${servedModel}"; refusing to start "${repo}" on top`,
    );
    err.code = 'PORT_OCCUPIED_BY_OTHER_MODEL';
    throw err;
  }

  // 2. Ensure local cache is populated.
  if (!(await exists(model_path))) {
    const client = deps.client || createHFClient({ fetch: fetchImpl });
    const files = await client.listSnapshot(repo, revision);
    for (const f of files) {
      await client.downloadFile(repo, revision, f, model_path);
    }
  }

  // 3. Start the inference server.
  const chosenEngine = engine || pickEngine(quantization);
  const startServer = deps.startServer || startInferenceServer;
  const result = await startServer({
    engine: chosenEngine,
    model_path,
    host,
    port,
    quantization,
    fetch: fetchImpl,
    timeoutMs,
  });

  return {
    ready: result.ready === true,
    served_at: result.served_at,
    model_path,
    source: 'started',
  };
}

function pickEngine(quantization) {
  if (quantization === 'awq' || quantization === 'gptq') return 'vllm';
  return 'vllm'; // default — vLLM also serves raw precision.
}

export { validateQuantization };
