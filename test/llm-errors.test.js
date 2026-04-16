/**
 * Unit tests for llm-errors.js — MP-CONFIG-1 relays l9m-1 (LLMSettingsInvalid)
 * + l9m-2 (LLMCascadeExhausted, BudgetExceeded).
 *
 * Coverage:
 *   - Instantiation + payload + name + code for each of 3 exported error classes
 *   - `instanceof Error` AND `instanceof <SpecificClass>` checks
 *   - Subpath import via `@coretex/organ-boot/llm-errors` (bug #1 compliance)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  LLMSettingsInvalid,
  LLMCascadeExhausted,
  BudgetExceeded,
} from '../lib/llm-errors.js';

describe('llm-errors: LLMSettingsInvalid', () => {
  it('instantiates with full payload', () => {
    const err = new LLMSettingsInvalid({
      field: 'model',
      expected_pattern: 'non-empty string',
      actual_value: null,
      reason: 'model required',
      filename: 'test.yaml',
    });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof LLMSettingsInvalid);
    assert.equal(err.name, 'LLMSettingsInvalid');
    assert.equal(err.code, 'LLM_SETTINGS_INVALID');
    assert.equal(err.field, 'model');
    assert.equal(err.expected_pattern, 'non-empty string');
    assert.equal(err.actual_value, null);
    assert.equal(err.reason, 'model required');
    assert.equal(err.filename, 'test.yaml');
    assert.match(err.message, /test\.yaml: model required/);
  });

  it('instantiates with no args (defensive)', () => {
    const err = new LLMSettingsInvalid();
    assert.equal(err.name, 'LLMSettingsInvalid');
    assert.equal(err.code, 'LLM_SETTINGS_INVALID');
  });
});

describe('llm-errors: LLMCascadeExhausted', () => {
  it('instantiates with multi-stage attempted array', () => {
    const attempted = [
      { provider: 'anthropic', model: 'claude-sonnet-4-6', error_class: 'http_503', error_message: 'down', elapsed_ms: 120 },
      { provider: 'openai-compatible', model: 'qwen', error_class: 'connection_refused', error_message: 'no socket', elapsed_ms: 5 },
    ];
    const err = new LLMCascadeExhausted({ attempted });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof LLMCascadeExhausted);
    assert.equal(err.name, 'LLMCascadeExhausted');
    assert.equal(err.code, 'LLM_CASCADE_EXHAUSTED');
    assert.deepEqual(err.attempted, attempted);
    assert.match(err.message, /2 stage/);
    assert.match(err.message, /connection_refused/);
  });

  it('instantiates with single-stage exhaustion (no fallback configured)', () => {
    const err = new LLMCascadeExhausted({
      attempted: [
        { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', error_class: 'http_5xx', error_message: 'oops', elapsed_ms: 10 },
      ],
    });
    assert.equal(err.attempted.length, 1);
    assert.match(err.message, /1 stage/);
  });

  it('instantiates with no args (defensive)', () => {
    const err = new LLMCascadeExhausted();
    assert.equal(err.name, 'LLMCascadeExhausted');
    assert.deepEqual(err.attempted, []);
  });
});

describe('llm-errors: BudgetExceeded', () => {
  it('instantiates with full payload', () => {
    const err = new BudgetExceeded({
      tenant_urn: 'urn:llm-ops:entity:graphheight',
      requested_cost_usd: 0.42,
      remaining_budget_usd: 0.10,
      policy_reason: 'daily_ceiling_reached',
    });
    assert.ok(err instanceof Error);
    assert.ok(err instanceof BudgetExceeded);
    assert.equal(err.name, 'BudgetExceeded');
    assert.equal(err.code, 'BUDGET_EXCEEDED');
    assert.equal(err.tenant_urn, 'urn:llm-ops:entity:graphheight');
    assert.equal(err.requested_cost_usd, 0.42);
    assert.equal(err.remaining_budget_usd, 0.10);
    assert.equal(err.policy_reason, 'daily_ceiling_reached');
    assert.match(err.message, /graphheight/);
    assert.match(err.message, /daily_ceiling_reached/);
  });

  it('instantiates with no args (defensive)', () => {
    const err = new BudgetExceeded();
    assert.equal(err.name, 'BudgetExceeded');
    assert.equal(err.code, 'BUDGET_EXCEEDED');
  });
});

describe('llm-errors: subpath import (@coretex/organ-boot/llm-errors)', () => {
  it('resolves all three exports via subpath', async () => {
    const m = await import('@coretex/organ-boot/llm-errors');
    assert.ok(m.LLMSettingsInvalid);
    assert.ok(m.LLMCascadeExhausted);
    assert.ok(m.BudgetExceeded);
    // Identity check — same class reference whether imported via relative or subpath path.
    assert.equal(m.LLMSettingsInvalid, LLMSettingsInvalid);
    assert.equal(m.LLMCascadeExhausted, LLMCascadeExhausted);
    assert.equal(m.BudgetExceeded, BudgetExceeded);
  });

  it('instanceof works through subpath import', async () => {
    const { LLMCascadeExhausted: LCE } = await import('@coretex/organ-boot/llm-errors');
    const err = new LCE({ attempted: [] });
    assert.ok(err instanceof LCE);
    assert.ok(err instanceof Error);
  });
});
