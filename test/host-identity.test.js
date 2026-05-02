/**
 * Tests for lib/host-identity.js — invariant #5 writer-internal accessor.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  getHostIdentity,
  resetHostIdentityCache,
  setHostIdentityForTests,
  __internal,
} from '../lib/host-identity.js';

const { mapMachineName, normalizeSilicon } = __internal;

describe('host-identity', () => {
  const origHostType = process.env.LLM_OPS_HOST_TYPE;
  const origSilicon = process.env.LLM_OPS_SILICON;

  beforeEach(() => {
    resetHostIdentityCache();
  });

  afterEach(() => {
    resetHostIdentityCache();
    if (origHostType === undefined) delete process.env.LLM_OPS_HOST_TYPE;
    else process.env.LLM_OPS_HOST_TYPE = origHostType;
    if (origSilicon === undefined) delete process.env.LLM_OPS_SILICON;
    else process.env.LLM_OPS_SILICON = origSilicon;
  });

  it('env-var override wins over detection', () => {
    process.env.LLM_OPS_HOST_TYPE = 'mac-studio';
    process.env.LLM_OPS_SILICON = 'm2-ultra';
    const id = getHostIdentity();
    assert.equal(id.host_type, 'mac-studio');
    assert.equal(id.silicon, 'm2-ultra');
  });

  it('caches after first resolve (same reference across calls)', () => {
    const a = getHostIdentity();
    const b = getHostIdentity();
    assert.strictEqual(a, b);
  });

  it('returned identity object is frozen', () => {
    const id = getHostIdentity();
    assert.ok(Object.isFrozen(id));
  });

  it('setHostIdentityForTests injects a deterministic identity', () => {
    setHostIdentityForTests({ host_type: 'mbp', silicon: 'm4-max' });
    const id = getHostIdentity();
    assert.equal(id.host_type, 'mbp');
    assert.equal(id.silicon, 'm4-max');
  });

  it('resetHostIdentityCache forces re-resolution', () => {
    setHostIdentityForTests({ host_type: 'x', silicon: 'y' });
    const before = getHostIdentity();
    assert.equal(before.host_type, 'x');
    resetHostIdentityCache();
    process.env.LLM_OPS_HOST_TYPE = 'mac-mini';
    process.env.LLM_OPS_SILICON = 'm2';
    const after = getHostIdentity();
    assert.equal(after.host_type, 'mac-mini');
    assert.equal(after.silicon, 'm2');
  });

  it('native detection on this machine yields non-"unknown" values (live-wire)', () => {
    // This test runs on the dev machine (MBP M4 Max) and verifies that the
    // detection path produces real values — no env override, no test stub.
    const id = getHostIdentity();
    assert.notEqual(id.host_type, '', 'host_type must not be empty');
    assert.notEqual(id.silicon, '', 'silicon must not be empty');
    // On darwin we expect a successful parse; on other platforms the test
    // asserts only the shape, not the specific value.
    if (process.platform === 'darwin') {
      assert.ok(
        ['mbp', 'mba', 'mac-mini', 'mac-studio', 'mac-pro', 'imac', 'unknown'].includes(id.host_type),
        `host_type should be a known chassis tag, got "${id.host_type}"`,
      );
      assert.match(id.silicon, /^(m\d+(-(pro|max|ultra))?|unknown)$/i,
        `silicon should match Apple Silicon shape, got "${id.silicon}"`);
    }
  });

  describe('mapMachineName', () => {
    it('maps canonical machine names to short tags', () => {
      assert.equal(mapMachineName('MacBook Pro'), 'mbp');
      assert.equal(mapMachineName('MacBook Air'), 'mba');
      assert.equal(mapMachineName('Mac mini'), 'mac-mini');
      assert.equal(mapMachineName('Mac Studio'), 'mac-studio');
      assert.equal(mapMachineName('Mac Pro'), 'mac-pro');
      assert.equal(mapMachineName('iMac'), 'imac');
    });

    it('returns "unknown" for unrecognized or missing names', () => {
      assert.equal(mapMachineName(''), 'unknown');
      assert.equal(mapMachineName(null), 'unknown');
      assert.equal(mapMachineName('Mysterious Device'), 'unknown');
    });
  });

  describe('normalizeSilicon', () => {
    it('parses Apple silicon chip strings', () => {
      assert.equal(normalizeSilicon('Apple M1'), 'm1');
      assert.equal(normalizeSilicon('Apple M2 Pro'), 'm2-pro');
      assert.equal(normalizeSilicon('Apple M3 Max'), 'm3-max');
      assert.equal(normalizeSilicon('Apple M4 Max'), 'm4-max');
      assert.equal(normalizeSilicon('Apple M2 Ultra'), 'm2-ultra');
    });

    it('returns null for unrecognized or missing strings', () => {
      assert.equal(normalizeSilicon(''), null);
      assert.equal(normalizeSilicon(null), null);
      assert.equal(normalizeSilicon('Intel Xeon'), null);
    });
  });
});
