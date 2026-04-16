/**
 * Erlang-ModelBroker bridge exporter (YAML → JSON) — MP-CONFIG-1 relay l9m-11.
 *
 * Pure, deterministic transform. Each YAML LLM settings file → one JSON record
 * per the bridge contract (contract_version: 1). Validates via R1 schema before
 * export; invalid YAML is rejected (no partial records).
 *
 * Subpath import: `@coretex/organ-boot/erlang-bridge-exporter`
 */

import { validateSettings } from './llm-settings-schema.js';

export const CONTRACT_VERSION = 1;

const DEPRECATED_DOC_FIELD_NAMES = Object.freeze([
  'agent', 'api_key_path', 'temperature', 'notes', 'runtime_source_file',
]);

const CANONICAL_JSON_KEY_ORDER = Object.freeze([
  'contract_version',
  'schema_version',
  'organ_number',
  'organ_name',
  'file_kind',
  'agent_name',
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
  'deprecated_doc_fields',
]);

/**
 * Derive file_kind and agent_name from the settings filename.
 *
 * @param {string} filename — basename e.g. "arbiter-organ-clause-matcher-llm-settings.yaml"
 * @returns {{file_kind: 'default'|'agent', agent_name: string|null}}
 */
export function deriveFileKindFromFilename(filename) {
  const base = filename.replace(/\.ya?ml$/, '');
  const m = base.match(/^.+-organ-(.+)-llm-settings$/);
  if (!m) {
    return { file_kind: 'default', agent_name: null };
  }
  const part = m[1];
  if (part === 'default') {
    return { file_kind: 'default', agent_name: null };
  }
  return { file_kind: 'agent', agent_name: part };
}

function normalizeThinking(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    enabled: raw.enabled === true,
    budget_tokens: typeof raw.budget_tokens === 'number' ? raw.budget_tokens : 0,
  };
}

function normalizeFallback(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  return raw.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    max_tokens: entry.max_tokens ?? null,
    thinking: normalizeThinking(entry.thinking),
    deployment_target: entry.deployment_target ?? null,
    api_key_env_var: entry.api_key_env_var ?? null,
  }));
}

function normalizeHFAutoprovision(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    repo: raw.repo,
    revision: raw.revision,
    quantization: raw.quantization,
  };
}

function collectDeprecated(parsed) {
  const result = {};
  let found = false;
  for (const key of DEPRECATED_DOC_FIELD_NAMES) {
    if (parsed[key] !== undefined) {
      result[key] = parsed[key] ?? null;
      found = true;
    }
  }
  return found ? result : null;
}

/**
 * Export a parsed YAML settings object to a JSON bridge record.
 *
 * @param {object} opts
 * @param {object|string} opts.yamlParsed  — parsed YAML object or raw YAML string
 * @param {string}        opts.filename    — basename for file_kind derivation + validation diagnostics
 * @param {number}        opts.organNumber — organ number (from directory name)
 * @returns {object} JSON record in canonical key order
 * @throws {LLMSettingsInvalid} on validation failure
 */
export function exportSettingsToJSON({ yamlParsed, filename, organNumber }) {
  const parsed = validateSettings(yamlParsed, filename);
  const { file_kind, agent_name } = deriveFileKindFromFilename(filename);
  const isStandalone = parsed.llm_required === false;

  const record = {
    contract_version: CONTRACT_VERSION,
    schema_version: parsed.schema_version,
    organ_number: organNumber,
    organ_name: parsed.organ,
    file_kind,
    agent_name,
    llm_required: parsed.llm_required !== false,
    provider: isStandalone ? null : (parsed.provider ?? null),
    model: isStandalone ? null : (parsed.model ?? null),
    max_tokens: isStandalone ? null : (parsed.max_tokens ?? null),
    thinking: isStandalone ? null : normalizeThinking(parsed.thinking),
    fallback: isStandalone ? null : normalizeFallback(parsed.fallback),
    deployment_target: isStandalone ? null : (parsed.deployment_target ?? null),
    api_key_env_var: isStandalone ? null : (parsed.api_key_env_var ?? null),
    tenant_urn: parsed.tenant_urn ?? null,
    huggingface_autoprovision: isStandalone ? null : normalizeHFAutoprovision(parsed.huggingface_autoprovision),
    deprecated_doc_fields: collectDeprecated(parsed),
  };

  // Enforce canonical key order via ordered reconstruction.
  const ordered = {};
  for (const key of CANONICAL_JSON_KEY_ORDER) {
    ordered[key] = record[key];
  }
  return ordered;
}

/**
 * Deterministic JSON.stringify with canonical key order (already enforced
 * by the ordered record, but this ensures nested objects are also stable).
 */
export function stableStringify(record) {
  return JSON.stringify(record, null, 2);
}
