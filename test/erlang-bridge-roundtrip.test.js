/**
 * Erlang-ModelBroker bridge round-trip tests — MP-CONFIG-1 relay l9m-11.
 *
 * Exercises ALL 48 LLM settings YAML files under 01-Organs/:
 *   1. Read YAML → parse → export to JSON.
 *   2. Import JSON → emit YAML string → parse → export to JSON again.
 *   3. Assert: the two JSON outputs are byte-identical (JSON.stringify).
 *
 * Plus fuzz cases (extra/missing fields) and contract-version mismatch rejection.
 *
 * Round-trip invariant: export(import(export(A))) === export(A).
 * Comments are NOT preserved (contract policy). Assertion is JSON-level, not YAML-string.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import yaml from 'js-yaml';

import {
  exportSettingsToJSON,
  stableStringify,
  deriveFileKindFromFilename,
  CONTRACT_VERSION,
} from '../lib/erlang-bridge-exporter.js';
import {
  importSettingsFromJSON,
  ContractVersionMismatch,
  InvalidBridgeRecord,
} from '../lib/erlang-bridge-importer.js';
import { LLMSettingsInvalid } from '../lib/llm-errors.js';

const SETTINGS_ROOT = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs';

function* walkSettingsYaml(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkSettingsYaml(full);
    } else if (entry.endsWith('-llm-settings.yaml')) {
      yield full;
    }
  }
}

function parseOrganNumber(filePath) {
  const parts = filePath.split('/');
  for (const part of parts) {
    const m = part.match(/^(\d+)-/);
    if (m) return parseInt(m[1], 10);
  }
  return 0;
}

const allFiles = [...walkSettingsYaml(SETTINGS_ROOT)];

// -------------------------------------------------------------------------
// Round-trip: all 48 YAML files
// -------------------------------------------------------------------------

describe('erlang-bridge: round-trip all 48 settings YAML files', () => {
  for (const filePath of allFiles) {
    const fn = basename(filePath);
    const organNumber = parseOrganNumber(filePath);

    it(`round-trips ${fn}`, () => {
      const rawYaml = readFileSync(filePath, 'utf8');
      const parsed = yaml.load(rawYaml);

      // Pass 1: export.
      const json1 = exportSettingsToJSON({ yamlParsed: parsed, filename: fn, organNumber });
      const str1 = stableStringify(json1);

      // Import back to YAML.
      const yamlOut = importSettingsFromJSON(json1);

      // Parse imported YAML.
      const reparsed = yaml.load(yamlOut);

      // Pass 2: export again.
      const json2 = exportSettingsToJSON({ yamlParsed: reparsed, filename: fn, organNumber });
      const str2 = stableStringify(json2);

      // Assert byte-identity.
      assert.equal(str1, str2, `round-trip mismatch for ${fn}`);
    });
  }

  it(`covers exactly 48 files`, () => {
    assert.equal(allFiles.length, 48, `expected 48 YAML files, found ${allFiles.length}`);
  });
});

// -------------------------------------------------------------------------
// Structural assertions on exported records
// -------------------------------------------------------------------------

describe('erlang-bridge: export structural checks', () => {
  it('probabilistic file has all required fields non-null', () => {
    const yamlParsed = {
      schema_version: 1,
      organ: 'arbiter',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
    };
    const json = exportSettingsToJSON({
      yamlParsed,
      filename: 'arbiter-organ-default-llm-settings.yaml',
      organNumber: 190,
    });
    assert.equal(json.contract_version, 1);
    assert.equal(json.organ_number, 190);
    assert.equal(json.organ_name, 'arbiter');
    assert.equal(json.file_kind, 'default');
    assert.equal(json.agent_name, null);
    assert.equal(json.llm_required, true);
    assert.equal(json.provider, 'anthropic');
    assert.equal(json.model, 'claude-haiku-4-5-20251001');
    assert.equal(json.max_tokens, 2048);
    assert.equal(json.thinking, null);
    assert.equal(json.fallback, null);
    assert.equal(json.deployment_target, null);
    assert.equal(json.api_key_env_var, null);
    assert.equal(json.tenant_urn, null);
    assert.equal(json.huggingface_autoprovision, null);
    assert.equal(json.deprecated_doc_fields, null);
  });

  it('standalone file nulls all LLM fields', () => {
    const yamlParsed = {
      schema_version: 1,
      organ: 'syntra',
      llm_required: false,
    };
    const json = exportSettingsToJSON({
      yamlParsed,
      filename: 'syntra-organ-default-llm-settings.yaml',
      organNumber: 110,
    });
    assert.equal(json.llm_required, false);
    assert.equal(json.provider, null);
    assert.equal(json.model, null);
    assert.equal(json.max_tokens, null);
    assert.equal(json.thinking, null);
  });

  it('thinking block normalizes to {enabled, budget_tokens}', () => {
    const yamlParsed = {
      schema_version: 1,
      organ: 'soul',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      thinking: { enabled: true, budget_tokens: 10000 },
    };
    const json = exportSettingsToJSON({
      yamlParsed,
      filename: 'soul-organ-evolution-analyst-llm-settings.yaml',
      organNumber: 90,
    });
    assert.deepEqual(json.thinking, { enabled: true, budget_tokens: 10000 });
    assert.equal(json.file_kind, 'agent');
    assert.equal(json.agent_name, 'evolution-analyst');
  });

  it('deprecated doc fields collected into sub-object', () => {
    const yamlParsed = {
      schema_version: 1,
      organ: 'arbiter',
      agent: 'clause-matcher',
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      api_key_path: '140-API-keys/10-api-keys-anthropic/190-api-key-organ-arbiter',
      temperature: null,
      notes: 'test notes',
      runtime_source_file: 'test.js:1',
    };
    const json = exportSettingsToJSON({
      yamlParsed,
      filename: 'arbiter-organ-clause-matcher-llm-settings.yaml',
      organNumber: 190,
    });
    assert.ok(json.deprecated_doc_fields);
    assert.equal(json.deprecated_doc_fields.agent, 'clause-matcher');
    assert.equal(json.deprecated_doc_fields.api_key_path, '140-API-keys/10-api-keys-anthropic/190-api-key-organ-arbiter');
    assert.equal(json.deprecated_doc_fields.temperature, null);
    assert.equal(json.deprecated_doc_fields.notes, 'test notes');
    assert.equal(json.deprecated_doc_fields.runtime_source_file, 'test.js:1');
  });

  it('HF autoprovision block preserved', () => {
    const yamlParsed = {
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
    const json = exportSettingsToJSON({
      yamlParsed,
      filename: 'cortex-organ-default-llm-settings.yaml',
      organNumber: 225,
    });
    assert.deepEqual(json.huggingface_autoprovision, {
      repo: 'Qwen/Qwen2.5-32B-Instruct-AWQ',
      revision: 'v1.0.0',
      quantization: 'awq',
    });
    assert.equal(json.deployment_target, 'localhost:8000');
  });
});

// -------------------------------------------------------------------------
// deriveFileKindFromFilename
// -------------------------------------------------------------------------

describe('erlang-bridge: deriveFileKindFromFilename', () => {
  it('default file', () => {
    const r = deriveFileKindFromFilename('arbiter-organ-default-llm-settings.yaml');
    assert.equal(r.file_kind, 'default');
    assert.equal(r.agent_name, null);
  });

  it('agent file', () => {
    const r = deriveFileKindFromFilename('arbiter-organ-clause-matcher-llm-settings.yaml');
    assert.equal(r.file_kind, 'agent');
    assert.equal(r.agent_name, 'clause-matcher');
  });

  it('multi-hyphen agent name', () => {
    const r = deriveFileKindFromFilename('senate-organ-senate-supremacy-validator-llm-settings.yaml');
    assert.equal(r.file_kind, 'agent');
    assert.equal(r.agent_name, 'senate-supremacy-validator');
  });
});

// -------------------------------------------------------------------------
// Import structural checks
// -------------------------------------------------------------------------

describe('erlang-bridge: import structural checks', () => {
  it('standalone import omits LLM fields', () => {
    const record = {
      contract_version: 1,
      schema_version: 1,
      organ_number: 110,
      organ_name: 'syntra',
      file_kind: 'default',
      agent_name: null,
      llm_required: false,
      provider: null,
      model: null,
      max_tokens: null,
      thinking: null,
      fallback: null,
      deployment_target: null,
      api_key_env_var: null,
      tenant_urn: null,
      huggingface_autoprovision: null,
      deprecated_doc_fields: null,
    };
    const yamlStr = importSettingsFromJSON(record);
    const parsed = yaml.load(yamlStr);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.organ, 'syntra');
    assert.equal(parsed.llm_required, false);
    assert.equal(parsed.provider, undefined);
    assert.equal(parsed.model, undefined);
  });

  it('probabilistic import includes provider/model/max_tokens', () => {
    const record = {
      contract_version: 1,
      schema_version: 1,
      organ_number: 190,
      organ_name: 'arbiter',
      file_kind: 'default',
      agent_name: null,
      llm_required: true,
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048,
      thinking: null,
      fallback: null,
      deployment_target: null,
      api_key_env_var: null,
      tenant_urn: null,
      huggingface_autoprovision: null,
      deprecated_doc_fields: null,
    };
    const yamlStr = importSettingsFromJSON(record);
    const parsed = yaml.load(yamlStr);
    assert.equal(parsed.provider, 'anthropic');
    assert.equal(parsed.model, 'claude-haiku-4-5-20251001');
    assert.equal(parsed.max_tokens, 2048);
  });

  it('deprecated fields expand back to top-level YAML', () => {
    const record = {
      contract_version: 1, schema_version: 1, organ_number: 190,
      organ_name: 'arbiter', file_kind: 'agent', agent_name: 'clause-matcher',
      llm_required: true, provider: 'anthropic', model: 'claude-haiku-4-5-20251001',
      max_tokens: 2048, thinking: null, fallback: null, deployment_target: null,
      api_key_env_var: null, tenant_urn: null, huggingface_autoprovision: null,
      deprecated_doc_fields: { agent: 'clause-matcher', api_key_path: 'k', temperature: null, notes: 'n', runtime_source_file: 'f' },
    };
    const yamlStr = importSettingsFromJSON(record);
    const parsed = yaml.load(yamlStr);
    assert.equal(parsed.agent, 'clause-matcher');
    assert.equal(parsed.api_key_path, 'k');
    assert.equal(parsed.temperature, null);
    assert.equal(parsed.notes, 'n');
    assert.equal(parsed.runtime_source_file, 'f');
  });
});

// -------------------------------------------------------------------------
// Contract-version mismatch rejection
// -------------------------------------------------------------------------

describe('erlang-bridge: contract-version mismatch', () => {
  const base = {
    schema_version: 1, organ_number: 10, organ_name: 'test',
    file_kind: 'default', agent_name: null, llm_required: false,
    provider: null, model: null, max_tokens: null, thinking: null,
    fallback: null, deployment_target: null, api_key_env_var: null,
    tenant_urn: null, huggingface_autoprovision: null, deprecated_doc_fields: null,
  };

  it('rejects contract_version: 0', () => {
    assert.throws(
      () => importSettingsFromJSON({ ...base, contract_version: 0 }),
      ContractVersionMismatch,
    );
  });

  it('rejects contract_version: 2', () => {
    assert.throws(
      () => importSettingsFromJSON({ ...base, contract_version: 2 }),
      ContractVersionMismatch,
    );
  });

  it('rejects missing contract_version', () => {
    const { contract_version: _, ...noVersion } = { ...base, contract_version: 1 };
    assert.throws(
      () => importSettingsFromJSON(noVersion),
      ContractVersionMismatch,
    );
  });

  it('rejects null record', () => {
    assert.throws(
      () => importSettingsFromJSON(null),
      InvalidBridgeRecord,
    );
  });
});

// -------------------------------------------------------------------------
// Fuzz: schema violations caught at export
// -------------------------------------------------------------------------

describe('erlang-bridge: fuzz — exporter rejects invalid YAML', () => {
  it('rejects extra unknown fields', () => {
    const bad = {
      schema_version: 1,
      organ: 'test',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
      unknown_extra: 'oops',
    };
    assert.throws(
      () => exportSettingsToJSON({ yamlParsed: bad, filename: 'test-organ-default-llm-settings.yaml', organNumber: 999 }),
      LLMSettingsInvalid,
    );
  });

  it('rejects missing required field (provider)', () => {
    const bad = {
      schema_version: 1,
      organ: 'test',
      model: 'claude-sonnet-4-6',
      max_tokens: 100,
    };
    assert.throws(
      () => exportSettingsToJSON({ yamlParsed: bad, filename: 'test-organ-default-llm-settings.yaml', organNumber: 999 }),
      LLMSettingsInvalid,
    );
  });

  it('rejects missing schema_version', () => {
    const bad = { organ: 'test', llm_required: false };
    assert.throws(
      () => exportSettingsToJSON({ yamlParsed: bad, filename: 'test-organ-default-llm-settings.yaml', organNumber: 999 }),
      LLMSettingsInvalid,
    );
  });
});
