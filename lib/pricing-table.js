/**
 * LLM pricing table — MP-CONFIG-1 relay l9m-9.
 *
 * Per-model rates are published by the model vendor. The `estimateCost`
 * function converts a token usage pair into a USD cost estimate. The rates
 * are intentionally stored as a JavaScript map (not fetched at runtime) so
 * `estimateCost` stays synchronous and deterministic for use inside the
 * cascade wrapper's post-call hook.
 *
 * Source of Anthropic rates (snapshot 2026-04-15):
 *   https://www.anthropic.com/pricing
 *   - Claude Opus 4.x:    $15/M input, $75/M output
 *   - Claude Sonnet 4.x:  $3/M input,  $15/M output
 *   - Claude Haiku 4.5:   $1/M input,  $5/M output
 *
 * Rates stored per-million-tokens for precision. `estimateCost()` converts.
 *
 * OpenAI-compatible / local inference (vLLM, TGI, llama.cpp) → 0 cost.
 * Operators may override via `setPricing()` when metering power / hardware.
 *
 * Unknown model → 0 cost + a warning log entry (non-throwing). Returning 0
 * ensures cascade observability never breaks when a new model enters the
 * fleet before the table is updated; the warning flags the gap.
 */

const ANTHROPIC_RATES_PER_MILLION = {
  // Opus family
  'claude-opus-4-6':        { input: 15.0, output: 75.0 },
  'claude-opus-4-5':        { input: 15.0, output: 75.0 },
  // Sonnet family (bare form canonical per R1 per-family table)
  'claude-sonnet-4-6':      { input: 3.0, output: 15.0 },
  'claude-sonnet-4-5':      { input: 3.0, output: 15.0 },
  // Haiku family (dated suffix canonical per R1 per-family table)
  'claude-haiku-4-5-20251001': { input: 1.0, output: 5.0 },
};

// Mutable copy so tests / operators can override.
let activePricing = { ...ANTHROPIC_RATES_PER_MILLION };

/**
 * Replace the active pricing table (full replacement, not merge).
 * Exported for tests and for operator override at boot. Callers that want
 * to merge should spread the default table explicitly:
 *   setPricing({ ...getPricing(), 'my-local-model': { input: 0, output: 0 } })
 */
export function setPricing(newTable) {
  activePricing = { ...newTable };
}

export function getPricing() {
  return { ...activePricing };
}

/**
 * Reset to the snapshot rates. Mostly used by tests between cases.
 */
export function resetPricing() {
  activePricing = { ...ANTHROPIC_RATES_PER_MILLION };
}

/**
 * Estimate the USD cost of a chat call given the model and token usage.
 *
 * @param {object} args
 * @param {string} args.model        — model string from the resolved config (bug #11 canonical form)
 * @param {string} [args.provider]   — 'anthropic' | 'openai-compatible' | 'huggingface-autoprovision'
 * @param {number} args.tokens_in    — prompt tokens
 * @param {number} args.tokens_out   — completion tokens
 * @returns {number} cost in USD (float, non-negative)
 */
export function estimateCost({ model, provider, tokens_in = 0, tokens_out = 0 }) {
  // Local inference: 0 $ cost by default. Operators may override by
  // calling setPricing() with a table that includes their local model.
  if (provider && provider !== 'anthropic' && !(model in activePricing)) {
    return 0;
  }

  const rate = activePricing[model];
  if (!rate) {
    // Unknown model — non-throwing zero cost + structured log so the gap is visible.
    const entry = { timestamp: new Date().toISOString(), event: 'pricing_table_unknown_model', model, provider };
    try { process.stdout.write(JSON.stringify(entry) + '\n'); } catch { /* test env may not have stdout */ }
    return 0;
  }

  const inCost = (tokens_in / 1_000_000) * rate.input;
  const outCost = (tokens_out / 1_000_000) * rate.output;
  return inCost + outCost;
}
