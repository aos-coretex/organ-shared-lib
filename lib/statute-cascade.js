/**
 * Statute cascade resolver (MP-17 relay g7c-7; input validator relaxed g7c-8 RFI-1).
 *
 * INPUT contract: `personaUrn` may use any `urn:<scheme>:<rest>` prefix
 * (Graphheight-native `urn:graphheight:vivan:*`, LLM-Ops-native
 * `urn:llm-ops:persona:*`, or any future scheme). Governance URNs produced
 * by the engine (via `@coretex/organ-boot/governance-urn`) remain strictly
 * `urn:llm-ops:governance:*`. See binding decision #26 and RFI-1 reply for
 * MP-17 g7c-8.
 *
 * Implements the CSS-style cascade for Vivan governance:
 *
 *     Constitution (layer 0, supreme)
 *         ↓
 *     Statute: Category  (layer 1)
 *         ↓
 *     Statute: Domain    (layer 2)
 *         ↓
 *     Statute: Role      (layer 3)
 *         ↓
 *     Persona overrides  (layer 4, Soul-managed)
 *
 * Chain is walked from persona up to Constitution, then merged general → specific.
 * Constitutional fields are locked: once the Constitution sets a field, no layer
 * below may override it. Everything else follows more-specific-wins.
 *
 * The resolver is pure with respect to a graphClient dependency. Callers pass any
 * object that exposes the minimal interface:
 *
 *   queryConcept(urn)                           → { urn, data, created_at } | null
 *   queryBindings({ sourceUrn?, targetUrn?, type? }) → [{ ubn, data:{from_urn,to_urn,relation,...}, created_at }]
 *
 * which matches `@coretex/organ-boot/graph-client`. Mocked equivalents work in unit tests.
 *
 * Consumers (post-MP-17): Arbiter Tier 1 vivan-branch, Nomos Tier 2 vivan-branch, Soul
 * evolution analyst. Each consumer passes its own graphClient; no singleton.
 *
 * Binding direction convention:
 *   - persona → role       : binding from_urn = persona, to_urn = role
 *   - domain  → role       : binding from_urn = domain,  to_urn = role (parent→child)
 *   - category → domain    : binding from_urn = category, to_urn = domain (parent→child)
 *   - Constitution is the implicit root (no binding to category required — always applied).
 *
 * Governance URN prefixes are imported from `@coretex/organ-boot/governance-urn` so
 * naming drift is impossible.
 */

import {
  constitutionUrn,
  personaOverridesUrn,
} from './governance-urn.js';

const ROLE_PREFIX = 'urn:llm-ops:governance:statute:role:';
const DOMAIN_PREFIX = 'urn:llm-ops:governance:statute:domain:';
const CATEGORY_PREFIX = 'urn:llm-ops:governance:statute:category:';

export class GraphIntegrityError extends Error {
  constructor(message, urn) {
    super(message);
    this.name = 'GraphIntegrityError';
    this.urn = urn;
  }
}

function findBindingEndpoint(bindings, endpointField, prefix) {
  for (const b of bindings) {
    const target = b?.data?.[endpointField];
    if (typeof target === 'string' && target.startsWith(prefix)) {
      return target;
    }
  }
  return null;
}

async function loadOrThrow(graphClient, urn, layerLabel) {
  const row = await graphClient.queryConcept(urn);
  if (!row) {
    throw new GraphIntegrityError(
      `${layerLabel} binding declared but concept missing: ${urn}`,
      urn,
    );
  }
  return row;
}

/**
 * Walk the cascade chain for a persona without merging.
 *
 * Returns the chain in general → specific order:
 *   [constitution, category?, domain?, role?, persona_overrides?]
 * Only layers actually reachable via bindings (or the persona-overrides concept)
 * appear in the result. The Constitution is always first.
 *
 * Throws GraphIntegrityError if a binding points at a concept that cannot be loaded.
 */
export async function walkCascadeChain({ personaUrn, graphClient }) {
  // Scheme-agnostic input validation (RFI-1 Option A for g7c-8). Accepts any
  // `urn:<scheme>:<rest>` — Graphheight-native Vivan URNs, LLM-Ops-native
  // persona URNs, or future schemes. Governance output URNs remain strict.
  if (typeof personaUrn !== 'string' || !/^urn:[^:]+:.+/.test(personaUrn)) {
    throw new TypeError(`personaUrn must be a URN of shape "urn:<scheme>:<rest>" (got ${JSON.stringify(personaUrn)})`);
  }
  if (!graphClient || typeof graphClient.queryConcept !== 'function' || typeof graphClient.queryBindings !== 'function') {
    throw new TypeError('graphClient must expose queryConcept and queryBindings');
  }

  const chain = [];

  // Layer 0 — Constitution (always).
  const constitution = await graphClient.queryConcept(constitutionUrn());
  if (constitution) {
    chain.push({ layer: 'constitution', urn: constitution.urn, payload: constitution.data });
  }
  // If Constitution is absent, we proceed — the resolver is legal to run against a
  // pre-seed Graph. Consumers (Arbiter/Nomos) decide whether to block on it.

  // Persona → role binding.
  const personaOutbound = await graphClient.queryBindings({ sourceUrn: personaUrn });
  const roleUrn = findBindingEndpoint(personaOutbound, 'to_urn', ROLE_PREFIX);

  let domainUrn = null;
  let categoryUrn = null;

  // Role → domain: look for a parent domain whose binding targets the role.
  if (roleUrn) {
    const roleInbound = await graphClient.queryBindings({ targetUrn: roleUrn });
    domainUrn = findBindingEndpoint(roleInbound, 'from_urn', DOMAIN_PREFIX);
  }

  // Domain → category.
  if (domainUrn) {
    const domainInbound = await graphClient.queryBindings({ targetUrn: domainUrn });
    categoryUrn = findBindingEndpoint(domainInbound, 'from_urn', CATEGORY_PREFIX);
  }

  // Append in general → specific order.
  if (categoryUrn) {
    const c = await loadOrThrow(graphClient, categoryUrn, 'category');
    chain.push({ layer: 'category', urn: c.urn, payload: c.data });
  }
  if (domainUrn) {
    const d = await loadOrThrow(graphClient, domainUrn, 'domain');
    chain.push({ layer: 'domain', urn: d.urn, payload: d.data });
  }
  if (roleUrn) {
    const r = await loadOrThrow(graphClient, roleUrn, 'role');
    chain.push({ layer: 'role', urn: r.urn, payload: r.data });
  }

  // Layer 4 — persona overrides (Soul-managed, direct concept lookup).
  const overrides = await graphClient.queryConcept(personaOverridesUrn(personaUrn));
  if (overrides) {
    chain.push({ layer: 'persona_overrides', urn: overrides.urn, payload: overrides.data });
  }

  return chain;
}

/**
 * Pure merge of a cascade chain.
 *
 * Merges each layer's `payload.constraints` object (or `{}` when absent) into an
 * accumulating effective governance map in chain order. Later layers override
 * earlier ones (more specific wins) — EXCEPT fields first set by the Constitution,
 * which are locked against override.
 *
 * Returns:
 *   {
 *     effective: { [field]: value, ... },
 *     sourceByField: { [field]: layerName },
 *     constitutionFieldsLocked: [fieldName, ...]
 *   }
 */
export function mergeChain(chain) {
  const effective = {};
  const sourceByField = {};

  for (const link of chain) {
    const constraints = (link && link.payload && typeof link.payload.constraints === 'object' && link.payload.constraints !== null)
      ? link.payload.constraints
      : {};
    for (const [field, value] of Object.entries(constraints)) {
      const existingSource = sourceByField[field];
      if (existingSource === 'constitution' && link.layer !== 'constitution') {
        // Constitutional lock: field was set by Constitution and cannot be overridden.
        continue;
      }
      effective[field] = value;
      sourceByField[field] = link.layer;
    }
  }

  const constitutionFieldsLocked = Object.entries(sourceByField)
    .filter(([, src]) => src === 'constitution')
    .map(([field]) => field);

  return { effective, sourceByField, constitutionFieldsLocked };
}

/**
 * End-to-end cascade resolution. Convenience wrapper over walkCascadeChain + mergeChain.
 *
 * Returns:
 *   {
 *     effectiveGovernance: flat field map after merge,
 *     layersApplied:      [{layer, urn}, ...] in order,
 *     constitutionFieldsLocked: [fieldName, ...]
 *   }
 */
export async function resolveCascade({ personaUrn, graphClient }) {
  const chain = await walkCascadeChain({ personaUrn, graphClient });
  const layersApplied = chain.map(({ layer, urn }) => ({ layer, urn }));
  const { effective, constitutionFieldsLocked } = mergeChain(chain);
  return {
    effectiveGovernance: effective,
    layersApplied,
    constitutionFieldsLocked,
  };
}
