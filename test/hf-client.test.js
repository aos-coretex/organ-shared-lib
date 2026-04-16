/**
 * Unit tests for hf-client.js — MP-CONFIG-1 relay l9m-10.
 *
 * All network I/O is stubbed via injected fetch. No real HF Hub calls.
 * File I/O for downloadFile is exercised via an in-memory Writable sink.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Writable, Readable } from 'node:stream';
import { createHFClient } from '../lib/hf-client.js';

/** Minimal Response-shaped stub. */
function mockRes({ ok = true, status = 200, json, text, body }) {
  return {
    ok,
    status,
    json: async () => json,
    text: async () => text ?? '',
    body: body ?? null,
  };
}

describe('hf-client: getModelInfo', () => {
  it('GETs /api/models/<repo>/revision/<rev> and returns JSON', async () => {
    const calls = [];
    const client = createHFClient({
      fetch: async (url, opts) => {
        calls.push({ url, opts });
        return mockRes({
          json: {
            siblings: [
              { rfilename: 'config.json' },
              { rfilename: 'model.safetensors' },
            ],
          },
        });
      },
    });
    const info = await client.getModelInfo('Qwen/Qwen2.5-32B-Instruct-AWQ', 'abc1234');
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/api\/models\/.+\/revision\/abc1234$/);
    assert.equal(info.siblings.length, 2);
  });

  it('sends Bearer auth header when token is configured', async () => {
    let seenHeaders;
    const client = createHFClient({
      token: 'hf_test_token',
      fetch: async (_url, opts) => {
        seenHeaders = opts.headers;
        return mockRes({ json: { siblings: [] } });
      },
    });
    await client.getModelInfo('x/y', 'sha1');
    assert.equal(seenHeaders.authorization, 'Bearer hf_test_token');
  });

  it('throws with status + body on non-OK response', async () => {
    const client = createHFClient({
      fetch: async () => mockRes({ ok: false, status: 404, text: 'Not Found' }),
    });
    await assert.rejects(
      () => client.getModelInfo('x/y', 'sha1'),
      (err) => err.status === 404 && /404/.test(err.message),
    );
  });
});

describe('hf-client: listSnapshot', () => {
  it('returns rfilename array from model info', async () => {
    const client = createHFClient({
      fetch: async () =>
        mockRes({
          json: {
            siblings: [{ rfilename: 'a.json' }, { rfilename: 'b.safetensors' }, {}],
          },
        }),
    });
    const files = await client.listSnapshot('x/y', 'sha1');
    assert.deepEqual(files, ['a.json', 'b.safetensors']);
  });
});

describe('hf-client: downloadFile', () => {
  it('pipes response body into an injected write stream', async () => {
    const sinkChunks = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        sinkChunks.push(Buffer.from(chunk));
        cb();
      },
    });
    const bodyReadable = Readable.from(['abc', 'def']);
    const client = createHFClient({
      fetch: async () => ({ ok: true, status: 200, body: bodyReadable, text: async () => '' }),
      openWriteStream: () => sink,
    });
    const result = await client.downloadFile('x/y', 'sha1', 'config.json', '/tmp/fixture-unused');
    assert.equal(Buffer.concat(sinkChunks).toString(), 'abcdef');
    assert.ok(result.path.endsWith('config.json'));
  });
});

describe('hf-client: live HF Hub integration', { skip: true }, () => {
  // ACTIVATION TRIGGER: "activate when local Qwen2.5-32B-AWQ deployed at deployment_target"
  // Requires network + HF_TOKEN for private repos. Public Qwen models don't need a token.
  it('TODO: getModelInfo against real HF Hub (mocked until activation)', () => {});
  it('TODO: downloadFile against real HF Hub (mocked until activation)', () => {});
});
