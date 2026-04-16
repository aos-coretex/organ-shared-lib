/**
 * Inference-server bootstrap — MP-CONFIG-1 relay l9m-10.
 *
 * Launches one of three open-source inference servers in front of a locally
 * cached model and waits for its OpenAI-compatible endpoint to become ready.
 *
 *   - vLLM    — preferred for AWQ/GPTQ; best throughput + most robust quant path
 *   - TGI     — HuggingFace text-generation-inference; acceptable fallback
 *   - llama.cpp — CPU/metal fallback for GGUF (not the AWQ/GPTQ path)
 *
 * RESPONSIBILITIES
 * ----------------
 * - Build the correct CLI argv per server from `{model_path, host, port, quantization}`.
 * - Spawn the server as a subprocess (local-dev scope).
 * - Poll `/v1/models` (OpenAI-compat) until 200 OK or timeout.
 * - Return `{ pid, ready, served_at }` on success; throw on timeout/failure.
 *
 * OUT OF SCOPE
 * ------------
 * - LaunchAgent integration, systemd units, process supervision.
 * - Multi-model hosting (D8 — first cut single-model-per-host).
 * - GPU-memory accounting at runtime (see `hf-orchestrator.checkVramFit` for
 *   the static heuristic gate).
 *
 * Subpath import: `@coretex/organ-boot/inference-server-bootstrap`
 */

import { spawn as nodeSpawn } from 'node:child_process';

const DEFAULT_READINESS_TIMEOUT_MS = 180_000; // 3 min — large quantized models load slowly
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/**
 * Build vLLM argv for `vllm serve`.
 *   vllm serve <model_path> --host <host> --port <port> [--quantization awq|gptq]
 */
export function buildVLLMArgs({ model_path, host, port, quantization }) {
  assertCommon({ model_path, host, port });
  const args = ['serve', model_path, '--host', host, '--port', String(port)];
  if (quantization === 'awq' || quantization === 'gptq') {
    args.push('--quantization', quantization);
  }
  return args;
}

/**
 * Build TGI argv for the `text-generation-launcher` binary.
 *   text-generation-launcher --model-id <path> --hostname <host> --port <port> [--quantize <q>]
 */
export function buildTGIArgs({ model_path, host, port, quantization }) {
  assertCommon({ model_path, host, port });
  const args = [
    '--model-id', model_path,
    '--hostname', host,
    '--port', String(port),
  ];
  if (quantization === 'awq') args.push('--quantize', 'awq');
  if (quantization === 'gptq') args.push('--quantize', 'gptq');
  return args;
}

/**
 * Build llama.cpp server argv (`llama-server`).
 *   llama-server -m <gguf_path> --host <host> --port <port>
 *
 * Note: llama.cpp does NOT run AWQ/GPTQ — it consumes GGUF. `quantization` is
 * ignored for this server; caller is responsible for supplying the right
 * `model_path` format.
 */
export function buildLlamaCppArgs({ model_path, host, port }) {
  assertCommon({ model_path, host, port });
  return ['-m', model_path, '--host', host, '--port', String(port)];
}

function assertCommon({ model_path, host, port }) {
  if (!model_path || typeof model_path !== 'string') {
    throw new Error('inference-server-bootstrap: model_path required');
  }
  if (!host || typeof host !== 'string') {
    throw new Error('inference-server-bootstrap: host required');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('inference-server-bootstrap: port must be 1..65535');
  }
}

/**
 * Poll an OpenAI-compatible `/v1/models` endpoint until it returns 200 OK or the
 * timeout elapses.
 *
 * @param {object} opts
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.pollMs]
 * @param {typeof fetch} [opts.fetch]
 * @param {() => number} [opts.now]            — test hook for deterministic timing
 * @param {(ms:number)=>Promise<void>} [opts.sleep] — test hook
 * @returns {Promise<boolean>} true when ready
 */
export async function waitForReadiness({
  host,
  port,
  timeoutMs = DEFAULT_READINESS_TIMEOUT_MS,
  pollMs = DEFAULT_POLL_INTERVAL_MS,
  fetch: fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  sleep = defaultSleep,
} = {}) {
  const deadline = now() + timeoutMs;
  const url = `http://${host}:${port}/v1/models`;
  // Minimum one probe so a zero timeout still attempts once (useful in tests).
  let attempted = false;
  while (now() <= deadline || !attempted) {
    attempted = true;
    try {
      const res = await fetchImpl(url, { method: 'GET' });
      if (res && res.ok) return true;
    } catch {
      // connection not yet accepting — continue polling
    }
    if (now() > deadline) break;
    await sleep(pollMs);
  }
  throw new Error(`inference-server not ready at ${host}:${port} within ${timeoutMs}ms`);
}

function defaultSleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Start one of the supported servers and wait for readiness.
 *
 * @param {object} opts
 * @param {'vllm'|'tgi'|'llama-cpp'} opts.engine
 * @param {string} opts.model_path
 * @param {string} opts.host
 * @param {number} opts.port
 * @param {string} [opts.quantization]
 * @param {typeof nodeSpawn} [opts.spawn]     — test hook
 * @param {typeof fetch}     [opts.fetch]     — test hook
 * @param {number}           [opts.timeoutMs]
 * @param {object}           [opts.spawnOpts] — forwarded to child_process.spawn
 * @returns {Promise<{pid:number, ready:true, served_at:string, engine:string}>}
 */
export async function startInferenceServer(opts) {
  const {
    engine,
    host,
    port,
    spawn: spawnImpl = nodeSpawn,
    fetch: fetchImpl = globalThis.fetch,
    timeoutMs,
    spawnOpts = { stdio: 'inherit', detached: false },
  } = opts;

  let bin;
  let args;
  switch (engine) {
    case 'vllm':
      bin = 'vllm';
      args = buildVLLMArgs(opts);
      break;
    case 'tgi':
      bin = 'text-generation-launcher';
      args = buildTGIArgs(opts);
      break;
    case 'llama-cpp':
      bin = 'llama-server';
      args = buildLlamaCppArgs(opts);
      break;
    default:
      throw new Error(`inference-server-bootstrap: unknown engine "${engine}"`);
  }

  const child = spawnImpl(bin, args, spawnOpts);
  const pid = child && child.pid;
  if (!pid) {
    throw new Error(`inference-server-bootstrap: spawn(${bin}) returned no pid`);
  }

  await waitForReadiness({ host, port, timeoutMs, fetch: fetchImpl });

  return { pid, ready: true, served_at: `${host}:${port}`, engine };
}

/** Convenience wrappers — match the relay's public-API contract. */
export function startVLLM(opts) {
  return startInferenceServer({ ...opts, engine: 'vllm' });
}
export function startTGI(opts) {
  return startInferenceServer({ ...opts, engine: 'tgi' });
}
export function startLlamaCpp(opts) {
  return startInferenceServer({ ...opts, engine: 'llama-cpp' });
}
