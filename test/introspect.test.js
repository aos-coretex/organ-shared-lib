import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createIntrospectRouter } from '../lib/introspect.js';

async function makeApp(getIntrospectState) {
  const app = express();
  app.use(createIntrospectRouter(getIntrospectState));
  const server = await new Promise(resolve => {
    const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}` };
}

describe('Introspect endpoint factory', () => {
  it('returns complete introspection response', async () => {
    const { server, url } = await makeApp(async () => ({
      organ: 'TestOrgan',
      mailbox_depth: 5,
      last_message_ts: '2026-04-06T14:30:00Z',
      loop_iteration: 100,
      spine_connected: true,
      connected_since: '2026-04-06T00:00:00Z',
      extra: { db_size: 1024 },
    }));

    const res = await fetch(`${url}/introspect`);
    const data = await res.json();

    assert.equal(data.organ, 'TestOrgan');
    assert.equal(data.mailbox_depth, 5);
    assert.equal(data.last_message_ts, '2026-04-06T14:30:00Z');
    assert.equal(data.loop_iteration, 100);
    assert.equal(data.spine_connected, true);
    assert.equal(data.connected_since, '2026-04-06T00:00:00Z');
    assert.deepEqual(data.extra, { db_size: 1024 });

    server.close();
  });

  it('defaults null/zero for missing fields', async () => {
    const { server, url } = await makeApp(async () => ({
      organ: 'TestOrgan',
    }));

    const res = await fetch(`${url}/introspect`);
    const data = await res.json();

    assert.equal(data.mailbox_depth, 0);
    assert.equal(data.last_message_ts, null);
    assert.equal(data.loop_iteration, 0);
    assert.equal(data.spine_connected, false);
    assert.equal(data.connected_since, null);
    assert.deepEqual(data.extra, {});

    server.close();
  });
});
