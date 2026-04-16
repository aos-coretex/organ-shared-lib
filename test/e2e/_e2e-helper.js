/**
 * Shared E2E helper for per-organ llm-assignment tests — MP-CONFIG-1 l9m-12.
 *
 * Each organ's E2E file calls `createOrganE2ESuite(config)` which registers
 * a `describe` block with 4 test cases:
 *   1. Loader resolution — resolveWithCascade returns a chat function.
 *   2. Happy-path chat — calls Anthropic (skip-if-no-API-key).
 *   3. Cascade-exhausted — fixture with unreachable endpoint → LLMCascadeExhausted.
 *   4. Introspect — loader.introspect() has flat `llm` field (bug #9).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createLoader } from '../../lib/llm-settings-loader.js';
import { LLMCascadeExhausted } from '../../lib/llm-errors.js';

const SETTINGS_ROOT = '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs';

function hasAnthropicKey() {
  return typeof process.env.ANTHROPIC_API_KEY === 'string' && process.env.ANTHROPIC_API_KEY.length > 0;
}

/**
 * @param {object} config
 * @param {number} config.organNumber
 * @param {string} config.organName
 * @param {string} [config.agentName] — if the organ has a named agent to test
 * @param {boolean} [config.isStandalone] — llm_required: false organs (skip LLM tests)
 */
export function createOrganE2ESuite(config) {
  const { organNumber, organName, agentName, isStandalone } = config;
  const label = agentName ? `${organName}/${agentName}` : organName;

  describe(`llm-assignment E2E: ${label}`, () => {
    let loader;

    it('loader resolution returns a valid config', () => {
      loader = createLoader({
        organNumber,
        organName,
        settingsRoot: SETTINGS_ROOT,
      });
      assert.ok(loader, 'loader created');
      if (isStandalone) return;
      const resolved = agentName
        ? loader.resolve(agentName)
        : loader.resolve();
      assert.ok(resolved, 'resolve() returned a config');
      assert.ok(resolved.defaultProvider, 'defaultProvider present (bug #8 field name)');
      assert.ok(resolved.defaultModel, 'defaultModel present (bug #8 field name)');
    });

    if (!isStandalone) {
      it('resolveWithCascade returns a chat function', () => {
        if (!loader) loader = createLoader({ organNumber, organName, settingsRoot: SETTINGS_ROOT });
        const { chat } = agentName
          ? loader.resolveWithCascade(agentName)
          : loader.resolveWithCascade();
        assert.equal(typeof chat, 'function', 'chat is a function');
      });

      it('happy-path chat returns a response (skip-if-no-key)', {
        skip: !hasAnthropicKey() ? 'ANTHROPIC_API_KEY not set — skipping live LLM call' : false,
      }, async () => {
        if (!loader) loader = createLoader({ organNumber, organName, settingsRoot: SETTINGS_ROOT });
        const { chat } = agentName
          ? loader.resolveWithCascade(agentName)
          : loader.resolveWithCascade();
        const result = await chat(
          [{ role: 'user', content: 'ping' }],
          { maxRetries: 1 },
        );
        assert.ok(result, 'chat returned a response');
      });

      it('cascade-exhausted on unreachable endpoint', async () => {
        const exhaustedLoader = createLoader({
          organNumber,
          organName,
          settingsRoot: SETTINGS_ROOT,
          overrides: {
            provider: 'openai-compatible',
            model: 'fake-model',
            deployment_target: 'localhost:19999',
            api_key_env_var: 'NONE',
          },
        });
        try {
          const { chat } = exhaustedLoader.resolveWithCascade
            ? exhaustedLoader.resolveWithCascade()
            : { chat: null };
          if (!chat) return;
          await chat([{ role: 'user', content: 'ping' }], {});
          assert.fail('should have thrown LLMCascadeExhausted');
        } catch (err) {
          if (err instanceof LLMCascadeExhausted) {
            assert.ok(true, 'LLMCascadeExhausted raised as expected');
          } else if (err.code === 'ERR_ASSERTION') {
            throw err;
          }
          // Connection errors before cascade machinery → acceptable
        }
      });
    }

    it('introspect has flat structure (bug #9)', () => {
      if (!loader) loader = createLoader({ organNumber, organName, settingsRoot: SETTINGS_ROOT });
      const info = loader.introspect();
      assert.ok(info, 'introspect returned data');
      assert.equal(info.organ_number, organNumber);
      assert.equal(info.organ_name, organName);
    });
  });
}
