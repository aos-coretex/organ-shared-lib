import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkDependencies } from '../lib/dependency-check.js';

function createMockSpine(opts = {}) {
  const { healthOk = true, consumers = [] } = opts;

  const server = http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      if (healthOk) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'down' }));
      }
    } else if (req.url === '/consumers' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        consumers: consumers.map(name => ({ organ_name: name, status: 'connected' })),
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  return server;
}

describe('Dependency checker', () => {
  let server;
  let url;

  afterEach(async () => {
    if (server) {
      await new Promise(resolve => server.close(resolve));
      server = null;
    }
  });

  it('passes when all dependencies are present', async () => {
    server = createMockSpine({ consumers: ['Graph', 'Radiant'] });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    // Should not throw
    await checkDependencies(url, ['Spine', 'Graph', 'Radiant'], {
      maxRetries: 3,
      retryInterval: 100,
    });
  });

  it('retries when dependencies are missing', async () => {
    let requestCount = 0;
    server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } else if (req.url === '/consumers') {
        requestCount++;
        const consumers = requestCount >= 3
          ? [{ organ_name: 'Graph', status: 'connected' }]
          : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ consumers }));
      }
    });

    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    await checkDependencies(url, ['Spine', 'Graph'], {
      maxRetries: 10,
      retryInterval: 100,
    });

    assert.ok(requestCount >= 3, `Expected at least 3 consumer requests, got ${requestCount}`);
  });

  it('throws after max retries with missing dependencies', async () => {
    server = createMockSpine({ consumers: [] });
    await new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => {
        url = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });

    await assert.rejects(
      () => checkDependencies(url, ['Spine', 'Graph'], {
        maxRetries: 3,
        retryInterval: 100,
      }),
      (err) => {
        assert.match(err.message, /Graph/);
        return true;
      },
    );
  });
});
