import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateUrn } from '../lib/urn.js';

describe('URN generation', () => {
  it('generates URN with correct format', () => {
    const urn = generateUrn('otm');
    assert.match(urn, /^urn:llm-ops:otm:\d{4}-\d{2}-\d{2}T.+-[a-z0-9]{4}$/);
  });

  it('uses the provided namespace', () => {
    for (const ns of ['otm', 'apm', 'pem', 'atm', 'hom', 'transition']) {
      const urn = generateUrn(ns);
      assert.ok(urn.startsWith(`urn:llm-ops:${ns}:`), `Expected namespace ${ns} in ${urn}`);
    }
  });

  it('generates unique URNs', () => {
    const urns = new Set();
    for (let i = 0; i < 100; i++) {
      urns.add(generateUrn('otm'));
    }
    // With timestamps + random4, collisions should be near-impossible
    assert.ok(urns.size >= 99, `Expected at least 99 unique URNs, got ${urns.size}`);
  });
});
