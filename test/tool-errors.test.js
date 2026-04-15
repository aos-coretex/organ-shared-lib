import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOOL_STATUS,
  TOOL_RESPONSE_SCHEMA_VERSION,
  success,
  notImplemented,
  toolNotFound,
  toolError,
  toolTimeout,
  organDegraded,
} from '../lib/tool-errors.js';

describe('tool-errors: TOOL_STATUS enum', () => {
  it('exports all 6 canonical statuses', () => {
    assert.deepEqual(
      Object.keys(TOOL_STATUS).sort(),
      [
        'NOT_IMPLEMENTED',
        'ORGAN_DEGRADED',
        'SUCCESS',
        'TOOL_ERROR',
        'TOOL_NOT_FOUND',
        'TOOL_TIMEOUT',
      ].sort()
    );
  });

  it('is frozen (closed enum)', () => {
    assert.ok(Object.isFrozen(TOOL_STATUS));
    assert.throws(() => { TOOL_STATUS.NEW_STATUS = 'NEW'; }, TypeError);
  });

  it('exports schema version 1.0', () => {
    assert.equal(TOOL_RESPONSE_SCHEMA_VERSION, '1.0');
  });
});

describe('tool-errors: helper constructors', () => {
  it('success() returns SUCCESS payload with data', () => {
    const p = success('graph__get_stats', { concepts: 100 });
    assert.equal(p.event_type, 'tool_call_response');
    assert.equal(p.schema_version, '1.0');
    assert.equal(p.status, 'SUCCESS');
    assert.equal(p.tool, 'graph__get_stats');
    assert.deepEqual(p.data, { concepts: 100 });
    assert.equal(p.meta, undefined);
  });

  it('success() includes optional meta when provided', () => {
    const p = success('graph__query', [], { source: 'cache' });
    assert.deepEqual(p.meta, { source: 'cache' });
  });

  it('notImplemented() returns NOT_IMPLEMENTED with reason citing organ', () => {
    const p = notImplemented('graph__get_stats', 'Graph');
    assert.equal(p.status, 'NOT_IMPLEMENTED');
    assert.equal(p.tool, 'graph__get_stats');
    assert.match(p.reason, /Graph/);
    assert.match(p.reason, /tool_call_request/);
  });

  it('toolNotFound() returns TOOL_NOT_FOUND with reason', () => {
    const p = toolNotFound('graph__bogus', 'Graph');
    assert.equal(p.status, 'TOOL_NOT_FOUND');
    assert.equal(p.tool, 'graph__bogus');
    assert.match(p.reason, /graph__bogus/);
    assert.match(p.reason, /Graph/);
  });

  it('toolError() carries error.code and error.message', () => {
    const p = toolError('graph__query', 'EBADPARAM', 'sql is required', { query_id: 'q1' });
    assert.equal(p.status, 'TOOL_ERROR');
    assert.deepEqual(p.error, { code: 'EBADPARAM', message: 'sql is required' });
    assert.deepEqual(p.meta, { query_id: 'q1' });
  });

  it('toolTimeout() carries elapsed_ms and limit_ms', () => {
    const p = toolTimeout('minder__dream', 30000, 25000);
    assert.equal(p.status, 'TOOL_TIMEOUT');
    assert.equal(p.elapsed_ms, 30000);
    assert.equal(p.limit_ms, 25000);
  });

  it('organDegraded() carries checks_status', () => {
    const p = organDegraded('radiant__store_context', 'db_unreachable');
    assert.equal(p.status, 'ORGAN_DEGRADED');
    assert.equal(p.checks_status, 'db_unreachable');
  });

  it('all helpers stamp event_type and schema_version', () => {
    const payloads = [
      success('t', null),
      notImplemented('t', 'O'),
      toolNotFound('t', 'O'),
      toolError('t', 'E', 'm'),
      toolTimeout('t', 1, 1),
      organDegraded('t', 's'),
    ];
    for (const p of payloads) {
      assert.equal(p.event_type, 'tool_call_response');
      assert.equal(p.schema_version, '1.0');
    }
  });
});
