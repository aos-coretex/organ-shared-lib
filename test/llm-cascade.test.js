/**
 * Unit tests for llm-cascade.js — MP-CONFIG-1 relay l9m-4.
 *
 * Coverage:
 *   - Per D4 class (7) — primary throws, fallback[0] succeeds → result from fallback
 *   - Per D5 class (4) — primary throws → LLMCascadeExhausted immediately, reason: fail_closed
 *   - Multi-stage success at stage 2 (3-element cascade)
 *   - Terminal exhaustion (all stages throw D4)
 *   - No fallback configured + primary D4-fails → exhausted with attempted.length === 1
 *   - Unknown classification → fail-closed
 *   - cascade_total_timeout_ms expiry
 *   - Diagnostic payload completeness (provider, model, error_class, error_message, elapsed_ms)
 *   - Field inheritance (fallback partial config inherits from primary)
 *   - Signature pin: cascade chat(messages, options) matches llm.chat positional
 *   - Loader integration: resolveWithCascade returns {config, chat}
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createCascadeChat,
  buildFallbackStageConfig,
} from '../lib/llm-cascade.js';
import { LLMCascadeExhausted } from '../lib/llm-errors.js';
import { createLoader } from '../lib/llm-settings-loader.js';

// ---------------------------------------------------------------------------
// Helpers — fake client factory + classifier
// ---------------------------------------------------------------------------

/**
 * Build a stub createLLMClient that returns scripted responses per stage.
 * `script` is an array, one entry per construction call:
 *   { mode: 'success', payload: {...} }   // chat() resolves with payload
 *   { mode: 'throw',   error: new Error() } // chat() rejects with this error
 *   { mode: 'delay',   ms: 100, then: '...' } // chat() delays then performs `then` action
 */
function makeFakeClientFactory(script) {
  let constructionIdx = 0;
  const constructed = [];
  const factory = (cfg) => {
    const i = constructionIdx++;
    const step = script[i];
    constructed.push({ cfg, step });
    return {
      chat: async () => {
        if (!step) throw new Error(`no script entry for client #${i}`);
        if (step.mode === 'delay') {
          await new Promise((r) => setTimeout(r, step.ms));
          if (step.then === 'success') return step.payload || { content: 'ok' };
          if (step.then === 'throw') throw step.error || new Error('post-delay');
        }
        if (step.mode === 'success') return step.payload || { content: 'ok' };
        if (step.mode === 'throw') throw step.error || new Error('script throw');
        throw new Error(`unknown step mode: ${step.mode}`);
      },
      isAvailable: () => true,
      getUsage: () => ({}),
    };
  };
  factory.constructed = constructed;
  return factory;
}

/** Build a stub classifier that returns the named class for every call. */
function makeStaticClassifier(className, fallbackEligible) {
  return () => ({ class: className, fallback_eligible: fallbackEligible });
}

const PRIMARY_CONFIG_BASE = {
  agentName: 'test-agent',
  organ: 'cortex',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-sonnet-4-6',
  maxTokens: 2048,
  apiKeyEnvVar: 'TEST_KEY',
  tenant_urn: 'urn:llm-ops:entity:llm-ops-platform',
};

function configWithFallback(fallback) {
  return { ...PRIMARY_CONFIG_BASE, fallback };
}

// ---------------------------------------------------------------------------
// D4 — cascade-eligible classes (7)
// ---------------------------------------------------------------------------

const D4_CLASSES = [
  'connection_refused',
  'connection_timeout',
  'http_5xx',
  'http_503',
  'http_429',
  'model_not_loaded',
  'timeout_during_streaming',
];

describe('llm-cascade: D4 cascade-eligible classes', () => {
  for (const cls of D4_CLASSES) {
    it(`primary throws ${cls} → fallback[0] succeeds → cascade returns fallback result`, async () => {
      const factory = makeFakeClientFactory([
        { mode: 'throw', error: new Error('primary failed') },
        { mode: 'success', payload: { content: 'from-fallback', model: 'qwen' } },
      ]);
      const cfg = configWithFallback([
        { provider: 'openai-compatible', model: 'qwen', max_tokens: 2048, deployment_target: 'gpu:8000' },
      ]);
      const cascade = createCascadeChat(cfg, {
        _clientFactory: factory,
        _classifier: makeStaticClassifier(cls, true),
      });
      const result = await cascade.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(result.content, 'from-fallback');
      // 2 clients constructed (primary + 1 fallback), 1 attempted entry recorded.
      assert.equal(factory.constructed.length, 2);
    });
  }
});

// ---------------------------------------------------------------------------
// D5 — fail-closed classes (4)
// ---------------------------------------------------------------------------

const D5_CLASSES = [
  'http_4xx',
  'parse_error',
  'context_length_exceeded',
  'content_filter_triggered',
];

describe('llm-cascade: D5 fail-closed classes', () => {
  for (const cls of D5_CLASSES) {
    it(`primary throws ${cls} → LLMCascadeExhausted immediately (no fallback attempted)`, async () => {
      const factory = makeFakeClientFactory([
        { mode: 'throw', error: new Error(`primary ${cls}`) },
        { mode: 'success', payload: { content: 'should-not-reach' } },
      ]);
      const cfg = configWithFallback([
        { provider: 'openai-compatible', model: 'qwen', max_tokens: 2048, deployment_target: 'gpu:8000' },
      ]);
      const cascade = createCascadeChat(cfg, {
        _clientFactory: factory,
        _classifier: makeStaticClassifier(cls, false),
      });
      let thrown;
      try {
        await cascade.chat([{ role: 'user', content: 'hi' }]);
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown instanceof LLMCascadeExhausted);
      assert.equal(thrown.attempted.length, 1);
      assert.equal(thrown.attempted[0].error_class, cls);
    });
  }
});

// ---------------------------------------------------------------------------
// Multi-stage cascade
// ---------------------------------------------------------------------------

describe('llm-cascade: multi-stage success at stage 2', () => {
  it('primary D4-fails, fallback[0] D4-fails, fallback[1] succeeds', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('primary http_5xx') },
      { mode: 'throw', error: new Error('stage-1 connection_refused') },
      { mode: 'success', payload: { content: 'stage-2-success' } },
    ]);
    const cfg = configWithFallback([
      { provider: 'openai-compatible', model: 'qwen-a', max_tokens: 2048, deployment_target: 'gpu:8000' },
      { provider: 'openai-compatible', model: 'qwen-b', max_tokens: 2048, deployment_target: 'gpu:8001' },
    ]);
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_5xx', true),
    });
    const result = await cascade.chat([{ role: 'user', content: 'hi' }]);
    assert.equal(result.content, 'stage-2-success');
    assert.equal(factory.constructed.length, 3);
  });
});

describe('llm-cascade: terminal exhaustion (all stages throw D4)', () => {
  it('raises LLMCascadeExhausted with attempted.length === stage count', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('primary') },
      { mode: 'throw', error: new Error('stage-1') },
      { mode: 'throw', error: new Error('stage-2') },
    ]);
    const cfg = configWithFallback([
      { provider: 'openai-compatible', model: 'qwen-a', max_tokens: 2048, deployment_target: 'gpu:8000' },
      { provider: 'openai-compatible', model: 'qwen-b', max_tokens: 2048, deployment_target: 'gpu:8001' },
    ]);
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_5xx', true),
    });
    let thrown;
    try {
      await cascade.chat([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof LLMCascadeExhausted);
    assert.equal(thrown.attempted.length, 3);
    for (const a of thrown.attempted) {
      assert.equal(a.error_class, 'http_5xx');
    }
  });
});

describe('llm-cascade: no fallback configured + primary D4-fails', () => {
  it('raises LLMCascadeExhausted with attempted.length === 1', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('primary http_503') },
    ]);
    const cfg = { ...PRIMARY_CONFIG_BASE }; // no fallback
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_503', true),
    });
    let thrown;
    try {
      await cascade.chat([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof LLMCascadeExhausted);
    assert.equal(thrown.attempted.length, 1);
    assert.equal(thrown.attempted[0].error_class, 'http_503');
  });
});

describe('llm-cascade: unknown classification treated as fail-closed', () => {
  it('classifier returns class:unknown, fallback_eligible:false → exhausted immediately', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('weird error') },
      { mode: 'success', payload: { content: 'should-not-reach' } },
    ]);
    const cfg = configWithFallback([
      { provider: 'openai-compatible', model: 'qwen', max_tokens: 2048, deployment_target: 'gpu:8000' },
    ]);
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('unknown', false),
    });
    let thrown;
    try {
      await cascade.chat([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof LLMCascadeExhausted);
    assert.equal(thrown.attempted.length, 1);
    assert.equal(thrown.attempted[0].error_class, 'unknown');
  });
});

// ---------------------------------------------------------------------------
// cascade_total_timeout_ms
// ---------------------------------------------------------------------------

describe('llm-cascade: cascade_total_timeout_ms', () => {
  it('expires mid-cascade, raises LLMCascadeExhausted', async () => {
    const factory = makeFakeClientFactory([
      // Primary takes 200ms then throws — by then total timeout (50ms) has expired.
      { mode: 'delay', ms: 200, then: 'throw', error: new Error('primary slow') },
      { mode: 'success', payload: { content: 'should-not-reach' } },
    ]);
    const cfg = {
      ...PRIMARY_CONFIG_BASE,
      cascade_total_timeout_ms: 50,
      fallback: [
        { provider: 'openai-compatible', model: 'qwen', max_tokens: 2048, deployment_target: 'gpu:8000' },
      ],
    };
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_5xx', true),
    });
    let thrown;
    try {
      await cascade.chat([{ role: 'user', content: 'hi' }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof LLMCascadeExhausted);
    // attempted may be empty if budget expires before any stage records — both are valid.
    // The point: cascade did NOT silently degrade or hang.
  });
});

// ---------------------------------------------------------------------------
// Diagnostic payload completeness
// ---------------------------------------------------------------------------

describe('llm-cascade: diagnostic payload', () => {
  it('every attempted entry has provider/model/error_class/error_message/elapsed_ms', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('p') },
      { mode: 'throw', error: new Error('s1') },
    ]);
    const cfg = configWithFallback([
      { provider: 'openai-compatible', model: 'qwen', max_tokens: 2048, deployment_target: 'gpu:8000' },
    ]);
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_5xx', true),
    });
    let thrown;
    try {
      await cascade.chat([{ role: 'user', content: 'x' }]);
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown instanceof LLMCascadeExhausted);
    assert.equal(thrown.attempted.length, 2);
    for (const a of thrown.attempted) {
      assert.ok(a.provider, 'provider field present');
      assert.ok(a.model, 'model field present');
      assert.equal(a.error_class, 'http_5xx');
      assert.ok(a.error_message, 'error_message field present');
      assert.equal(typeof a.elapsed_ms, 'number');
      assert.ok(a.elapsed_ms >= 0);
    }
    // Stage-0 reports primary's provider/model; stage-1 reports fallback[0]'s.
    assert.equal(thrown.attempted[0].provider, 'anthropic');
    assert.equal(thrown.attempted[0].model, 'claude-sonnet-4-6');
    assert.equal(thrown.attempted[1].provider, 'openai-compatible');
    assert.equal(thrown.attempted[1].model, 'qwen');
  });
});

// ---------------------------------------------------------------------------
// Field inheritance for fallback stages
// ---------------------------------------------------------------------------

describe('llm-cascade: fallback stage field inheritance', () => {
  it('fallback with partial config inherits apiKeyEnvVar + maxTokens from primary', async () => {
    const factory = makeFakeClientFactory([
      { mode: 'throw', error: new Error('p') },
      { mode: 'success', payload: { content: 'ok' } },
    ]);
    const cfg = configWithFallback([
      // Only provider + model + deployment_target — others must inherit.
      { provider: 'openai-compatible', model: 'qwen', deployment_target: 'gpu:8000' },
    ]);
    const cascade = createCascadeChat(cfg, {
      _clientFactory: factory,
      _classifier: makeStaticClassifier('http_5xx', true),
    });
    await cascade.chat([{ role: 'user', content: 'x' }]);
    // Inspect the second client construction (fallback stage).
    const fbConfig = factory.constructed[1].cfg;
    assert.equal(fbConfig.defaultProvider, 'openai-compatible');
    assert.equal(fbConfig.defaultModel, 'qwen');
    assert.equal(fbConfig.maxTokens, 2048, 'inherits primary maxTokens');
    assert.equal(fbConfig.apiKeyEnvVar, 'TEST_KEY', 'inherits primary apiKeyEnvVar');
    assert.equal(fbConfig.baseUrl, 'http://gpu:8000');
    assert.equal(fbConfig.agentName, 'test-agent-stage-1');
  });

  it('buildFallbackStageConfig (exported helper) inherits fields correctly', () => {
    const primary = {
      ...PRIMARY_CONFIG_BASE,
      thinking: true,
      thinkingBudget: 8000,
    };
    const stage = buildFallbackStageConfig(
      primary,
      { provider: 'openai-compatible', model: 'qwen' },
      1,
    );
    assert.equal(stage.defaultProvider, 'openai-compatible');
    assert.equal(stage.defaultModel, 'qwen');
    assert.equal(stage.maxTokens, 2048);
    assert.equal(stage.apiKeyEnvVar, 'TEST_KEY');
    assert.equal(stage.thinking, true);
    assert.equal(stage.thinkingBudget, 8000);
    assert.equal(stage.tenant_urn, 'urn:llm-ops:entity:llm-ops-platform');
    assert.equal(stage.agentName, 'test-agent-stage-1');
  });
});

// ---------------------------------------------------------------------------
// Signature pin
// ---------------------------------------------------------------------------

describe('llm-cascade: signature pin (bug #2)', () => {
  it('cascade.chat(messages, options) matches llm.chat positional signature', async () => {
    const factory = makeFakeClientFactory([{ mode: 'success', payload: { content: 'ok' } }]);
    const cfg = { ...PRIMARY_CONFIG_BASE };
    const cascade = createCascadeChat(cfg, { _clientFactory: factory });
    // Both arities must work:
    const r1 = await cascade.chat([{ role: 'user', content: 'one-arg' }]);
    assert.equal(r1.content, 'ok');
    const factory2 = makeFakeClientFactory([{ mode: 'success', payload: { content: 'ok2' } }]);
    const cascade2 = createCascadeChat(cfg, { _clientFactory: factory2 });
    const r2 = await cascade2.chat(
      [{ role: 'user', content: 'two-arg' }],
      { system: 'sys', temperature: 0.3 },
    );
    assert.equal(r2.content, 'ok2');
  });

  it('rejects standalone (llm_required:false) configs', () => {
    let thrown;
    try {
      createCascadeChat({ llm_required: false, organ: 'syntra' });
    } catch (err) {
      thrown = err;
    }
    assert.ok(thrown);
    assert.match(thrown.message, /standalone|llm_required/i);
  });
});

// ---------------------------------------------------------------------------
// Loader integration — resolveWithCascade
// ---------------------------------------------------------------------------

describe('llm-cascade: loader.resolveWithCascade integration', () => {
  it('returns { config, chat }; chat is the cascade-wrapped function', () => {
    const root = mkdtempSync(join(tmpdir(), 'l9m4-cascade-'));
    try {
      const dir = join(root, '200-Nomos');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'nomos-organ-default-llm-settings.yaml'),
        'schema_version: 1\norgan: nomos\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 2048\n',
      );
      const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
      const { config, chat } = loader.resolveWithCascade();
      assert.equal(config.defaultModel, 'claude-sonnet-4-6');
      assert.equal(typeof chat, 'function');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws when called for a standalone (llm_required:false) organ', () => {
    const root = mkdtempSync(join(tmpdir(), 'l9m4-cascade-'));
    try {
      const dir = join(root, '110-Syntra');
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'syntra-organ-default-llm-settings.yaml'),
        'schema_version: 1\norgan: syntra\nllm_required: false\n',
      );
      const loader = createLoader({ organNumber: 110, organName: 'syntra', settingsRoot: root });
      let thrown;
      try {
        loader.resolveWithCascade();
      } catch (err) {
        thrown = err;
      }
      assert.ok(thrown);
      assert.match(thrown.message, /standalone|llm_required/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
