/**
 * Shared Graph HTTP client factory for DIO organs.
 *
 * Type-agnostic Graph client used by every organ that reads or writes
 * concepts and bindings through the Graph organ's HTTP surface. Mirrors
 * Graphheight's generic URN/UBN primitive — the client carries no
 * governance-specific knowledge. Callers supply the concept `type` and
 * any domain fields; the client handles envelope shape, SQL, headers,
 * timeouts, and typed error classification.
 *
 * Wire contract (post-a7u-5, enforced by Graph's Ajv schema gate):
 *   POST /concepts   body: { urn, data: { type, ...fields }, metadata? }
 *   PATCH /concepts/:urn  body: { data: {...} }
 *   POST /bindings   body: { ubn, type?, data: { from_urn, to_urn, relation, ...fields }, metadata? }
 *   POST /query      body: { sql, params }
 *   GET  /concepts/:urn  → { urn, data, created_at } or 404
 *   GET  /health     → { ... }
 *
 * Header discipline:
 *   - X-Organ-Name: <organName> on every request
 *   - X-Infrastructure-Exemption: <value> only when `exemptionHeader` is
 *     configured at client creation (Cerberus opt-in for audit/SPENT writes)
 *
 * Error taxonomy:
 *   - GraphUnreachableError — network failure, timeout, or abort
 *   - GraphSchemaError      — 400 SCHEMA_VALIDATION_FAILED from the gate
 *   - Error                 — other non-2xx responses (with .status and .body)
 *
 * Usage:
 *   import { createGraphClient } from '@coretex/organ-boot/graph-client';
 *   const graph = createGraphClient({ baseUrl: 'http://127.0.0.1:4020', organName: 'Nomos' });
 *   await graph.insertConcept('ruling', 'urn:llm-ops:ruling:abc', { ap_ref: '...', ... });
 */

export class GraphUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'GraphUnreachableError';
    this.cause = cause;
  }
}

export class GraphSchemaError extends Error {
  constructor(message, details, errors) {
    super(message);
    this.name = 'GraphSchemaError';
    this.details = details;
    this.errors = errors;
  }
}

function parseConceptData(row) {
  if (!row) return null;
  if (row.data == null) return row;
  const data = typeof row.data === 'string' ? safeJsonParse(row.data) : row.data;
  return { ...row, data };
}

function safeJsonParse(s) {
  try { return JSON.parse(s); } catch { return s; }
}

export function createGraphClient(opts = {}) {
  const {
    baseUrl,
    organName,
    timeoutMs = 5000,
    exemptionHeader = null,
    fetchImpl,
  } = opts;

  if (!baseUrl) throw new Error('createGraphClient: baseUrl is required');
  if (!organName) throw new Error('createGraphClient: organName is required');

  // Always read globalThis.fetch at call time so test suites that swap
  // globalThis.fetch between constructor and call (the standard mock
  // pattern) continue to observe their mock. Explicit fetchImpl still wins.
  const doFetch = fetchImpl ? fetchImpl : (...args) => globalThis.fetch(...args);

  function buildHeaders(extra = {}) {
    const headers = {
      'Content-Type': 'application/json',
      'X-Organ-Name': organName,
      ...extra,
    };
    if (exemptionHeader) {
      headers['X-Infrastructure-Exemption'] = exemptionHeader;
    }
    return headers;
  }

  async function timedFetch(url, init = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new GraphUnreachableError(
          `Graph request timed out after ${timeoutMs}ms: ${url}`,
          err,
        );
      }
      throw new GraphUnreachableError(
        `Graph request failed (${err?.code || err?.name || 'network'}) ${url}: ${err?.message || err}`,
        err,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(response) {
    try { return await response.json(); } catch { return null; }
  }

  async function rejectHttp(response, opLabel) {
    const body = await readJson(response);
    if (response.status === 400 && body?.error === 'SCHEMA_VALIDATION_FAILED') {
      throw new GraphSchemaError(
        `Graph ${opLabel} rejected by schema gate: ${body.details || 'SCHEMA_VALIDATION_FAILED'}`,
        body.details,
        body.errors,
      );
    }
    const err = new Error(
      `Graph ${opLabel} failed: ${response.status}${body?.error ? ` ${body.error}` : ''}`,
    );
    err.status = response.status;
    err.body = body;
    throw err;
  }

  // ── Concept operations ────────────────────────────────────────────

  async function insertConcept(type, urn, data = {}, options = {}) {
    if (!type) throw new Error('insertConcept: type is required');
    if (!urn) throw new Error('insertConcept: urn is required');

    const envelope = {
      urn,
      data: { type, ...data },
    };
    if (options.metadata !== undefined) envelope.metadata = options.metadata;

    const response = await timedFetch(`${baseUrl}/concepts`, {
      method: 'POST',
      headers: buildHeaders(options.headers),
      body: JSON.stringify(envelope),
    });
    if (!response.ok) await rejectHttp(response, 'insertConcept');
    return readJson(response);
  }

  async function updateConcept(urn, data = {}, options = {}) {
    if (!urn) throw new Error('updateConcept: urn is required');

    const envelope = { data };
    const response = await timedFetch(
      `${baseUrl}/concepts/${encodeURIComponent(urn)}`,
      {
        method: 'PATCH',
        headers: buildHeaders(options.headers),
        body: JSON.stringify(envelope),
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) await rejectHttp(response, 'updateConcept');
    return parseConceptData(await readJson(response));
  }

  async function queryConcept(urn) {
    if (!urn) throw new Error('queryConcept: urn is required');
    const response = await timedFetch(
      `${baseUrl}/concepts/${encodeURIComponent(urn)}`,
      { method: 'GET', headers: buildHeaders() },
    );
    if (response.status === 404) return null;
    if (!response.ok) await rejectHttp(response, 'queryConcept');
    return parseConceptData(await readJson(response));
  }

  async function queryActiveByType(type) {
    if (!type) throw new Error('queryActiveByType: type is required');
    const sql =
      "SELECT urn, data, created_at FROM concepts" +
      " WHERE json_extract(data, '$.type') = ?" +
      " AND json_extract(data, '$.status') = 'active'";
    const response = await timedFetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ sql, params: [type] }),
    });
    if (!response.ok) await rejectHttp(response, 'queryActiveByType');
    const body = await readJson(response);
    const rows = body?.results || body?.rows || [];
    return rows.map(parseConceptData);
  }

  // ── Binding operations ────────────────────────────────────────────

  async function insertBinding(ubn, type, sourceUrn, targetUrn, data = {}, options = {}) {
    if (!ubn) throw new Error('insertBinding: ubn is required');
    if (!sourceUrn) throw new Error('insertBinding: sourceUrn is required');
    if (!targetUrn) throw new Error('insertBinding: targetUrn is required');
    if (!data.relation) {
      throw new Error('insertBinding: data.relation is required (binding schema contract)');
    }

    const envelope = {
      ubn,
      data: {
        from_urn: sourceUrn,
        to_urn: targetUrn,
        ...data,
      },
    };
    if (type) envelope.type = type;
    if (options.metadata !== undefined) envelope.metadata = options.metadata;

    const response = await timedFetch(`${baseUrl}/bindings`, {
      method: 'POST',
      headers: buildHeaders(options.headers),
      body: JSON.stringify(envelope),
    });
    if (!response.ok) await rejectHttp(response, 'insertBinding');
    return readJson(response);
  }

  async function queryBindings(filters = {}) {
    const clauses = [];
    const params = [];
    if (filters.sourceUrn) {
      clauses.push("json_extract(data, '$.from_urn') = ?");
      params.push(filters.sourceUrn);
    }
    if (filters.targetUrn) {
      clauses.push("json_extract(data, '$.to_urn') = ?");
      params.push(filters.targetUrn);
    }
    if (filters.type) {
      // Matches the binding's `relation` field inside data. The wire-level
      // `type` field is optional and not stored by the SQLite adapter, so
      // relation is the addressable binding classifier.
      clauses.push("json_extract(data, '$.relation') = ?");
      params.push(filters.type);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const sql = `SELECT ubn, data, created_at FROM class_bindings ${where}`.trim();

    const response = await timedFetch(`${baseUrl}/query`, {
      method: 'POST',
      headers: buildHeaders(),
      body: JSON.stringify({ sql, params }),
    });
    if (!response.ok) await rejectHttp(response, 'queryBindings');
    const body = await readJson(response);
    const rows = body?.results || body?.rows || [];
    return rows.map((row) => {
      if (!row) return row;
      const data = typeof row.data === 'string' ? safeJsonParse(row.data) : row.data;
      return { ...row, data };
    });
  }

  async function healthCheck() {
    const response = await timedFetch(`${baseUrl}/health`, {
      method: 'GET',
      headers: buildHeaders(),
    });
    if (!response.ok) await rejectHttp(response, 'healthCheck');
    return readJson(response);
  }

  return {
    insertConcept,
    updateConcept,
    queryConcept,
    queryActiveByType,
    insertBinding,
    queryBindings,
    healthCheck,
  };
}
