/**
 * Host-identity accessor — writer-internal platform context.
 *
 * Provides `host_type` (short chassis tag, e.g. "mbp", "mac-mini") and
 * `silicon` (kebab-case Apple silicon model, e.g. "m4-max") for telemetry
 * emitters. Values are platform-context, not caller-context — the writer
 * is the authority, parallel to how `correlation_id` is writer-generated.
 *
 * Resolution order (first wins):
 *   1. Explicit env-var override — `LLM_OPS_HOST_TYPE` / `LLM_OPS_SILICON`
 *   2. Native detection on darwin via `system_profiler SPHardwareDataType`
 *      — parses `machine_name` ("MacBook Pro" → "mbp") and `chip_type`
 *      ("Apple M4 Max" → "m4-max"). One-shot subprocess at first call;
 *      result is cached for the remainder of the process.
 *   3. Fallback `{host_type: 'unknown', silicon: 'unknown'}` on any error.
 *
 * The cache is module-scoped — host identity does not change mid-process.
 * Tests can inject a deterministic identity via `setHostIdentityForTests()`
 * and restore via `resetHostIdentityCache()`.
 */

import { execFileSync } from 'node:child_process';
import os from 'node:os';

let cached = null;

const MACHINE_NAME_MAP = {
  'MacBook Pro': 'mbp',
  'MacBook Air': 'mba',
  'Mac mini': 'mac-mini',
  'Mac Studio': 'mac-studio',
  'Mac Pro': 'mac-pro',
  iMac: 'imac',
};

/**
 * Return the cached host identity. First call resolves; subsequent calls
 * return the same object reference.
 *
 * @returns {{host_type: string, silicon: string}}
 */
export function getHostIdentity() {
  if (cached) return cached;
  cached = Object.freeze(resolve());
  return cached;
}

/**
 * Clear the cache. Intended for tests that want to re-resolve after
 * mutating process.env.
 */
export function resetHostIdentityCache() {
  cached = null;
}

/**
 * Inject a deterministic identity for tests. Bypasses detection entirely.
 *
 * @param {{host_type: string, silicon: string}} identity
 */
export function setHostIdentityForTests(identity) {
  cached = Object.freeze({ ...identity });
}

function resolve() {
  const envHostType = process.env.LLM_OPS_HOST_TYPE;
  const envSilicon = process.env.LLM_OPS_SILICON;
  if (envHostType && envSilicon) {
    return { host_type: envHostType, silicon: envSilicon };
  }
  const detected = detectFromSystemProfiler();
  return {
    host_type: envHostType || detected.host_type,
    silicon: envSilicon || detected.silicon,
  };
}

function detectFromSystemProfiler() {
  if (os.platform() !== 'darwin') {
    return { host_type: 'unknown', silicon: deriveSiliconFromCpus() };
  }
  try {
    const raw = execFileSync('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], {
      encoding: 'utf8',
      timeout: 2000,
    });
    const hw = JSON.parse(raw)?.SPHardwareDataType?.[0] ?? {};
    return {
      host_type: mapMachineName(hw.machine_name),
      silicon: normalizeSilicon(hw.chip_type) || deriveSiliconFromCpus(),
    };
  } catch {
    return { host_type: 'unknown', silicon: deriveSiliconFromCpus() };
  }
}

function mapMachineName(name) {
  if (!name || typeof name !== 'string') return 'unknown';
  return MACHINE_NAME_MAP[name] || 'unknown';
}

function normalizeSilicon(chip) {
  if (!chip || typeof chip !== 'string') return null;
  const m = chip.match(/Apple\s+(M\d+)(?:\s+(Pro|Max|Ultra))?/i);
  if (!m) return null;
  const gen = m[1].toLowerCase();
  const tier = m[2]?.toLowerCase();
  return tier ? `${gen}-${tier}` : gen;
}

function deriveSiliconFromCpus() {
  try {
    const model = os.cpus()?.[0]?.model ?? '';
    return normalizeSilicon(model) || 'unknown';
  } catch {
    return 'unknown';
  }
}

export const __internal = { mapMachineName, normalizeSilicon };
