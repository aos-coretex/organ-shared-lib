/**
 * Unit tests for quantization-validator.js — MP-CONFIG-1 relay l9m-10.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateQuantization,
  diagnoseQuantization,
  HF_QUANTIZATION_CLASSES,
} from '../lib/quantization-validator.js';

describe('quantization-validator: canonical classes', () => {
  it('accepts awq', () => assert.equal(validateQuantization('awq'), true));
  it('accepts gptq', () => assert.equal(validateQuantization('gptq'), true));
  it('accepts none', () => assert.equal(validateQuantization('none'), true));
  it('exposes frozen HF_QUANTIZATION_CLASSES', () => {
    assert.deepEqual([...HF_QUANTIZATION_CLASSES], ['awq', 'gptq', 'none']);
    assert.ok(Object.isFrozen(HF_QUANTIZATION_CLASSES));
  });
});

describe('quantization-validator: raw-precision rejection', () => {
  for (const raw of ['bf16', 'fp16', 'float16', 'bfloat16']) {
    it(`rejects "${raw}" as raw precision, not quantization`, () => {
      assert.equal(validateQuantization(raw), false);
      const d = diagnoseQuantization(raw);
      assert.equal(d.ok, false);
      assert.match(d.reason, /raw precision/);
    });
  }
});

describe('quantization-validator: misc invalid inputs', () => {
  it('rejects unknown label', () => {
    assert.equal(validateQuantization('int8'), false);
    const d = diagnoseQuantization('int8');
    assert.equal(d.ok, false);
    assert.match(d.reason, /not one of/);
  });
  it('rejects empty string', () => assert.equal(validateQuantization(''), false));
  it('rejects non-string', () => assert.equal(validateQuantization(null), false));
});
