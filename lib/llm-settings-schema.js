/**
 * LLM settings YAML schema v1 + validator — MP-CONFIG-1 relay l9m-1.
 *
 * Schema convention (mirrors `tool-response-schema.js`): plain JSON Schema-shaped
 * documentation object + throwing validator. No external schema library (no ajv).
 *
 * The validator parses YAML, branches on `llm_required` (D12), and enforces the
 * schema contract per binding decisions D1–D12 (see meta-l9m §3 + relay l9m-1).
 *
 * Exports:
 *   - LLM_SETTINGS_SCHEMA_VERSION   — the integer schema version this module enforces (1)
 *   - validateSettings(parsed, filename) → validatedConfig
 *   - CASCADE_FAILURE_CLASSES        — frozen array of 7 D4 classes (cascade-eligible failures)
 *   - FAIL_CLOSED_CLASSES            — frozen array of 4 D5 classes (fail-closed, no cascade)
 *   - LLM_SETTINGS_SCHEMA            — JSON-Schema-shaped documentation object
 *   - PROVIDER_CLASSES               — frozen array of 3 D3 provider classes
 *   - ANTHROPIC_MODEL_REGEX          — D11 regex (per-family canonical policy in spec doc)
 *
 * Per-family Anthropic canonical policy (RFI-1 reply 2026-04-15, supersedes RFI-2):
 *   - Haiku 4.5  → dated form (`claude-haiku-4-5-20251001`); bare alias is drift
 *   - Sonnet 4.6 → bare form (`claude-sonnet-4-6`); no dated form published
 *   - Opus 4.6   → bare form (`claude-opus-4-6`); no dated form published
 * Validator regex is permissive on dated suffix; per-family canonical table lives in spec doc.
 *
 * Deprecated documentation fields (skeleton-era; permitted-but-ignored at runtime):
 *   `agent`, `api_key_path`, `temperature`, `notes`, `runtime_source_file`
 * These passed through repair-platform-01's documentation-only skeleton. The validator
 * accepts them so existing 48 YAMLs need only `schema_version: 1` added (D10 mandatory).
 * Loader (R3) ignores them. Future repair may strip them after R5/R6/R7 close.
 */

import yaml from 'js-yaml';
import { LLMSettingsInvalid } from './llm-errors.js';

export const LLM_SETTINGS_SCHEMA_VERSION = 1;

/** D3 — three provider classes (frozen). */
export const PROVIDER_CLASSES = Object.freeze([
  'anthropic',
  'openai-compatible',
  'huggingface-autoprovision',
]);

/** D4 — 7 failure classes that trigger cascade fallback (frozen). */
export const CASCADE_FAILURE_CLASSES = Object.freeze([
  'connection_refused',
  'connection_timeout',
  'http_5xx',
  'http_503',
  'http_429',
  'model_not_loaded',
  'timeout_during_streaming',
]);

/** D5 — 4 failure classes that fail-close (no fallback). */
export const FAIL_CLOSED_CLASSES = Object.freeze([
  'http_4xx',
  'parse_error',
  'context_length_exceeded',
  'content_filter_triggered',
]);

/**
 * D11 — Anthropic model-string regex. Permissive on dated suffix per RFI-1 reply
 * (Sonnet 4.6 / Opus 4.6 publish only the bare form; Haiku 4.5 publishes both
 * with the dated form being canonical). Per-family canonical policy is enforced
 * by the spec doc's table, not by this regex.
 */
export const ANTHROPIC_MODEL_REGEX = /^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$/;

/** Default tenant URN — matches MP-17 §10 Decision #35 vocabulary verbatim. */
export const DEFAULT_TENANT_URN = 'urn:llm-ops:entity:llm-ops-platform';

/** Schema-canonical fields per branch. */
const STANDALONE_REQUIRED = Object.freeze(['schema_version', 'organ', 'llm_required']);
const STANDALONE_PERMITTED = Object.freeze([
  'schema_version',
  'organ',
  'llm_required',
  'tenant_urn',
]);

const PROBABILISTIC_REQUIRED = Object.freeze([
  'schema_version',
  'organ',
  'provider',
  'model',
  'max_tokens',
]);
const PROBABILISTIC_PERMITTED = Object.freeze([
  'schema_version',
  'organ',
  'llm_required',
  'provider',
  'model',
  'max_tokens',
  'fallback',
  'thinking',
  'deployment_target',
  'api_key_env_var',
  'tenant_urn',
  'huggingface_autoprovision',
]);

/** D3 — accepted quantization labels (R10 amendment). bf16/fp16 are raw precision → `none`. */
export const HF_QUANTIZATION_CLASSES = Object.freeze(['awq', 'gptq', 'none']);

/**
 * Deprecated documentation fields from the repair-platform-01 skeleton. These
 * are accepted by the validator (so the existing 48 YAMLs only need `schema_version`
 * added) but carry no runtime semantics. Future repair may strip them.
 */
const DEPRECATED_DOC_FIELDS = Object.freeze([
  'agent',
  'api_key_path',
  'temperature',
  'notes',
  'runtime_source_file',
]);

/**
 * JSON-Schema-shaped documentation object. Not used internally for validation
 * (no ajv); exported for external tooling, the spec doc, and R11 contract author.
 */
export const LLM_SETTINGS_SCHEMA = Object.freeze({
  $id: 'https://coretex.llm-ops/schemas/llm-settings/1',
  title: 'LLM settings YAML schema v1',
  type: 'object',
  required: ['schema_version', 'organ'],
  properties: {
    schema_version: { const: LLM_SETTINGS_SCHEMA_VERSION },
    organ: { type: 'string', minLength: 1 },
    llm_required: { type: 'boolean' },
    provider: { enum: [...PROVIDER_CLASSES] },
    model: { type: 'string', minLength: 1 },
    max_tokens: { type: 'integer', minimum: 1 },
    fallback: {
      type: 'array',
      items: { $ref: '#/definitions/cascade_entry' },
    },
    thinking: {
      type: 'object',
      required: ['enabled'],
      properties: {
        enabled: { type: 'boolean' },
        budget_tokens: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },
    deployment_target: { type: 'string', pattern: '^[^:]+:\\d+$' },
    api_key_env_var: { type: 'string', minLength: 1 },
    tenant_urn: { type: 'string', pattern: '^urn:llm-ops:entity:[a-z0-9-]+$' },
    // Deprecated documentation fields (skeleton-era; ignored at runtime):
    agent: { type: 'string' },
    api_key_path: { type: 'string' },
    temperature: { type: ['number', 'null'] },
    notes: { type: ['string', 'null'] },
    runtime_source_file: { type: 'string' },
  },
  definitions: {
    cascade_entry: {
      type: 'object',
      required: ['provider', 'model'],
      properties: {
        provider: { enum: [...PROVIDER_CLASSES] },
        model: { type: 'string', minLength: 1 },
        max_tokens: { type: 'integer', minimum: 1 },
        thinking: { $ref: '#/properties/thinking' },
        deployment_target: { type: 'string', pattern: '^[^:]+:\\d+$' },
        api_key_env_var: { type: 'string', minLength: 1 },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

function fail({ field, expected_pattern, actual_value, reason, filename }) {
  throw new LLMSettingsInvalid({ field, expected_pattern, actual_value, reason, filename });
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkSchemaVersion(parsed, filename) {
  if (parsed.schema_version !== LLM_SETTINGS_SCHEMA_VERSION) {
    fail({
      field: 'schema_version',
      expected_pattern: String(LLM_SETTINGS_SCHEMA_VERSION),
      actual_value: parsed.schema_version,
      reason: 'missing or mismatched schema_version',
      filename,
    });
  }
}

function checkOrgan(parsed, filename) {
  if (typeof parsed.organ !== 'string' || parsed.organ.length === 0) {
    fail({
      field: 'organ',
      expected_pattern: 'non-empty string',
      actual_value: parsed.organ,
      reason: 'missing or empty organ name',
      filename,
    });
  }
}

function checkUnknownFields(parsed, permittedSet, filename) {
  for (const key of Object.keys(parsed)) {
    if (!permittedSet.has(key) && !DEPRECATED_DOC_FIELDS.includes(key)) {
      fail({
        field: key,
        expected_pattern: `one of: ${[...permittedSet].join(', ')}`,
        actual_value: parsed[key],
        reason: `unknown top-level field "${key}"`,
        filename,
      });
    }
  }
}

function checkTenantUrn(value, filename) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^urn:llm-ops:entity:[a-z0-9-]+$/.test(value)) {
    fail({
      field: 'tenant_urn',
      expected_pattern: 'urn:llm-ops:entity:<name>',
      actual_value: value,
      reason: 'tenant_urn must match MP-17 §10 #35 vocabulary',
      filename,
    });
  }
}

function checkProvider(value, filename) {
  if (!PROVIDER_CLASSES.includes(value)) {
    fail({
      field: 'provider',
      expected_pattern: PROVIDER_CLASSES.join('|'),
      actual_value: value,
      reason: 'provider must be one of the 3 D3 classes',
      filename,
    });
  }
}

function checkModel(value, provider, filename) {
  if (typeof value !== 'string' || value.length === 0) {
    fail({
      field: 'model',
      expected_pattern: 'non-empty string',
      actual_value: value,
      reason: 'model is required and must be a non-empty string',
      filename,
    });
  }
  if (provider === 'anthropic' && !ANTHROPIC_MODEL_REGEX.test(value)) {
    fail({
      field: 'model',
      expected_pattern: ANTHROPIC_MODEL_REGEX.toString(),
      actual_value: value,
      reason: 'anthropic model must match D11 regex (per-family canonical in spec doc)',
      filename,
    });
  }
  // openai-compatible + huggingface-autoprovision: pass-through (D11 + D3).
}

function checkMaxTokens(value, filename) {
  if (!Number.isInteger(value) || value < 1) {
    fail({
      field: 'max_tokens',
      expected_pattern: 'positive integer',
      actual_value: value,
      reason: 'max_tokens must be a positive integer',
      filename,
    });
  }
}

function checkThinking(value, filename) {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    fail({
      field: 'thinking',
      expected_pattern: '{ enabled: bool, budget_tokens?: int }',
      actual_value: value,
      reason: 'thinking must be a plain object',
      filename,
    });
  }
  if (typeof value.enabled !== 'boolean') {
    fail({
      field: 'thinking.enabled',
      expected_pattern: 'boolean',
      actual_value: value.enabled,
      reason: 'thinking.enabled is required and must be boolean',
      filename,
    });
  }
  if (value.budget_tokens !== undefined) {
    if (!Number.isInteger(value.budget_tokens) || value.budget_tokens < 1) {
      fail({
        field: 'thinking.budget_tokens',
        expected_pattern: 'positive integer',
        actual_value: value.budget_tokens,
        reason: 'thinking.budget_tokens must be a positive integer',
        filename,
      });
    }
  }
  for (const key of Object.keys(value)) {
    if (key !== 'enabled' && key !== 'budget_tokens') {
      fail({
        field: `thinking.${key}`,
        expected_pattern: 'enabled|budget_tokens',
        actual_value: value[key],
        reason: `unknown thinking subfield "${key}"`,
        filename,
      });
    }
  }
}

function checkDeploymentTarget(value, filename) {
  if (value === undefined) return;
  if (typeof value !== 'string' || !/^[^:]+:\d+$/.test(value)) {
    fail({
      field: 'deployment_target',
      expected_pattern: 'host:port',
      actual_value: value,
      reason: 'deployment_target must be host:port',
      filename,
    });
  }
}

/**
 * R10 amendment — `huggingface_autoprovision` block validation.
 * Required when `provider: huggingface-autoprovision`; permitted (but unused) otherwise.
 *
 * Sub-schema:
 *   - repo         — non-empty string, must resemble `<org>/<name>`
 *   - revision     — non-empty string; MUST be a pinned reference. `main` and `HEAD`
 *                    are explicitly rejected (meta §5 R10). Accepts SHA-like (>=7 hex)
 *                    or semver-style tags (`v1.2.3`).
 *   - quantization — one of {awq, gptq, none}; bf16/fp16 rejected (not a quantization)
 */
const HF_UNPINNED_REVISIONS = new Set(['main', 'HEAD', 'master', 'head']);
const HF_REVISION_OK_RE = /^([0-9a-f]{7,40}|v?\d+\.\d+(\.\d+)?(-[a-z0-9.-]+)?)$/i;

function checkHFAutoprovision(value, provider, filename) {
  if (value === undefined) {
    if (provider === 'huggingface-autoprovision') {
      fail({
        field: 'huggingface_autoprovision',
        expected_pattern: '{ repo, revision, quantization }',
        actual_value: undefined,
        reason: 'provider=huggingface-autoprovision requires huggingface_autoprovision block',
        filename,
      });
    }
    return;
  }
  if (!isPlainObject(value)) {
    fail({
      field: 'huggingface_autoprovision',
      expected_pattern: '{ repo, revision, quantization }',
      actual_value: value,
      reason: 'huggingface_autoprovision must be a plain object',
      filename,
    });
  }
  const permitted = new Set(['repo', 'revision', 'quantization']);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      fail({
        field: `huggingface_autoprovision.${key}`,
        expected_pattern: [...permitted].join('|'),
        actual_value: value[key],
        reason: `unknown huggingface_autoprovision subfield "${key}"`,
        filename,
      });
    }
  }
  // repo
  if (typeof value.repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(value.repo)) {
    fail({
      field: 'huggingface_autoprovision.repo',
      expected_pattern: '<org>/<name>',
      actual_value: value.repo,
      reason: 'repo must be a HuggingFace "<org>/<name>" identifier',
      filename,
    });
  }
  // revision — pinning enforcement
  if (typeof value.revision !== 'string' || value.revision.length === 0) {
    fail({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'pinned SHA or tag',
      actual_value: value.revision,
      reason: 'revision is required and must be a pinned reference',
      filename,
    });
  }
  if (HF_UNPINNED_REVISIONS.has(value.revision)) {
    fail({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'pinned SHA or tag (not main/HEAD/master)',
      actual_value: value.revision,
      reason: 'un-pinned revisions (main/HEAD/master) are rejected — pin to a SHA or tag',
      filename,
    });
  }
  if (!HF_REVISION_OK_RE.test(value.revision)) {
    fail({
      field: 'huggingface_autoprovision.revision',
      expected_pattern: 'SHA (7-40 hex) or tag (v1.2.3)',
      actual_value: value.revision,
      reason: 'revision must resemble a commit SHA or a release tag',
      filename,
    });
  }
  // quantization
  if (!HF_QUANTIZATION_CLASSES.includes(value.quantization)) {
    fail({
      field: 'huggingface_autoprovision.quantization',
      expected_pattern: HF_QUANTIZATION_CLASSES.join('|'),
      actual_value: value.quantization,
      reason: `quantization must be one of ${HF_QUANTIZATION_CLASSES.join('|')} (bf16/fp16 are raw precision → use "none")`,
      filename,
    });
  }
}

function checkApiKeyEnvVar(value, filename) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length === 0) {
    fail({
      field: 'api_key_env_var',
      expected_pattern: 'non-empty string',
      actual_value: value,
      reason: 'api_key_env_var must be a non-empty string',
      filename,
    });
  }
}

function validateProbabilistic(parsed, filename) {
  // Required fields.
  for (const f of PROBABILISTIC_REQUIRED) {
    if (parsed[f] === undefined) {
      fail({
        field: f,
        expected_pattern: 'present',
        actual_value: undefined,
        reason: `required field "${f}" missing in probabilistic settings`,
        filename,
      });
    }
  }
  checkProvider(parsed.provider, filename);
  checkModel(parsed.model, parsed.provider, filename);
  checkMaxTokens(parsed.max_tokens, filename);
  checkThinking(parsed.thinking, filename);
  checkDeploymentTarget(parsed.deployment_target, filename);
  checkApiKeyEnvVar(parsed.api_key_env_var, filename);
  checkTenantUrn(parsed.tenant_urn, filename);
  checkHFAutoprovision(parsed.huggingface_autoprovision, parsed.provider, filename);

  // Fallback array: each entry is itself a probabilistic-bucket entry MINUS `fallback`
  // (no nested cascades).
  if (parsed.fallback !== undefined) {
    if (!Array.isArray(parsed.fallback)) {
      fail({
        field: 'fallback',
        expected_pattern: 'array of cascade entries',
        actual_value: parsed.fallback,
        reason: 'fallback must be an array',
        filename,
      });
    }
    parsed.fallback.forEach((entry, i) => {
      if (!isPlainObject(entry)) {
        fail({
          field: `fallback[${i}]`,
          expected_pattern: 'plain object',
          actual_value: entry,
          reason: `fallback[${i}] must be a plain object`,
          filename,
        });
      }
      const allowed = new Set([
        'provider',
        'model',
        'max_tokens',
        'thinking',
        'deployment_target',
        'api_key_env_var',
      ]);
      for (const key of Object.keys(entry)) {
        if (!allowed.has(key)) {
          fail({
            field: `fallback[${i}].${key}`,
            expected_pattern: [...allowed].join('|'),
            actual_value: entry[key],
            reason: `unknown fallback subfield "${key}" (no nested fallback permitted)`,
            filename,
          });
        }
      }
      if (entry.provider === undefined || entry.model === undefined) {
        fail({
          field: `fallback[${i}]`,
          expected_pattern: 'provider + model required',
          actual_value: entry,
          reason: `fallback[${i}] requires provider + model`,
          filename,
        });
      }
      checkProvider(entry.provider, filename);
      checkModel(entry.model, entry.provider, filename);
      if (entry.max_tokens !== undefined) checkMaxTokens(entry.max_tokens, filename);
      checkThinking(entry.thinking, filename);
      checkDeploymentTarget(entry.deployment_target, filename);
      checkApiKeyEnvVar(entry.api_key_env_var, filename);
    });
  }

  checkUnknownFields(parsed, new Set(PROBABILISTIC_PERMITTED), filename);
}

function validateStandalone(parsed, filename) {
  // D12 — explicitly reject any LLM-bearing field.
  const llmFields = [
    'model',
    'provider',
    'fallback',
    'thinking',
    'max_tokens',
    'deployment_target',
    'api_key_env_var',
  ];
  for (const f of llmFields) {
    if (parsed[f] !== undefined) {
      fail({
        field: f,
        expected_pattern: 'absent',
        actual_value: parsed[f],
        reason: 'llm_required:false must be standalone; no LLM fields permitted',
        filename,
      });
    }
  }
  checkTenantUrn(parsed.tenant_urn, filename);
  // Required fields already covered by checkOrgan + checkSchemaVersion + the explicit
  // `llm_required: false` discovery; the only remaining policing is unknown-field
  // detection (still permitted: deprecated doc fields).
  checkUnknownFields(parsed, new Set(STANDALONE_PERMITTED), filename);
}

/**
 * Validate a parsed-YAML settings object against schema v1.
 *
 * @param {object|string} input    — parsed YAML (object) OR raw YAML string (will be parsed here)
 * @param {string} filename        — path or filename used in error messages (for grep-friendly diagnostics)
 * @returns {object}               — the validated settings object (same reference if input was already an object)
 * @throws {LLMSettingsInvalid}   on any schema violation
 */
export function validateSettings(input, filename = '<unknown>') {
  let parsed = input;
  if (typeof input === 'string') {
    try {
      parsed = yaml.load(input);
    } catch (err) {
      throw new LLMSettingsInvalid({
        field: '<root>',
        expected_pattern: 'valid YAML',
        actual_value: undefined,
        reason: `YAML parse error: ${err.message}`,
        filename,
      });
    }
  }

  if (!isPlainObject(parsed)) {
    fail({
      field: '<root>',
      expected_pattern: 'plain object (mapping)',
      actual_value: parsed,
      reason: 'top-level YAML must be a mapping',
      filename,
    });
  }

  checkSchemaVersion(parsed, filename);
  checkOrgan(parsed, filename);

  // D12 — branch on llm_required FIRST.
  if (parsed.llm_required === false) {
    validateStandalone(parsed, filename);
    return parsed;
  }
  // llm_required: true OR absent (default to probabilistic).
  if (parsed.llm_required !== undefined && parsed.llm_required !== true) {
    fail({
      field: 'llm_required',
      expected_pattern: 'boolean',
      actual_value: parsed.llm_required,
      reason: 'llm_required must be boolean if present',
      filename,
    });
  }
  validateProbabilistic(parsed, filename);
  return parsed;
}
