/**
 * Tests for pricing-table.js — MP-CONFIG-1 R9.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { estimateCost, getPricing, setPricing, resetPricing } from '../lib/pricing-table.js';

describe('pricing-table — estimateCost', () => {
  beforeEach(() => resetPricing());

  it('computes Anthropic Haiku cost correctly (1.0 in + 5.0 out per 1M)', () => {
    // 1000 input + 500 output → 1e-3 * 1.0 + 5e-4 * 5.0 = 0.001 + 0.0025 = 0.0035
    const cost = estimateCost({
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      tokens_in: 1000,
      tokens_out: 500,
    });
    assert.ok(Math.abs(cost - 0.0035) < 1e-9, `expected ~0.0035, got ${cost}`);
  });

  it('computes Anthropic Sonnet cost correctly (3.0 in + 15.0 out per 1M)', () => {
    // 10000 input + 2000 output → 0.03 + 0.03 = 0.06
    const cost = estimateCost({
      model: 'claude-sonnet-4-6',
      provider: 'anthropic',
      tokens_in: 10_000,
      tokens_out: 2_000,
    });
    assert.ok(Math.abs(cost - 0.06) < 1e-9, `expected 0.06, got ${cost}`);
  });

  it('returns 0 for openai-compatible (local inference) when model not in table', () => {
    const cost = estimateCost({
      model: 'qwen2.5-32b-awq',
      provider: 'openai-compatible',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    assert.equal(cost, 0);
  });

  it('returns 0 for unknown Anthropic model (non-throwing; warning logged)', () => {
    const cost = estimateCost({
      model: 'claude-future-model-99',
      provider: 'anthropic',
      tokens_in: 1000,
      tokens_out: 1000,
    });
    assert.equal(cost, 0);
  });

  it('setPricing replaces the active table wholesale', () => {
    setPricing({ 'my-local-model': { input: 0.1, output: 0.2 } });
    const cost = estimateCost({
      model: 'my-local-model',
      provider: 'openai-compatible',
      tokens_in: 1_000_000,
      tokens_out: 1_000_000,
    });
    // 1.0 * 0.1 + 1.0 * 0.2 = 0.3
    assert.ok(Math.abs(cost - 0.3) < 1e-9);

    // Canonical Anthropic model is NOT in the replaced table → falls into
    // openai-compatible branch and returns 0.
    const cost2 = estimateCost({
      model: 'claude-haiku-4-5-20251001',
      provider: 'anthropic',
      tokens_in: 1000,
      tokens_out: 500,
    });
    // Under a non-Anthropic-aware table, the model is unknown → 0
    assert.equal(cost2, 0);
  });

  it('getPricing returns a copy — mutation does not leak', () => {
    const a = getPricing();
    a['evil-model'] = { input: 999, output: 999 };
    const b = getPricing();
    assert.equal(b['evil-model'], undefined);
  });
});
