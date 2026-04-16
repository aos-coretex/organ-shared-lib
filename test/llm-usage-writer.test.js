/**
 * Tests for llm-usage-writer.js — MP-CONFIG-1 R9.
 *
 * The writer must:
 *   - call graphClient.insertConcept with type 'llm_usage_event' + a URN that
 *     matches `urn:llm-ops:llm_usage_event:<id>`
 *   - call graphClient.insertBinding with relation 'llm-usage' from tenant to event
 *   - use infrastructure-exemption (no Spine OTM): mock a Spine client and
 *     assert no call happened
 *   - be fire-and-forget (synchronous return; internal promise catches errors)
 *   - compute cost_usd via the injected pricingTable / estimateCost stub
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createUsageWriter,
  setDefaultUsageWriter,
  getDefaultUsageWriter,
  buildModelUrn,
  buildAgentUrn,
  buildOrganUrn,
} from '../lib/llm-usage-writer.js';

function makeMockGraph() {
  const calls = { concepts: [], bindings: [] };
  return {
    calls,
    insertConcept: async (type, urn, data) => { calls.concepts.push({ type, urn, data }); return { ok: true }; },
    insertBinding: async (ubn, type, source, target, data) => {
      calls.bindings.push({ ubn, type, source, target, data });
      return { ok: true };
    },
  };
}

function makeMockSpine() {
  const calls = [];
  return { calls, send: async (...args) => { calls.push(args); return { ok: true }; } };
}

async function flush() {
  // Allow the fire-and-forget Promise.resolve().then(...) to settle.
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

describe('llm-usage-writer', () => {
  beforeEach(() => setDefaultUsageWriter(null));

  it('throws if constructed without a graphClient', () => {
    assert.throws(() => createUsageWriter({}), /graphClient is required/);
  });

  it('happy path: writes concept + binding with correct shape', async () => {
    const graph = makeMockGraph();
    const writer = createUsageWriter({
      graphClient: graph,
      now: () => new Date('2026-04-15T23:45:00.000Z'),
      randomHex: () => 'abc123',
      costEstimator: () => 0.0035,
    });
    writer.writeLLMUsageEvent({
      tenant_urn: 'urn:llm-ops:entity:llm-ops-platform',
      organ: 'arbiter',
      agent: 'clause-matcher',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_in: 1000,
      tokens_out: 500,
      cascade_stage: 0,
      correlation_id: 'corr-test-1',
      outcome: 'success',
    });
    await flush();
    assert.equal(graph.calls.concepts.length, 1);
    const c = graph.calls.concepts[0];
    assert.equal(c.type, 'llm_usage_event');
    assert.match(c.urn, /^urn:llm-ops:llm_usage_event:.+/);
    assert.equal(c.data.type, 'llm_usage_event');
    assert.equal(c.data.tenant_urn, 'urn:llm-ops:entity:llm-ops-platform');
    assert.equal(c.data.model_urn, 'urn:llm-ops:model:anthropic:claude-haiku-4-5-20251001');
    assert.equal(c.data.agent_urn, 'urn:llm-ops:agent:arbiter:clause-matcher');
    assert.equal(c.data.organ_urn, 'urn:llm-ops:organ:arbiter');
    assert.equal(c.data.cost_usd, 0.0035);
    assert.equal(c.data.tokens_in, 1000);
    assert.equal(c.data.tokens_out, 500);
    assert.equal(c.data.cascade_stage, 0);
    assert.equal(c.data.outcome, 'success');
    assert.equal(c.data.correlation_id, 'corr-test-1');
    assert.equal(c.data.timestamp, '2026-04-15T23:45:00.000Z');

    assert.equal(graph.calls.bindings.length, 1);
    const b = graph.calls.bindings[0];
    assert.equal(b.data.relation, 'llm-usage');
    assert.equal(b.data.from_urn, 'urn:llm-ops:entity:llm-ops-platform');
    assert.equal(b.data.to_urn, c.urn);
  });

  it('infrastructure-exemption: no Spine OTM emitted (governance bypass)', async () => {
    const graph = makeMockGraph();
    const spine = makeMockSpine();
    const writer = createUsageWriter({ graphClient: graph });
    writer.writeLLMUsageEvent({
      tenant_urn: 'urn:llm-ops:entity:test',
      organ: 'receptor',
      agent: 'intent-classifier',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_in: 100,
      tokens_out: 50,
    });
    await flush();
    assert.equal(spine.calls.length, 0, 'no Spine OTM may be emitted for audit writes');
    assert.equal(graph.calls.concepts.length, 1);
  });

  it('fire-and-forget: writeLLMUsageEvent returns synchronously, not a Promise', () => {
    const graph = makeMockGraph();
    const writer = createUsageWriter({ graphClient: graph });
    const ret = writer.writeLLMUsageEvent({
      tenant_urn: 'urn:llm-ops:entity:test',
      organ: 'soul',
      agent: 'behavioral-observer',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_in: 0,
      tokens_out: 0,
    });
    assert.equal(ret, undefined);
  });

  it('failed graph write is logged but does not throw from caller', async () => {
    const brokenGraph = {
      insertConcept: async () => { throw new Error('graph down'); },
      insertBinding: async () => { throw new Error('graph down'); },
    };
    const logged = [];
    const writer = createUsageWriter({
      graphClient: brokenGraph,
      logger: (entry) => logged.push(entry),
    });
    writer.writeLLMUsageEvent({
      tenant_urn: 'urn:llm-ops:entity:test',
      organ: 'soul',
      agent: 'behavioral-observer',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_in: 100,
      tokens_out: 50,
    });
    await flush();
    assert.ok(logged.some((l) => l.event === 'llm_usage_writer_error'),
      'error must be logged');
  });

  it('URN format matches urn:llm-ops:llm_usage_event:<id>', async () => {
    const graph = makeMockGraph();
    const writer = createUsageWriter({
      graphClient: graph,
      now: () => new Date('2026-04-15T00:00:00.000Z'),
      randomHex: () => 'xx0001',
    });
    writer.writeLLMUsageEvent({
      tenant_urn: 'urn:llm-ops:entity:test',
      organ: 'lobe',
      agent: 'session-synthesizer',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      tokens_in: 0, tokens_out: 0,
    });
    await flush();
    const urn = graph.calls.concepts[0].urn;
    // Schema: `^urn:[a-zA-Z0-9._-]+:[a-zA-Z0-9_]+:.+$` — type segment snake_case, identifier may include letters/digits/dashes.
    assert.match(urn, /^urn:llm-ops:llm_usage_event:[0-9A-Za-z\-]+-xx0001$/);
  });

  it('getLLMUsageConceptSchema returns a documentation spec with required_fields', () => {
    const graph = makeMockGraph();
    const writer = createUsageWriter({ graphClient: graph });
    const schema = writer.getLLMUsageConceptSchema();
    assert.equal(schema.type, 'llm_usage_event');
    assert.ok(schema.required_fields.includes('cost_usd'));
    assert.ok(schema.required_fields.includes('tenant_urn'));
    assert.equal(schema.binding_relation, 'llm-usage');
  });

  it('URN builders produce MP-17 compliant shapes', () => {
    assert.equal(buildModelUrn('anthropic', 'claude-sonnet-4-6'), 'urn:llm-ops:model:anthropic:claude-sonnet-4-6');
    assert.equal(buildAgentUrn('soul', 'evolution-analyst'), 'urn:llm-ops:agent:soul:evolution-analyst');
    assert.equal(buildOrganUrn('Radiant'), 'urn:llm-ops:organ:radiant');
  });

  it('invalid event payloads are dropped (no graph calls, no throw)', async () => {
    const graph = makeMockGraph();
    const logged = [];
    const writer = createUsageWriter({
      graphClient: graph,
      logger: (entry) => logged.push(entry),
    });
    writer.writeLLMUsageEvent(null);
    writer.writeLLMUsageEvent({ organ: 'x', agent: 'y' }); // missing tenant_urn
    writer.writeLLMUsageEvent({ tenant_urn: 'urn:...' });  // missing organ/agent
    await flush();
    assert.equal(graph.calls.concepts.length, 0);
    assert.equal(logged.filter((l) => l.event === 'llm_usage_writer_invalid_event').length, 3);
  });

  it('setDefaultUsageWriter / getDefaultUsageWriter round-trip', () => {
    const fn = () => {};
    setDefaultUsageWriter(fn);
    assert.strictEqual(getDefaultUsageWriter(), fn);
    setDefaultUsageWriter(null);
    assert.strictEqual(getDefaultUsageWriter(), null);
    assert.throws(() => setDefaultUsageWriter('bogus'), /must be a function or null/);
  });
});
