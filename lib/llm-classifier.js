/**
 * Pure failure classifier — MP-CONFIG-1 relay l9m-2.
 *
 * Maps raw `Error` instances to the closed enum of D4 + D5 failure classes
 * defined by `lib/llm-settings-schema.js`. No network. No side effects. Pure.
 *
 * Subpath import:
 *   `import { classifyLLMFailure, FAILURE_CLASSES } from '@coretex/organ-boot/llm-classifier';`
 *
 * The cascade executor (R4) consumes this — given an error from `llm.chat()`,
 * it calls `classifyLLMFailure(err, { provider, baseUrl, duringStream })` and
 * branches on the returned `class` + `fallback_eligible`. R4 is the policy;
 * this module is the recognition.
 *
 * Detection precedence (most-specific first):
 *   1. Connection refused          (ECONNREFUSED on err / err.cause)
 *   2. Timeout                     (AbortError, ETIMEDOUT) — split into
 *                                  `timeout_during_streaming` if context.duringStream
 *   3. HTTP 503                    (status === 503 OR body matches model-not-loaded patterns)
 *   4. HTTP 429                    (status === 429)
 *   5. Model not loaded            (body matches loading patterns; status agnostic)
 *   6. HTTP 5xx (other)            (status >= 500)
 *   7. Context length exceeded     (body matches "context_length_exceeded" / equivalents)
 *   8. Content filter triggered    (body matches "content_policy" / "content_filter" / safety)
 *   9. Parse error                 (SyntaxError / "Unexpected token" / "JSON" parse text)
 *  10. HTTP 4xx                    (status >= 400 && < 500)
 *  11. Unknown                     (no pattern matched — fail-closed for safety)
 *
 * Note ordering: `model_not_loaded` body pattern is matched BEFORE generic 5xx
 * because vLLM/TGI return 503 with that body. The 503 case alone (without the
 * pattern) keeps `http_503` so the cascade still tries the next stage.
 */

/**
 * Closed enum of all possible classifier outputs (D4 ∪ D5 ∪ {unknown}).
 * Frozen for runtime stability. Referenced by R4 cascade tests + R12 conformance.
 */
export const FAILURE_CLASSES = Object.freeze({
  // D4 — cascade-eligible
  CONNECTION_REFUSED: 'connection_refused',
  CONNECTION_TIMEOUT: 'connection_timeout',
  HTTP_5XX: 'http_5xx',
  HTTP_503: 'http_503',
  HTTP_429: 'http_429',
  MODEL_NOT_LOADED: 'model_not_loaded',
  TIMEOUT_DURING_STREAMING: 'timeout_during_streaming',
  // D5 — fail-closed
  HTTP_4XX: 'http_4xx',
  PARSE_ERROR: 'parse_error',
  CONTEXT_LENGTH_EXCEEDED: 'context_length_exceeded',
  CONTENT_FILTER_TRIGGERED: 'content_filter_triggered',
  // Sentinel
  UNKNOWN: 'unknown',
});

/** Patterns recognized as "model not loaded" across providers (vLLM/TGI/llama.cpp). */
const MODEL_NOT_LOADED_PATTERNS = [
  /model[\s_-]+not[\s_-]+loaded/i,
  /model[\s_-]+is[\s_-]+loading/i,
  /model[\s_-]+not[\s_-]+yet[\s_-]+loaded/i,
  /no[\s_-]+model[\s_-]+loaded/i,
  /model[\s_-]+unavailable/i,
];

const CONTEXT_LENGTH_PATTERNS = [
  /context[\s_-]+length[\s_-]+exceeded/i,
  /maximum[\s_-]+context/i,
  /context[\s_-]+window/i,
  /too[\s_-]+many[\s_-]+tokens/i,
  /prompt[\s_-]+is[\s_-]+too[\s_-]+long/i,
];

const CONTENT_FILTER_PATTERNS = [
  /content[\s_-]+policy/i,
  /content[\s_-]+filter/i,
  /safety[\s_-]+filter/i,
  /content[_-]?policy[_-]?violation/i,
  /refus(ed|al)/i, // some moderated providers
];

const PARSE_ERROR_PATTERNS = [
  /unexpected[\s_-]+token/i,
  /unexpected[\s_-]+end[\s_-]+of[\s_-]+json/i,
  /JSON\.parse/i,
  /invalid[\s_-]+json/i,
];

/**
 * Read a numeric HTTP status from an Error or its cause chain.
 * The hardened `callOpenAICompatible` (R2) attaches `.status` directly.
 * Older Anthropic-path errors carry the status only in the message text
 * (`"Anthropic API 503: ..."`); we extract it as a fallback.
 */
function readStatus(err) {
  if (!err) return null;
  if (Number.isInteger(err.status)) return err.status;
  if (err.cause && Number.isInteger(err.cause.status)) return err.cause.status;
  // Message text fallback — match a 3-digit status after a known prefix.
  const m = (err.message || '').match(/\b(?:API|status|HTTP)\s+(\d{3})\b/i);
  if (m) return parseInt(m[1], 10);
  // Loose fallback — `"... API 503: ..."` shape used by current llm-client.js.
  const m2 = (err.message || '').match(/\bAPI\s+(\d{3})\b/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/**
 * Read the HTTP response body text from an Error or its cause chain.
 * Hardened R2 errors expose `.body`. Anthropic legacy errors include the body
 * inline in the message after the status (`"... 503: <body>"`).
 */
function readBody(err) {
  if (!err) return '';
  if (typeof err.body === 'string') return err.body;
  if (err.cause && typeof err.cause.body === 'string') return err.cause.body;
  return err.message || '';
}

/**
 * Read the underlying Node `code` (e.g., `'ECONNREFUSED'`, `'ETIMEDOUT'`) from
 * an Error or its cause chain. Node's fetch wraps undici errors as `TypeError`
 * with a `cause: { code }` chain.
 */
function readSyscallCode(err) {
  if (!err) return null;
  if (typeof err.code === 'string' && /^E[A-Z]+$/.test(err.code)) return err.code;
  if (err.cause) return readSyscallCode(err.cause);
  return null;
}

function isAbortError(err) {
  if (!err) return false;
  if (err.name === 'AbortError') return true;
  if (err.cause) return isAbortError(err.cause);
  return false;
}

function isSyntaxError(err) {
  if (!err) return false;
  if (err instanceof SyntaxError) return true;
  if (err.cause) return isSyntaxError(err.cause);
  return false;
}

/**
 * Classify a raw Error from an LLM call into a D4/D5 failure class.
 *
 * @param {Error} err          — the thrown error
 * @param {object} [context]   — optional hints
 * @param {string} [context.provider]      — `'anthropic'` | `'openai-compatible'` | `'huggingface-autoprovision'`
 * @param {string} [context.baseUrl]       — for diagnostics; not used for classification
 * @param {boolean} [context.duringStream] — set by R4 (or future streaming layer) when a timeout fires mid-stream
 * @returns {{class: string, fallback_eligible: boolean}}
 */
export function classifyLLMFailure(err, context = {}) {
  if (!err) {
    return { class: FAILURE_CLASSES.UNKNOWN, fallback_eligible: false };
  }

  // 1. Connection refused — local server down (vLLM/TGI/llama.cpp), or remote port closed.
  const syscall = readSyscallCode(err);
  if (syscall === 'ECONNREFUSED' || /ECONNREFUSED/.test(err.message || '')) {
    return { class: FAILURE_CLASSES.CONNECTION_REFUSED, fallback_eligible: true };
  }

  // 2. Timeout — split by streaming context.
  if (
    syscall === 'ETIMEDOUT' ||
    syscall === 'UND_ERR_CONNECT_TIMEOUT' ||
    syscall === 'UND_ERR_HEADERS_TIMEOUT' ||
    isAbortError(err) ||
    /\btimed?[\s_-]?out\b/i.test(err.message || '')
  ) {
    if (context.duringStream) {
      return { class: FAILURE_CLASSES.TIMEOUT_DURING_STREAMING, fallback_eligible: true };
    }
    return { class: FAILURE_CLASSES.CONNECTION_TIMEOUT, fallback_eligible: true };
  }

  const status = readStatus(err);
  const body = readBody(err);

  // 3. HTTP 503 — service unavailable. May carry "model not loaded" pattern;
  //    we still return http_503 (the more specific status) unless the body
  //    explicitly matches a model-loading pattern, in which case
  //    `model_not_loaded` is more diagnostic for R4 + R12 telemetry.
  if (status === 503) {
    for (const re of MODEL_NOT_LOADED_PATTERNS) {
      if (re.test(body)) {
        return { class: FAILURE_CLASSES.MODEL_NOT_LOADED, fallback_eligible: true };
      }
    }
    return { class: FAILURE_CLASSES.HTTP_503, fallback_eligible: true };
  }

  // 4. HTTP 429 — rate limited.
  if (status === 429) {
    return { class: FAILURE_CLASSES.HTTP_429, fallback_eligible: true };
  }

  // 5. Model not loaded (body match without 503 — some providers return 200/400).
  for (const re of MODEL_NOT_LOADED_PATTERNS) {
    if (re.test(body)) {
      return { class: FAILURE_CLASSES.MODEL_NOT_LOADED, fallback_eligible: true };
    }
  }

  // 6. Generic 5xx.
  if (Number.isInteger(status) && status >= 500 && status < 600) {
    return { class: FAILURE_CLASSES.HTTP_5XX, fallback_eligible: true };
  }

  // 7. Context length exceeded.
  for (const re of CONTEXT_LENGTH_PATTERNS) {
    if (re.test(body)) {
      return { class: FAILURE_CLASSES.CONTEXT_LENGTH_EXCEEDED, fallback_eligible: false };
    }
  }

  // 8. Content filter / policy.
  for (const re of CONTENT_FILTER_PATTERNS) {
    if (re.test(body)) {
      return { class: FAILURE_CLASSES.CONTENT_FILTER_TRIGGERED, fallback_eligible: false };
    }
  }

  // 9. JSON parse error.
  if (isSyntaxError(err)) {
    return { class: FAILURE_CLASSES.PARSE_ERROR, fallback_eligible: false };
  }
  for (const re of PARSE_ERROR_PATTERNS) {
    if (re.test(err.message || '')) {
      return { class: FAILURE_CLASSES.PARSE_ERROR, fallback_eligible: false };
    }
  }

  // 10. Generic 4xx.
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return { class: FAILURE_CLASSES.HTTP_4XX, fallback_eligible: false };
  }

  // 11. Unknown — fail-closed for safety.
  return { class: FAILURE_CLASSES.UNKNOWN, fallback_eligible: false };
}
