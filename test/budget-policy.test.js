/**
 * Tests for budget-policy.js — MP-CONFIG-1 R9.
 *
 * The default policy always returns `allow`. `setPolicy` swaps the active
 * policy; `BudgetExceeded` is raiseable from llm-errors (already exported in
 * R2) when a caller elects to enforce a `deny` verdict.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBudgetPolicy, setPolicy, getPolicy, resetPolicy } from '../lib/budget-policy.js';
import { BudgetExceeded } from '../lib/llm-errors.js';

describe('budget-policy', () => {
  beforeEach(() => resetPolicy());

  it('default policy always returns { action: "allow" } with a reason', () => {
    const result = evaluateBudgetPolicy({
      tenant_urn: 'urn:llm-ops:entity:llm-ops-platform',
      estimated_cost_usd: 123.45,
      context: { organ: 'cortex' },
    });
    assert.equal(result.action, 'allow');
    assert.equal(typeof result.reason, 'string');
    assert.ok(result.reason.length > 0);
  });

  it('setPolicy swaps the active policy; evaluator uses the new one', () => {
    const denyAll = () => ({ action: 'deny', reason: 'test-ceiling-zero' });
    setPolicy(denyAll);
    const result = evaluateBudgetPolicy({
      tenant_urn: 'urn:llm-ops:entity:test',
      estimated_cost_usd: 0.001,
      context: {},
    });
    assert.equal(result.action, 'deny');
    assert.equal(result.reason, 'test-ceiling-zero');
  });

  it('getPolicy returns the currently-active function', () => {
    const fn = (args) => ({ action: 'cascade', reason: 'test' });
    setPolicy(fn);
    assert.strictEqual(getPolicy(), fn);
  });

  it('setPolicy rejects non-function arguments', () => {
    assert.throws(() => setPolicy('not a function'), /must be a function/);
    assert.throws(() => setPolicy(null), /must be a function/);
  });

  it('evaluator fails open if the policy throws (defense in depth)', () => {
    setPolicy(() => { throw new Error('boom'); });
    const result = evaluateBudgetPolicy({
      tenant_urn: 'urn:llm-ops:entity:test',
      estimated_cost_usd: 1,
      context: {},
    });
    assert.equal(result.action, 'allow');
    assert.ok(result.reason.includes('policy-evaluator-error'));
    assert.ok(result.reason.includes('boom'));
  });

  it('BudgetExceeded is raiseable from llm-errors with structured payload (reachability proof)', () => {
    let err;
    try {
      throw new BudgetExceeded({
        tenant_urn: 'urn:llm-ops:entity:test',
        requested_cost_usd: 10,
        remaining_budget_usd: 2,
        policy_reason: 'test-ceiling-exceeded',
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BudgetExceeded);
    assert.equal(err.code, 'BUDGET_EXCEEDED');
    assert.equal(err.tenant_urn, 'urn:llm-ops:entity:test');
    assert.equal(err.requested_cost_usd, 10);
    assert.equal(err.remaining_budget_usd, 2);
    assert.equal(err.policy_reason, 'test-ceiling-exceeded');
  });
});
