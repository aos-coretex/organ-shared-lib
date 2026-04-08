import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createLLMClient, LLMUnavailableError, LLMCallError } from '../lib/llm-client.js';

describe('LLM Client', () => {
  const originalEnv = {};

  beforeEach(() => {
    originalEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    originalEnv.TEST_LLM_KEY = process.env.TEST_LLM_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.TEST_LLM_KEY;
  });

  afterEach(() => {
    if (originalEnv.ANTHROPIC_API_KEY !== undefined) {
      process.env.ANTHROPIC_API_KEY = originalEnv.ANTHROPIC_API_KEY;
    } else {
      delete process.env.ANTHROPIC_API_KEY;
    }
    if (originalEnv.TEST_LLM_KEY !== undefined) {
      process.env.TEST_LLM_KEY = originalEnv.TEST_LLM_KEY;
    } else {
      delete process.env.TEST_LLM_KEY;
    }
    mock.restoreAll();
  });

  describe('createLLMClient factory', () => {
    it('creates a client with required methods', () => {
      const client = createLLMClient({
        agentName: 'test-agent',
        defaultModel: 'claude-haiku-4-5-20251001',
      });

      assert.equal(typeof client.chat, 'function');
      assert.equal(typeof client.isAvailable, 'function');
      assert.equal(typeof client.getUsage, 'function');
    });

    it('reports unavailable when API key is missing', () => {
      const client = createLLMClient({
        agentName: 'test-agent',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'ANTHROPIC_API_KEY',
      });

      assert.equal(client.isAvailable(), false);
    });

    it('reports available when API key is set', () => {
      process.env.TEST_LLM_KEY = 'sk-test-key';

      const client = createLLMClient({
        agentName: 'test-agent',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      assert.equal(client.isAvailable(), true);
    });
  });

  describe('chat — unavailable', () => {
    it('throws LLMUnavailableError when API key is missing', async () => {
      const client = createLLMClient({
        agentName: 'test-agent',
        defaultModel: 'claude-haiku-4-5-20251001',
      });

      await assert.rejects(
        () => client.chat([{ role: 'user', content: 'hello' }]),
        (err) => {
          assert.equal(err instanceof LLMUnavailableError, true);
          assert.equal(err.code, 'LLM_UNAVAILABLE');
          return true;
        },
      );
    });
  });

  describe('chat — Anthropic provider', () => {
    it('calls Anthropic API and returns parsed response', async () => {
      process.env.TEST_LLM_KEY = 'sk-test-anthropic';

      const mockResponse = {
        content: [{ type: 'text', text: 'Hello from Claude' }],
        model: 'claude-haiku-4-5-20251001',
        usage: { input_tokens: 10, output_tokens: 5 },
      };

      const fetchMock = mock.fn(async () => ({
        ok: true,
        json: async () => mockResponse,
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'deriver',
        defaultModel: 'claude-haiku-4-5-20251001',
        defaultProvider: 'anthropic',
        apiKeyEnvVar: 'TEST_LLM_KEY',
        maxTokens: 512,
      });

      const result = await client.chat([{ role: 'user', content: 'test' }]);

      assert.equal(result.content, 'Hello from Claude');
      assert.equal(result.model, 'claude-haiku-4-5-20251001');
      assert.equal(result.input_tokens, 10);
      assert.equal(result.output_tokens, 5);

      // Verify fetch was called with correct URL and headers
      const [url, opts] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, 'https://api.anthropic.com/v1/messages');
      assert.equal(opts.method, 'POST');
      const headers = opts.headers;
      assert.equal(headers['x-api-key'], 'sk-test-anthropic');
      assert.equal(headers['anthropic-version'], '2023-06-01');

      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'claude-haiku-4-5-20251001');
      assert.equal(body.max_tokens, 512);
      assert.deepEqual(body.messages, [{ role: 'user', content: 'test' }]);
    });

    it('passes system prompt when provided', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      const fetchMock = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 5, output_tokens: 2 },
        }),
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'card-gen',
        defaultModel: 'claude-sonnet-4-6',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      await client.chat(
        [{ role: 'user', content: 'generate card' }],
        { system: 'You are a card generator.' },
      );

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      assert.equal(body.system, 'You are a card generator.');
    });

    it('enables extended thinking when configured', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      const fetchMock = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'answer' }],
          usage: { input_tokens: 20, output_tokens: 50 },
        }),
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'dialectic',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      const result = await client.chat(
        [{ role: 'user', content: 'analyze' }],
        { thinking: true, thinkingBudget: 5000 },
      );

      // Only text blocks returned as content
      assert.equal(result.content, 'answer');

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 5000 });
    });

    it('throws LLMCallError on API error', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      const fetchMock = mock.fn(async () => ({
        ok: false,
        status: 429,
        text: async () => 'Rate limited',
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'deriver',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      await assert.rejects(
        () => client.chat([{ role: 'user', content: 'test' }]),
        (err) => {
          assert.equal(err instanceof LLMCallError, true);
          assert.equal(err.code, 'LLM_CALL_FAILED');
          return true;
        },
      );
    });
  });

  describe('chat — OpenAI-compatible provider', () => {
    it('calls OpenAI-compatible API with correct format', async () => {
      process.env.TEST_LLM_KEY = 'none';

      const mockResponse = {
        choices: [{ message: { content: 'Local model response' } }],
        model: 'llama3',
        usage: { prompt_tokens: 8, completion_tokens: 4 },
      };

      const fetchMock = mock.fn(async () => ({
        ok: true,
        json: async () => mockResponse,
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'local-agent',
        defaultModel: 'llama3',
        defaultProvider: 'openai-compatible',
        apiKeyEnvVar: 'TEST_LLM_KEY',
        baseUrl: 'http://127.0.0.1:11434',
      });

      const result = await client.chat([{ role: 'user', content: 'hi' }]);

      assert.equal(result.content, 'Local model response');
      assert.equal(result.model, 'llama3');
      assert.equal(result.input_tokens, 8);
      assert.equal(result.output_tokens, 4);

      const [url] = fetchMock.mock.calls[0].arguments;
      assert.equal(url, 'http://127.0.0.1:11434/v1/chat/completions');
    });
  });

  describe('usage tracking', () => {
    it('accumulates usage across multiple calls', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      let callCount = 0;
      const fetchMock = mock.fn(async () => {
        callCount++;
        return {
          ok: true,
          json: async () => ({
            content: [{ type: 'text', text: 'ok' }],
            usage: { input_tokens: 10 * callCount, output_tokens: 5 * callCount },
          }),
        };
      });
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'deriver',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      await client.chat([{ role: 'user', content: 'call 1' }]);
      await client.chat([{ role: 'user', content: 'call 2' }]);

      const u = client.getUsage();
      assert.equal(u.agent, 'deriver');
      assert.equal(u.model, 'claude-haiku-4-5-20251001');
      assert.equal(u.provider, 'anthropic');
      assert.equal(u.total_input, 30);   // 10 + 20
      assert.equal(u.total_output, 15);  // 5 + 10
      assert.equal(u.total_calls, 2);
      assert.equal(u.errors, 0);
    });

    it('tracks errors in usage', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      const fetchMock = mock.fn(async () => ({
        ok: false,
        status: 500,
        text: async () => 'Server error',
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'failer',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      try { await client.chat([{ role: 'user', content: 'fail' }]); } catch {}

      const u = client.getUsage();
      assert.equal(u.errors, 1);
      assert.equal(u.total_calls, 0);
    });
  });

  describe('model override per call', () => {
    it('uses overridden model instead of default', async () => {
      process.env.TEST_LLM_KEY = 'sk-test';

      const fetchMock = mock.fn(async () => ({
        ok: true,
        json: async () => ({
          content: [{ type: 'text', text: 'ok' }],
          model: 'claude-sonnet-4-6',
          usage: { input_tokens: 5, output_tokens: 3 },
        }),
      }));
      mock.method(globalThis, 'fetch', fetchMock);

      const client = createLLMClient({
        agentName: 'flex-agent',
        defaultModel: 'claude-haiku-4-5-20251001',
        apiKeyEnvVar: 'TEST_LLM_KEY',
      });

      const result = await client.chat(
        [{ role: 'user', content: 'test' }],
        { model: 'claude-sonnet-4-6' },
      );

      assert.equal(result.model, 'claude-sonnet-4-6');

      const body = JSON.parse(fetchMock.mock.calls[0].arguments[1].body);
      assert.equal(body.model, 'claude-sonnet-4-6');
    });
  });
});
