/**
 * Governance URN builders (MP-17 relay g7c-1).
 *
 * Scheme (OUTPUT — unchanged): urn:llm-ops:governance:<domain>:<segments>
 *
 * Canonical output patterns:
 *   urn:llm-ops:governance:constitution
 *   urn:llm-ops:governance:bor:<tenant_urn>
 *   urn:llm-ops:governance:msp:<tenant_urn>
 *   urn:llm-ops:governance:statute:category:<name>
 *   urn:llm-ops:governance:statute:domain:<name>
 *   urn:llm-ops:governance:statute:role:<name>
 *   urn:llm-ops:governance:persona:<persona_urn>:overrides
 *
 * INPUT URNs (identity, persona, tenant) may use any `urn:<scheme>:` prefix —
 * see binding decision #26 (interim URN formats) and MP-17 g7c-8 RFI-1 reply.
 * Known interim schemes include:
 *   - urn:graphheight:vivan:*            (Soul personas)
 *   - urn:graphheight:conversation:*     (Hippocampus)
 *   - urn:graphheight:authorization_token:*  (Cerberus)
 *   - urn:graphheight:user:*             (Phi/Cerberus)
 *   - urn:llm-ops:entity:*               (tenant entities)
 *   - urn:llm-ops:derivation:*
 *   - urn:llm-ops:persona:*              (future LLM-Ops-native personas)
 *
 * OUTPUT governance URNs are always `urn:llm-ops:governance:*` — that scheme
 * is ours and stays strict.
 *
 * All downstream consumers (Arbiter, Nomos, Senate, Soul, cascade engine) MUST
 * import these builders rather than string-concatenating URNs.
 */

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
// Input-side scheme-agnostic validator: `urn:<scheme>:<rest>` with non-empty
// scheme and non-empty rest. Used for identity/persona/tenant INPUT URNs
// which may arrive from Graphheight (urn:graphheight:*) or any future
// provider. See MP-17 g7c-8 RFI-1 reply.
const URN_INPUT_RE = /^urn:[^:]+:.+/;

function assertSlug(name, field) {
  if (typeof name !== 'string' || !SLUG_RE.test(name)) {
    throw new TypeError(
      `${field} must be a lowercase slug matching ${SLUG_RE} (got ${JSON.stringify(name)})`
    );
  }
}

function assertUrn(urn, field) {
  if (typeof urn !== 'string' || !URN_INPUT_RE.test(urn)) {
    throw new TypeError(
      `${field} must be a URN of shape "urn:<scheme>:<rest>" (got ${JSON.stringify(urn)})`
    );
  }
}

export function constitutionUrn() {
  return 'urn:llm-ops:governance:constitution';
}

export function entityBorUrn(tenantUrn) {
  assertUrn(tenantUrn, 'tenantUrn');
  return `urn:llm-ops:governance:bor:${tenantUrn}`;
}

export function entityMspUrn(tenantUrn) {
  assertUrn(tenantUrn, 'tenantUrn');
  return `urn:llm-ops:governance:msp:${tenantUrn}`;
}

export function statuteCategoryUrn(name) {
  assertSlug(name, 'category name');
  return `urn:llm-ops:governance:statute:category:${name}`;
}

export function statuteDomainUrn(name) {
  assertSlug(name, 'domain name');
  return `urn:llm-ops:governance:statute:domain:${name}`;
}

export function statuteRoleUrn(name) {
  assertSlug(name, 'role name');
  return `urn:llm-ops:governance:statute:role:${name}`;
}

export function personaOverridesUrn(personaUrn) {
  assertUrn(personaUrn, 'personaUrn');
  return `urn:llm-ops:governance:persona:${personaUrn}:overrides`;
}
