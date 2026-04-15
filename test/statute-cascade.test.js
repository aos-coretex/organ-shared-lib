import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  walkCascadeChain,
  mergeChain,
  resolveCascade,
  GraphIntegrityError,
} from '../lib/statute-cascade.js';

// ─── Test fixtures ────────────────────────────────────────────────────────────

const CONSTITUTION_URN = 'urn:llm-ops:governance:constitution';
const PERSONA_URN = 'urn:llm-ops:persona:vivan-cpa-alice';
const ROLE_URN = 'urn:llm-ops:governance:statute:role:cpa';
const DOMAIN_URN = 'urn:llm-ops:governance:statute:domain:accounting';
const CATEGORY_URN = 'urn:llm-ops:governance:statute:category:regulated-professions';
const PERSONA_OVERRIDES_URN = `urn:llm-ops:governance:persona:${PERSONA_URN}:overrides`;

function constitutionConcept(constraints = {}) {
  return { urn: CONSTITUTION_URN, data: { type: 'constitution', constraints } };
}
function statuteConcept(urn, type, constraints) {
  return { urn, data: { type, constraints } };
}
function binding(from_urn, to_urn, relation = 'in-cascade') {
  return { ubn: `urn:llm-ops:ubn:${from_urn}->${to_urn}`, data: { from_urn, to_urn, relation } };
}

/**
 * Builds a mock graphClient from a concept map and binding list.
 * concepts: Map<urn, conceptRow>
 * bindings: array of binding rows
 */
function mockGraphClient({ concepts = new Map(), bindings = [] } = {}) {
  return {
    async queryConcept(urn) {
      return concepts.has(urn) ? concepts.get(urn) : null;
    },
    async queryBindings({ sourceUrn, targetUrn, type } = {}) {
      return bindings.filter((b) => {
        if (sourceUrn && b.data.from_urn !== sourceUrn) return false;
        if (targetUrn && b.data.to_urn !== targetUrn) return false;
        if (type && b.data.relation !== type) return false;
        return true;
      });
    },
  };
}

// ─── walkCascadeChain ─────────────────────────────────────────────────────────

describe('walkCascadeChain', () => {
  it('returns Constitution-only chain when persona has no role binding', async () => {
    const concepts = new Map([[CONSTITUTION_URN, constitutionConcept()]]);
    const client = mockGraphClient({ concepts });
    const chain = await walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(chain.map((l) => l.layer), ['constitution']);
  });

  it('returns empty chain when Constitution absent and no role', async () => {
    const client = mockGraphClient({});
    const chain = await walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(chain, []);
  });

  it('walks persona → role → domain → category and prepends Constitution', async () => {
    const concepts = new Map([
      [CONSTITUTION_URN, constitutionConcept({ base_principle: 'safety-first' })],
      [ROLE_URN, statuteConcept(ROLE_URN, 'statute', { max_scope: 'cpa' })],
      [DOMAIN_URN, statuteConcept(DOMAIN_URN, 'statute', { domain_scope: 'accounting' })],
      [CATEGORY_URN, statuteConcept(CATEGORY_URN, 'statute', { category_scope: 'regulated' })],
    ]);
    const bindings = [
      binding(PERSONA_URN, ROLE_URN, 'assigned-to'),
      binding(DOMAIN_URN, ROLE_URN, 'includes'),
      binding(CATEGORY_URN, DOMAIN_URN, 'includes'),
    ];
    const client = mockGraphClient({ concepts, bindings });
    const chain = await walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(
      chain.map((l) => l.layer),
      ['constitution', 'category', 'domain', 'role'],
    );
    assert.equal(chain[0].urn, CONSTITUTION_URN);
    assert.equal(chain[1].urn, CATEGORY_URN);
    assert.equal(chain[2].urn, DOMAIN_URN);
    assert.equal(chain[3].urn, ROLE_URN);
  });

  it('appends persona_overrides when overrides concept exists', async () => {
    const concepts = new Map([
      [CONSTITUTION_URN, constitutionConcept()],
      [ROLE_URN, statuteConcept(ROLE_URN, 'statute', {})],
      [PERSONA_OVERRIDES_URN, { urn: PERSONA_OVERRIDES_URN, data: { type: 'persona_overrides', constraints: { style: 'blunt' } } }],
    ]);
    const bindings = [binding(PERSONA_URN, ROLE_URN, 'assigned-to')];
    const client = mockGraphClient({ concepts, bindings });
    const chain = await walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(
      chain.map((l) => l.layer),
      ['constitution', 'role', 'persona_overrides'],
    );
  });

  it('skips missing middle layers (role without domain binding)', async () => {
    const concepts = new Map([
      [CONSTITUTION_URN, constitutionConcept()],
      [ROLE_URN, statuteConcept(ROLE_URN, 'statute', {})],
    ]);
    const bindings = [binding(PERSONA_URN, ROLE_URN, 'assigned-to')];
    const client = mockGraphClient({ concepts, bindings });
    const chain = await walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(chain.map((l) => l.layer), ['constitution', 'role']);
  });

  it('throws GraphIntegrityError when a binding references a missing concept', async () => {
    const concepts = new Map([[CONSTITUTION_URN, constitutionConcept()]]);
    const bindings = [binding(PERSONA_URN, ROLE_URN, 'assigned-to')];
    const client = mockGraphClient({ concepts, bindings });
    await assert.rejects(
      () => walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: client }),
      (err) => err instanceof GraphIntegrityError && err.urn === ROLE_URN,
    );
  });

  it('rejects invalid personaUrn', async () => {
    const client = mockGraphClient({});
    await assert.rejects(
      () => walkCascadeChain({ personaUrn: 'not-a-urn', graphClient: client }),
      TypeError,
    );
  });

  it('rejects bad graphClient', async () => {
    await assert.rejects(
      () => walkCascadeChain({ personaUrn: PERSONA_URN, graphClient: {} }),
      TypeError,
    );
  });

  // MP-17 g7c-8 RFI-1: scheme-agnostic input validation.
  it('accepts urn:graphheight:vivan:* as personaUrn (Graphheight-native)', async () => {
    const vivan = 'urn:graphheight:vivan:20260414-xy99';
    const concepts = new Map([[CONSTITUTION_URN, constitutionConcept()]]);
    const client = mockGraphClient({ concepts });
    const chain = await walkCascadeChain({ personaUrn: vivan, graphClient: client });
    assert.equal(chain.length, 1);
    assert.equal(chain[0].layer, 'constitution');
  });

  it('accepts urn:llm-ops:derivation:* as personaUrn', async () => {
    const d = 'urn:llm-ops:derivation:vivan-alice';
    const concepts = new Map([[CONSTITUTION_URN, constitutionConcept()]]);
    const client = mockGraphClient({ concepts });
    const chain = await walkCascadeChain({ personaUrn: d, graphClient: client });
    assert.equal(chain.length, 1);
  });

  it('rejects personaUrn with empty scheme', async () => {
    const client = mockGraphClient({});
    await assert.rejects(
      () => walkCascadeChain({ personaUrn: 'urn::rest', graphClient: client }),
      TypeError,
    );
  });

  it('rejects personaUrn without rest segment', async () => {
    const client = mockGraphClient({});
    await assert.rejects(
      () => walkCascadeChain({ personaUrn: 'urn:graphheight:', graphClient: client }),
      TypeError,
    );
  });
});

// ─── mergeChain ───────────────────────────────────────────────────────────────

describe('mergeChain', () => {
  it('returns empty effective governance for empty chain', () => {
    const result = mergeChain([]);
    assert.deepEqual(result.effective, {});
    assert.deepEqual(result.sourceByField, {});
    assert.deepEqual(result.constitutionFieldsLocked, []);
  });

  it('more-specific-wins: role overrides category overrides constitution (for unlocked fields)', () => {
    const chain = [
      { layer: 'constitution', urn: CONSTITUTION_URN, payload: { constraints: { max_tokens: 1000 } } },
      { layer: 'category', urn: CATEGORY_URN, payload: { constraints: { max_tokens: 2000 } } },
      { layer: 'role', urn: ROLE_URN, payload: { constraints: { max_tokens: 4000 } } },
    ];
    const result = mergeChain(chain);
    // Constitution sets max_tokens first → LOCKED. Category and role attempts are skipped.
    assert.equal(result.effective.max_tokens, 1000);
    assert.deepEqual(result.constitutionFieldsLocked, ['max_tokens']);
  });

  it('constitutional lock: Constitution-sourced fields cannot be overridden', () => {
    const chain = [
      { layer: 'constitution', urn: CONSTITUTION_URN, payload: { constraints: { forbid_x: true } } },
      { layer: 'role', urn: ROLE_URN, payload: { constraints: { forbid_x: false, role_field: 'cpa' } } },
    ];
    const result = mergeChain(chain);
    assert.equal(result.effective.forbid_x, true, 'Constitutional lock must preserve forbid_x=true');
    assert.equal(result.effective.role_field, 'cpa', 'Unlocked field role_field is set by role');
    assert.deepEqual(result.constitutionFieldsLocked, ['forbid_x']);
    assert.equal(result.sourceByField.forbid_x, 'constitution');
    assert.equal(result.sourceByField.role_field, 'role');
  });

  it('unlocked cascade: role can override category which can override an unlocked field', () => {
    const chain = [
      { layer: 'constitution', urn: CONSTITUTION_URN, payload: { constraints: {} } },
      { layer: 'category', urn: CATEGORY_URN, payload: { constraints: { style: 'formal' } } },
      { layer: 'domain', urn: DOMAIN_URN, payload: { constraints: { style: 'precise' } } },
      { layer: 'role', urn: ROLE_URN, payload: { constraints: { style: 'cpa-attestation' } } },
    ];
    const result = mergeChain(chain);
    assert.equal(result.effective.style, 'cpa-attestation');
    assert.equal(result.sourceByField.style, 'role');
    assert.deepEqual(result.constitutionFieldsLocked, []);
  });

  it('persona overrides: layer 4 beats role for unlocked fields, not for constitutional', () => {
    const chain = [
      { layer: 'constitution', urn: CONSTITUTION_URN, payload: { constraints: { safety_floor: 'high' } } },
      { layer: 'role', urn: ROLE_URN, payload: { constraints: { tone: 'professional' } } },
      { layer: 'persona_overrides', urn: PERSONA_OVERRIDES_URN, payload: { constraints: { tone: 'blunt', safety_floor: 'medium' } } },
    ];
    const result = mergeChain(chain);
    assert.equal(result.effective.tone, 'blunt');
    assert.equal(result.effective.safety_floor, 'high', 'Persona overrides cannot relax constitutional safety_floor');
    assert.deepEqual(result.constitutionFieldsLocked, ['safety_floor']);
  });

  it('handles layers with no constraints block (document-only scaffold)', () => {
    const chain = [
      { layer: 'constitution', urn: CONSTITUTION_URN, payload: { type: 'constitution', sections: { preamble: 'x' } } }, // no constraints
      { layer: 'role', urn: ROLE_URN, payload: { constraints: { a: 1 } } },
    ];
    const result = mergeChain(chain);
    assert.deepEqual(result.effective, { a: 1 });
    assert.deepEqual(result.constitutionFieldsLocked, []);
  });
});

// ─── resolveCascade ───────────────────────────────────────────────────────────

describe('resolveCascade', () => {
  it('composes walk + merge and returns the documented shape', async () => {
    const concepts = new Map([
      [CONSTITUTION_URN, constitutionConcept({ constitutional_floor: true })],
      [ROLE_URN, statuteConcept(ROLE_URN, 'statute', { role_field: 'cpa', constitutional_floor: false })],
    ]);
    const bindings = [binding(PERSONA_URN, ROLE_URN, 'assigned-to')];
    const client = mockGraphClient({ concepts, bindings });

    const result = await resolveCascade({ personaUrn: PERSONA_URN, graphClient: client });

    assert.deepEqual(result.layersApplied, [
      { layer: 'constitution', urn: CONSTITUTION_URN },
      { layer: 'role', urn: ROLE_URN },
    ]);
    // constitutional_floor was set by Constitution first → locked; role's override ignored.
    assert.equal(result.effectiveGovernance.constitutional_floor, true);
    assert.equal(result.effectiveGovernance.role_field, 'cpa');
    assert.deepEqual(result.constitutionFieldsLocked, ['constitutional_floor']);
  });

  it('Vivan with no statutes: effective governance is Constitution-only', async () => {
    const concepts = new Map([[
      CONSTITUTION_URN,
      { urn: CONSTITUTION_URN, data: { type: 'constitution', constraints: { base: 'safe' } } },
    ]]);
    const client = mockGraphClient({ concepts });
    const result = await resolveCascade({ personaUrn: PERSONA_URN, graphClient: client });
    assert.deepEqual(result.layersApplied, [{ layer: 'constitution', urn: CONSTITUTION_URN }]);
    assert.deepEqual(result.effectiveGovernance, { base: 'safe' });
    assert.deepEqual(result.constitutionFieldsLocked, ['base']);
  });
});
