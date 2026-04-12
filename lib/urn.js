/**
 * URN generation utility for DIO organs.
 *
 * Format: urn:llm-ops:<namespace>:<ISO-timestamp>-<random4>
 * @param {string} namespace — short label; known values include
 *   "transition, otm, apm, pem, atm, hom, goal, job, cortex-gap,
 *   assessment, assessment_request, assessment_triggered, payload" (documented;
 *   the function accepts any string, these are the ones emitted by
 *   current organs).
 */

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

function random4() {
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += CHARS[Math.floor(Math.random() * CHARS.length)];
  }
  return result;
}

export function generateUrn(namespace) {
  const timestamp = new Date().toISOString();
  return `urn:llm-ops:${namespace}:${timestamp}-${random4()}`;
}
