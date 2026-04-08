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
