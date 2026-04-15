/**
 * Tool-call response error taxonomy — MP-TOOL-1 relay t8r-1.
 *
 * Closed enum of statuses + helper constructors for tool_call_response payloads.
 *
 * ENVELOPE VS PAYLOAD: these helpers return PAYLOAD objects (the `payload` field
 * of a Spine OTM). Envelope wrapping (source_organ / target_organ / correlation_id
 * / message_id) is the responsibility of the live-loop, which converts the payload
 * into a directed `tool_call_response` OTM addressed to `envelope.reply_to` with
 * `correlation_id: envelope.message_id` — matching the existing ping/pong pattern
 * in live-loop.js.
 *
 * The enum is CLOSED. New statuses require an RFI (no silent extension).
 */

/**
 * Closed status enum. Frozen to prevent runtime mutation.
 *
 * SUCCESS           — tool executed; `data` field carries the result.
 * NOT_IMPLEMENTED   — universal fallback; tool name unknown to this organ.
 * TOOL_NOT_FOUND    — tool name known but declared tool does not map to a method.
 * TOOL_ERROR        — tool executed but threw; `error.code` + `error.message` carry detail.
 * TOOL_TIMEOUT      — per-tool timeout exceeded (distinct from MCP-Router envelope timeout).
 * ORGAN_DEGRADED    — organ's health `checks.status !== 'ok'`; fail-closed for callers.
 */
export const TOOL_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ERROR: 'TOOL_ERROR',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  ORGAN_DEGRADED: 'ORGAN_DEGRADED',
});

const SCHEMA_VERSION = '1.0';

/**
 * Build a SUCCESS response payload.
 *
 * @param {string} tool          — canonical tool name (e.g. "graph__get_stats")
 * @param {unknown} data         — tool result; carried as-is (no re-wrapping)
 * @param {object} [meta]        — optional metadata (timings, source, etc.)
 * @returns {object} tool_call_response payload
 */
export function success(tool, data, meta) {
  const payload = {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.SUCCESS,
    tool,
    data,
  };
  if (meta !== undefined) payload.meta = meta;
  return payload;
}

/**
 * Build a NOT_IMPLEMENTED fallback payload.
 *
 * Used by the universal fallback handler when an organ has not registered
 * a `toolCallHandler` and receives a tool_call_request.
 */
export function notImplemented(tool, organ) {
  return {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.NOT_IMPLEMENTED,
    tool,
    reason: `Organ ${organ} does not implement tool_call_request`,
  };
}

/**
 * Build a TOOL_NOT_FOUND payload.
 *
 * Used when the organ has a toolCallHandler but the specific tool name does
 * not map to a declared method in tool-declarations.json.
 */
export function toolNotFound(tool, organ) {
  return {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.TOOL_NOT_FOUND,
    tool,
    reason: `Tool ${tool} is not registered for organ ${organ}`,
  };
}

/**
 * Build a TOOL_ERROR payload for a method that threw.
 *
 * @param {string} tool
 * @param {string} code         — short, grep-able error code (e.g. "EBADPARAM")
 * @param {string} message      — human-readable message (never include secrets)
 * @param {object} [meta]       — optional diagnostic data
 */
export function toolError(tool, code, message, meta) {
  const payload = {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.TOOL_ERROR,
    tool,
    error: { code, message },
  };
  if (meta !== undefined) payload.meta = meta;
  return payload;
}

/**
 * Build a TOOL_TIMEOUT payload.
 *
 * Per-tool timeout policy (RFI-1 reply): the declared `timeout_ms` in
 * tool-declarations.json is the absolute limit. Invariant asserted by R1:
 * `tool.timeout_ms ≤ organ.timeout_ms - 2000ms` so the handler's TOOL_TIMEOUT
 * always fires before the MCP-Router envelope times out.
 *
 * @param {string} tool
 * @param {number} elapsedMs    — actual elapsed time before timeout
 * @param {number} limitMs      — declared timeout limit
 */
export function toolTimeout(tool, elapsedMs, limitMs) {
  return {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.TOOL_TIMEOUT,
    tool,
    elapsed_ms: elapsedMs,
    limit_ms: limitMs,
  };
}

/**
 * Build an ORGAN_DEGRADED payload (fail-closed for callers).
 *
 * Called when the organ's health checks report a non-ok status; tool execution
 * is refused rather than returning partial/incorrect data.
 */
export function organDegraded(tool, checksStatus) {
  return {
    event_type: 'tool_call_response',
    schema_version: SCHEMA_VERSION,
    status: TOOL_STATUS.ORGAN_DEGRADED,
    tool,
    checks_status: checksStatus,
  };
}

/** Schema version exported for consumers that stamp metadata. */
export const TOOL_RESPONSE_SCHEMA_VERSION = SCHEMA_VERSION;
