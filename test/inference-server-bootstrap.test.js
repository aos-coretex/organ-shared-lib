/**
 * Unit tests for inference-server-bootstrap.js — MP-CONFIG-1 relay l9m-10.
 *
 * Command-construction tests are always active (pure function).
 * Actual subprocess spawn + readiness probe is `describe.skip` — activating them
 * requires a local vLLM install, a downloaded AWQ model, and GPU hardware.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVLLMArgs,
  buildTGIArgs,
  buildLlamaCppArgs,
  waitForReadiness,
  startInferenceServer,
} from '../lib/inference-server-bootstrap.js';

describe('inference-server-bootstrap: buildVLLMArgs', () => {
  it('constructs "vllm serve <path> --host <h> --port <p> --quantization awq"', () => {
    const args = buildVLLMArgs({
      model_path: '/cache/qwen-32b',
      host: '0.0.0.0',
      port: 8000,
      quantization: 'awq',
    });
    assert.deepEqual(args, [
      'serve', '/cache/qwen-32b', '--host', '0.0.0.0', '--port', '8000', '--quantization', 'awq',
    ]);
  });

  it('omits --quantization for "none"', () => {
    const args = buildVLLMArgs({
      model_path: '/cache/qwen',
      host: 'localhost',
      port: 8000,
      quantization: 'none',
    });
    assert.equal(args.includes('--quantization'), false);
  });

  it('throws on invalid port', () => {
    assert.throws(
      () => buildVLLMArgs({ model_path: '/m', host: 'h', port: 99999, quantization: 'awq' }),
      /port/,
    );
  });
});

describe('inference-server-bootstrap: buildTGIArgs', () => {
  it('uses --model-id + --hostname + --quantize awq', () => {
    const args = buildTGIArgs({
      model_path: '/cache/m',
      host: '127.0.0.1',
      port: 3000,
      quantization: 'awq',
    });
    assert.deepEqual(args, [
      '--model-id', '/cache/m', '--hostname', '127.0.0.1', '--port', '3000', '--quantize', 'awq',
    ]);
  });
});

describe('inference-server-bootstrap: buildLlamaCppArgs', () => {
  it('constructs "-m <gguf> --host <h> --port <p>" (no quantization flag)', () => {
    const args = buildLlamaCppArgs({ model_path: '/m.gguf', host: 'h', port: 8080 });
    assert.deepEqual(args, ['-m', '/m.gguf', '--host', 'h', '--port', '8080']);
  });
});

describe('inference-server-bootstrap: waitForReadiness polling logic', () => {
  it('returns true on first OK response', async () => {
    let calls = 0;
    const ok = await waitForReadiness({
      host: 'h',
      port: 1,
      timeoutMs: 1000,
      pollMs: 1,
      fetch: async () => {
        calls += 1;
        return { ok: true };
      },
      sleep: async () => {},
    });
    assert.equal(ok, true);
    assert.equal(calls, 1);
  });

  it('throws after timeout when endpoint never becomes ready', async () => {
    let t = 0;
    await assert.rejects(
      waitForReadiness({
        host: 'h',
        port: 1,
        timeoutMs: 10,
        pollMs: 1,
        fetch: async () => ({ ok: false }),
        now: () => t,
        sleep: async () => {
          t += 20; // advance past deadline
        },
      }),
      /not ready/,
    );
  });

  it('recovers from transient fetch rejections', async () => {
    let n = 0;
    const ok = await waitForReadiness({
      host: 'h',
      port: 1,
      timeoutMs: 1000,
      pollMs: 1,
      fetch: async () => {
        n += 1;
        if (n < 3) throw new Error('ECONNREFUSED');
        return { ok: true };
      },
      sleep: async () => {},
    });
    assert.equal(ok, true);
    assert.equal(n, 3);
  });
});

describe('inference-server-bootstrap: startInferenceServer with mocked spawn', () => {
  it('spawns vllm and waits for readiness; returns served_at + pid', async () => {
    const spawnCalls = [];
    const result = await startInferenceServer({
      engine: 'vllm',
      model_path: '/m',
      host: 'localhost',
      port: 8000,
      quantization: 'awq',
      spawn: (bin, args, opts) => {
        spawnCalls.push({ bin, args, opts });
        return { pid: 12345 };
      },
      fetch: async () => ({ ok: true }),
      timeoutMs: 100,
    });
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].bin, 'vllm');
    assert.equal(result.pid, 12345);
    assert.equal(result.ready, true);
    assert.equal(result.served_at, 'localhost:8000');
    assert.equal(result.engine, 'vllm');
  });

  it('throws on unknown engine', async () => {
    await assert.rejects(
      startInferenceServer({
        engine: 'unknown-engine',
        model_path: '/m',
        host: 'h',
        port: 1,
      }),
      /unknown engine/,
    );
  });
});

describe('inference-server-bootstrap: live subprocess execution', { skip: true }, () => {
  // ACTIVATION TRIGGER: "activate when local Qwen2.5-32B-AWQ deployed at deployment_target"
  // Requires: vLLM installed, AWQ model downloaded, CUDA-capable GPU with ≥20GB VRAM.
  it('TODO: start real vLLM server + probe /v1/models', () => {});
  it('TODO: TGI parity run against same model', () => {});
  it('TODO: llama.cpp GGUF path (CPU/metal fallback)', () => {});
});
