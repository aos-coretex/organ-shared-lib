/**
 * Convenience boot-initializer for per-organ cost attribution wiring.
 * MP-CONFIG-1 relay l9m-9.
 *
 * Each probabilistic organ (the 11 listed in MP-CONFIG-1 §4) calls this at
 * boot, once, after `config` is loaded. It:
 *
 *   1. Constructs a Graph HTTP client carrying the infrastructure-exemption
 *      header `llm-usage-audit` (meta §8.8 — cost audit bypasses governance).
 *   2. Constructs a `createUsageWriter` bound to that graph client.
 *   3. Registers the writer's `writeLLMUsageEvent` as the process-default so
 *      every `llm.chat()` via the shared-lib cascade wrapper emits a flat
 *      `llm_usage_event` concept post-call.
 *
 * Returns the writer + graph client so callers can introspect (e.g. surface
 * usage-writer readiness in `/health`).
 *
 * Idempotent: calling twice replaces the prior default writer (useful for
 * boot sequences that re-initialize on config reload).
 */

import { createGraphClient } from './graph-client.js';
import { createUsageWriter, setDefaultUsageWriter } from './llm-usage-writer.js';

const DEFAULT_GRAPH_URL = 'http://127.0.0.1:4020';
const EXEMPTION_HEADER = 'llm-usage-audit';

/**
 * @param {object} opts
 * @param {string} opts.organName           — capitalized organ label (e.g. 'Arbiter')
 * @param {string} [opts.graphUrl]          — defaults to env GRAPH_URL or 127.0.0.1:4020
 * @param {number} [opts.timeoutMs]         — default 5000
 * @param {Function} [opts.fetchImpl]       — override global fetch (tests)
 * @returns {{ writer, graphClient }}
 */
export function initializeUsageAttribution({
  organName,
  graphUrl = process.env.GRAPH_URL || DEFAULT_GRAPH_URL,
  timeoutMs = 5000,
  fetchImpl,
} = {}) {
  if (!organName) {
    throw new Error('initializeUsageAttribution: organName is required');
  }

  const graphClient = createGraphClient({
    baseUrl: graphUrl,
    organName,
    timeoutMs,
    exemptionHeader: EXEMPTION_HEADER,
    fetchImpl,
  });

  const writer = createUsageWriter({ graphClient });
  setDefaultUsageWriter(writer.writeLLMUsageEvent);
  return { writer, graphClient };
}
