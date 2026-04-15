/**
 * tool_call_response payload schema — MP-TOOL-1 relay t8r-1, schema_version 1.0.
 *
 * Shared-lib convention: plain regex + throwing validators (see governance-urn.js,
 * statute-cascade.js). No external schema library (ajv/zod/json-schema).
 *
 * This module exports:
 *   - TOOL_RESPONSE_SCHEMA       — a JSON-Schema-shaped object for documentation
 *                                  and external consumers (MCP-Router, CV runner).
 *   - validateToolResponse(p)    — throws TypeError on invalid payload; returns true.
 *   - isToolResponse(p)          — boolean variant that swallows the error.
 *
 * The schema validates the PAYLOAD (the `payload` field of a Spine OTM), NOT the
 * OTM envelope. Envelope validation is Spine's job.
 *
 * Conditional field rules by status:
 *   SUCCESS         → requires `data`
 *   NOT_IMPLEMENTED → requires `reason`
 *   TOOL_NOT_FOUND  → requires `reason`
 *   TOOL_ERROR      → requires `error.code` + `error.message`
 *   TOOL_TIMEOUT    → requires `elapsed_ms` + `limit_ms` (both numbers)
 *   ORGAN_DEGRADED  → requires `checks_status`
 *
 * D7 reminder: tool methods MUST NOT emit Spine OTMs. Responses carry no nested
 * envelope structures — only structured data retrieved via HTTP.
 */

import { TOOL_STATUS, TOOL_RESPONSE_SCHEMA_VERSION } from './tool-errors.js';

/**
 * JSON-Schema-shaped documentation object. Not used internally for validation
 * (shared-lib has no ajv) but exported for external tooling and humans.
 */
export const TOOL_RESPONSE_SCHEMA = Object.freeze({
  $id: 'https://coretex.llm-ops/schemas/tool-call-response/1.0',
  type: 'object',
  required: ['event_type', 'schema_version', 'status', 'tool'],
  properties: {
    event_type: { const: 'tool_call_response' },
    schema_version: { const: TOOL_RESPONSE_SCHEMA_VERSION },
    status: { enum: Object.values(TOOL_STATUS) },
    tool: { type: 'string', minLength: 1 },
    data: {}, // any type — only required for SUCCESS
    reason: { type: 'string' }, // required for NOT_IMPLEMENTED + TOOL_NOT_FOUND
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string', minLength: 1 },
        message: { type: 'string' },
      },
    },
    elapsed_ms: { type: 'number', minimum: 0 },
    limit_ms: { type: 'number', minimum: 0 },
    checks_status: { type: 'string' },
    meta: { type: 'object' },
  },
  additionalProperties: false,
});

const ALLOWED_KEYS = new Set([
  'event_type',
  'schema_version',
  'status',
  'tool',
  'data',
  'reason',
  'error',
  'elapsed_ms',
  'limit_ms',
  'checks_status',
  'meta',
]);

function fail(msg) {
  throw new TypeError(`tool_call_response: ${msg}`);
}

/**
 * Validate a tool_call_response payload. Throws TypeError on invalid input.
 * Returns `true` on success so it composes cleanly in assertions.
 *
 * @param {unknown} payload
 * @returns {true}
 */
export function validateToolResponse(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    fail('payload must be a plain object');
  }

  // Extra-keys check
  for (const key of Object.keys(payload)) {
    if (!ALLOWED_KEYS.has(key)) fail(`unknown field "${key}"`);
  }

  if (payload.event_type !== 'tool_call_response') {
    fail(`event_type must be "tool_call_response" (got ${JSON.stringify(payload.event_type)})`);
  }
  if (payload.schema_version !== TOOL_RESPONSE_SCHEMA_VERSION) {
    fail(
      `schema_version must be "${TOOL_RESPONSE_SCHEMA_VERSION}" (got ${JSON.stringify(
        payload.schema_version
      )})`
    );
  }
  if (typeof payload.tool !== 'string' || payload.tool.length === 0) {
    fail('tool must be a non-empty string');
  }

  const validStatuses = Object.values(TOOL_STATUS);
  if (!validStatuses.includes(payload.status)) {
    fail(`status must be one of ${validStatuses.join('|')} (got ${JSON.stringify(payload.status)})`);
  }

  // Conditional-field validation per status.
  switch (payload.status) {
    case TOOL_STATUS.SUCCESS:
      if (!('data' in payload)) fail('SUCCESS requires `data` field');
      break;
    case TOOL_STATUS.NOT_IMPLEMENTED:
      if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
        fail('NOT_IMPLEMENTED requires `reason` string');
      }
      break;
    case TOOL_STATUS.TOOL_NOT_FOUND:
      if (typeof payload.reason !== 'string' || payload.reason.length === 0) {
        fail('TOOL_NOT_FOUND requires `reason` string');
      }
      break;
    case TOOL_STATUS.TOOL_ERROR: {
      const err = payload.error;
      if (!err || typeof err !== 'object' || Array.isArray(err)) {
        fail('TOOL_ERROR requires `error` object');
      }
      if (typeof err.code !== 'string' || err.code.length === 0) {
        fail('TOOL_ERROR requires `error.code` non-empty string');
      }
      if (typeof err.message !== 'string') {
        fail('TOOL_ERROR requires `error.message` string');
      }
      break;
    }
    case TOOL_STATUS.TOOL_TIMEOUT:
      if (typeof payload.elapsed_ms !== 'number' || payload.elapsed_ms < 0) {
        fail('TOOL_TIMEOUT requires `elapsed_ms` non-negative number');
      }
      if (typeof payload.limit_ms !== 'number' || payload.limit_ms < 0) {
        fail('TOOL_TIMEOUT requires `limit_ms` non-negative number');
      }
      break;
    case TOOL_STATUS.ORGAN_DEGRADED:
      if (typeof payload.checks_status !== 'string' || payload.checks_status.length === 0) {
        fail('ORGAN_DEGRADED requires `checks_status` string');
      }
      break;
    default:
      fail(`unreachable: unhandled status ${payload.status}`);
  }

  if ('meta' in payload) {
    if (payload.meta === null || typeof payload.meta !== 'object' || Array.isArray(payload.meta)) {
      fail('meta must be a plain object when present');
    }
  }

  return true;
}

/** Boolean variant — returns true/false instead of throwing. */
export function isToolResponse(payload) {
  try {
    return validateToolResponse(payload);
  } catch {
    return false;
  }
}
