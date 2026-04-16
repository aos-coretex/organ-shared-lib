/**
 * Cascade execution wrapper — MP-CONFIG-1 relay l9m-4.
 *
 * Wraps `llm.chat()` in a higher-order layer that walks a `fallback:` cascade
 * under D4/D5 classification rules and raises `LLMCascadeExhausted` (D6) when
 * all stages fail.
 *
 * Subpath import:
 *   `import { createCascadeChat } from '@coretex/organ-boot/llm-cascade';`
 *
 * State machine (per stage):
 *
 *   ACTIVE ── primary.chat() ──► SUCCESS ──► DONE
 *      │
 *      └── error ──► classifyLLMFailure(err)
 *                         │
 *                         ├── fallback_eligible: false ──► FAIL_CLOSED ──► DONE_FAIL (raise LLMCascadeExhausted, reason: 'fail_closed')
 *                         │
 *                         └── fallback_eligible: true ──► next stage exists?
 *                                                            │
 *                                                            ├── yes ──► STAGE_FAILED ──► (loop with fallbackClients[i+1])
 *                                                            │
 *                                                            └── no  ──► EXHAUSTED ──► DONE_FAIL (raise LLMCascadeExhausted, reason: 'all_stages_exhausted')
 *
 * Optional `cascade_total_timeout_ms` on the resolved config sets a wall-clock
 * upper bound across all stages; on expiry, raises `LLMCascadeExhausted` with
 * `reason: 'cascade_total_timeout'`.
 *
 * Field inheritance: each fallback stage's config is a merge — fallback entry
 * fields override primary; missing fields inherit from primary (so a
 * fallback declared as `{provider, model, deployment_target}` automatically
 * inherits the primary's `apiKeyEnvVar`, `maxTokens`, `tenant_urn`, etc.).
 *
 * NOT done here:
 *   - No request-level retry inside a stage (Anthropic SDK's internal retry
 *     happens inside callAnthropic). Cascade is stage-level only.
 *   - No streaming. Future MP. When added, R4 sets `context.duringStream: true`
 *     on the classifier call so `timeout_during_streaming` is distinguishable
 *     from `connection_timeout` (already supported in classifier).
 *   - No graceful degradation. Terminal exhaustion ALWAYS raises — caller
 *     decides whether to surface, retry at a higher layer, or drop.
 */

import { createLLMClient } from './llm-client.js';
import { classifyLLMFailure } from './llm-classifier.js';
import { LLMCascadeExhausted } from './llm-errors.js';
import { evaluateBudgetPolicy as defaultEvaluateBudgetPolicy } from './budget-policy.js';
import { getDefaultUsageWriter } from './llm-usage-writer.js';

/**
 * @param {object} resolvedConfig — output of `loader.resolve(agentName)`.
 *   Required: `agentName`, `defaultProvider`, `defaultModel`, `maxTokens`.
 *   Optional: `apiKeyEnvVar`, `thinking`, `thinkingBudget`, `baseUrl`,
 *             `tenant_urn`, `organ`, `fallback[]` (YAML-shape entries),
 *             `cascade_total_timeout_ms` (number).
 *
 * @param {object} [opts]                — DI hooks (test-only + R9 wiring)
 * @param {Function} [opts._clientFactory] — defaults to `createLLMClient`
 * @param {Function} [opts._classifier]    — defaults to `classifyLLMFailure`
 * @param {Function} [opts.usageWriter]    — optional `writeLLMUsageEvent`-shaped
 *                                            callback invoked fire-and-forget
 *                                            after each chat() completion
 *                                            (success OR cascade-exhausted).
 *                                            Injected by boot wiring when
 *                                            MP-CONFIG-1 R9 cost-attribution
 *                                            is active; absent in older callers.
 * @param {Function} [opts.evaluateBudgetPolicy] — overrides the default policy
 *                                                  evaluator. Hot-path call is
 *                                                  advisory in R9 (default always
 *                                                  allows); reserved for a future
 *                                                  MP to enforce ceilings.
 *
 * @returns {{ chat: (messages: Array, options?: object) => Promise<object> }}
 */
export function createCascadeChat(resolvedConfig, opts = {}) {
  const clientFactory = opts._clientFactory || createLLMClient;
  const classifier = opts._classifier || classifyLLMFailure;
  const usageWriter = opts.usageWriter || null;
  const evaluateBudgetPolicy = opts.evaluateBudgetPolicy || defaultEvaluateBudgetPolicy;

  if (!resolvedConfig || resolvedConfig.llm_required === false) {
    throw new Error(
      'createCascadeChat: resolvedConfig must be a probabilistic config (llm_required !== false)',
    );
  }

  // Build the per-stage configs. Stage 0 is primary; stages 1..N are fallback entries.
  const stageConfigs = [
    { ...resolvedConfig }, // primary already in createLLMClient shape
  ];
  if (Array.isArray(resolvedConfig.fallback)) {
    resolvedConfig.fallback.forEach((entry, i) => {
      stageConfigs.push(buildFallbackStageConfig(resolvedConfig, entry, i + 1));
    });
  }

  // Strip non-createLLMClient fields before construction (these are cascade-level
  // metadata: `fallback`, `cascade_total_timeout_ms`, `tenant_urn`, `organ`,
  // `llm_required` — none are in the createLLMClient field whitelist).
  const stageClients = stageConfigs.map((cfg) =>
    clientFactory(stripCascadeMeta(cfg)),
  );

  const totalTimeoutMs = resolvedConfig.cascade_total_timeout_ms;

  async function chat(messages, options = {}) {
    const attempted = [];
    const cascadeStart = Date.now();

    for (let i = 0; i < stageClients.length; i++) {
      // Cascade-level timeout check before each stage.
      if (totalTimeoutMs && Date.now() - cascadeStart > totalTimeoutMs) {
        emitUsage({
          stage: stageConfigs[i - 1] || stageConfigs[0],
          cascadeStage: i - 1,
          result: null,
          options,
          outcome: 'cascade_exhausted',
        });
        throw new LLMCascadeExhausted({ attempted });
      }

      const stage = stageConfigs[i];

      // R9 budget hook — advisory in current wiring (default policy always
      // returns 'allow'). Reserved for future ceiling enforcement; the
      // returned action is NOT consulted in this relay beyond the call itself.
      try {
        evaluateBudgetPolicy({
          tenant_urn: resolvedConfig.tenant_urn,
          estimated_cost_usd: 0, // refined once we have tokens_in/out after the call
          context: {
            organ: resolvedConfig.organ,
            agent: resolvedConfig.agentName,
            model: stage.defaultModel,
            provider: stage.defaultProvider,
            cascade_stage: i,
          },
        });
      } catch {
        /* evaluateBudgetPolicy fails open internally; this catch is defensive */
      }

      const stageStart = Date.now();
      try {
        // Race the stage call against the remaining cascade-total budget.
        const result =
          totalTimeoutMs !== undefined
            ? await Promise.race([
                stageClients[i].chat(messages, options),
                cascadeBudgetTimer(totalTimeoutMs - (stageStart - cascadeStart)),
              ])
            : await stageClients[i].chat(messages, options);
        emitUsage({ stage, cascadeStage: i, result, options, outcome: 'success' });
        return result;
      } catch (err) {
        // If err is the cascade-budget signal, raise exhausted now.
        if (err && err.__cascadeBudgetExpired) {
          emitUsage({ stage, cascadeStage: i, result: null, options, outcome: 'cascade_exhausted' });
          throw new LLMCascadeExhausted({ attempted });
        }

        const classification = classifier(err, {
          provider: stage.defaultProvider,
          baseUrl: stage.baseUrl,
        });
        attempted.push({
          provider: stage.defaultProvider,
          model: stage.defaultModel,
          error_class: classification.class,
          error_message: err.message,
          elapsed_ms: Date.now() - stageStart,
        });

        if (!classification.fallback_eligible) {
          // D5 fail-closed OR unknown classification (treated as fail-closed).
          emitUsage({ stage, cascadeStage: i, result: null, options, outcome: 'cascade_exhausted' });
          throw new LLMCascadeExhausted({ attempted });
        }
        // D4 — try next stage. If no next stage, fall through to exhaustion.
      }
    }

    // All stages tried, none succeeded.
    emitUsage({
      stage: stageConfigs[stageConfigs.length - 1],
      cascadeStage: stageConfigs.length - 1,
      result: null,
      options,
      outcome: 'cascade_exhausted',
    });
    throw new LLMCascadeExhausted({ attempted });
  }

  /**
   * Fire-and-forget writer hook — runs only if a `usageWriter` was injected.
   * MUST NOT throw (writer is responsible for its own internal error handling);
   * we wrap in try/catch as defense in depth.
   */
  function emitUsage({ stage, cascadeStage, result, options, outcome }) {
    // Per-call DI wins; falls back to the process-default registered via
    // `setDefaultUsageWriter`. Absent both, the emission is silently dropped.
    const writer = usageWriter || getDefaultUsageWriter();
    if (!writer) return;
    try {
      writer({
        tenant_urn: resolvedConfig.tenant_urn,
        organ: resolvedConfig.organ || 'unknown',
        agent: resolvedConfig.agentName || 'default',
        provider: stage.defaultProvider,
        model: stage.defaultModel,
        tokens_in: result?.input_tokens || result?.usage?.prompt_tokens || 0,
        tokens_out: result?.output_tokens || result?.usage?.completion_tokens || 0,
        cascade_stage: cascadeStage,
        correlation_id: options?.correlation_id,
        outcome,
      });
    } catch {
      /* writer is expected to be fire-and-forget; ignore here */
    }
  }

  return { chat };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a stage config for a fallback entry, inheriting unspecified fields
 * from the primary createLLMClient-shape config. The entry comes from YAML
 * (probabilistic-bucket schema shape: `provider`, `model`, `max_tokens`,
 * `thinking`, `deployment_target`, `api_key_env_var`).
 */
export function buildFallbackStageConfig(primary, fallbackEntry, stageIndex) {
  const out = {
    agentName: `${primary.agentName}-stage-${stageIndex}`,
    organ: primary.organ,
    defaultProvider: fallbackEntry.provider,
    defaultModel: fallbackEntry.model,
    maxTokens:
      fallbackEntry.max_tokens !== undefined
        ? fallbackEntry.max_tokens
        : primary.maxTokens,
    apiKeyEnvVar:
      fallbackEntry.api_key_env_var !== undefined
        ? fallbackEntry.api_key_env_var
        : primary.apiKeyEnvVar,
    tenant_urn: primary.tenant_urn,
  };

  // D9 thinking: fallback entry's block (if present) wins wholesale; else inherit.
  if (fallbackEntry.thinking !== undefined) {
    out.thinking = fallbackEntry.thinking.enabled === true;
    if (
      fallbackEntry.thinking.enabled === true &&
      fallbackEntry.thinking.budget_tokens !== undefined
    ) {
      out.thinkingBudget = fallbackEntry.thinking.budget_tokens;
    }
  } else if (primary.thinking !== undefined) {
    out.thinking = primary.thinking;
    if (primary.thinkingBudget !== undefined) {
      out.thinkingBudget = primary.thinkingBudget;
    }
  }

  // deployment_target → baseUrl (openai-compatible only; harmless on Anthropic).
  if (fallbackEntry.deployment_target) {
    out.baseUrl = `http://${fallbackEntry.deployment_target}`;
  } else if (primary.baseUrl) {
    out.baseUrl = primary.baseUrl;
  }

  return out;
}

/**
 * Remove cascade-level metadata fields from a stage config before passing to
 * `createLLMClient`. Keeps the createLLMClient field whitelist clean (bug #8).
 */
function stripCascadeMeta(stageConfig) {
  const {
    fallback: _fallback,
    cascade_total_timeout_ms: _ttm,
    tenant_urn: _t,
    organ: _o,
    llm_required: _lr,
    ...clientConfig
  } = stageConfig;
  return clientConfig;
}

/**
 * Returns a Promise that rejects after `ms` with a sentinel error so the
 * cascade `chat()` loop can recognize it and raise `LLMCascadeExhausted`.
 * If `ms <= 0` rejects synchronously (next microtask).
 */
function cascadeBudgetTimer(ms) {
  return new Promise((_, reject) => {
    setTimeout(() => {
      const e = new Error('cascade_total_timeout');
      e.__cascadeBudgetExpired = true;
      reject(e);
    }, Math.max(0, ms));
  });
}
