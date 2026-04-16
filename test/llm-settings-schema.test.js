/**
 * Unit tests for llm-settings-schema.js — MP-CONFIG-1 relay l9m-1.
 *
 * Coverage:
 *   - Positive fixtures (probabilistic + standalone + thinking + fallback + tenant_urn)
 *   - Negative fixtures (D10 schema_version, D11 model regex, D12 standalone leak,
 *     unknown fields, invalid provider, non-positive max_tokens)
 *   - D4 (CASCADE_FAILURE_CLASSES) — 7 classes per-class membership
 *   - D5 (FAIL_CLOSED_CLASSES) — 4 classes per-class membership
 *   - D11 family-aware acceptance (haiku dated, sonnet bare, opus bare) + drift detection
 *   - All 6 retrofit files parse + validate from disk
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  validateSettings,
  CASCADE_FAILURE_CLASSES,
  FAIL_CLOSED_CLASSES,
  PROVIDER_CLASSES,
  ANTHROPIC_MODEL_REGEX,
  DEFAULT_TENANT_URN,
  LLM_SETTINGS_SCHEMA_VERSION,
  LLM_SETTINGS_SCHEMA,
} from '../lib/llm-settings-schema.js';
import { LLMSettingsInvalid } from '../lib/llm-errors.js';

const SETTINGS_ROOT = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs';

function load(rel) {
  return readFileSync(join(SETTINGS_ROOT, rel), 'utf8');
}

/**
 * Assert that `fn` throws an LLMSettingsInvalid and return the error so callers
 * can introspect its structured payload.
 */
function expectInvalid(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof LLMSettingsInvalid, `expected LLMSettingsInvalid, got ${err?.constructor?.name}: ${err?.message}`);
    return err;
  }
  assert.fail('expected LLMSettingsInvalid to be thrown');
}

// -------------------------------------------------------------------------
// Positive fixtures (probabilistic)
// -------------------------------------------------------------------------

describe('llm-settings-schema: positive — probabilistic', () => {
  it('validates anthropic + Haiku dated suffix', () => {
    const yaml = `
schema_version: 1
organ: arbiter
provider: anthropic
model: claude-haiku-4-5-20251001
max_tokens: 2048
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates anthropic + Sonnet bare alias (D11 per-family canonical)', () => {
    const yaml = `
schema_version: 1
organ: nomos
provider: anthropic
model: claude-sonnet-4-6
max_tokens: 2048
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates anthropic + Opus bare alias', () => {
    const yaml = `
schema_version: 1
organ: cortex
provider: anthropic
model: claude-opus-4-6
max_tokens: 4096
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates openai-compatible (pass-through model)', () => {
    const yaml = `
schema_version: 1
organ: cortex
provider: openai-compatible
model: Qwen2.5-32B-Instruct-AWQ
max_tokens: 4096
deployment_target: gpu-host-01:8000
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates probabilistic with thinking block (D9)', () => {
    const yaml = `
schema_version: 1
organ: soul
provider: anthropic
model: claude-sonnet-4-6
max_tokens: 4096
thinking:
  enabled: true
  budget_tokens: 10000
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates probabilistic with fallback cascade', () => {
    const yaml = `
schema_version: 1
organ: cortex
provider: anthropic
model: claude-sonnet-4-6
max_tokens: 4096
fallback:
  - provider: openai-compatible
    model: Qwen2.5-32B-Instruct-AWQ
    max_tokens: 4096
    deployment_target: gpu-host-01:8000
  - provider: anthropic
    model: claude-haiku-4-5-20251001
    max_tokens: 2048
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates probabilistic with tenant_urn (MP-17 §10 #35 vocabulary)', () => {
    const yaml = `
schema_version: 1
organ: nomos
provider: anthropic
model: claude-sonnet-4-6
max_tokens: 2048
tenant_urn: urn:llm-ops:entity:graphheight
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });
});

// -------------------------------------------------------------------------
// Positive fixtures (standalone, D12)
// -------------------------------------------------------------------------

describe('llm-settings-schema: positive — standalone (D12)', () => {
  it('validates Syntra-shape standalone', () => {
    const yaml = `
schema_version: 1
organ: syntra
llm_required: false
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });

  it('validates standalone with tenant_urn permitted', () => {
    const yaml = `
schema_version: 1
organ: vectr
llm_required: false
tenant_urn: urn:llm-ops:entity:llm-ops-platform
`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });
});

// -------------------------------------------------------------------------
// Negative fixtures
// -------------------------------------------------------------------------

describe('llm-settings-schema: negative — D10 schema_version', () => {
  it('rejects missing schema_version', () => {
    const yaml = `organ: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'schema_version');
    assert.match(err.reason, /schema_version/);
  });

  it('rejects mismatched schema_version: 2', () => {
    const yaml = `schema_version: 2\norgan: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'schema_version');
    assert.equal(err.actual_value, 2);
  });
});

describe('llm-settings-schema: negative — unknown / invalid fields', () => {
  it('rejects truly unknown top-level field (typo)', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 2048\nfoo: bar\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'foo');
    assert.match(err.reason, /unknown top-level field/);
  });

  it('rejects invalid provider string', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: bedrock\nmodel: x\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'provider');
  });

  it('rejects non-positive max_tokens', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 0\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'max_tokens');
  });

  it('rejects null model on probabilistic', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: null\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'model');
  });
});

describe('llm-settings-schema: negative — D11 anthropic model regex', () => {
  it('rejects anthropic model not matching family pattern', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: gpt-4\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'model');
    assert.match(err.reason, /D11/);
  });

  it('rejects anthropic Haiku model with wrong date format (6 digits not 8)', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-251001\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'model');
  });

  it('rejects anthropic with unknown family (claude-pro)', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: claude-pro-1-0\nmax_tokens: 2048\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'model');
  });

  it('accepts openai-compatible with arbitrary model (pass-through)', () => {
    const yaml = `schema_version: 1\norgan: cortex\nprovider: openai-compatible\nmodel: anything-goes/here_v1\nmax_tokens: 2048\n`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });
});

describe('llm-settings-schema: negative — D12 standalone discipline', () => {
  it('rejects llm_required:false with stray model field', () => {
    const yaml = `schema_version: 1\norgan: syntra\nllm_required: false\nmodel: claude-haiku-4-5-20251001\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'model');
    assert.match(err.reason, /standalone; no LLM fields permitted/);
  });

  it('rejects llm_required:false with stray provider field', () => {
    const yaml = `schema_version: 1\norgan: syntra\nllm_required: false\nprovider: anthropic\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'provider');
  });

  it('rejects llm_required:false with stray fallback array', () => {
    const yaml = `schema_version: 1\norgan: syntra\nllm_required: false\nfallback: []\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'fallback');
  });

  it('rejects llm_required:false with stray thinking block', () => {
    const yaml = `schema_version: 1\norgan: syntra\nllm_required: false\nthinking: { enabled: true }\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'thinking');
  });
});

describe('llm-settings-schema: negative — tenant_urn vocabulary', () => {
  it('rejects tenant_urn with wrong namespace (tenant: not entity:)', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 2048\ntenant_urn: urn:llm-ops:tenant:platform\n`;
    const err = expectInvalid(() => validateSettings(yaml, 'fixture'));
    assert.equal(err.field, 'tenant_urn');
  });
});

// -------------------------------------------------------------------------
// D4 / D5 classification arrays
// -------------------------------------------------------------------------

describe('llm-settings-schema: D4 CASCADE_FAILURE_CLASSES', () => {
  const expected = [
    'connection_refused',
    'connection_timeout',
    'http_5xx',
    'http_503',
    'http_429',
    'model_not_loaded',
    'timeout_during_streaming',
  ];
  for (const cls of expected) {
    it(`includes ${cls}`, () => {
      assert.ok(CASCADE_FAILURE_CLASSES.includes(cls));
    });
  }
  it('is exactly 7 classes, frozen', () => {
    assert.equal(CASCADE_FAILURE_CLASSES.length, 7);
    assert.ok(Object.isFrozen(CASCADE_FAILURE_CLASSES));
  });
});

describe('llm-settings-schema: D5 FAIL_CLOSED_CLASSES', () => {
  const expected = [
    'http_4xx',
    'parse_error',
    'context_length_exceeded',
    'content_filter_triggered',
  ];
  for (const cls of expected) {
    it(`includes ${cls}`, () => {
      assert.ok(FAIL_CLOSED_CLASSES.includes(cls));
    });
  }
  it('is exactly 4 classes, frozen', () => {
    assert.equal(FAIL_CLOSED_CLASSES.length, 4);
    assert.ok(Object.isFrozen(FAIL_CLOSED_CLASSES));
  });
});

// -------------------------------------------------------------------------
// Constants surface
// -------------------------------------------------------------------------

describe('llm-settings-schema: constants surface', () => {
  it('LLM_SETTINGS_SCHEMA_VERSION === 1', () => {
    assert.equal(LLM_SETTINGS_SCHEMA_VERSION, 1);
  });
  it('PROVIDER_CLASSES is the closed D3 enum', () => {
    assert.deepEqual([...PROVIDER_CLASSES], [
      'anthropic',
      'openai-compatible',
      'huggingface-autoprovision',
    ]);
    assert.ok(Object.isFrozen(PROVIDER_CLASSES));
  });
  it('DEFAULT_TENANT_URN matches MP-17 §10 #35 vocabulary', () => {
    assert.equal(DEFAULT_TENANT_URN, 'urn:llm-ops:entity:llm-ops-platform');
  });
  it('ANTHROPIC_MODEL_REGEX accepts canonical per-family forms', () => {
    assert.ok(ANTHROPIC_MODEL_REGEX.test('claude-haiku-4-5-20251001'));
    assert.ok(ANTHROPIC_MODEL_REGEX.test('claude-sonnet-4-6'));
    assert.ok(ANTHROPIC_MODEL_REGEX.test('claude-opus-4-6'));
    assert.ok(!ANTHROPIC_MODEL_REGEX.test('gpt-4'));
    assert.ok(!ANTHROPIC_MODEL_REGEX.test('claude-pro-1-0'));
  });
  it('LLM_SETTINGS_SCHEMA is frozen', () => {
    assert.ok(Object.isFrozen(LLM_SETTINGS_SCHEMA));
  });
});

// -------------------------------------------------------------------------
// Retrofit files parse + validate from disk
// -------------------------------------------------------------------------

describe('llm-settings-schema: retrofit files validate (on-disk)', () => {
  const retrofits = [
    '90-Soul/soul-organ-default-llm-settings.yaml',
    '70-Minder/minder-organ-default-llm-settings.yaml',
    '100-Lobe/lobe-organ-default-llm-settings.yaml',
    '80-Hippocampus/hippocampus-organ-default-llm-settings.yaml',
    '200-Nomos/nomos-organ-default-llm-settings.yaml',
    '250-Receptor/receptor-organ-default-llm-settings.yaml',
    '250-Receptor/receptor-organ-intent-classifier-llm-settings.yaml',
    '110-Syntra/syntra-organ-default-llm-settings.yaml',
  ];
  for (const rel of retrofits) {
    it(`validates ${rel}`, () => {
      const text = load(rel);
      const config = validateSettings(text, rel);
      assert.equal(config.schema_version, 1);
    });
  }
});

describe('llm-settings-schema: D11 Receptor before/after retrofit', () => {
  it('rejects pre-retrofit Receptor (bare alias) ONLY when family canonical enforcement is required', () => {
    // The validator regex permits the bare alias (per RFI-1 reply).
    // Per-family canonical policy lives in spec doc.
    const yaml = `schema_version: 1\norgan: receptor\nprovider: anthropic\nmodel: claude-haiku-4-5\nmax_tokens: 256\n`;
    assert.ok(validateSettings(yaml, 'fixture')); // permissive at validator layer
  });
  it('accepts post-retrofit Receptor (dated form)', () => {
    const yaml = `schema_version: 1\norgan: receptor\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 256\n`;
    assert.ok(validateSettings(yaml, 'fixture'));
  });
});

// -------------------------------------------------------------------------
// LLMSettingsInvalid payload structure
// -------------------------------------------------------------------------

describe('llm-settings-schema: LLMSettingsInvalid payload', () => {
  it('carries field, expected_pattern, actual_value, reason, filename', () => {
    const yaml = `schema_version: 1\norgan: arbiter\nprovider: bedrock\nmodel: x\nmax_tokens: 2048\n`;
    try {
      validateSettings(yaml, 'fixture');
      assert.fail('should have thrown');
    } catch (err) {
      assert.ok(err instanceof LLMSettingsInvalid);
      assert.equal(err.code, 'LLM_SETTINGS_INVALID');
      assert.equal(err.name, 'LLMSettingsInvalid');
      assert.equal(err.field, 'provider');
      assert.equal(err.actual_value, 'bedrock');
      assert.equal(err.filename, 'fixture');
      assert.ok(err.reason);
    }
  });
});

// -------------------------------------------------------------------------
// R10 amendment — huggingface_autoprovision block
// -------------------------------------------------------------------------

describe('llm-settings-schema: R10 huggingface_autoprovision block', () => {
  const base = {
    schema_version: 1,
    organ: 'cortex',
    llm_required: true,
    provider: 'huggingface-autoprovision',
    model: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
    max_tokens: 4096,
    deployment_target: 'localhost:8000',
    huggingface_autoprovision: {
      repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      revision: 'v1.0.0',
      quantization: 'awq',
    },
  };

  it('accepts a valid huggingface-autoprovision settings block', () => {
    assert.doesNotThrow(() => validateSettings({ ...base }, 'hf-ok.yaml'));
  });

  it('rejects revision: "main" as un-pinned', () => {
    const cfg = { ...base, huggingface_autoprovision: { ...base.huggingface_autoprovision, revision: 'main' } };
    assert.throws(
      () => validateSettings(cfg, 'hf-unpinned.yaml'),
      (err) =>
        err instanceof LLMSettingsInvalid &&
        err.field === 'huggingface_autoprovision.revision' &&
        /un-pinned/.test(err.reason),
    );
  });

  it('requires huggingface_autoprovision block when provider is huggingface-autoprovision', () => {
    const cfg = { ...base };
    delete cfg.huggingface_autoprovision;
    assert.throws(
      () => validateSettings(cfg, 'hf-missing.yaml'),
      (err) => err instanceof LLMSettingsInvalid && err.field === 'huggingface_autoprovision',
    );
  });

  it('rejects unknown quantization', () => {
    const cfg = {
      ...base,
      huggingface_autoprovision: { ...base.huggingface_autoprovision, quantization: 'int8' },
    };
    assert.throws(
      () => validateSettings(cfg, 'hf-badquant.yaml'),
      (err) => err.field === 'huggingface_autoprovision.quantization',
    );
  });
});
