import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  constitutionUrn,
  entityBorUrn,
  entityMspUrn,
  statuteCategoryUrn,
  statuteDomainUrn,
  statuteRoleUrn,
  personaOverridesUrn,
} from '../lib/governance-urn.js';

describe('Governance URN builders', () => {
  describe('constitutionUrn', () => {
    it('returns the canonical Constitution URN', () => {
      assert.equal(constitutionUrn(), 'urn:llm-ops:governance:constitution');
    });

    it('is idempotent', () => {
      assert.equal(constitutionUrn(), constitutionUrn());
    });
  });

  describe('entityBorUrn', () => {
    it('composes BoR URN from a tenant URN', () => {
      const tenant = 'urn:llm-ops:entity:graphheight';
      assert.equal(
        entityBorUrn(tenant),
        'urn:llm-ops:governance:bor:urn:llm-ops:entity:graphheight'
      );
    });

    it('rejects non-URN input', () => {
      assert.throws(() => entityBorUrn('graphheight'), TypeError);
      assert.throws(() => entityBorUrn(''), TypeError);
      assert.throws(() => entityBorUrn(null), TypeError);
      assert.throws(() => entityBorUrn(42), TypeError);
    });
  });

  describe('entityMspUrn', () => {
    it('composes MSP URN from a tenant URN', () => {
      const tenant = 'urn:llm-ops:entity:opvera';
      assert.equal(
        entityMspUrn(tenant),
        'urn:llm-ops:governance:msp:urn:llm-ops:entity:opvera'
      );
    });

    it('rejects non-URN input', () => {
      assert.throws(() => entityMspUrn('opvera'), TypeError);
    });
  });

  describe('statute URN builders', () => {
    it('statuteCategoryUrn composes correctly', () => {
      assert.equal(
        statuteCategoryUrn('regulated-professions'),
        'urn:llm-ops:governance:statute:category:regulated-professions'
      );
    });

    it('statuteDomainUrn composes correctly', () => {
      assert.equal(
        statuteDomainUrn('accounting'),
        'urn:llm-ops:governance:statute:domain:accounting'
      );
    });

    it('statuteRoleUrn composes correctly', () => {
      assert.equal(
        statuteRoleUrn('cpa'),
        'urn:llm-ops:governance:statute:role:cpa'
      );
    });

    it('rejects non-slug names (uppercase, spaces, leading/trailing hyphens)', () => {
      assert.throws(() => statuteCategoryUrn('Regulated-Professions'), TypeError);
      assert.throws(() => statuteDomainUrn('health care'), TypeError);
      assert.throws(() => statuteRoleUrn('-cpa'), TypeError);
      assert.throws(() => statuteRoleUrn('cpa-'), TypeError);
      assert.throws(() => statuteCategoryUrn(''), TypeError);
      assert.throws(() => statuteCategoryUrn('x_y'), TypeError);
    });
  });

  describe('personaOverridesUrn', () => {
    it('wraps a persona URN with the overrides suffix', () => {
      const persona = 'urn:llm-ops:persona:vivan-psychologist-alice';
      assert.equal(
        personaOverridesUrn(persona),
        'urn:llm-ops:governance:persona:urn:llm-ops:persona:vivan-psychologist-alice:overrides'
      );
    });

    it('rejects non-URN input', () => {
      assert.throws(() => personaOverridesUrn('vivan-psychologist-alice'), TypeError);
    });
  });

  describe('cross-cutting', () => {
    it('every builder produces a URN with the llm-ops scheme', () => {
      const samples = [
        constitutionUrn(),
        entityBorUrn('urn:llm-ops:entity:x'),
        entityMspUrn('urn:llm-ops:entity:x'),
        statuteCategoryUrn('a'),
        statuteDomainUrn('a'),
        statuteRoleUrn('a'),
        personaOverridesUrn('urn:llm-ops:persona:x'),
      ];
      for (const u of samples) {
        assert.ok(u.startsWith('urn:llm-ops:governance:'), `expected governance URN, got ${u}`);
      }
    });
  });

  // MP-17 g7c-8 RFI-1: input URNs may use any urn:<scheme>:<rest> prefix.
  // Governance output remains strictly urn:llm-ops:governance:*.
  describe('scheme-agnostic input validation (RFI-1 Option A)', () => {
    it('accepts Graphheight-native Vivan URN as persona input', () => {
      const vivan = 'urn:graphheight:vivan:20260414-ab12';
      const out = personaOverridesUrn(vivan);
      assert.equal(out, `urn:llm-ops:governance:persona:${vivan}:overrides`);
      assert.ok(out.startsWith('urn:llm-ops:governance:'));
    });

    it('accepts Graphheight-native user URN as tenant input for BoR/MSP', () => {
      const tenant = 'urn:graphheight:user:20260414-cd34';
      assert.equal(
        entityBorUrn(tenant),
        `urn:llm-ops:governance:bor:${tenant}`
      );
      assert.equal(
        entityMspUrn(tenant),
        `urn:llm-ops:governance:msp:${tenant}`
      );
    });

    it('accepts urn:llm-ops:entity:* (unchanged existing contract)', () => {
      const e = 'urn:llm-ops:entity:graphheight';
      assert.equal(
        entityBorUrn(e),
        'urn:llm-ops:governance:bor:urn:llm-ops:entity:graphheight'
      );
    });

    it('accepts urn:llm-ops:derivation:* as a valid input scheme', () => {
      const d = 'urn:llm-ops:derivation:vivan-alice-2026-04';
      const out = personaOverridesUrn(d);
      assert.equal(out, `urn:llm-ops:governance:persona:${d}:overrides`);
    });

    it('rejects missing "urn:" prefix', () => {
      assert.throws(() => personaOverridesUrn('vivan-alice'), TypeError);
      assert.throws(() => entityBorUrn('graphheight'), TypeError);
    });

    it('rejects empty scheme (urn::rest)', () => {
      assert.throws(() => personaOverridesUrn('urn::rest'), TypeError);
    });

    it('rejects scheme-only without a rest segment', () => {
      assert.throws(() => personaOverridesUrn('urn:graphheight:'), TypeError);
      assert.throws(() => personaOverridesUrn('urn:graphheight'), TypeError);
    });

    it('rejects empty string and non-string input', () => {
      assert.throws(() => personaOverridesUrn(''), TypeError);
      assert.throws(() => personaOverridesUrn(null), TypeError);
      assert.throws(() => personaOverridesUrn(42), TypeError);
    });
  });
});
