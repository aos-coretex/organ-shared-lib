import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createGraphClient,
  GraphUnreachableError,
  GraphSchemaError,
} from '../lib/graph-client.js';

const BASE_URL = 'http://127.0.0.1:4020';
const ORIGINAL_FETCH = globalThis.fetch;

function mockFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return handler(url, opts, calls);
  };
  return calls;
}

function jsonResponse(body, { ok = true, status = ok ? 200 : 500 } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  });
}

describe('graph-client — construction', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('throws when baseUrl is missing', () => {
    assert.throws(() => createGraphClient({ organName: 'Nomos' }), /baseUrl is required/);
  });

  it('throws when organName is missing', () => {
    assert.throws(() => createGraphClient({ baseUrl: BASE_URL }), /organName is required/);
  });

  it('exposes all type-agnostic methods', () => {
    const c = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    for (const fn of [
      'insertConcept', 'updateConcept', 'queryConcept', 'queryActiveByType',
      'insertBinding', 'queryBindings', 'healthCheck',
    ]) {
      assert.equal(typeof c[fn], 'function', `missing ${fn}`);
    }
  });
});

describe('graph-client — insertConcept', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('sends envelope {urn, data: {type, ...}} with organ header', async () => {
    const calls = mockFetch(() => jsonResponse({ urn: 'ok' }, { status: 201 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });

    const result = await client.insertConcept('ruling', 'urn:llm-ops:ruling:1', {
      ap_ref: 'urn:ap:1',
      risk_tier: 'low',
    });

    assert.equal(result.urn, 'ok');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${BASE_URL}/concepts`);

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.urn, 'urn:llm-ops:ruling:1');
    assert.equal(body.data.type, 'ruling');
    assert.equal(body.data.ap_ref, 'urn:ap:1');
    assert.equal(body.type, undefined, 'type must NOT be at envelope level');
    assert.equal(calls[0].opts.headers['X-Organ-Name'], 'Nomos');
    assert.equal(calls[0].opts.headers['Content-Type'], 'application/json');
  });

  it('omits exemption header by default', async () => {
    const calls = mockFetch(() => jsonResponse({}, { status: 201 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Senate' });
    await client.insertConcept('msp_version', 'urn:graphheight:msp_version:1', {});
    assert.equal(calls[0].opts.headers['X-Infrastructure-Exemption'], undefined);
  });

  it('sets exemption header when configured at construction', async () => {
    const calls = mockFetch(() => jsonResponse({}, { status: 201 }));
    const client = createGraphClient({
      baseUrl: BASE_URL,
      organName: 'Cerberus',
      exemptionHeader: 'cerberus-audit-trail',
    });
    await client.insertConcept('cerberus_audit', 'urn:llm-ops:cerberus_audit:1', {
      event_type: 'committed',
    });
    assert.equal(
      calls[0].opts.headers['X-Infrastructure-Exemption'],
      'cerberus-audit-trail',
    );
  });

  it('rejects 400 SCHEMA_VALIDATION_FAILED as GraphSchemaError', async () => {
    mockFetch(() => jsonResponse(
      {
        error: 'SCHEMA_VALIDATION_FAILED',
        details: 'envelope/additionalProperties: must NOT have additional property "type"',
        errors: [{ keyword: 'additionalProperties' }],
      },
      { ok: false, status: 400 },
    ));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await assert.rejects(
      () => client.insertConcept('ruling', 'urn:llm-ops:ruling:x', {}),
      (err) => err instanceof GraphSchemaError &&
        /envelope\/additionalProperties/.test(err.details),
    );
  });

  it('throws a descriptive error on non-schema 4xx/5xx', async () => {
    mockFetch(() => jsonResponse({ error: 'Concept already exists: urn:x' }, { ok: false, status: 409 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await assert.rejects(
      () => client.insertConcept('ruling', 'urn:x', {}),
      (err) => err.status === 409 && /Concept already exists/.test(err.message),
    );
  });

  it('validates type and urn', async () => {
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await assert.rejects(() => client.insertConcept('', 'urn:x', {}), /type is required/);
    await assert.rejects(() => client.insertConcept('ruling', '', {}), /urn is required/);
  });
});

describe('graph-client — queryConcept and queryActiveByType', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('queryConcept returns null on 404', async () => {
    mockFetch(() => jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    assert.equal(await client.queryConcept('urn:missing'), null);
  });

  it('queryConcept parses string-encoded data field', async () => {
    mockFetch(() => jsonResponse({
      urn: 'urn:x',
      data: JSON.stringify({ type: 'ruling', risk_tier: 'low' }),
    }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    const c = await client.queryConcept('urn:x');
    assert.equal(c.data.type, 'ruling');
    assert.equal(c.data.risk_tier, 'low');
  });

  it('queryActiveByType sends parameterized SQL with the type param', async () => {
    const calls = mockFetch(() => jsonResponse({
      results: [
        { urn: 'urn:a', data: { type: 'msp_version', status: 'active', version: '1.0' } },
      ],
    }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Senate' });
    const rows = await client.queryActiveByType('msp_version');
    const body = JSON.parse(calls[0].opts.body);
    assert.match(body.sql, /json_extract\(data, '\$\.type'\) = \?/);
    assert.match(body.sql, /json_extract\(data, '\$\.status'\) = 'active'/);
    assert.deepEqual(body.params, ['msp_version']);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].data.type, 'msp_version');
  });

  it('queryActiveByType returns [] when Graph returns empty results', async () => {
    mockFetch(() => jsonResponse({ results: [] }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Senate' });
    assert.deepEqual(await client.queryActiveByType('genome_version'), []);
  });
});

describe('graph-client — insertBinding and queryBindings', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('sends binding envelope with data.{from_urn,to_urn,relation}', async () => {
    const calls = mockFetch(() => jsonResponse({ ubn: 'ok' }, { status: 201 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });

    await client.insertBinding(
      'ubn:llm-ops:adjudicates:2026-04-13-aaaa',
      'instance',
      'urn:llm-ops:ruling:1',
      'urn:llm-ops:ap:1',
      { relation: 'adjudicates', created_by: 'Nomos' },
    );

    const body = JSON.parse(calls[0].opts.body);
    assert.equal(body.ubn, 'ubn:llm-ops:adjudicates:2026-04-13-aaaa');
    assert.equal(body.type, 'instance');
    assert.equal(body.data.from_urn, 'urn:llm-ops:ruling:1');
    assert.equal(body.data.to_urn, 'urn:llm-ops:ap:1');
    assert.equal(body.data.relation, 'adjudicates');
    assert.equal(body.data.created_by, 'Nomos');
  });

  it('rejects binding missing relation', async () => {
    mockFetch(() => jsonResponse({}, { status: 201 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await assert.rejects(
      () => client.insertBinding('ubn:x', 'instance', 'urn:a', 'urn:b', {}),
      /relation is required/,
    );
  });

  it('queryBindings constructs SQL with optional filters', async () => {
    const calls = mockFetch(() => jsonResponse({ results: [] }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await client.queryBindings({
      sourceUrn: 'urn:a',
      targetUrn: 'urn:b',
      type: 'adjudicates',
    });
    const body = JSON.parse(calls[0].opts.body);
    assert.match(body.sql, /from_urn/);
    assert.match(body.sql, /to_urn/);
    assert.match(body.sql, /relation/);
    assert.deepEqual(body.params, ['urn:a', 'urn:b', 'adjudicates']);
  });

  it('queryBindings with no filters omits WHERE clause', async () => {
    const calls = mockFetch(() => jsonResponse({ results: [] }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await client.queryBindings();
    const body = JSON.parse(calls[0].opts.body);
    assert.doesNotMatch(body.sql, /WHERE/);
    assert.deepEqual(body.params, []);
  });
});

describe('graph-client — timeout and reachability', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('triggers AbortController and throws GraphUnreachableError on timeout', async () => {
    // Never-resolving fetch that only rejects on abort signal.
    globalThis.fetch = (url, opts) => new Promise((_, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });
    const client = createGraphClient({
      baseUrl: BASE_URL,
      organName: 'Nomos',
      timeoutMs: 20,
    });
    await assert.rejects(
      () => client.queryConcept('urn:x'),
      (err) => err instanceof GraphUnreachableError && /timed out after 20ms/.test(err.message),
    );
  });

  it('wraps generic network errors as GraphUnreachableError', async () => {
    globalThis.fetch = () => {
      const err = new Error('ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      return Promise.reject(err);
    };
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    await assert.rejects(
      () => client.healthCheck(),
      (err) => err instanceof GraphUnreachableError && /ECONNREFUSED/.test(err.message),
    );
  });
});

describe('graph-client — updateConcept', () => {
  afterEach(() => { globalThis.fetch = ORIGINAL_FETCH; });

  it('PATCHes with body.data and returns parsed concept', async () => {
    const calls = mockFetch(() => jsonResponse({
      urn: 'urn:x',
      data: JSON.stringify({ type: 'ruling', status: 'superseded' }),
    }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    const updated = await client.updateConcept('urn:x', { status: 'superseded' });
    assert.equal(calls[0].opts.method, 'PATCH');
    const body = JSON.parse(calls[0].opts.body);
    assert.deepEqual(body, { data: { status: 'superseded' } });
    assert.equal(updated.data.status, 'superseded');
  });

  it('returns null on 404', async () => {
    mockFetch(() => jsonResponse({ error: 'not found' }, { ok: false, status: 404 }));
    const client = createGraphClient({ baseUrl: BASE_URL, organName: 'Nomos' });
    assert.equal(await client.updateConcept('urn:missing', { x: 1 }), null);
  });
});
