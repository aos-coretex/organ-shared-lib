/**
 * Unit tests for llm-classifier.js — MP-CONFIG-1 relay l9m-2.
 *
 * Coverage:
 *   - One test per D4 (7) + D5 (4) failure class — synthetic Error → correct class
 *   - `unknown` fallback for unclassifiable errors
 *   - `fallback_eligible` flag matches D4 (true) / D5 (false) / unknown (false)
 *   - Streaming-context split (timeout vs timeout_during_streaming)
 *   - Subpath import via `@coretex/organ-boot/llm-classifier`
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyLLMFailure, FAILURE_CLASSES } from '../lib/llm-classifier.js';

/** Build a synthetic provider error mimicking the hardened openai-compatible shape. */
function providerError({ message = 'err', status, body, code, name } = {}) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  if (body !== undefined) err.body = body;
  if (code !== undefined) err.code = code;
  if (name !== undefined) err.name = name;
  return err;
}

// -------------------------------------------------------------------------
// D4 — cascade-eligible classes (7)
// -------------------------------------------------------------------------

describe('llm-classifier: D4 connection_refused', () => {
  it('detects ECONNREFUSED via err.code', () => {
    const err = providerError({ message: 'fetch failed', code: 'ECONNREFUSED' });
    const r = classifyLLMFailure(err, { provider: 'openai-compatible' });
    assert.equal(r.class, FAILURE_CLASSES.CONNECTION_REFUSED);
    assert.equal(r.fallback_eligible, true);
  });

  it('detects ECONNREFUSED via cause chain (Node fetch wraps undici)', () => {
    const inner = providerError({ message: 'connect ECONNREFUSED 127.0.0.1:8000', code: 'ECONNREFUSED' });
    const wrapper = new Error('openai-compatible fetch failed');
    wrapper.cause = inner;
    const r = classifyLLMFailure(wrapper);
    assert.equal(r.class, FAILURE_CLASSES.CONNECTION_REFUSED);
  });
});

describe('llm-classifier: D4 connection_timeout', () => {
  it('detects AbortError', () => {
    const err = providerError({ message: 'aborted', name: 'AbortError' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONNECTION_TIMEOUT);
    assert.equal(r.fallback_eligible, true);
  });

  it('detects ETIMEDOUT', () => {
    const err = providerError({ message: 'timed out', code: 'ETIMEDOUT' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONNECTION_TIMEOUT);
  });
});

describe('llm-classifier: D4 timeout_during_streaming (context-dependent)', () => {
  it('returns timeout_during_streaming when context.duringStream is true', () => {
    const err = providerError({ message: 'aborted', name: 'AbortError' });
    const r = classifyLLMFailure(err, { duringStream: true });
    assert.equal(r.class, FAILURE_CLASSES.TIMEOUT_DURING_STREAMING);
    assert.equal(r.fallback_eligible, true);
  });
});

describe('llm-classifier: D4 http_5xx', () => {
  it('detects status 500', () => {
    const err = providerError({ message: 'API 500', status: 500, body: 'internal' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_5XX);
    assert.equal(r.fallback_eligible, true);
  });
  it('detects status 502', () => {
    const err = providerError({ status: 502, body: 'bad gateway' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_5XX);
  });
});

describe('llm-classifier: D4 http_503', () => {
  it('detects status 503 without model-loading body', () => {
    const err = providerError({ status: 503, body: 'maintenance window' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_503);
    assert.equal(r.fallback_eligible, true);
  });
});

describe('llm-classifier: D4 http_429', () => {
  it('detects status 429', () => {
    const err = providerError({ status: 429, body: 'rate limited' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_429);
    assert.equal(r.fallback_eligible, true);
  });
});

describe('llm-classifier: D4 model_not_loaded', () => {
  it('detects 503 + "model not loaded" (vLLM pattern)', () => {
    const err = providerError({ status: 503, body: '{"error":"Model not loaded"}' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.MODEL_NOT_LOADED);
    assert.equal(r.fallback_eligible, true);
  });
  it('detects 200/non-503 + "model is loading" (TGI warmup)', () => {
    const err = providerError({ status: 400, body: 'Model is loading; please retry' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.MODEL_NOT_LOADED);
  });
});

// -------------------------------------------------------------------------
// D5 — fail-closed classes (4)
// -------------------------------------------------------------------------

describe('llm-classifier: D5 http_4xx', () => {
  it('detects status 400 (no other patterns match)', () => {
    const err = providerError({ status: 400, body: 'malformed request' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_4XX);
    assert.equal(r.fallback_eligible, false);
  });
  it('detects status 401', () => {
    const err = providerError({ status: 401, body: 'unauthorized' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_4XX);
  });
  it('detects status 404', () => {
    const err = providerError({ status: 404, body: 'not found' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_4XX);
  });
});

describe('llm-classifier: D5 parse_error', () => {
  it('detects SyntaxError (JSON.parse failure on response body)', () => {
    const err = new SyntaxError('Unexpected token < in JSON at position 0');
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.PARSE_ERROR);
    assert.equal(r.fallback_eligible, false);
  });
  it('detects via message text fallback', () => {
    const err = providerError({ message: 'JSON.parse: invalid input' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.PARSE_ERROR);
  });
});

describe('llm-classifier: D5 context_length_exceeded', () => {
  it('detects via body pattern', () => {
    const err = providerError({ status: 400, body: 'context_length_exceeded for model x' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONTEXT_LENGTH_EXCEEDED);
    assert.equal(r.fallback_eligible, false);
  });
  it('detects "context window" variant', () => {
    const err = providerError({ status: 400, body: 'prompt exceeds context window' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONTEXT_LENGTH_EXCEEDED);
  });
});

describe('llm-classifier: D5 content_filter_triggered', () => {
  it('detects content policy violation in body', () => {
    const err = providerError({ status: 400, body: 'content-policy-violation' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONTENT_FILTER_TRIGGERED);
    assert.equal(r.fallback_eligible, false);
  });
  it('detects safety filter variant', () => {
    const err = providerError({ status: 400, body: 'response blocked by safety filter' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.CONTENT_FILTER_TRIGGERED);
  });
});

// -------------------------------------------------------------------------
// Unknown fallback
// -------------------------------------------------------------------------

describe('llm-classifier: unknown fallback', () => {
  it('returns unknown + fallback_eligible:false for unclassifiable error', () => {
    const err = providerError({ message: 'something weird' });
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.UNKNOWN);
    assert.equal(r.fallback_eligible, false);
  });

  it('returns unknown for null error (defensive)', () => {
    const r = classifyLLMFailure(null);
    assert.equal(r.class, FAILURE_CLASSES.UNKNOWN);
    assert.equal(r.fallback_eligible, false);
  });
});

// -------------------------------------------------------------------------
// Status extraction from message text (Anthropic legacy path)
// -------------------------------------------------------------------------

describe('llm-classifier: status extraction from message text (legacy Anthropic errors)', () => {
  it('extracts 503 from "Anthropic API 503: ..." style message', () => {
    const err = new Error('Anthropic API 503: service unavailable');
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_503);
  });

  it('extracts 429 from message text', () => {
    const err = new Error('Anthropic API 429: rate limited');
    const r = classifyLLMFailure(err);
    assert.equal(r.class, FAILURE_CLASSES.HTTP_429);
  });
});

// -------------------------------------------------------------------------
// Subpath import
// -------------------------------------------------------------------------

describe('llm-classifier: subpath import', () => {
  it('resolves classifyLLMFailure + FAILURE_CLASSES via @coretex/organ-boot/llm-classifier', async () => {
    const m = await import('@coretex/organ-boot/llm-classifier');
    assert.equal(typeof m.classifyLLMFailure, 'function');
    assert.equal(m.classifyLLMFailure, classifyLLMFailure);
    assert.equal(m.FAILURE_CLASSES, FAILURE_CLASSES);
  });

  it('FAILURE_CLASSES enum is frozen', () => {
    assert.ok(Object.isFrozen(FAILURE_CLASSES));
  });
});
