import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateToolResponse,
  isToolResponse,
  TOOL_RESPONSE_SCHEMA,
} from '../lib/tool-response-schema.js';
import {
  success,
  notImplemented,
  toolNotFound,
  toolError,
  toolTimeout,
  organDegraded,
} from '../lib/tool-errors.js';

describe('tool-response-schema: positive fixtures', () => {
  it('validates SUCCESS payload (via helper)', () => {
    assert.equal(validateToolResponse(success('graph__get_stats', { x: 1 })), true);
  });
  it('validates NOT_IMPLEMENTED payload', () => {
    assert.equal(validateToolResponse(notImplemented('graph__x', 'Graph')), true);
  });
  it('validates TOOL_NOT_FOUND payload', () => {
    assert.equal(validateToolResponse(toolNotFound('graph__x', 'Graph')), true);
  });
  it('validates TOOL_ERROR payload', () => {
    assert.equal(validateToolResponse(toolError('t', 'E1', 'm1')), true);
  });
  it('validates TOOL_TIMEOUT payload', () => {
    assert.equal(validateToolResponse(toolTimeout('t', 100, 50)), true);
  });
  it('validates ORGAN_DEGRADED payload', () => {
    assert.equal(validateToolResponse(organDegraded('t', 'degraded')), true);
  });
  it('isToolResponse returns true for valid payloads', () => {
    assert.equal(isToolResponse(success('t', null)), true);
  });
});

describe('tool-response-schema: negative fixtures', () => {
  it('rejects non-object payloads', () => {
    assert.throws(() => validateToolResponse(null), /plain object/);
    assert.throws(() => validateToolResponse('string'), /plain object/);
    assert.throws(() => validateToolResponse([]), /plain object/);
  });

  it('rejects wrong event_type', () => {
    const p = { ...success('t', null), event_type: 'ping' };
    assert.throws(() => validateToolResponse(p), /event_type/);
  });

  it('rejects wrong schema_version', () => {
    const p = { ...success('t', null), schema_version: '0.9' };
    assert.throws(() => validateToolResponse(p), /schema_version/);
  });

  it('rejects missing tool field', () => {
    const p = success('t', null);
    delete p.tool;
    assert.throws(() => validateToolResponse(p), /tool/);
  });

  it('rejects unknown status', () => {
    const p = { ...success('t', null), status: 'BOGUS' };
    assert.throws(() => validateToolResponse(p), /status/);
  });

  it('rejects extra unknown fields', () => {
    const p = { ...success('t', null), wat: 1 };
    assert.throws(() => validateToolResponse(p), /unknown field/);
  });

  it('SUCCESS without data field is invalid', () => {
    const p = success('t', null);
    delete p.data;
    assert.throws(() => validateToolResponse(p), /SUCCESS requires/);
  });

  it('TOOL_ERROR without error.code is invalid', () => {
    const p = toolError('t', 'E', 'm');
    delete p.error.code;
    assert.throws(() => validateToolResponse(p), /error.code/);
  });

  it('TOOL_TIMEOUT with non-numeric elapsed_ms is invalid', () => {
    const p = toolTimeout('t', 1, 2);
    p.elapsed_ms = 'not-a-number';
    assert.throws(() => validateToolResponse(p), /elapsed_ms/);
  });

  it('isToolResponse returns false for invalid payloads', () => {
    assert.equal(isToolResponse(null), false);
    assert.equal(isToolResponse({ status: 'BOGUS' }), false);
  });
});

describe('tool-response-schema: documentation object', () => {
  it('TOOL_RESPONSE_SCHEMA is frozen and describes the contract', () => {
    assert.ok(Object.isFrozen(TOOL_RESPONSE_SCHEMA));
    assert.equal(TOOL_RESPONSE_SCHEMA.$id, 'https://coretex.llm-ops/schemas/tool-call-response/1.0');
    assert.equal(TOOL_RESPONSE_SCHEMA.properties.event_type.const, 'tool_call_response');
  });
});
