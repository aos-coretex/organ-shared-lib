/**
 * Enhanced Spine client library for organ developers.
 *
 * Provides HTTP methods (send, drain, ack, register, health, introspect, consumers)
 * and WebSocket connection with auto-reconnect, heartbeat monitoring, and
 * separate onMessage/onBroadcast dispatch.
 *
 * Wire-compatible with Spine ESB WebSocket protocol:
 *   - register: { action: "register", organ_name }
 *   - subscribe: { action: "subscribe", filter }
 *   - unsubscribe: { action: "unsubscribe", filter }
 *   - ack: { action: "ack", message_ids }
 *   - inbound: { action: "message", envelope }
 *
 * Usage:
 *   import { createSpineClient } from '@coretex/organ-boot/spine-client';
 *   const spine = createSpineClient({ serverUrl: 'http://127.0.0.1:4000', organName: 'Vigil' });
 *   await spine.register();
 *   spine.connect({ onMessage, onBroadcast });
 */

import WebSocket from 'ws';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

export function createSpineClient(opts = {}) {
  const serverUrl = opts.serverUrl || 'http://127.0.0.1:4000';
  const organName = opts.organName;

  // WebSocket state
  let ws = null;
  let connected = false;
  let intentionalClose = false;
  let callbacks = null;
  let subscriptionFilters = [];

  // Reconnect state
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  const MAX_RECONNECT_DELAY = 30_000;

  // Heartbeat state
  let pingTimer = null;
  let missedPongs = 0;
  const PING_INTERVAL = 30_000;
  const MAX_MISSED_PONGS = 3;

  // --- HTTP methods ---

  async function httpRequest(method, path, body) {
    const url = `${serverUrl}${path}`;
    const options = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) {
      options.body = JSON.stringify(body);
    }
    const res = await fetch(url, options);
    const data = await res.json();
    if (!res.ok) {
      const err = new Error(data.error || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = data;
      throw err;
    }
    return data;
  }

  async function send(envelope) {
    return httpRequest('POST', '/messages', envelope);
  }

  async function drain(limit) {
    const body = limit ? { limit } : {};
    return httpRequest('POST', `/mailbox/${encodeURIComponent(organName)}/drain`, body);
  }

  async function ack(messageIds) {
    return httpRequest('POST', `/mailbox/${encodeURIComponent(organName)}/ack`, {
      message_ids: messageIds,
    });
  }

  async function register() {
    return httpRequest('POST', `/mailbox/${encodeURIComponent(organName)}`, {});
  }

  async function health() {
    return httpRequest('GET', '/health');
  }

  async function introspect() {
    return httpRequest('GET', '/introspect');
  }

  async function consumers() {
    return httpRequest('GET', '/consumers');
  }

  // --- Heartbeat ---

  function startHeartbeat() {
    stopHeartbeat();
    missedPongs = 0;

    pingTimer = setInterval(() => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;

      missedPongs++;
      if (missedPongs > MAX_MISSED_PONGS) {
        log('spine_heartbeat_timeout', {
          organ: organName,
          missed_pongs: missedPongs,
        });
        // Force close — triggers reconnect via close handler
        ws.terminate();
        return;
      }

      ws.ping();
    }, PING_INTERVAL);
  }

  function stopHeartbeat() {
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    missedPongs = 0;
  }

  // --- WebSocket ---

  function doConnect() {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/subscribe';
    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      connected = true;
      reconnectDelay = 1000; // reset backoff on successful connect
      ws.send(JSON.stringify({ action: 'register', organ_name: organName }));

      // Re-subscribe to previously registered filters
      for (const filter of subscriptionFilters) {
        ws.send(JSON.stringify({ action: 'subscribe', filter }));
      }

      startHeartbeat();
      log('spine_ws_connected', { organ: organName, url: wsUrl });
    });

    ws.on('pong', () => {
      missedPongs = 0;
    });

    ws.on('message', (raw) => {
      try {
        const data = JSON.parse(raw.toString());
        if (data.action === 'message' && data.envelope) {
          if (data.envelope.target_organ === '*') {
            if (callbacks?.onBroadcast) callbacks.onBroadcast(data.envelope);
          } else {
            if (callbacks?.onMessage) callbacks.onMessage(data.envelope);
          }
        }
      } catch { /* ignore parse errors */ }
    });

    ws.on('close', () => {
      connected = false;
      stopHeartbeat();
      if (!intentionalClose) {
        scheduleReconnect();
      }
    });

    ws.on('error', () => {
      // close event follows — reconnect handled there
    });
  }

  function scheduleReconnect() {
    if (intentionalClose) return;
    if (reconnectTimer) return;

    log('spine_ws_reconnecting', {
      organ: organName,
      delay_ms: reconnectDelay,
    });

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!intentionalClose) {
        doConnect();
      }
    }, reconnectDelay);

    // Exponential backoff: 1s → 2s → 4s → 8s → 16s → cap at 30s
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
  }

  /**
   * Connect to Spine WebSocket with auto-reconnect and heartbeat.
   *
   * @param {object} cbs - { onMessage(envelope), onBroadcast(envelope) }
   */
  function connect(cbs = {}) {
    callbacks = cbs;
    intentionalClose = false;
    doConnect();
  }

  /**
   * Subscribe to broadcast messages matching a filter.
   * Persisted in Spine — survives reconnect.
   *
   * @param {object} filter - e.g. { event_type: 'organ_connected' }
   */
  function subscribe(filter) {
    subscriptionFilters.push(filter);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ action: 'subscribe', filter }));
    }
  }

  function isConnected() {
    return connected && ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Clean disconnect — no auto-reconnect.
   */
  function disconnect() {
    intentionalClose = true;
    stopHeartbeat();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.close();
      ws = null;
    }
    connected = false;
  }

  /**
   * Close all connections (alias for disconnect).
   */
  function close() {
    disconnect();
  }

  return {
    send,
    drain,
    ack,
    register,
    health,
    introspect,
    consumers,
    connect,
    subscribe,
    isConnected,
    disconnect,
    close,
  };
}
