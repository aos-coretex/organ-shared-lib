/**
 * Typed LLM-related error classes — MP-CONFIG-1.
 *
 * Canonical home for typed errors raised by the LLM-settings loader, validator,
 * cascade executor, and budget interception layer. Mirrors `tool-errors.js` in
 * structure (extends Error; `.name`; `.code`; structured payload).
 *
 * Subpath import contract (systemic bug #1): consumers import via
 *   `import { LLMSettingsInvalid, LLMCascadeExhausted, BudgetExceeded } from '@coretex/organ-boot/llm-errors';`
 *
 * Errors defined here:
 *   - LLMSettingsInvalid    (R1 l9m-1) — validator rejection on YAML schema violation
 *   - LLMCascadeExhausted   (R2 l9m-2) — all fallbacks attempted, none succeeded (D6 terminal)
 *   - BudgetExceeded        (R2 l9m-2) — budget policy denied a call (R9 raises it; default policy doesn't)
 *   - SettingsFileMissing   (R3 l9m-3) — no YAML at expected loader path
 *   - SettingsParseError    (R3 l9m-3) — YAML parse failure (distinct from schema rejection)
 */

/**
 * Validator rejection. Raised by `validateSettings(...)` in
 * `lib/llm-settings-schema.js` whenever a YAML file fails the schema-v1 contract.
 *
 * Payload:
 *   - `field`            — the offending field name (e.g., `model`, `provider`, `schema_version`)
 *   - `expected_pattern` — human-readable description of the expected value/pattern
 *   - `actual_value`     — the value that triggered the rejection (may be undefined for missing fields)
 *   - `reason`           — short, grep-able explanation suitable for logs and CV reports
 *
 * `name` is `LLMSettingsInvalid`; `code` is `LLM_SETTINGS_INVALID`. Consumers
 * may match on either.
 */
export class LLMSettingsInvalid extends Error {
  constructor({ field, expected_pattern, actual_value, reason, filename } = {}) {
    const prefix = filename ? `${filename}: ` : '';
    super(`${prefix}${reason || 'invalid LLM settings'}`);
    this.name = 'LLMSettingsInvalid';
    this.code = 'LLM_SETTINGS_INVALID';
    this.field = field;
    this.expected_pattern = expected_pattern;
    this.actual_value = actual_value;
    this.reason = reason;
    this.filename = filename;
  }
}

/**
 * D6 terminal error — the cascade executor (R4) attempted every fallback entry
 * and none succeeded. Caller decides whether to surface, retry, or drop; the
 * cascade engine never invents graceful-degradation semantics.
 *
 * Payload:
 *   - `attempted` — array of `{ provider, model, error_class, error_message, elapsed_ms }`
 *                   one per cascade stage tried, in order. Stage 0 is primary; 1+ are fallbacks.
 *
 * Single-stage exhaustion (no fallback configured + primary failed) is still
 * `LLMCascadeExhausted` with a one-element `attempted` array.
 */
export class LLMCascadeExhausted extends Error {
  constructor({ attempted = [] } = {}) {
    const stageCount = attempted.length;
    const lastClass = stageCount > 0 ? attempted[stageCount - 1].error_class : 'unknown';
    super(`LLM cascade exhausted after ${stageCount} stage(s); final class=${lastClass}`);
    this.name = 'LLMCascadeExhausted';
    this.code = 'LLM_CASCADE_EXHAUSTED';
    this.attempted = attempted;
  }
}

/**
 * Raised when the budget policy denies an LLM call. R9 ships the interception
 * point + a default `allow` policy that NEVER throws this. A future MP can wire
 * a ceiling-enforcing policy that raises `BudgetExceeded` when the per-tenant
 * spend would exceed its allocation.
 *
 * Payload:
 *   - `tenant_urn`            — `urn:llm-ops:entity:<name>` (MP-17 §10 #35 vocabulary)
 *   - `requested_cost_usd`    — estimated cost of the denied call (>= 0)
 *   - `remaining_budget_usd`  — what was left before the denial (>= 0)
 *   - `policy_reason`         — short, grep-able label from the policy decision
 */
export class BudgetExceeded extends Error {
  constructor({ tenant_urn, requested_cost_usd, remaining_budget_usd, policy_reason } = {}) {
    super(
      `budget exceeded for ${tenant_urn || 'unknown tenant'}: ` +
        `requested $${requested_cost_usd ?? '?'} > remaining $${remaining_budget_usd ?? '?'} (${policy_reason || 'no reason'})`,
    );
    this.name = 'BudgetExceeded';
    this.code = 'BUDGET_EXCEEDED';
    this.tenant_urn = tenant_urn;
    this.requested_cost_usd = requested_cost_usd;
    this.remaining_budget_usd = remaining_budget_usd;
    this.policy_reason = policy_reason;
  }
}

/**
 * Raised by the settings loader (`lib/llm-settings-loader.js`) when the expected
 * organ-default settings file is not present on disk. Distinct from
 * `LLMSettingsInvalid` (parsed-but-schema-invalid) and `SettingsParseError`
 * (present-but-malformed-YAML) so callers can route each to the correct
 * remediation path.
 *
 * Payload:
 *   - `filename`       — short filename for log/grep
 *   - `expected_path`  — absolute path the loader checked
 */
export class SettingsFileMissing extends Error {
  constructor({ filename, expected_path } = {}) {
    super(`settings file missing: ${expected_path || filename || '<unknown path>'}`);
    this.name = 'SettingsFileMissing';
    this.code = 'SETTINGS_FILE_MISSING';
    this.filename = filename;
    this.expected_path = expected_path;
  }
}

/**
 * Raised by the settings loader when a YAML file is present but cannot be
 * parsed. Distinct from `LLMSettingsInvalid` so the validator's structured
 * payload (field/expected_pattern/actual_value) is reserved for genuine
 * schema rejections, and YAML-syntax problems get their own diagnostic shape.
 *
 * Payload:
 *   - `filename`    — short filename for log/grep
 *   - `yaml_error`  — the underlying YAML parser error message
 */
export class SettingsParseError extends Error {
  constructor({ filename, yaml_error } = {}) {
    super(`settings YAML parse error in ${filename || '<unknown>'}: ${yaml_error || 'unknown'}`);
    this.name = 'SettingsParseError';
    this.code = 'SETTINGS_PARSE_ERROR';
    this.filename = filename;
    this.yaml_error = yaml_error;
  }
}
