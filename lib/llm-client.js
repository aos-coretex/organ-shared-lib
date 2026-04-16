/**
 * Shared LLM client factory for DIO organs.
 *
 * Every probabilistic organ creates per-agent LLM clients using this factory.
 * Supports Anthropic (native SDK) and OpenAI-compatible (raw fetch for Ollama/vLLM).
 *
 * Design:
 *   - Per-agent model assignment (not per-organ)
 *   - Graceful degradation: isAvailable() returns false if API key missing
 *   - Token usage tracking per agent
 *   - Never throws on missing config — reports unavailability
 *
 * Known consumers (7 probabilistic organs, 17+ LLM agents):
 *   Radiant   — Phase 2 dream consolidation (1 agent)           [MP-4 l4e-2]
 *   Minder    — Deriver, deduction, induction, dialectic, card   [MP-4 l4e-2]
 *   Lobe      — Constitutional classifier, cross-pollinator,     [MP-4 l4e-3]
 *               session synthesizer (3 agents)
 *   Soul      — Behavioral observer, consistency checker,        [MP-7]
 *               evolution analyst, persona dream (4 agents)
 *   Cortex    — Strategic assessment (1+ agents)                 [MP-12]
 *   Nomos     — Nomos-Evidence, advisory opinions (2 agents)     [MP-9]
 *   Arbiter   — Clause matching (1 agent)                        [MP-8]
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} config
 * @param {string} config.agentName        - e.g., "deriver", "induction_worker"
 * @param {string} config.defaultModel     - e.g., "claude-haiku-4-5-20251001"
 * @param {string} config.defaultProvider  - "anthropic" | "openai-compatible"
 * @param {string} config.apiKeyEnvVar     - e.g., "ANTHROPIC_API_KEY"
 * @param {number} config.maxTokens        - default max output tokens
 * @param {boolean} config.thinking        - enable extended thinking (Anthropic only)
 * @param {number} config.thinkingBudget   - thinking budget tokens (default 10000)
 * @param {string} config.baseUrl          - override base URL (for OpenAI-compatible endpoints)
 * @returns {{ chat, isAvailable, getUsage }}
 */
export function createLLMClient(config) {
  const {
    agentName,
    defaultModel,
    defaultProvider = 'anthropic',
    apiKeyEnvVar = 'ANTHROPIC_API_KEY',
    maxTokens = 1024,
    thinking = false,
    thinkingBudget = 10000,
    baseUrl,
  } = config;

  // Usage tracking
  const usage = {
    total_input: 0,
    total_output: 0,
    total_calls: 0,
    errors: 0,
  };

  // Resolve API key from environment
  function getApiKey() {
    return process.env[apiKeyEnvVar] || null;
  }

  /**
   * Check if this LLM client is available (API key present).
   * Does NOT check provider reachability — that's a runtime concern.
   */
  function isAvailable() {
    return getApiKey() !== null;
  }

  /**
   * Send a chat request to the configured provider.
   *
   * @param {Array<{role: string, content: string}>} messages
   * @param {object} options
   * @param {string} options.model   - override model for this call
   * @param {number} options.maxTokens - override max tokens
   * @param {string} options.system  - system prompt
   * @param {number} options.temperature - sampling temperature
   * @returns {Promise<{content: string, model: string, input_tokens: number, output_tokens: number}>}
   */
  async function chat(messages, options = {}) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new LLMUnavailableError(`API key not set (env: ${apiKeyEnvVar})`);
    }

    const model = options.model || defaultModel;
    const tokens = options.maxTokens || maxTokens;

    try {
      let result;
      if (defaultProvider === 'anthropic') {
        result = await callAnthropic(apiKey, model, messages, tokens, options);
      } else if (defaultProvider === 'openai-compatible') {
        // Merge config-level baseUrl into per-call options so callOpenAICompatible
        // can use it. Per-call `options.baseUrl` wins over `config.baseUrl`.
        const ocOptions = { ...options };
        if (ocOptions.baseUrl === undefined && baseUrl !== undefined) {
          ocOptions.baseUrl = baseUrl;
        }
        result = await callOpenAICompatible(apiKey, model, messages, tokens, ocOptions);
      } else {
        throw new Error(`Unknown provider: ${defaultProvider}`);
      }

      // Track usage
      usage.total_input += result.input_tokens;
      usage.total_output += result.output_tokens;
      usage.total_calls += 1;

      log('llm_call_complete', {
        agent: agentName,
        model: result.model,
        input_tokens: result.input_tokens,
        output_tokens: result.output_tokens,
        provider: defaultProvider,
      });

      return result;
    } catch (err) {
      usage.errors += 1;
      if (err instanceof LLMUnavailableError) throw err;

      log('llm_call_error', {
        agent: agentName,
        model,
        provider: defaultProvider,
        error: err.message,
      });
      throw new LLMCallError(err.message, { cause: err });
    }
  }

  /**
   * Get cumulative usage stats for this agent.
   */
  function getUsage() {
    return {
      agent: agentName,
      model: defaultModel,
      provider: defaultProvider,
      ...usage,
    };
  }

  return { chat, isAvailable, getUsage };
}

// --- Anthropic provider ---

async function callAnthropic(apiKey, model, messages, maxTokens, options) {
  const url = 'https://api.anthropic.com/v1/messages';

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  if (options.system) {
    body.system = options.system;
  }

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  // Extended thinking support
  if (options.thinking) {
    body.thinking = {
      type: 'enabled',
      budget_tokens: options.thinkingBudget || 10000,
    };
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`Anthropic API ${res.status}: ${errorBody}`);
  }

  const data = await res.json();

  // Extract text content from response
  const textBlocks = (data.content || []).filter(b => b.type === 'text');
  const content = textBlocks.map(b => b.text).join('');

  return {
    content,
    model: data.model || model,
    input_tokens: data.usage?.input_tokens || 0,
    output_tokens: data.usage?.output_tokens || 0,
  };
}

// --- OpenAI-compatible provider (vLLM / TGI / llama.cpp / Ollama) ---
//
// MP-CONFIG-1 R2 hardening (relay l9m-2):
//   - `baseUrl` consumed from per-call options (which receives config.baseUrl
//     via the chat() merge step). Legacy default `http://127.0.0.1:11434` only
//     fires when both are absent — preserves Ollama out-of-the-box behavior.
//   - Explicit per-call timeout via AbortController. Budget is `max(maxTokens * 100ms, 5000ms)`
//     unless `options.timeoutMs` overrides. Documented assumption only — R4
//     imposes the actual cascade-level timeout.
//   - Errors thrown from this function carry structured fields (`.status`,
//     `.body`, `.provider`) so `classifyLLMFailure` can detect HTTP class +
//     body patterns reliably without regex-grepping the message text.
//   - Body-text "model not loaded" detection delegated to classifier; this
//     function simply preserves the body verbatim on the thrown error.
//
// NOT changed: the Anthropic provider path. Existing callAnthropic() is
// untouched (regression test pinned in test/llm-client.test.js).
//
// NOT added: streaming. Non-streaming JSON POST only. Streaming support is a
// future MP — when it lands, `context.duringStream` will be set by R4 so the
// classifier can return `timeout_during_streaming` for stream-mid-flight aborts.

const DEFAULT_OPENAI_COMPAT_BASE_URL = 'http://127.0.0.1:11434';

function makeProviderError(message, { status, body, provider, cause } = {}) {
  const err = new Error(message);
  if (status !== undefined) err.status = status;
  if (body !== undefined) err.body = body;
  if (provider !== undefined) err.provider = provider;
  if (cause !== undefined) err.cause = cause;
  return err;
}

async function callOpenAICompatible(apiKey, model, messages, maxTokens, options) {
  const base = options.baseUrl || DEFAULT_OPENAI_COMPAT_BASE_URL;
  const url = base.replace(/\/+$/, '') + '/v1/chat/completions';

  const body = {
    model,
    max_tokens: maxTokens,
    messages,
  };

  if (options.temperature !== undefined) {
    body.temperature = options.temperature;
  }

  const headers = {
    'Content-Type': 'application/json',
  };

  // Some OpenAI-compatible APIs require auth (vLLM with --api-key, llama.cpp
  // with --api-key, hosted endpoints). Local Ollama defaults to 'none'.
  if (apiKey && apiKey !== 'none') {
    headers['Authorization'] = `Bearer ${apiKey}`;
  }

  // Timeout — rough budget; R4 supersedes with cascade-level enforcement.
  const timeoutMs = options.timeoutMs || Math.max(maxTokens * 100, 5000);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (fetchErr) {
    clearTimeout(timer);
    // Network-layer failure (ECONNREFUSED, AbortError on timeout, DNS failure).
    // Re-throw with structured provider context so the classifier can read
    // `.cause` for syscall codes (Node fetch wraps undici errors as
    // TypeError with chained cause).
    throw makeProviderError(
      `openai-compatible fetch failed: ${fetchErr.message}`,
      { provider: 'openai-compatible', cause: fetchErr },
    );
  }
  clearTimeout(timer);

  if (!res.ok) {
    let errorBody;
    try {
      errorBody = await res.text();
    } catch {
      errorBody = '';
    }
    throw makeProviderError(
      `openai-compatible API ${res.status}: ${errorBody}`,
      { status: res.status, body: errorBody, provider: 'openai-compatible' },
    );
  }

  let data;
  try {
    data = await res.json();
  } catch (parseErr) {
    throw makeProviderError(
      `openai-compatible response JSON parse error: ${parseErr.message}`,
      { status: res.status, provider: 'openai-compatible', cause: parseErr },
    );
  }
  const choice = data.choices?.[0];

  return {
    content: choice?.message?.content || '',
    model: data.model || model,
    input_tokens: data.usage?.prompt_tokens || 0,
    output_tokens: data.usage?.completion_tokens || 0,
  };
}

// --- Error types ---

export class LLMUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LLMUnavailableError';
    this.code = 'LLM_UNAVAILABLE';
  }
}

export class LLMCallError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'LLMCallError';
    this.code = 'LLM_CALL_FAILED';
  }
}
