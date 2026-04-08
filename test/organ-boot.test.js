import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { createOrgan } from '../lib/organ-boot.js';

// --- Mock Spine server (simplified for boot tests) ---

function createMockSpine() {
  const state = { registeredOrgans: [], wsConnections: 0 };

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.method === 'GET' && req.url === '/consumers') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ consumers: state.registeredOrgans.map(n => ({ organ_name: n })) }));
      } else if (req.method === 'POST' && req.url?.startsWith('/mailbox/') && !req.url.includes('/drain') && !req.url.includes('/ack')) {
        const organName = decodeURIComponent(req.url.split('/mailbox/')[1]);
        if (!state.registeredOrgans.includes(organName)) {
          state.registeredOrgans.push(organName);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ organ_name: organName, status: 'registered' }));
      } else if (req.method === 'POST' && req.url?.includes('/drain')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ messages: [] }));
      } else if (req.method === 'POST' && req.url?.includes('/ack')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ acknowledged: 0 }));
      } else if (req.method === 'POST' && req.url === '/messages') {
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message_id: 'urn:test', routing: 'directed' }));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'NOT_FOUND' }));
      }
    });
  });

  const wss = new WebSocketServer({ server, path: '/subscribe' });
  wss.on('connection', (ws) => {
    state.wsConnections++;
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString());
      if (data.action === 'register') {
        ws.send(JSON.stringify({ action: 'registered', organ_name: data.organ_name, mailbox_depth: 0 }));
      } else if (data.action === 'subscribe') {
        ws.send(JSON.stringify({ action: 'subscribed', organ_name: data.organ_name, filter: data.filter }));
      }
    });
  });

  server._state = state;
  server._wss = wss;
  return server;
}

describe('createOrgan factory', () => {
  let mockSpine;
  let spineUrl;
  let organ;

  beforeEach(async () => {
    mockSpine = createMockSpine();
    await new Promise(resolve => {
      mockSpine.listen(0, '127.0.0.1', () => {
        spineUrl = `http://127.0.0.1:${mockSpine.address().port}`;
        resolve();
      });
    });
  });

  afterEach(async () => {
    if (organ) {
      // Remove signal handlers to avoid interference between tests
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      await organ.shutdown();
      organ = null;
    }
    if (mockSpine) {
      mockSpine._wss.close();
      await new Promise(resolve => mockSpine.close(resolve));
    }
  });

  it('creates Express app with /health and /introspect endpoints', async () => {
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0, // random port
      spineUrl,
      dependencies: ['Spine'],
    });

    const { port } = organ.server.address();

    const healthRes = await fetch(`http://127.0.0.1:${port}/health`);
    const healthData = await healthRes.json();
    assert.equal(healthData.organ, 'TestOrgan');
    assert.ok(['ok', 'degraded', 'down'].includes(healthData.status));

    const introspectRes = await fetch(`http://127.0.0.1:${port}/introspect`);
    const introspectData = await introspectRes.json();
    assert.equal(introspectData.organ, 'TestOrgan');
  });

  it('mounts organ-specific routes', async () => {
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0,
      spineUrl,
      dependencies: ['Spine'],
      routes: (app) => {
        app.get('/ping', (_req, res) => res.json({ pong: true }));
      },
    });

    const { port } = organ.server.address();
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    const data = await res.json();
    assert.equal(data.pong, true);
  });

  it('registers mailbox with Spine', async () => {
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0,
      spineUrl,
      dependencies: ['Spine'],
    });

    assert.ok(mockSpine._state.registeredOrgans.includes('TestOrgan'));
  });

  it('connects to Spine WebSocket', async () => {
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0,
      spineUrl,
      dependencies: ['Spine'],
    });

    // Allow WS connection to establish
    await new Promise(r => setTimeout(r, 300));

    assert.ok(mockSpine._state.wsConnections >= 1);
  });

  it('calls onStartup callback after boot', async () => {
    let startupCalled = false;
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0,
      spineUrl,
      dependencies: ['Spine'],
      onStartup: async ({ spine, app }) => {
        startupCalled = true;
        assert.ok(spine);
        assert.ok(app);
      },
    });

    assert.equal(startupCalled, true);
  });

  it('shutdown closes all resources', async () => {
    organ = await createOrgan({
      name: 'TestOrgan',
      port: 0,
      spineUrl,
      dependencies: ['Spine'],
    });

    const { port } = organ.server.address();
    await organ.shutdown();

    // Server should be closed — fetch should fail
    await assert.rejects(() => fetch(`http://127.0.0.1:${port}/health`));

    organ = null; // prevent double-shutdown in afterEach
  });
});
