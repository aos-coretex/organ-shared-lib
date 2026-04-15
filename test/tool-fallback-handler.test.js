import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toolFallbackHandler,
  createToolFallbackHandler,
} from '../lib/tool-fallback-handler.js';
import { validateToolResponse } from '../lib/tool-response-schema.js';

describe('tool-fallback-handler', () => {
  it('returns NOT_IMPLEMENTED payload with organ name embedded', () => {
    const envelope = {
      message_id: 'msg-1',
      target_organ: 'Graph',
      reply_to: 'mcp-router',
      payload: { event_type: 'tool_call_request', tool: 'graph__get_stats', params: {} },
    };
    const out = toolFallbackHandler(envelope, 'Graph');
    assert.equal(out.status, 'NOT_IMPLEMENTED');
    assert.equal(out.tool, 'graph__get_stats');
    assert.match(out.reason, /Graph/);
  });

  it('produces a payload that passes schema validation', () => {
    const envelope = { payload: { event_type: 'tool_call_request', tool: 'x__y' } };
    const out = toolFallbackHandler(envelope, 'X');
    assert.equal(validateToolResponse(out), true);
  });

  it('falls back to tool name "unknown" when payload is malformed', () => {
    const out = toolFallbackHandler({}, 'Minder');
    assert.equal(out.status, 'NOT_IMPLEMENTED');
    assert.equal(out.tool, 'unknown');
  });

  it('createToolFallbackHandler binds organ name', () => {
    const handler = createToolFallbackHandler('Radiant');
    const out = handler({ payload: { event_type: 'tool_call_request', tool: 'radiant__promote' } });
    assert.equal(out.status, 'NOT_IMPLEMENTED');
    assert.match(out.reason, /Radiant/);
  });

  it('handler is a pure function (no side effects)', () => {
    const handler = createToolFallbackHandler('Syntra');
    const env = { payload: { event_type: 'tool_call_request', tool: 'syntra__ingest' } };
    const a = handler(env);
    const b = handler(env);
    assert.deepEqual(a, b);
  });
});
