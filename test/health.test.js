import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createHealthRouter } from '../lib/health.js';

async function makeApp(getHealthState) {
  const app = express();
  app.use(createHealthRouter(getHealthState));
  const server = await new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('Health endpoint factory', () => {
  it('returns ok when spine connected and all checks pass', async () => {
    const { server, url } = await makeApp(async () => ({
      organ: 'TestOrgan',
      uptime_s: 42,
      loop_iteration: 10,
      spine_connected: true,
      checks: { db: 'ok', embedding: 'ok' },
    }));

    const res = await fetch(`${url}/health`);
    const data = await res.json();

    assert.equal(data.status, 'ok');
    assert.equal(data.organ, 'TestOrgan');
    assert.equal(data.uptime_s, 42);
    assert.equal(data.loop_iteration, 10);
    assert.equal(data.spine_connected, true);
    assert.deepEqual(data.checks, { db: 'ok', embedding: 'ok' });

    server.close();
  });

  it('returns degraded when some checks report issues', async () => {
    const { server, url } = await makeApp(async () => ({
      organ: 'TestOrgan',
      uptime_s: 42,
      loop_iteration: 10,
      spine_connected: true,
      checks: { db: 'ok', embedding: 'degraded' },
    }));

    const res = await fetch(`${url}/health`);
    const data = await res.json();

    assert.equal(data.status, 'degraded');

    server.close();
  });

  it('returns down when spine disconnected', async () => {
    const { server, url } = await makeApp(async () => ({
      organ: 'TestOrgan',
      uptime_s: 42,
      loop_iteration: 10,
      spine_connected: false,
      checks: { db: 'ok' },
    }));

    const res = await fetch(`${url}/health`);
    const data = await res.json();

    assert.equal(data.status, 'down');

    server.close();
  });
});
