# LLM Settings YAML — Schema v1

**Status:** Active. Authoritative for MP-CONFIG-1 (`l9m`) and downstream relays R3–R12.
**Module:** `organ-shared-lib/lib/llm-settings-schema.js`
**Errors:** `organ-shared-lib/lib/llm-errors.js` (`LLMSettingsInvalid`)
**Subpath imports:** `@coretex/organ-boot/llm-settings-schema`, `@coretex/organ-boot/llm-errors`
**Validator script:** `organ-shared-lib/scripts/validate-all-settings.js` → `npm run validate-settings`

This document is the wire contract for every YAML file under
`01-Organs/<NNN>-<Organ>/<organ>-organ-{default,<agent>}-llm-settings.yaml`. The
loader (R3) consumes it; the cascade executor (R4) and the budget/cost layer (R9)
inherit field names from it; the Erlang ModelBroker bridge (R11) round-trips it;
the CV conformance scan (R12) re-runs the validator.

The schema is the source of truth for how organ LLM assignment is declared.
Organ source code stops carrying hardcoded defaults at R5/R6/R7.

---

## 1. File location & filename convention (D1)

```
01-Organs/<NNN>-<Organ>/
  ├─ <organ>-organ-default-llm-settings.yaml        # required (every probabilistic organ)
  └─ <organ>-organ-<agent>-llm-settings.yaml        # one per per-agent override
```

Examples:

```
01-Organs/200-Nomos/nomos-organ-default-llm-settings.yaml
01-Organs/200-Nomos/nomos-organ-nomos-evidence-llm-settings.yaml
01-Organs/110-Syntra/syntra-organ-default-llm-settings.yaml   # standalone
```

The agent name is encoded in the filename. The schema does NOT require an `agent:`
field inside the file (the deprecated documentation field `agent:` is permitted
for legacy skeleton compatibility but ignored).

## 2. Two branches: probabilistic vs standalone (D12)

The validator branches on `llm_required` FIRST.

| `llm_required` value | Branch | Meaning |
|---|---|---|
| `true` OR absent (default) | Probabilistic | Organ constructs an LLM client at boot. Full schema applies. |
| `false` | Standalone | Organ uses no LLM. Validator REJECTS any LLM-bearing field. |

### 2.1 Standalone branch (D12)

Required: `schema_version`, `organ`, `llm_required: false`.
Permitted: `tenant_urn`, comments.
Rejected (raises `LLMSettingsInvalid` with `reason: "llm_required:false must be standalone; no LLM fields permitted"`):
`model`, `provider`, `fallback`, `thinking`, `max_tokens`, `deployment_target`, `api_key_env_var`.

Canonical example (Syntra):

```yaml
schema_version: 1
organ: syntra
llm_required: false
# Syntra is probabilistic via Vectr embeddings (semantic + alternating-hop retrieval),
# not via LLM inference. No LLM client is constructed at boot.
```

### 2.2 Probabilistic branch

Required: `schema_version`, `organ`, `provider`, `model`, `max_tokens`.
Optional: `fallback`, `thinking`, `deployment_target`, `api_key_env_var`, `tenant_urn`.

Canonical examples by provider class follow in §3.

## 3. Provider classes (D3)

Three permitted values for `provider:`. Closed enum.

### 3.1 `anthropic` — native Anthropic SDK

```yaml
schema_version: 1
organ: arbiter
provider: anthropic
model: claude-haiku-4-5-20251001
max_tokens: 2048
tenant_urn: urn:llm-ops:entity:llm-ops-platform
```

The `model:` string is enforced by the D11 regex (§4) and the per-family canonical
table (§4.1).

### 3.2 `openai-compatible` — local vLLM / TGI / llama.cpp / remote OpenAI-compatible

```yaml
schema_version: 1
organ: cortex
provider: openai-compatible
model: Qwen2.5-32B-Instruct-AWQ
max_tokens: 4096
deployment_target: gpu-host-01:8000
api_key_env_var: VLLM_API_KEY
tenant_urn: urn:llm-ops:entity:llm-ops-platform
```

`model:` is pass-through — whatever string the upstream server accepts. No regex
enforcement (drift-resolution deferred to a future repair if local-side drift surfaces).

### 3.3 `huggingface-autoprovision` — settings-declared download + local serve

```yaml
schema_version: 1
organ: cortex
provider: huggingface-autoprovision
model: Qwen/Qwen2.5-32B-Instruct-AWQ
max_tokens: 4096
deployment_target: gpu-host-01:8000
tenant_urn: urn:llm-ops:entity:llm-ops-platform
```

R10 owns the autoprovisioning orchestrator. R10 may extend the schema with
`revision:` and `quantization:` subfields; documented at R10 close.

## 4. D11 — Anthropic model-string canonical policy

### 4.1 Validator regex

```
/^claude-(opus|sonnet|haiku)-\d+-\d+(-\d{8})?$/
```

The dated suffix is OPTIONAL at the regex layer (per RFI-1-relay-l9m-1 reply
2026-04-15). Per-family canonical form is enforced by the table below, not the
regex.

### 4.2 Per-family canonical table

| Family | Canonical form | Rationale |
|---|---|---|
| Haiku 4.5 | `claude-haiku-4-5-20251001` (dated) | Anthropic publishes both forms; the dated form is the non-aliased id |
| Sonnet 4.6 | `claude-sonnet-4-6` (bare) | Anthropic publishes only the bare form; no dated revision exists |
| Opus 4.6 | `claude-opus-4-6` (bare) | Anthropic publishes only the bare form |

When Anthropic publishes a dated Sonnet-4-6 or Opus-4-6, this table updates and a
follow-on retrofit relay re-canonicalizes affected YAMLs. Until then, the bare
alias is both documented canonical and validator-accepted for those families.

### 4.3 Why per-family rather than universal dated suffix?

The architect's RFI-2 reply (2026-04-15) initially mandated a universal dated
suffix. The implementor's grep audit of the 48-YAML skeleton showed that 14
Sonnet YAMLs use the bare alias because Anthropic does not publish a dated form
for Sonnet 4.6. Inventing one would be fabrication, not canonicalization.
RFI-1-relay-l9m-1 reply rules the per-family canonical policy in.

Discipline (architect's own carry-forward at session-11): *"Specification
decisions governing source-of-truth identifiers must grep-audit actual platform
usage before locking. Anticipated-form assumptions fabricate drift."*

## 5. D9 — Thinking block (extended thinking)

Optional probabilistic-bucket field. Matches the Anthropic API field name
verbatim (no loader translation).

```yaml
thinking:
  enabled: true
  budget_tokens: 10000
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `enabled` | boolean | yes | Toggles extended thinking |
| `budget_tokens` | integer ≥ 1 | no | Defaults to llm-client.js default (10000) when absent |

Used by Soul/consistency-checker (8000), Soul/evolution-analyst (10000),
Minder/dialectic-worker (5000) per repair-platform-01 finding #3.

## 6. Fallback cascade (D4 + D5 + D6)

Optional probabilistic-bucket field. Each entry is itself a probabilistic-bucket
schema MINUS `fallback` (no nested cascades — depth limited to 1).

```yaml
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
```

Each fallback entry permits: `provider`, `model`, `max_tokens`, `thinking`,
`deployment_target`, `api_key_env_var`. No `fallback`.

The cascade executor (R4) consults the classification helper (R2) for each
failure:

| Class set | Behavior | Module |
|---|---|---|
| `CASCADE_FAILURE_CLASSES` (D4 — 7 classes) | Try next fallback entry | `lib/llm-settings-schema.js` exports |
| `FAIL_CLOSED_CLASSES` (D5 — 4 classes) | Raise immediately, no fallback | `lib/llm-settings-schema.js` exports |
| Cascade exhausted (all entries attempted) | Raise `LLMCascadeExhausted` (R2 owns) | `lib/llm-errors.js` (R2 extension) |

### D4 — cascade-eligible failure classes (7)

```
connection_refused
connection_timeout
http_5xx
http_503
http_429
model_not_loaded
timeout_during_streaming
```

### D5 — fail-closed failure classes (4)

```
http_4xx           (excluding 429 and 503, which are D4)
parse_error
context_length_exceeded
content_filter_triggered
```

## 7. Tenant URN (`tenant_urn`)

Optional probabilistic + standalone field. Matches MP-17 §10 Decision #35
vocabulary verbatim (`urn:llm-ops:entity:<name>`).

| Field | Type | Default | Notes |
|---|---|---|---|
| `tenant_urn` | string matching `^urn:llm-ops:entity:[a-z0-9-]+$` | `urn:llm-ops:entity:llm-ops-platform` | Consumed by R9 `llm_usage_event.tenant_urn` for cost attribution |

`DEFAULT_TENANT_URN` constant exported from the schema module. R9 reads this when
the field is absent.

## 8. Deployment target (`deployment_target`)

Optional probabilistic-bucket field. String of form `host:port` (regex
`^[^:]+:\d+$`). Consumed by R10 for HF auto-provisioning + by `openai-compatible`
provider in R2 to construct base URL.

```yaml
deployment_target: gpu-host-01:8000
```

## 9. API key env var (`api_key_env_var`)

Optional probabilistic-bucket field. Names the environment variable from which
the loader reads the API key. Defaults inside `llm-client.js`:

| Provider | Default env var |
|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai-compatible` | unset (some local servers don't require one) |
| `huggingface-autoprovision` | unset (HF orchestrator handles auth) |

Per-organ override permitted but rare; most organs share the platform-wide key.

## 10. Schema version (D10)

Mandatory top-level field, integer constant `1`. The validator rejects any other
value with `LLMSettingsInvalid { field: 'schema_version', reason: 'missing or
mismatched schema_version' }`. Future schema revisions bump this and the loader
dispatches on version.

## 11. Deprecated documentation fields (skeleton-era)

The repair-platform-01 (2026-04-14) skeleton populated 48 YAMLs with five fields
that are NOT part of schema v1's runtime contract:

| Field | Source intent | Migration plan |
|---|---|---|
| `agent` | Echoed agent name from filename | Remove after R5/R6/R7; agent name lives in filename per D1 |
| `api_key_path` | Documented Keychain path of the API key | Remove; superseded by `api_key_env_var` |
| `temperature` | Default temperature | Remove; temperature is per-call (`llm.chat(opts)` argument) |
| `notes` | Free-form documentation | Migrate to YAML comments (`#`) at top of file |
| `runtime_source_file` | Provenance pointer | Remove after R5/R6/R7 (source no longer carries the value) |

The validator PERMITS these fields so the existing 48 YAMLs validate after only
a `schema_version: 1` line is added (D10 mandatory). The loader (R3) ignores
them. A future repair relay strips them once R5/R6/R7 land.

## 12. Validator — `validateSettings(input, filename)`

```js
import { validateSettings } from '@coretex/organ-boot/llm-settings-schema';
import { LLMSettingsInvalid } from '@coretex/organ-boot/llm-errors';

try {
  const config = validateSettings(yamlText, '200-Nomos/nomos-organ-default-llm-settings.yaml');
  // config is the parsed + validated mapping
} catch (err) {
  if (err instanceof LLMSettingsInvalid) {
    // err.field, err.expected_pattern, err.actual_value, err.reason, err.filename
    console.error(`schema rejection: ${err.message}`);
  }
  throw err;
}
```

**Behavior:**
1. Parses YAML if `input` is a string. Parse errors raise `LLMSettingsInvalid` with `reason: "YAML parse error: ..."`.
2. Asserts `schema_version === 1`.
3. Asserts `organ` is a non-empty string.
4. Branches on `llm_required` (D12): `false` → standalone branch; otherwise probabilistic.
5. Probabilistic: enforces `provider` ∈ `PROVIDER_CLASSES`, `model` non-empty, D11 regex when anthropic, `max_tokens` positive int, optional `thinking` D9, optional `deployment_target` `host:port`, optional `fallback[]` with each entry validated against probabilistic-MINUS-fallback.
6. Standalone: rejects every LLM-bearing field; permits `tenant_urn` + deprecated doc fields + comments.
7. Rejects unknown top-level fields outside the permitted set + deprecated doc fields.
8. On success: returns the parsed mapping (same reference if input was already an object).

## 13. Exports

```js
import {
  LLM_SETTINGS_SCHEMA_VERSION,    // 1
  validateSettings,                // (input, filename) → validated config / throws
  CASCADE_FAILURE_CLASSES,         // frozen array of 7 D4 classes
  FAIL_CLOSED_CLASSES,             // frozen array of 4 D5 classes
  PROVIDER_CLASSES,                // frozen array of 3 D3 classes
  ANTHROPIC_MODEL_REGEX,           // D11 regex
  DEFAULT_TENANT_URN,              // 'urn:llm-ops:entity:llm-ops-platform'
  LLM_SETTINGS_SCHEMA,             // JSON-Schema-shaped doc object (frozen)
} from '@coretex/organ-boot/llm-settings-schema';
```

```js
import { LLMSettingsInvalid } from '@coretex/organ-boot/llm-errors';
// extends Error; .name; .code='LLM_SETTINGS_INVALID';
// payload: .field, .expected_pattern, .actual_value, .reason, .filename
```

## 14. Cross-relay contracts

| Artifact | Consumer | Relay |
|---|---|---|
| `validateSettings` | R3 loader; R4 cascade executor; R10 HF schema check; R11 Erlang export; R12 conformance scan | R3, R4, R10, R11, R12 |
| `LLMSettingsInvalid` | R3 loader catch-and-rethrow; R12 CV diagnostic surface | R3, R12 |
| `CASCADE_FAILURE_CLASSES` + `FAIL_CLOSED_CLASSES` | R2 classification helper; R4 cascade executor | R2, R4 |
| `DEFAULT_TENANT_URN` | R9 `llm_usage_event` writer | R9 |
| Per-family canonical table (this doc) | Future repair relays for Sonnet/Opus dated-suffix landings | post-MP |

## 15. Future schema revisions

When v2 ships:
1. Bump `LLM_SETTINGS_SCHEMA_VERSION = 2`.
2. Update validator regex / required fields / etc.
3. Loader dispatches on version (read `schema_version`, route to v1 or v2 validator).
4. Migration path: backward-compatible v1 YAMLs OR a sweep relay rewrites all to v2.

The deprecated documentation fields (§11) are candidates for removal in a future
schema revision once R5/R6/R7 close and source-side carry-forward is dead.

---

**End of llm-settings-schema-v1.md.**
