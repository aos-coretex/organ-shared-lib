/**
 * Universal tool_call_request fallback handler — MP-TOOL-1 relay t8r-1.
 *
 * Binding decision D1: every organ gets a factory-registered default handler that
 * returns `NOT_IMPLEMENTED` when the organ has not provided its own
 * `toolCallHandler` in `createOrgan(config)`. Per-organ handlers (R2–R6) override
 * by passing `config.toolCallHandler`.
 *
 * ENVELOPE VS PAYLOAD: this module returns PAYLOAD objects. The live-loop wraps
 * them into directed `tool_call_response` OTMs addressed to `envelope.reply_to`
 * with `correlation_id: envelope.message_id`, mirroring the ping/pong pattern
 * at live-loop.js:54-75.
 *
 * The handler is a pure function of (envelope, organName) → payload. No side
 * effects, no I/O, no Spine calls — the live-loop owns all wire interactions.
 */

import { notImplemented } from './tool-errors.js';

/**
 * Extract the tool name from a tool_call_request envelope.
 *
 * The expected payload shape is:
 *   { event_type: 'tool_call_request', tool: '<organ>__<action>', params: {...} }
 *
 * If the payload is malformed, returns 'unknown' so the fallback still emits a
 * well-formed response and doesn't throw (live-loop's error isolation already
 * handles throws, but returning a response is cleaner — the caller's
 * correlation_id still round-trips).
 */
function extractTool(envelope) {
  const tool = envelope?.payload?.tool;
  return typeof tool === 'string' && tool.length > 0 ? tool : 'unknown';
}

/**
 * Build a NOT_IMPLEMENTED response payload for a given envelope.
 *
 * @param {object} envelope     — inbound tool_call_request OTM envelope
 * @param {string} organName    — the organ's name (from createOrgan config.name)
 * @returns {object} tool_call_response payload
 */
export function toolFallbackHandler(envelope, organName) {
  const tool = extractTool(envelope);
  return notImplemented(tool, organName);
}

/**
 * Factory variant — returns a handler pre-bound to an organ name. This is the
 * shape `createOrgan` uses when registering the default; the live-loop calls
 * the bound handler with just the envelope.
 */
export function createToolFallbackHandler(organName) {
  return (envelope) => toolFallbackHandler(envelope, organName);
}
