import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createLiveLoop } from '../lib/live-loop.js';

// --- Mock Spine client ---

function createMockSpine(opts = {}) {
  const state = {
    connected: true,
    drainResult: opts.drainResult || { messages: [] },
    ackedIds: [],
    sentMessages: [],
    connectCalled: false,
    wsCallbacks: null,
  };

  return {
    isConnected: () => state.connected,
    drain: async () => state.drainResult,
    ack: async (ids) => { state.ackedIds.push(...ids); },
    send: async (envelope) => { state.sentMessages.push(envelope); },
    connect: (cbs) => { state.connectCalled = true; state.wsCallbacks = cbs; },
    subscribe: () => {},
    close: () => {},
    _state: state,
  };
}

describe('Live loop engine', () => {
  let loop;

  afterEach(() => {
    if (loop) loop.stop();
  });

  it('drains messages and dispatches to onMessage', async () => {
    const processed = [];
    const spine = createMockSpine({
      drainResult: {
        messages: [
          { message_id: 'msg-1', payload: { x: 1 } },
          { message_id: 'msg-2', payload: { x: 2 } },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async (env) => { processed.push(env.message_id); return null; },
      drainInterval: 50,
    });

    // Wait for a drain cycle
    await new Promise(r => setTimeout(r, 200));

    assert.ok(processed.includes('msg-1'));
    assert.ok(processed.includes('msg-2'));
  });

  it('acks successfully processed messages', async () => {
    const spine = createMockSpine({
      drainResult: {
        messages: [
          { message_id: 'msg-1', payload: {} },
          { message_id: 'msg-2', payload: {} },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async () => null,
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    assert.ok(spine._state.ackedIds.includes('msg-1'));
    assert.ok(spine._state.ackedIds.includes('msg-2'));
  });

  it('skips ack on handler error (message will be redelivered)', async () => {
    let callCount = 0;
    const spine = createMockSpine({
      drainResult: {
        messages: [
          { message_id: 'msg-ok', payload: {} },
          { message_id: 'msg-fail', payload: {} },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async (env) => {
        callCount++;
        if (env.message_id === 'msg-fail') throw new Error('handler failed');
        return null;
      },
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    assert.ok(spine._state.ackedIds.includes('msg-ok'));
    assert.ok(!spine._state.ackedIds.includes('msg-fail'));
  });

  // --- MP-TOOL-1 D1: tool_call_request interception ---

  it('intercepts tool_call_request via toolCallHandler (drain path)', async () => {
    let onMessageCalled = false;
    const spine = createMockSpine({
      drainResult: {
        messages: [
          {
            message_id: 'tcr-1',
            target_organ: 'Graph',
            reply_to: 'mcp-router',
            payload: { event_type: 'tool_call_request', tool: 'graph__get_stats' },
          },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async () => { onMessageCalled = true; return null; },
      toolCallHandler: async (env) => ({
        event_type: 'tool_call_response',
        schema_version: '1.0',
        status: 'SUCCESS',
        tool: env.payload.tool,
        data: { concepts: 42 },
      }),
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    assert.equal(onMessageCalled, false, 'onMessage must not run for tool_call_request');
    // Drain fires repeatedly; every reply must be shaped correctly.
    assert.ok(spine._state.sentMessages.length >= 1);
    for (const reply of spine._state.sentMessages) {
      assert.equal(reply.target_organ, 'mcp-router');
      assert.equal(reply.correlation_id, 'tcr-1');
      assert.equal(reply.payload.status, 'SUCCESS');
      assert.equal(reply.payload.data.concepts, 42);
    }
    assert.ok(spine._state.ackedIds.includes('tcr-1'));
  });

  it('intercepts tool_call_request via WebSocket push path', async () => {
    const spine = createMockSpine();

    loop = createLiveLoop({
      spine,
      onMessage: async () => null,
      toolCallHandler: async (env) => ({
        event_type: 'tool_call_response',
        schema_version: '1.0',
        status: 'NOT_IMPLEMENTED',
        tool: env.payload.tool,
        reason: 'test',
      }),
      drainInterval: 50,
    });

    // Simulate a WS push (bypasses drain)
    await spine._state.wsCallbacks.onMessage({
      message_id: 'ws-1',
      target_organ: 'Graph',
      reply_to: 'mcp-router',
      payload: { event_type: 'tool_call_request', tool: 'graph__bogus' },
    });

    assert.equal(spine._state.sentMessages.length, 1);
    assert.equal(spine._state.sentMessages[0].correlation_id, 'ws-1');
    assert.equal(spine._state.sentMessages[0].payload.status, 'NOT_IMPLEMENTED');
  });

  it('falls through to onMessage when toolCallHandler is absent', async () => {
    let onMessageEnvelope = null;
    const spine = createMockSpine({
      drainResult: {
        messages: [
          {
            message_id: 'tcr-2',
            target_organ: 'Graph',
            reply_to: 'mcp-router',
            payload: { event_type: 'tool_call_request', tool: 'graph__get_stats' },
          },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async (env) => { onMessageEnvelope = env; return null; },
      // no toolCallHandler — should fall through
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    assert.ok(onMessageEnvelope);
    assert.equal(onMessageEnvelope.message_id, 'tcr-2');
  });

  it('acks even when toolCallHandler throws (error-isolated)', async () => {
    const spine = createMockSpine({
      drainResult: {
        messages: [
          {
            message_id: 'tcr-3',
            target_organ: 'Graph',
            reply_to: 'mcp-router',
            payload: { event_type: 'tool_call_request', tool: 'x' },
          },
        ],
      },
    });

    loop = createLiveLoop({
      spine,
      onMessage: async () => null,
      toolCallHandler: async () => { throw new Error('boom'); },
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    // Handler threw but we still ack (the error is isolated + logged; the message
    // is not redelivered, preserving the ping/pong semantics).
    assert.ok(spine._state.ackedIds.includes('tcr-3'));
  });

  it('skips drain when spine disconnected', async () => {
    let drainCalled = false;
    const spine = createMockSpine();
    spine._state.connected = false;
    const originalDrain = spine.drain;
    spine.drain = async () => { drainCalled = true; return originalDrain(); };

    loop = createLiveLoop({
      spine,
      onMessage: async () => null,
      drainInterval: 50,
    });

    await new Promise(r => setTimeout(r, 200));

    assert.equal(drainCalled, false);
  });
});
