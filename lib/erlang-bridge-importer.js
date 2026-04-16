/**
 * Erlang-ModelBroker bridge importer (JSON → YAML) — MP-CONFIG-1 relay l9m-11.
 *
 * Pure, deterministic reverse transform. Each JSON bridge record → YAML string
 * in canonical key order. Null optional fields are omitted (matching existing
 * skeleton style). Comments are NOT preserved (see contract comment-handling policy).
 *
 * Subpath import: `@coretex/organ-boot/erlang-bridge-importer`
 */

import yaml from 'js-yaml';
import { CONTRACT_VERSION } from './erlang-bridge-exporter.js';

const CANONICAL_YAML_KEY_ORDER = [
  'schema_version',
  'organ',
  'llm_required',
  'provider',
  'model',
  'max_tokens',
  'thinking',
  'fallback',
  'deployment_target',
  'api_key_env_var',
  'tenant_urn',
  'huggingface_autoprovision',
  // Deprecated doc fields (appended after contract fields):
  'agent',
  'api_key_path',
  'temperature',
  'notes',
  'runtime_source_file',
];

class ContractVersionMismatch extends Error {
  constructor(expected, actual) {
    super(`contract_version mismatch: expected ${expected}, got ${actual}`);
    this.name = 'ContractVersionMismatch';
    this.code = 'CONTRACT_VERSION_MISMATCH';
    this.expected = expected;
    this.actual = actual;
  }
}

class InvalidBridgeRecord extends Error {
  constructor(reason) {
    super(`invalid bridge record: ${reason}`);
    this.name = 'InvalidBridgeRecord';
    this.code = 'INVALID_BRIDGE_RECORD';
    this.reason = reason;
  }
}

export { ContractVersionMismatch, InvalidBridgeRecord };

/**
 * Import a JSON bridge record → YAML string.
 *
 * @param {object} jsonRecord — a contract-v1 JSON record
 * @returns {string} YAML string (block style, 2-space indent, no comments)
 * @throws {ContractVersionMismatch} if contract_version is wrong
 * @throws {InvalidBridgeRecord} if record is structurally invalid
 */
export function importSettingsFromJSON(jsonRecord) {
  if (!jsonRecord || typeof jsonRecord !== 'object') {
    throw new InvalidBridgeRecord('record must be a non-null object');
  }
  if (jsonRecord.contract_version !== CONTRACT_VERSION) {
    throw new ContractVersionMismatch(CONTRACT_VERSION, jsonRecord.contract_version);
  }
  if (typeof jsonRecord.organ_name !== 'string' || jsonRecord.organ_name.length === 0) {
    throw new InvalidBridgeRecord('organ_name is required');
  }

  const obj = {};
  obj.schema_version = jsonRecord.schema_version;
  obj.organ = jsonRecord.organ_name;

  if (jsonRecord.llm_required === false) {
    obj.llm_required = false;
  }

  // Probabilistic fields — only emit when llm_required is not false.
  if (jsonRecord.llm_required !== false) {
    if (jsonRecord.provider != null) obj.provider = jsonRecord.provider;
    if (jsonRecord.model != null) obj.model = jsonRecord.model;
    if (jsonRecord.max_tokens != null) obj.max_tokens = jsonRecord.max_tokens;
    if (jsonRecord.thinking != null) obj.thinking = denormalizeThinking(jsonRecord.thinking);
    if (jsonRecord.fallback != null) obj.fallback = denormalizeFallback(jsonRecord.fallback);
    if (jsonRecord.deployment_target != null) obj.deployment_target = jsonRecord.deployment_target;
    if (jsonRecord.api_key_env_var != null) obj.api_key_env_var = jsonRecord.api_key_env_var;
  }

  if (jsonRecord.tenant_urn != null) obj.tenant_urn = jsonRecord.tenant_urn;

  if (jsonRecord.llm_required !== false && jsonRecord.huggingface_autoprovision != null) {
    obj.huggingface_autoprovision = { ...jsonRecord.huggingface_autoprovision };
  }

  // Expand deprecated doc fields back to top-level YAML keys.
  if (jsonRecord.deprecated_doc_fields != null) {
    const dep = jsonRecord.deprecated_doc_fields;
    if (dep.agent !== undefined) obj.agent = dep.agent;
    if (dep.api_key_path !== undefined) obj.api_key_path = dep.api_key_path;
    if (dep.temperature !== undefined) obj.temperature = dep.temperature;
    if (dep.notes !== undefined) obj.notes = dep.notes;
    if (dep.runtime_source_file !== undefined) obj.runtime_source_file = dep.runtime_source_file;
  }

  // Enforce canonical YAML key order by building ordered output.
  const ordered = {};
  for (const key of CANONICAL_YAML_KEY_ORDER) {
    if (key in obj) {
      ordered[key] = obj[key];
    }
  }

  return yaml.dump(ordered, {
    indent: 2,
    flowLevel: -1,
    lineWidth: -1,
    sortKeys: false,
    noRefs: true,
    quotingType: '"',
    forceQuotes: false,
  });
}

function denormalizeThinking(t) {
  if (!t || typeof t !== 'object') return undefined;
  const result = { enabled: t.enabled };
  if (t.budget_tokens && t.budget_tokens > 0) {
    result.budget_tokens = t.budget_tokens;
  }
  return result;
}

function denormalizeFallback(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return undefined;
  return arr.map((entry) => {
    const e = { provider: entry.provider, model: entry.model };
    if (entry.max_tokens != null) e.max_tokens = entry.max_tokens;
    if (entry.thinking != null) e.thinking = denormalizeThinking(entry.thinking);
    if (entry.deployment_target != null) e.deployment_target = entry.deployment_target;
    if (entry.api_key_env_var != null) e.api_key_env_var = entry.api_key_env_var;
    return e;
  });
}
