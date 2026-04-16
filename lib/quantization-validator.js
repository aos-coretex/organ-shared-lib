/**
 * Quantization validator — MP-CONFIG-1 relay l9m-10.
 *
 * Accepts the three canonical classes from the `huggingface_autoprovision` block:
 *   - awq  — 4-bit activation-aware weight quantization (vLLM preferred)
 *   - gptq — 4-bit post-training quantization
 *   - none — no quantization (raw precision; bf16/fp16 weights are "none" here)
 *
 * Raw-precision strings (`bf16`, `fp16`, `float16`, `bfloat16`) are rejected —
 * they describe precision, not quantization. Use `none` for un-quantized models.
 *
 * Subpath import: `import { validateQuantization } from '@coretex/organ-boot/quantization-validator'`
 */

import { HF_QUANTIZATION_CLASSES } from './llm-settings-schema.js';

export { HF_QUANTIZATION_CLASSES };

const RAW_PRECISION_STRINGS = new Set(['bf16', 'fp16', 'float16', 'bfloat16', 'fp32', 'float32']);

/**
 * @param {string} q
 * @returns {boolean} true iff `q` is one of the three canonical quantization labels.
 *                    Raw precision (`bf16`/`fp16`/...) returns false.
 */
export function validateQuantization(q) {
  if (typeof q !== 'string') return false;
  if (RAW_PRECISION_STRINGS.has(q)) return false;
  return HF_QUANTIZATION_CLASSES.includes(q);
}

/** Diagnostic variant — returns `{ok, reason}` for use in validators that format errors. */
export function diagnoseQuantization(q) {
  if (typeof q !== 'string' || q.length === 0) {
    return { ok: false, reason: 'quantization must be a non-empty string' };
  }
  if (RAW_PRECISION_STRINGS.has(q)) {
    return {
      ok: false,
      reason: `"${q}" is a raw precision, not a quantization — use "none" for un-quantized models`,
    };
  }
  if (!HF_QUANTIZATION_CLASSES.includes(q)) {
    return {
      ok: false,
      reason: `quantization "${q}" not one of ${HF_QUANTIZATION_CLASSES.join('|')}`,
    };
  }
  return { ok: true };
}
