/**
 * LLM usage event writer — MP-CONFIG-1 relay l9m-9.
 *
 * Records one `llm_usage_event` concept per `llm.chat()` completion (success
 * OR cascade-exhausted), bound to the tenant entity. Reads like an audit
 * ledger: append-only, cost-attributed, never mutated.
 *
 * Concept schema (unvalidated at Graph's schema gate — concept.schema.json
 * permits any `data.type` matching `^[a-z][a-z0-9_]*$`):
 *
 *   {
 *     urn: "urn:llm-ops:llm_usage_event:<ISO>-<rand6>",
 *     data: {
 *       type: "llm_usage_event",
 *       tenant_urn:  "urn:llm-ops:entity:<slug>",
 *       model_urn:   "urn:llm-ops:model:<provider>:<model>",
 *       agent_urn:   "urn:llm-ops:agent:<organ>:<agent>",
 *       organ_urn:   "urn:llm-ops:organ:<organ>",
 *       host_type:   "mbp" | "mac-mini" | "mac-studio" | ...,  // invariant #5 flat tag
 *       silicon:     "m4-max" | "m3-max" | ...,                // invariant #5 flat tag
 *       llm_model:   "<model>",                                // invariant #5 flat tag — event.model verbatim
 *       cost_usd: <float>,
 *       tokens_in: <int>,
 *       tokens_out: <int>,
 *       provider: "anthropic" | "openai-compatible" | ...,
 *       cascade_stage: 0 | 1 | ... ,           // 0 = primary success
 *       correlation_id: "<string>",
 *       outcome: "success" | "cascade_exhausted",
 *       timestamp: "<ISO>"
 *     }
 *   }
 *
 * Flat tag fields (`host_type`, `silicon`, `llm_model`) coexist with
 * `model_urn` per architectural invariant #5: indexed flat tags are required
 * for CBA telemetry consumer performance and bilingual-DIO validation signals
 * at Scope 2 fleet growth. Host identity is sourced from the writer-internal
 * accessor (`host-identity.js`) — platform-context, not caller-context.
 * `llm_model` is the `event.model` input verbatim (caller-context).
 *
 * Binding:
 *   entity:<tenant_urn> ─relation:llm_usage─→ llm_usage_event:<urn>
 *
 * Infrastructure exemption (meta §8.8 — Cerberus audit precedent):
 * cost audit cannot require its own governance authorization (infinite
 * regress). Writes are issued with the `X-Infrastructure-Exemption` header
 * set on the graph client, bypassing the governance pathway.
 *
 * Semantics:
 *  - Synchronous return of `undefined`; internal writes are fire-and-forget
 *    so a failed write never blocks the chat completion. Errors are logged
 *    to stdout as structured JSON.
 *  - Pure function-of-inputs (no hidden state) except for the `graphClient`
 *    dependency supplied at factory construction.
 *  - URN generation uses Web Crypto when available; falls back to
 *    `Math.random` in test runners that stub the global.
 */

import { estimateCost } from './pricing-table.js';
import { getHostIdentity } from './host-identity.js';

const RAND_LEN = 6;

// Schema-gate regexes — mirror Graph organ's binding.schema.json literally.
// Enforced locally so the writer fails fast on drift instead of shipping a
// malformed binding over the wire for Graph to reject. Keep in lockstep with
// `AOS-organ-graph/server/schemas/binding.schema.json`.
const UBN_RE = /^ubn:[a-zA-Z0-9._-]+:[a-zA-Z0-9_]+:.+$/;
const RELATION_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Factory.
 *
 * @param {object} deps
 * @param {object} deps.graphClient   — Graph HTTP client (see graph-client.js).
 *                                       MUST be constructed with
 *                                       `exemptionHeader` set (e.g. 'llm-usage-audit')
 *                                       so writes carry the infrastructure-exemption
 *                                       header per meta §8.8. Factory does not
 *                                       set the header; construction site does.
 * @param {Function} [deps.logger]    — structured event logger, defaults to stdout.
 * @param {Function} [deps.now]       — () => Date, for deterministic tests.
 * @param {Function} [deps.randomHex] — (len) => hex string, for deterministic tests.
 * @param {Function} [deps.costEstimator] — overrides `estimateCost` for tests.
 * @param {Function} [deps.hostIdentity]  — () => {host_type, silicon}; overrides
 *                                          platform detection for tests.
 * @returns {{ writeLLMUsageEvent: Function, getLLMUsageConceptSchema: Function }}
 */
export function createUsageWriter(deps = {}) {
  const {
    graphClient,
    logger = defaultLogger,
    now = () => new Date(),
    randomHex = defaultRandomHex,
    costEstimator = estimateCost,
    hostIdentity = getHostIdentity,
  } = deps;

  if (!graphClient) {
    throw new Error('createUsageWriter: graphClient is required');
  }

  /**
   * Fire-and-forget write. Returns `undefined` synchronously; the actual
   * graph write resolves in the background.
   *
   * @param {object} event
   * @param {string} event.tenant_urn     — required; `urn:llm-ops:entity:<slug>`
   * @param {string} event.organ          — short organ name (e.g. 'radiant')
   * @param {string} event.agent          — short agent name (e.g. 'radiant-dreamer')
   * @param {string} event.provider       — 'anthropic' | 'openai-compatible' | ...
   * @param {string} event.model          — per the resolved config's defaultModel
   * @param {number} event.tokens_in
   * @param {number} event.tokens_out
   * @param {number} [event.cascade_stage] — default 0
   * @param {string} [event.correlation_id]
   * @param {string} [event.outcome]       — 'success' | 'cascade_exhausted'; default 'success'
   */
  function writeLLMUsageEvent(event) {
    // Shape validation is intentional and strict — the one moment we can
    // catch a miswired caller before it writes a malformed concept.
    if (!event || typeof event !== 'object') {
      logger({ event: 'llm_usage_writer_invalid_event', reason: 'event_not_object' });
      return;
    }
    if (!event.tenant_urn) {
      logger({ event: 'llm_usage_writer_invalid_event', reason: 'tenant_urn_missing' });
      return;
    }
    if (!event.organ || !event.agent) {
      logger({ event: 'llm_usage_writer_invalid_event', reason: 'organ_or_agent_missing' });
      return;
    }

    const iso = now().toISOString();
    const suffix = randomHex(RAND_LEN);
    // URN type segment uses underscore per concept.schema.json regex
    // `^urn:[a-zA-Z0-9._-]+:[a-zA-Z0-9_]+:.+$` (identifier may contain dashes).
    const urn = `urn:llm-ops:llm_usage_event:${iso.replace(/[:.]/g, '-')}-${suffix}`;

    // UBN third segment and relation are both snake_case — binding.schema.json
    // rejects hyphens in the third UBN segment and in the relation field.
    const ubn = `ubn:llm-ops:llm_usage:${iso.replace(/[:.]/g, '-')}-${suffix}`;
    const relation = 'llm_usage';

    if (!UBN_RE.test(ubn)) {
      logger({ event: 'llm_usage_writer_invalid_ubn', ubn, urn });
      return;
    }
    if (!RELATION_RE.test(relation)) {
      logger({ event: 'llm_usage_writer_invalid_relation', relation, urn });
      return;
    }

    const cost_usd = costEstimator({
      model: event.model,
      provider: event.provider,
      tokens_in: event.tokens_in || 0,
      tokens_out: event.tokens_out || 0,
    });

    // Flat tag fields per architectural invariant #5 — coexist with model_urn.
    // host_type + silicon come from platform-context (writer-internal accessor).
    // llm_model is event.model verbatim (caller-context), already in scope.
    const { host_type, silicon } = hostIdentity();
    const llm_model = (event.model || 'unknown');

    const conceptData = {
      type: 'llm_usage_event',
      tenant_urn: event.tenant_urn,
      model_urn: buildModelUrn(event.provider, event.model),
      agent_urn: buildAgentUrn(event.organ, event.agent),
      organ_urn: buildOrganUrn(event.organ),
      host_type,
      silicon,
      llm_model,
      cost_usd,
      tokens_in: event.tokens_in || 0,
      tokens_out: event.tokens_out || 0,
      provider: event.provider || 'unknown',
      cascade_stage: event.cascade_stage ?? 0,
      correlation_id: event.correlation_id || `corr-${suffix}`,
      outcome: event.outcome || 'success',
      timestamp: iso,
    };

    // Fire-and-forget. The chat call must NOT await this.
    Promise.resolve()
      .then(() => graphClient.insertConcept('llm_usage_event', urn, conceptData))
      .then(() => {
        // Emit the binding after the concept lands so FK-like constraints
        // (if any) see the source first. UBN and relation were validated
        // synchronously above against the Graph schema-gate regexes.
        return graphClient.insertBinding(ubn, 'class_binding', event.tenant_urn, urn, {
          relation,
          from_urn: event.tenant_urn,
          to_urn: urn,
        });
      })
      .catch((err) => {
        logger({
          event: 'llm_usage_writer_error',
          reason: err.name || 'unknown',
          message: err.message,
          urn,
        });
      });
  }

  function getLLMUsageConceptSchema() {
    // Documentation helper — returned shape matches the JSON document written
    // to the concept store (minus the URN, which is generated per-call). R12
    // conformance scan compares observed concepts against this spec.
    return {
      type: 'llm_usage_event',
      required_fields: [
        'type', 'tenant_urn', 'model_urn', 'agent_urn', 'organ_urn',
        'host_type', 'silicon', 'llm_model',
        'cost_usd', 'tokens_in', 'tokens_out', 'provider',
        'cascade_stage', 'correlation_id', 'outcome', 'timestamp',
      ],
      urn_pattern: '^urn:llm-ops:llm_usage_event:.+$',
      binding_relation: 'llm_usage',
      binding_from: 'tenant_urn (urn:llm-ops:entity:<slug>)',
      binding_to: 'llm_usage_event URN',
    };
  }

  return { writeLLMUsageEvent, getLLMUsageConceptSchema };
}

// ---------------------------------------------------------------------------
// URN builders (local helpers — no string-concatenation drift across callers).
// ---------------------------------------------------------------------------

function buildModelUrn(provider, model) {
  const p = (provider || 'unknown').toLowerCase();
  const m = (model || 'unknown').toLowerCase();
  return `urn:llm-ops:model:${p}:${m}`;
}

function buildAgentUrn(organ, agent) {
  return `urn:llm-ops:agent:${organ.toLowerCase()}:${agent.toLowerCase()}`;
}

function buildOrganUrn(organ) {
  return `urn:llm-ops:organ:${organ.toLowerCase()}`;
}

function defaultLogger(entry) {
  try {
    const withTs = { timestamp: new Date().toISOString(), ...entry };
    process.stdout.write(JSON.stringify(withTs) + '\n');
  } catch {
    /* ignore — test env may not have a usable stdout */
  }
}

function defaultRandomHex(len) {
  try {
    // Prefer Web Crypto (Node 20+).
    const bytes = new Uint8Array(Math.ceil(len / 2));
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, len);
  } catch {
    // Fallback for environments that stub the global.
    let s = '';
    while (s.length < len) s += Math.random().toString(16).slice(2);
    return s.slice(0, len);
  }
}

export { buildModelUrn, buildAgentUrn, buildOrganUrn, UBN_RE, RELATION_RE };

// ---------------------------------------------------------------------------
// Default writer registry — process-global.
//
// The cascade wrapper (llm-cascade.js) consults `getDefaultUsageWriter()` when
// no per-call `usageWriter` is injected. Boot paths construct a graph client,
// build a writer, then call `setDefaultUsageWriter(writer.writeLLMUsageEvent)`
// to wire the fire-and-forget hook for every cascade emission in the process.
//
// Absent registration, cascade emissions are silently dropped (pre-R9 behavior
// preserved — callers that don't want cost attribution see no change).
// ---------------------------------------------------------------------------

let defaultUsageWriter = null;

/**
 * Install a process-default usage writer callback. The callback must be a
 * `writeLLMUsageEvent`-shaped function (synchronous return; internal async).
 *
 * Only one default writer is active at a time; calling this again replaces
 * the prior writer. Pass `null` to clear.
 */
export function setDefaultUsageWriter(writerFn) {
  if (writerFn !== null && typeof writerFn !== 'function') {
    throw new TypeError('setDefaultUsageWriter: writer must be a function or null');
  }
  defaultUsageWriter = writerFn;
}

/**
 * Retrieve the active default writer (or null if unregistered). Used by the
 * cascade wrapper as a fallback when no per-call writer is injected.
 */
export function getDefaultUsageWriter() {
  return defaultUsageWriter;
}
