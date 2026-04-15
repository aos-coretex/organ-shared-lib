import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createSpineClient } from '../lib/spine-client.js';

// --- Mock Spine server ---

function createMockSpine() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      const parsed = body ? JSON.parse(body) : {};
      const handler = server._routes?.[`${req.method} ${req.url}`];
      if (handler) {
        const result = handler(parsed, req);
        res.writeHead(result.status || 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.body));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
    });
  });

  const wss = new WebSocketServer({ server, path: '/subscribe' });
  server._wss = wss;
  server._routes = {};

  server.route = (method, path, handler) => {
    server._routes[`${method} ${path}`] = handler;
  };

  return server;
}

function startServer(srv) {
  return new Promise(resolve => {
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      resolve({ port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function stopServer(srv) {
  return new Promise(resolve => {
    srv._wss?.close();
    srv.close(resolve);
  });
}

describe('Spine client — HTTP methods', () => {
  let mockSpine;
  let serverInfo;

  beforeEach(async () => {
    mockSpine = createMockSpine();

    // Default routes
    mockSpine.route('POST', '/messages', (body) => ({
      status: 202,
      body: { message_id: 'urn:llm-ops:otm:test', routing: 'directed', delivered_to: [] },
    }));
    mockSpine.route('POST', '/mailbox/TestOrgan/drain', (body) => ({
      body: { messages: [{ message_id: 'msg-1', payload: { x: 1 } }] },
    }));
    mockSpine.route('POST', '/mailbox/TestOrgan/ack', (body) => ({
      body: { acknowledged: body.message_ids?.length || 0 },
    }));
    mockSpine.route('POST', '/mailbox/TestOrgan', () => ({
      status: 200,
      body: { organ_name: 'TestOrgan', status: 'registered' },
    }));
    mockSpine.route('GET', '/health', () => ({
      body: { status: 'ok', uptime_s: 100 },
    }));

    serverInfo = await startServer(mockSpine);
  });

  afterEach(async () => {
    await stopServer(mockSpine);
  });

  it('send() posts envelope to /messages', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.send({ type: 'OTM', source_organ: 'TestOrgan', target_organ: '*', payload: {} });
    assert.equal(result.message_id, 'urn:llm-ops:otm:test');
    client.close();
  });

  it('drain() posts to /mailbox/:organ/drain', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.drain(10);
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].message_id, 'msg-1');
    client.close();
  });

  it('ack() posts message_ids to /mailbox/:organ/ack', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.ack(['msg-1', 'msg-2']);
    assert.equal(result.acknowledged, 2);
    client.close();
  });

  it('register() posts to /mailbox/:organ', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.register();
    assert.equal(result.organ_name, 'TestOrgan');
    client.close();
  });

  it('health() gets /health', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.health();
    assert.equal(result.status, 'ok');
    client.close();
  });

  // --- sendSafe() — structured-error variant (repair-mcp-router-05) ---

  it('sendSafe() returns { ok: true, status, data } on 2xx', async () => {
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.sendSafe({ type: 'OTM', source_organ: 'TestOrgan', target_organ: '*', payload: {} });
    assert.equal(result.ok, true);
    assert.equal(result.status, 202);
    assert.equal(result.data.message_id, 'urn:llm-ops:otm:test');
    client.close();
  });

  it('sendSafe() returns structured { ok: false, status, error, message } on 4xx (no throw)', async () => {
    // Override /messages to return the same 400 that triggered the crash
    mockSpine.route('POST', '/messages', () => ({
      status: 400,
      body: { error: 'ROUTING_FAILED', message: 'Organ not in manifest: graph' },
    }));

    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    const result = await client.sendSafe({
      type: 'OTM', source_organ: 'TestOrgan', target_organ: 'graph', payload: {},
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.equal(result.error, 'ROUTING_FAILED');
    assert.equal(result.message, 'Organ not in manifest: graph');
    client.close();
  });

  it('sendSafe() returns { ok: false, error: NETWORK_ERROR } when server is unreachable', async () => {
    const client = createSpineClient({ serverUrl: 'http://127.0.0.1:1', organName: 'TestOrgan' });
    const result = await client.sendSafe({ type: 'OTM', source_organ: 'TestOrgan', target_organ: '*', payload: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 0);
    assert.equal(result.error, 'NETWORK_ERROR');
    assert.ok(result.message);
    client.close();
  });

  it('send() STILL throws on 4xx (existing contract preserved for other callers)', async () => {
    mockSpine.route('POST', '/messages', () => ({
      status: 400,
      body: { error: 'ROUTING_FAILED', message: 'nope' },
    }));
    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    await assert.rejects(
      () => client.send({ type: 'OTM', source_organ: 'TestOrgan', target_organ: 'graph', payload: {} }),
      (err) => {
        assert.equal(err.status, 400);
        assert.equal(err.message, 'ROUTING_FAILED');
        return true;
      }
    );
    client.close();
  });
});

describe('Spine client — WebSocket', () => {
  let mockSpine;
  let serverInfo;

  beforeEach(async () => {
    mockSpine = createMockSpine();
    serverInfo = await startServer(mockSpine);
  });

  afterEach(async () => {
    await stopServer(mockSpine);
  });

  it('connect sends register action on open', async () => {
    const registered = new Promise((resolve) => {
      mockSpine._wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const data = JSON.parse(raw.toString());
          if (data.action === 'register') {
            ws.send(JSON.stringify({ action: 'registered', organ_name: data.organ_name }));
            resolve(data);
          }
        });
      });
    });

    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    client.connect({});

    const msg = await registered;
    assert.equal(msg.action, 'register');
    assert.equal(msg.organ_name, 'TestOrgan');
    client.close();
  });

  it('reconnects on close with increasing backoff', async () => {
    let connectCount = 0;
    mockSpine._wss.on('connection', (ws) => {
      connectCount++;
      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString());
        if (data.action === 'register') {
          ws.send(JSON.stringify({ action: 'registered', organ_name: data.organ_name }));
          // Close immediately to trigger reconnect
          if (connectCount <= 2) {
            setTimeout(() => ws.close(), 50);
          }
        }
      });
    });

    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    client.connect({});

    // Wait for at least 2 reconnections
    await new Promise(resolve => setTimeout(resolve, 4000));

    assert.ok(connectCount >= 3, `Expected at least 3 connections, got ${connectCount}`);
    client.close();
  });

  it('isConnected() tracks WebSocket state', async () => {
    const ready = new Promise((resolve) => {
      mockSpine._wss.on('connection', (ws) => {
        ws.on('message', (raw) => {
          const data = JSON.parse(raw.toString());
          if (data.action === 'register') {
            ws.send(JSON.stringify({ action: 'registered', organ_name: data.organ_name }));
            resolve();
          }
        });
      });
    });

    const client = createSpineClient({ serverUrl: serverInfo.url, organName: 'TestOrgan' });
    assert.equal(client.isConnected(), false);

    client.connect({});
    await ready;
    // Small delay to ensure the open handler has run
    await new Promise(r => setTimeout(r, 100));
    assert.equal(client.isConnected(), true);

    client.disconnect();
    assert.equal(client.isConnected(), false);
  });
});
