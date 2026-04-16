/**
 * Budget policy interception point — MP-CONFIG-1 relay l9m-9.
 *
 * This module is the SCAFFOLD for per-tenant ceiling enforcement. The
 * default policy always returns `{ action: 'allow' }`. Enforcement is not
 * activated by this relay. A future MP installs a ceiling-enforcing policy
 * via `setPolicy()` once ceiling storage, source-of-truth, and activation
 * triggers are ruled on.
 *
 * Location rationale: this module lives in `organ-shared-lib` because the
 * live `llm.chat()` call path goes through the shared-lib cascade wrapper
 * (see `llm-cascade.js`), and ModelBroker is currently a deterministic
 * routing scaffold (no LLM execution). ModelBroker source is documented as
 * the future owner of the policy-evaluator; when it assumes the LLM-call
 * path it can re-export the same module:
 *
 *   // ModelBroker re-export pattern:
 *   export { evaluateBudgetPolicy, setPolicy, getPolicy } from '@coretex/organ-boot/budget-policy';
 *
 * Import:
 *   import { evaluateBudgetPolicy } from '@coretex/organ-boot/budget-policy';
 *
 * Default contract:
 *   evaluateBudgetPolicy({ tenant_urn, estimated_cost_usd, context })
 *     → { action: 'allow' | 'cascade' | 'deny', reason: string }
 *
 * Caller dispatch (reserved for future enforcement):
 *   - 'allow':   proceed with the chat call (current default behavior).
 *   - 'cascade': skip the primary, jump to the next fallback stage (cheaper).
 *   - 'deny':    raise `BudgetExceeded` with the policy's reason.
 */

function defaultPolicy(/* { tenant_urn, estimated_cost_usd, context } */) {
  return { action: 'allow', reason: 'default-policy-no-ceiling-set' };
}

let activePolicy = defaultPolicy;

/**
 * Evaluate the active budget policy for a prospective chat call.
 *
 * The caller is expected to respect the returned action. In this relay's
 * wiring the cascade wrapper does NOT act on the action (default allow is
 * always returned); the wiring is present so that a future MP installs a
 * real policy via `setPolicy()` and the same call site starts enforcing
 * without further code changes in the hot path.
 *
 * @param {object} args
 * @param {string}   args.tenant_urn           — per MP-17 #35 canonical form
 *                                                (`urn:llm-ops:entity:<slug>`)
 * @param {number}   args.estimated_cost_usd   — projected call cost
 * @param {object}  [args.context]             — opaque hints from the caller:
 *                                                `{ organ, agent, model, provider,
 *                                                   cascade_stage, tokens_in_hint }`
 * @returns {{ action: 'allow' | 'cascade' | 'deny', reason: string }}
 */
export function evaluateBudgetPolicy(args) {
  try {
    return activePolicy(args);
  } catch (err) {
    // A broken policy must not kill the chat call. Fail-open with a reason.
    return { action: 'allow', reason: `policy-evaluator-error:${err.message}` };
  }
}

/**
 * Swap the active policy function. The provided function must return a
 * `{ action, reason }` object; any thrown error is caught by
 * `evaluateBudgetPolicy` and converted to a fail-open `allow`.
 *
 * Reserved for: a future MP that authors a ceiling-enforcing policy once
 * ceiling storage + source-of-truth are ruled on.
 */
export function setPolicy(policyFn) {
  if (typeof policyFn !== 'function') {
    throw new TypeError('setPolicy: policy must be a function (args) => { action, reason }');
  }
  activePolicy = policyFn;
}

/**
 * Get the currently-active policy function. Exposed for tests (assert that
 * `setPolicy()` actually swapped the function) and for introspection.
 */
export function getPolicy() {
  return activePolicy;
}

/**
 * Reset to the default `allow` policy. For test isolation.
 */
export function resetPolicy() {
  activePolicy = defaultPolicy;
}
