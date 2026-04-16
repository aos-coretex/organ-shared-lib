/**
 * LLM settings loader — MP-CONFIG-1 relay l9m-3.
 *
 * Reads per-organ default + per-agent override YAMLs from `01-Organs/<NNN>-<Organ>/`,
 * applies cascade precedence (agent overrides organ), returns config objects
 * ready for `createLLMClient(configObject)` (bug #8 compliant).
 *
 * Subpath import:
 *   `import { createLoader } from '@coretex/organ-boot/llm-settings-loader';`
 *
 * Scope (intentional minimum):
 *   - Boot-time resolution + on-demand `reload()`.
 *   - NO Spine OTM subscription. NO governance binding. NO event emission.
 *   - NO cascade execution — `fallback[]` arrays pass through to R4.
 *   - NO LLM client construction — the loader returns config; R4 / migrated organ source builds clients.
 *
 * Cascade merge rules:
 *   - Scalars (`provider`, `model`, `max_tokens`, `tenant_urn`, `deployment_target`, `api_key_env_var`):
 *     agent value REPLACES organ default if present (including explicit falsy values).
 *   - `thinking` object: WHOLESALE replacement (agent's whole `thinking` block wins; not subfield-merged).
 *   - `fallback` array: WHOLESALE replacement (agent's whole array wins; not element-by-element).
 *
 * createLLMClient field-name transform (bug #8 1:1 mapping):
 *   provider             → defaultProvider
 *   model                → defaultModel
 *   max_tokens           → maxTokens
 *   api_key_env_var      → apiKeyEnvVar
 *   thinking.enabled     → thinking            (boolean)
 *   thinking.budget_tokens → thinkingBudget    (number; undefined if thinking disabled)
 *   deployment_target    → baseUrl             ('host:port' → 'http://host:port'; openai-compatible only)
 *   tenant_urn           → tenant_urn          (preserved verbatim for R9 cost attribution)
 *   fallback             → fallback            (preserved verbatim for R4 cascade)
 *   agentName            → set by resolve(agentName) parameter
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import {
  validateSettings,
  DEFAULT_TENANT_URN,
} from './llm-settings-schema.js';
import {
  LLMSettingsInvalid,
  SettingsFileMissing,
  SettingsParseError,
} from './llm-errors.js';
import { createCascadeChat } from './llm-cascade.js';

/**
 * @param {object} opts
 * @param {string|number} opts.organNumber — numeric prefix (e.g. 200 for Nomos)
 * @param {string} opts.organName          — lowercase canonical name (e.g. 'nomos')
 * @param {string} opts.settingsRoot       — absolute path to `01-Organs/`
 * @returns {{
 *   resolve: (agentName?: string) => object,
 *   reload: () => void,
 *   listAgents: () => string[],
 *   introspect: () => object,
 * }}
 */
export function createLoader({ organNumber, organName, settingsRoot } = {}) {
  if (!organNumber || !organName || !settingsRoot) {
    throw new Error(
      `createLoader requires { organNumber, organName, settingsRoot } — got ${JSON.stringify({ organNumber, organName, settingsRoot })}`,
    );
  }

  const organDir = join(settingsRoot, `${organNumber}-${capitalize(organName)}`);
  // Some organs are PascalCase in the directory name (e.g. "200-Nomos"); accept
  // both the capitalized form and the raw filesystem entry.
  const dirPath = existsSync(organDir)
    ? organDir
    : findOrganDir(settingsRoot, organNumber, organName);

  const defaultFilename = `${organName}-organ-default-llm-settings.yaml`;
  const agentFilenameRegex = new RegExp(
    `^${escapeRegex(organName)}-organ-(.+)-llm-settings\\.yaml$`,
  );

  // Mutable cache replaced atomically on reload().
  let cache = null;

  function readAndValidate(absPath) {
    let text;
    try {
      text = readFileSync(absPath, 'utf8');
    } catch (err) {
      throw new SettingsFileMissing({
        filename: absPath.split('/').pop(),
        expected_path: absPath,
      });
    }
    let parsed;
    try {
      parsed = yaml.load(text);
    } catch (err) {
      throw new SettingsParseError({
        filename: absPath.split('/').pop(),
        yaml_error: err.message,
      });
    }
    // validateSettings throws LLMSettingsInvalid on schema violations.
    validateSettings(parsed, absPath.split('/').pop());
    return parsed;
  }

  function loadCache() {
    if (!dirPath || !existsSync(dirPath)) {
      throw new SettingsFileMissing({
        filename: defaultFilename,
        expected_path: join(settingsRoot, `${organNumber}-${organName}/`, defaultFilename),
      });
    }

    const defaultPath = join(dirPath, defaultFilename);
    if (!existsSync(defaultPath)) {
      throw new SettingsFileMissing({
        filename: defaultFilename,
        expected_path: defaultPath,
      });
    }

    const newCache = {
      defaultPath,
      defaultConfig: readAndValidate(defaultPath),
      agents: new Map(), // agentName → { path, config }
    };

    for (const entry of readdirSync(dirPath)) {
      const m = entry.match(agentFilenameRegex);
      if (!m) continue;
      if (m[1] === 'default') continue;
      const agentName = m[1];
      const agentPath = join(dirPath, entry);
      newCache.agents.set(agentName, {
        path: agentPath,
        config: readAndValidate(agentPath),
      });
    }

    return newCache;
  }

  // Initial load — surfaces SettingsFileMissing / SettingsParseError /
  // LLMSettingsInvalid at construction time. No partial-state risk because
  // we haven't published `cache` yet.
  cache = loadCache();

  function reload() {
    // Build a fresh cache; only swap on full success. On any failure the
    // existing `cache` reference is unchanged — old config remains valid.
    const newCache = loadCache();
    cache = newCache;
  }

  function resolve(agentName) {
    const merged = { ...cache.defaultConfig };
    if (agentName && cache.agents.has(agentName)) {
      const agentCfg = cache.agents.get(agentName).config;
      // Wholesale replacement for `thinking` and `fallback`; scalar fields
      // also wholesale-replaced if present in agent.
      for (const [k, v] of Object.entries(agentCfg)) {
        // schema_version + organ are organ-uniform; agent file's values are
        // structurally equal so the merge is a no-op for them.
        merged[k] = v;
      }
    }
    return Object.freeze(toLLMClientConfig(merged, agentName));
  }

  /**
   * Resolve a config for `agentName` AND wrap it in a cascade-executing chat
   * function. Returns `{ config, chat }`. Caller invokes `chat(messages, options)`
   * to walk primary + fallback under D4/D5 with `LLMCascadeExhausted` on terminal.
   *
   * Standalone configs (`llm_required: false`) cannot be cascaded; this method
   * throws if called for them.
   *
   * MP-CONFIG-1 R4 integration point.
   */
  function resolveWithCascade(agentName) {
    const config = resolve(agentName);
    if (config.llm_required === false) {
      throw new Error(
        `loader.resolveWithCascade: cannot wrap a standalone (llm_required:false) config for ${organName}/${agentName || 'default'}`,
      );
    }
    return { config, chat: createCascadeChat(config).chat };
  }

  function listAgents() {
    return [...cache.agents.keys()].sort();
  }

  function introspect() {
    // Flat shape per bug #9 — top-level keys only; no envelope.
    const agents = listAgents().map((name) => ({
      name,
      config: toLLMClientConfig(
        { ...cache.defaultConfig, ...cache.agents.get(name).config },
        name,
      ),
    }));
    return Object.freeze({
      organ_number: Number(organNumber),
      organ_name: organName,
      default: toLLMClientConfig(cache.defaultConfig, 'default'),
      agents,
    });
  }

  return { resolve, resolveWithCascade, reload, listAgents, introspect };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Locate the organ directory under `settingsRoot` matching the numeric prefix
 * even when the suffix casing differs (e.g. `200-Nomos` vs `200-nomos`).
 */
function findOrganDir(settingsRoot, organNumber, organName) {
  const prefix = `${organNumber}-`;
  const target = organName.toLowerCase();
  for (const entry of readdirSync(settingsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(prefix)) continue;
    const suffix = entry.name.slice(prefix.length).toLowerCase();
    if (suffix === target) return join(settingsRoot, entry.name);
  }
  return null;
}

/**
 * Transform a parsed-and-validated settings object into a
 * `createLLMClient(configObject)`-compatible shape (bug #8). Standalone
 * (`llm_required: false`) configs are passed through with `agentName` set
 * — they carry no LLM-specific fields, so callers should not call
 * `createLLMClient` with them; they may inspect `llm_required` to skip
 * client construction. tenant_urn is preserved for cost attribution either way.
 */
export function toLLMClientConfig(merged, agentName) {
  // Standalone — return minimal shape.
  if (merged.llm_required === false) {
    return {
      agentName: agentName || 'default',
      organ: merged.organ,
      llm_required: false,
      tenant_urn: merged.tenant_urn || DEFAULT_TENANT_URN,
    };
  }

  const out = {
    agentName: agentName || 'default',
    organ: merged.organ,
    defaultProvider: merged.provider,
    defaultModel: merged.model,
    maxTokens: merged.max_tokens,
    tenant_urn: merged.tenant_urn || DEFAULT_TENANT_URN,
  };

  if (merged.api_key_env_var !== undefined) {
    out.apiKeyEnvVar = merged.api_key_env_var;
  }

  // D9 thinking — schema field `thinking: { enabled, budget_tokens }` →
  // createLLMClient `thinking` (bool) + `thinkingBudget` (number).
  if (merged.thinking && merged.thinking.enabled === true) {
    out.thinking = true;
    if (merged.thinking.budget_tokens !== undefined) {
      out.thinkingBudget = merged.thinking.budget_tokens;
    }
  } else if (merged.thinking && merged.thinking.enabled === false) {
    out.thinking = false;
    // thinkingBudget intentionally omitted when disabled.
  }
  // If no thinking block: omit both fields; createLLMClient defaults to false.

  // deployment_target → baseUrl (openai-compatible only; harmless on Anthropic
  // since callAnthropic ignores baseUrl).
  if (merged.deployment_target) {
    out.baseUrl = `http://${merged.deployment_target}`;
  }

  // Fallback array preserved verbatim for R4 cascade executor.
  if (Array.isArray(merged.fallback)) {
    out.fallback = merged.fallback;
  }

  return out;
}
