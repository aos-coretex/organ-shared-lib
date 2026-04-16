/**
 * Unit tests for llm-settings-loader.js — MP-CONFIG-1 relay l9m-3.
 *
 * Coverage:
 *   - Construction success against real Nomos fixture (smoke)
 *   - Cascade precedence: agent overrides organ default (scalars + thinking + fallback)
 *   - Default-only path when agent file missing
 *   - SettingsFileMissing on missing organ default
 *   - SettingsParseError on malformed YAML
 *   - LLMSettingsInvalid on schema-invalid YAML (e.g., bad schema_version)
 *   - listAgents() returns sorted agent names
 *   - reload() reflects mutation; reload() atomic on failure (cache preserved)
 *   - introspect() flat shape (bug #9 compliant)
 *   - tenant_urn inheritance + default
 *   - createLLMClient bug #8 field-name compatibility (smoke against actual factory)
 *   - Frozen return objects
 *   - Standalone (llm_required: false) pass-through
 *   - No Spine OTM / governance import audit
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoader, toLLMClientConfig } from '../lib/llm-settings-loader.js';
import {
  LLMSettingsInvalid,
  SettingsFileMissing,
  SettingsParseError,
} from '../lib/llm-errors.js';
import { createLLMClient } from '../lib/llm-client.js';

// ---------------------------------------------------------------------------
// Test fixtures helper — write a fake organ directory under tmpdir, return root.
// ---------------------------------------------------------------------------

function makeFixtureRoot() {
  return mkdtempSync(join(tmpdir(), 'l9m3-loader-'));
}

function expectThrows(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  assert.fail('expected throw');
}

function makeOrganDir(root, organNumber, organName, files = {}) {
  const dir = join(root, `${organNumber}-${capitalize(organName)}`);
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  return dir;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

const NOMOS_DEFAULT_YAML = `
schema_version: 1
organ: nomos
provider: anthropic
model: claude-sonnet-4-6
max_tokens: 2048
`;

const NOMOS_AGENT_YAML = `
schema_version: 1
organ: nomos
provider: anthropic
model: claude-haiku-4-5-20251001
max_tokens: 1024
`;

// ---------------------------------------------------------------------------
// Construction + happy cascade
// ---------------------------------------------------------------------------

describe('llm-settings-loader: construction + happy cascade', () => {
  let root;
  before(() => {
    root = makeFixtureRoot();
    makeOrganDir(root, 200, 'nomos', {
      'nomos-organ-default-llm-settings.yaml': NOMOS_DEFAULT_YAML,
      'nomos-organ-evidence-llm-settings.yaml': NOMOS_AGENT_YAML,
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('constructs without throwing against a valid fixture', () => {
    const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
    assert.equal(typeof loader.resolve, 'function');
    assert.equal(typeof loader.reload, 'function');
    assert.equal(typeof loader.listAgents, 'function');
    assert.equal(typeof loader.introspect, 'function');
  });

  it('resolve(agentName) returns agent-override-wins shape', () => {
    const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
    const cfg = loader.resolve('evidence');
    assert.equal(cfg.defaultModel, 'claude-haiku-4-5-20251001');
    assert.equal(cfg.maxTokens, 1024);
    assert.equal(cfg.agentName, 'evidence');
    assert.equal(cfg.organ, 'nomos');
  });

  it('resolve() with no agent returns default config', () => {
    const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
    const cfg = loader.resolve();
    assert.equal(cfg.defaultModel, 'claude-sonnet-4-6');
    assert.equal(cfg.maxTokens, 2048);
    assert.equal(cfg.agentName, 'default');
  });

  it('resolve("nonexistent-agent") returns organ default', () => {
    const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
    const cfg = loader.resolve('nonexistent-agent');
    assert.equal(cfg.defaultModel, 'claude-sonnet-4-6');
    assert.equal(cfg.agentName, 'nonexistent-agent');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('llm-settings-loader: error paths', () => {
  it('throws SettingsFileMissing when organ default absent', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 999, 'ghost', {}); // no files
      const err = expectThrows(
        () => createLoader({ organNumber: 999, organName: 'ghost', settingsRoot: root }),
      );
      assert.ok(err instanceof SettingsFileMissing);
      assert.match(err.expected_path, /ghost-organ-default-llm-settings\.yaml$/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws SettingsParseError on malformed YAML', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 999, 'broken', {
        'broken-organ-default-llm-settings.yaml': '---\n: : not: valid: yaml: { here',
      });
      const err = expectThrows(
        () => createLoader({ organNumber: 999, organName: 'broken', settingsRoot: root }),
      );
      assert.ok(err instanceof SettingsParseError);
      assert.equal(err.code, 'SETTINGS_PARSE_ERROR');
      assert.match(err.filename, /broken-organ-default/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throws LLMSettingsInvalid on schema-invalid YAML (bad schema_version)', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 999, 'badver', {
        'badver-organ-default-llm-settings.yaml':
          'schema_version: 2\norgan: badver\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 1024\n',
      });
      const err = expectThrows(
        () => createLoader({ organNumber: 999, organName: 'badver', settingsRoot: root }),
      );
      assert.ok(err instanceof LLMSettingsInvalid);
      assert.equal(err.field, 'schema_version');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// listAgents + introspect
// ---------------------------------------------------------------------------

describe('llm-settings-loader: listAgents + introspect', () => {
  let root;
  before(() => {
    root = makeFixtureRoot();
    makeOrganDir(root, 70, 'minder', {
      'minder-organ-default-llm-settings.yaml':
        'schema_version: 1\norgan: minder\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 1024\n',
      'minder-organ-deriver-llm-settings.yaml':
        'schema_version: 1\norgan: minder\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 1024\n',
      'minder-organ-induction-llm-settings.yaml':
        'schema_version: 1\norgan: minder\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 2048\n',
      'minder-organ-card-generator-llm-settings.yaml':
        'schema_version: 1\norgan: minder\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\n',
    });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('listAgents() returns sorted agent names (excludes "default")', () => {
    const loader = createLoader({ organNumber: 70, organName: 'minder', settingsRoot: root });
    assert.deepEqual(loader.listAgents(), ['card-generator', 'deriver', 'induction']);
  });

  it('introspect() returns flat shape (bug #9)', () => {
    const loader = createLoader({ organNumber: 70, organName: 'minder', settingsRoot: root });
    const i = loader.introspect();
    assert.deepEqual(Object.keys(i).sort(), ['agents', 'default', 'organ_name', 'organ_number']);
    assert.equal(i.organ_number, 70);
    assert.equal(i.organ_name, 'minder');
    assert.equal(i.default.defaultModel, 'claude-haiku-4-5-20251001');
    assert.equal(i.agents.length, 3);
    // No nested envelope (bug #9 — frontends consume keys directly).
    for (const a of i.agents) {
      assert.deepEqual(Object.keys(a).sort(), ['config', 'name']);
    }
  });
});

// ---------------------------------------------------------------------------
// Cascade precedence — D9 thinking + fallback
// ---------------------------------------------------------------------------

describe('llm-settings-loader: cascade precedence — D9 thinking', () => {
  it('agent thinking.enabled:false wins over organ thinking.enabled:true (wholesale replacement)', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 90, 'soul', {
        'soul-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: soul\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\nthinking:\n  enabled: true\n  budget_tokens: 10000\n',
        'soul-organ-quick-llm-settings.yaml':
          'schema_version: 1\norgan: soul\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\nthinking:\n  enabled: false\n',
      });
      const loader = createLoader({ organNumber: 90, organName: 'soul', settingsRoot: root });
      const cfg = loader.resolve('quick');
      assert.equal(cfg.thinking, false);
      assert.equal(cfg.thinkingBudget, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('agent thinking absent inherits organ thinking', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 90, 'soul', {
        'soul-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: soul\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\nthinking:\n  enabled: true\n  budget_tokens: 8000\n',
        'soul-organ-checker-llm-settings.yaml':
          'schema_version: 1\norgan: soul\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\n',
      });
      const loader = createLoader({ organNumber: 90, organName: 'soul', settingsRoot: root });
      const cfg = loader.resolve('checker');
      assert.equal(cfg.thinking, true);
      assert.equal(cfg.thinkingBudget, 8000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('llm-settings-loader: cascade precedence — fallback array', () => {
  it('agent fallback:[] wins wholesale over organ fallback:[{...}]', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 225, 'cortex', {
        'cortex-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: cortex\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\nfallback:\n  - provider: openai-compatible\n    model: qwen\n    max_tokens: 4096\n    deployment_target: gpu:8000\n',
        'cortex-organ-no-fallback-llm-settings.yaml':
          'schema_version: 1\norgan: cortex\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 4096\nfallback: []\n',
      });
      const loader = createLoader({ organNumber: 225, organName: 'cortex', settingsRoot: root });
      const cfg = loader.resolve('no-fallback');
      assert.deepEqual(cfg.fallback, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// reload — mutation reflection + atomicity on failure
// ---------------------------------------------------------------------------

describe('llm-settings-loader: reload', () => {
  it('reload() reflects file mutation', () => {
    const root = makeFixtureRoot();
    try {
      const dir = makeOrganDir(root, 80, 'hippocampus', {
        'hippocampus-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: hippocampus\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 512\n',
      });
      const loader = createLoader({ organNumber: 80, organName: 'hippocampus', settingsRoot: root });
      assert.equal(loader.resolve().maxTokens, 512);

      writeFileSync(
        join(dir, 'hippocampus-organ-default-llm-settings.yaml'),
        'schema_version: 1\norgan: hippocampus\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 1024\n',
      );

      // Pre-reload: cached old value.
      assert.equal(loader.resolve().maxTokens, 512);
      loader.reload();
      // Post-reload: new value.
      assert.equal(loader.resolve().maxTokens, 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reload() atomic on failure — old cache preserved', () => {
    const root = makeFixtureRoot();
    try {
      const dir = makeOrganDir(root, 80, 'hippocampus', {
        'hippocampus-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: hippocampus\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 512\n',
      });
      const loader = createLoader({ organNumber: 80, organName: 'hippocampus', settingsRoot: root });
      assert.equal(loader.resolve().maxTokens, 512);

      // Corrupt the file — schema_version: 99 fails validation.
      writeFileSync(
        join(dir, 'hippocampus-organ-default-llm-settings.yaml'),
        'schema_version: 99\norgan: hippocampus\nprovider: anthropic\nmodel: claude-haiku-4-5-20251001\nmax_tokens: 1024\n',
      );

      assert.throws(() => loader.reload(), LLMSettingsInvalid);

      // Cache unchanged — old value still resolvable.
      assert.equal(loader.resolve().maxTokens, 512);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// tenant_urn inheritance + default
// ---------------------------------------------------------------------------

describe('llm-settings-loader: tenant_urn', () => {
  it('inherits tenant_urn from organ default when agent has none', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 200, 'nomos', {
        'nomos-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: nomos\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 2048\ntenant_urn: urn:llm-ops:entity:graphheight\n',
        'nomos-organ-evidence-llm-settings.yaml':
          'schema_version: 1\norgan: nomos\nprovider: anthropic\nmodel: claude-sonnet-4-6\nmax_tokens: 2048\n',
      });
      const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
      assert.equal(loader.resolve('evidence').tenant_urn, 'urn:llm-ops:entity:graphheight');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('defaults to urn:llm-ops:entity:llm-ops-platform when neither sets it', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 200, 'nomos', {
        'nomos-organ-default-llm-settings.yaml': NOMOS_DEFAULT_YAML,
      });
      const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
      assert.equal(loader.resolve().tenant_urn, 'urn:llm-ops:entity:llm-ops-platform');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// createLLMClient compatibility (bug #8)
// ---------------------------------------------------------------------------

describe('llm-settings-loader: createLLMClient bug #8 compatibility', () => {
  it('resolved config passes to createLLMClient(configObject) without error', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 200, 'nomos', {
        'nomos-organ-default-llm-settings.yaml': NOMOS_DEFAULT_YAML,
      });
      const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
      const cfg = loader.resolve();
      // Must not throw — bug #8 pinning.
      const client = createLLMClient(cfg);
      assert.equal(typeof client.chat, 'function');
      assert.equal(typeof client.isAvailable, 'function');
      assert.equal(typeof client.getUsage, 'function');
      const u = client.getUsage();
      assert.equal(u.agent, 'default');
      assert.equal(u.model, 'claude-sonnet-4-6');
      assert.equal(u.provider, 'anthropic');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen return + standalone pass-through
// ---------------------------------------------------------------------------

describe('llm-settings-loader: misc invariants', () => {
  it('resolve() returns a frozen object', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 200, 'nomos', {
        'nomos-organ-default-llm-settings.yaml': NOMOS_DEFAULT_YAML,
      });
      const loader = createLoader({ organNumber: 200, organName: 'nomos', settingsRoot: root });
      const cfg = loader.resolve();
      assert.ok(Object.isFrozen(cfg));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('standalone (llm_required: false) resolves without LLM fields', () => {
    const root = makeFixtureRoot();
    try {
      makeOrganDir(root, 110, 'syntra', {
        'syntra-organ-default-llm-settings.yaml':
          'schema_version: 1\norgan: syntra\nllm_required: false\n',
      });
      const loader = createLoader({ organNumber: 110, organName: 'syntra', settingsRoot: root });
      const cfg = loader.resolve();
      assert.equal(cfg.llm_required, false);
      assert.equal(cfg.organ, 'syntra');
      assert.equal(cfg.tenant_urn, 'urn:llm-ops:entity:llm-ops-platform');
      assert.equal(cfg.defaultModel, undefined);
      assert.equal(cfg.defaultProvider, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// No Spine OTM / no governance binding (source audit)
// ---------------------------------------------------------------------------

describe('llm-settings-loader: scope-protection audit', () => {
  it('source does NOT import spine-client, governance-urn, or statute-cascade', () => {
    const src = readFileSync(
      new URL('../lib/llm-settings-loader.js', import.meta.url),
      'utf8',
    );
    assert.equal(/spine[-_]client/.test(src), false, 'must not import spine-client');
    assert.equal(/governance[-_]urn/.test(src), false, 'must not import governance-urn');
    assert.equal(/statute[-_]cascade/.test(src), false, 'must not import statute-cascade');
    assert.equal(/EventEmitter|events/i.test(src.split('\n').filter(l => l.startsWith('import')).join('\n')), false, 'must not import event-emitter');
  });
});

// ---------------------------------------------------------------------------
// Integration smoke against real Nomos fixture in 01-Organs/
// ---------------------------------------------------------------------------

describe('llm-settings-loader: real-fixture smoke (Nomos)', () => {
  it('loads real 01-Organs/200-Nomos/ files and resolves nomos-evidence', () => {
    const loader = createLoader({
      organNumber: 200,
      organName: 'nomos',
      settingsRoot: '/Library/AI/AI-Infra-MDvaults/MDvault-LLM-Ops/01-Organs',
    });
    assert.deepEqual(loader.listAgents(), ['nomos-evidence']);
    const cfg = loader.resolve('nomos-evidence');
    assert.equal(cfg.defaultProvider, 'anthropic');
    assert.equal(cfg.defaultModel, 'claude-sonnet-4-6');
    assert.equal(cfg.maxTokens, 2048);
    assert.equal(cfg.tenant_urn, 'urn:llm-ops:entity:llm-ops-platform');
  });
});
