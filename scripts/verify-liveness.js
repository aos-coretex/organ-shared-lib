#!/usr/bin/env node

/**
 * Liveness verification script for the DIO organism.
 *
 * Three verification rounds:
 *   Round 1: Health endpoints — all organs return HTTP 200 with status ok/degraded
 *   Round 2: Spine manifest — all organs appear in the connected list
 *   Round 3: Ping-pong — directed OTM round-trip for each non-Spine organ
 *
 * Usage:
 *   node scripts/verify-liveness.js [--tier aos|saas] [--start] [--keep-running] [--organs organ1,organ2,...]
 *
 * Relay l4e-8 — MP-4 completion gate.
 * Note: Round 2 uses GET /manifest (not /introspect) — the Spine implementation
 *       places the connected organ list at /manifest, not /introspect.
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Port registry (matches organ-registry.md and start-all.js) ---

const PORT_REGISTRY = {
  Spine:       { aos: 4000, saas: 3900 },
  Vectr:       { aos: 4001, saas: 3901 },
  Graph:       { aos: 4020, saas: 3920 },
  Phi:         { aos: 4005, saas: 3905 },
  Radiant:     { aos: 4006, saas: 3906 },
  Minder:      { aos: 4007, saas: 3907 },
  Lobe:        { aos: 4010, saas: 3910 },
  Syntra:      { aos: 4011, saas: 3911 },
  Vigil:       { aos: 4015, saas: 3915 },
  Glia:        { aos: 4016, saas: 3916 },
  SafeVault:   { aos: 4017, saas: 3917 },
  GitSync:     { aos: 4030, saas: 3930 },
  Promote:     { aos: 4031, saas: 3931 },
  Sourcegraph: { aos: 4032, saas: 3932 },
  Engram:      { aos: 4035, saas: 3935 },
  Axon:        { aos: 4051, saas: 3951 },
};

const ALL_ORGANS = Object.keys(PORT_REGISTRY);
const VERIFIER_NAME = 'liveness-verifier';

// --- Argument parsing ---

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { tier: 'aos', keepRunning: false, startAll: false, filterOrgans: null };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && args[i + 1]) opts.tier = args[++i];
    else if (args[i] === '--keep-running') opts.keepRunning = true;
    else if (args[i] === '--start') opts.startAll = true;
    else if (args[i] === '--organs' && args[i + 1]) {
      opts.filterOrgans = args[++i].split(',').map(s => s.trim());
    }
  }

  if (opts.tier !== 'aos' && opts.tier !== 'saas') {
    console.error('Invalid tier. Use --tier aos or --tier saas');
    process.exit(1);
  }

  return opts;
}

// --- HTTP helpers ---

async function fetchJson(url, options = {}) {
  const { timeoutMs = 5000, method = 'GET', body } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const init = {
      method,
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);

    const res = await fetch(url, init);
    const data = await res.json();
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- Round 1: Health endpoints ---

async function round1Health(organs, tier) {
  const results = [];

  for (const organ of organs) {
    const port = PORT_REGISTRY[organ][tier];
    const t0 = Date.now();
    const { ok, data, error } = await fetchJson(`http://127.0.0.1:${port}/health`);
    const ms = Date.now() - t0;

    if (!ok || !data) {
      results.push({ organ, port, pass: false, status: 'unreachable', ms, error });
    } else {
      const status = data.status || 'unknown';
      const pass = status === 'ok' || status === 'degraded';
      results.push({ organ, port, pass, status, ms });
    }
  }

  return results;
}

// --- Round 2: Spine manifest registration ---
// Uses GET /manifest (not /introspect — see file header comment)

async function round2Manifest(organs, spineUrl) {
  const results = [];

  const { ok, data, error } = await fetchJson(`${spineUrl}/manifest`);
  if (!ok || !data) {
    for (const organ of organs) {
      results.push({ organ, pass: false, registered: false, error: error || 'manifest unreachable' });
    }
    return results;
  }

  const connected = new Set(data.connected || []);

  for (const organ of organs) {
    // Spine is the bus itself — it doesn't connect to itself via WebSocket.
    // It's registered if its health endpoint responded (checked in Round 1).
    const isSpine = organ === 'Spine';
    const isConnected = isSpine || connected.has(organ);
    results.push({
      organ,
      pass: isConnected,
      registered: isConnected,
      note: isSpine ? 'self (bus)' : undefined,
    });
  }

  return results;
}

// --- Round 3: Ping-pong round-trip ---

async function round3PingPong(organs, spineUrl) {
  const results = [];
  const pingTargets = organs.filter(o => o !== 'Spine');

  if (pingTargets.length === 0) return results;

  // 1. Register liveness-verifier in manifest + mailbox
  //    Manifest: so the routing engine accepts pong responses targeted at us
  //    Mailbox: so we can drain received messages
  const manifestRes = await fetchJson(`${spineUrl}/manifest/${VERIFIER_NAME}`, {
    method: 'POST', body: { required: false },
  });
  const mailboxRes = await fetchJson(`${spineUrl}/mailbox/${VERIFIER_NAME}`, {
    method: 'POST', body: {},
  });

  if (!manifestRes.ok && manifestRes.status !== 200) {
    // 200 = already exists (idempotent), 201 = created
    for (const organ of pingTargets) {
      results.push({ organ, pass: false, ms: 0, error: 'verifier manifest registration failed' });
    }
    return results;
  }

  // 2. Send directed pings to each organ
  const sentPings = new Map(); // Spine-assigned message_id → { organ, sentAt }

  for (const organ of pingTargets) {
    const t0 = Date.now();
    const { ok, data } = await fetchJson(`${spineUrl}/messages`, {
      method: 'POST',
      body: {
        type: 'OTM',
        source_organ: VERIFIER_NAME,
        target_organ: organ,
        reply_to: VERIFIER_NAME,
        payload: { event_type: 'ping', data: { verify: true } },
      },
      timeoutMs: 10_000,
    });

    if (ok && data?.message_id) {
      sentPings.set(data.message_id, { organ, sentAt: t0 });
    } else {
      results.push({ organ, pass: false, ms: 0, error: `ping send failed: ${data?.error || 'unknown'}` });
    }
  }

  // 3. Poll mailbox for pong responses (max 15s, poll every 500ms)
  const receivedPongs = new Map(); // correlation_id → receivedAt
  const deadline = Date.now() + 15_000;

  while (receivedPongs.size < sentPings.size && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));

    const { ok, data } = await fetchJson(`${spineUrl}/mailbox/${VERIFIER_NAME}/drain`, {
      method: 'POST', body: { limit: 100 }, timeoutMs: 5000,
    });

    if (ok && data?.messages) {
      for (const msg of data.messages) {
        if (msg.payload?.event_type === 'pong' && msg.correlation_id) {
          receivedPongs.set(msg.correlation_id, Date.now());
        }
      }

      // Ack all drained messages
      const ids = data.messages.map(m => m.message_id).filter(Boolean);
      if (ids.length > 0) {
        await fetchJson(`${spineUrl}/mailbox/${VERIFIER_NAME}/ack`, {
          method: 'POST', body: { message_ids: ids }, timeoutMs: 5000,
        });
      }
    }
  }

  // 4. Match pongs to pings
  for (const [messageId, { organ, sentAt }] of sentPings) {
    if (results.some(r => r.organ === organ)) continue; // already failed at send

    if (receivedPongs.has(messageId)) {
      results.push({ organ, pass: true, ms: receivedPongs.get(messageId) - sentAt });
    } else {
      results.push({ organ, pass: false, ms: 0, error: 'pong timeout (15s)' });
    }
  }

  return results;
}

// --- Report generation ---

function generateReport(tier, r1, r2, r3, organs) {
  const lines = [];
  const date = new Date().toISOString().split('T')[0];
  const portRange = tier === 'aos' ? '4000-series' : '3900-series';

  lines.push('=== Organ Liveness Verification ===');
  lines.push(`Date: ${date}`);
  lines.push(`Tier: ${tier.toUpperCase()} (${portRange} ports)`);
  lines.push('');

  // Round 1: Health
  lines.push('Round 1: Health Endpoints');
  let r1Pass = 0;
  for (const r of r1) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const pad = r.organ.padEnd(12);
    const portStr = `:${r.port}`;
    const detail = r.error
      ? `error     ${r.error}`
      : `${r.status.padEnd(10)}${r.ms}ms`;
    lines.push(`  [${tag}] ${pad} ${portStr.padEnd(7)} ${detail}`);
    if (r.pass) r1Pass++;
  }
  lines.push(`  Result: ${r1Pass}/${r1.length} PASS`);
  lines.push('');

  // Round 2: Manifest
  lines.push('Round 2: Spine Manifest Registration');
  let r2Pass = 0;
  for (const r of r2) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const pad = r.organ.padEnd(12);
    const detail = r.note
      ? r.note
      : r.registered
        ? 'connected'
        : `missing${r.error ? ` (${r.error})` : ''}`;
    lines.push(`  [${tag}] ${pad} ${detail}`);
    if (r.pass) r2Pass++;
  }
  lines.push(`  Result: ${r2Pass}/${r2.length} PASS`);
  lines.push('');

  // Round 3: Ping-pong
  lines.push('Round 3: Ping-Pong Round-Trip');
  let r3Pass = 0;
  const nonSpine = organs.filter(o => o !== 'Spine');
  for (const r of r3) {
    const tag = r.pass ? 'PASS' : 'FAIL';
    const pad = r.organ.padEnd(12);
    const detail = r.pass ? `${r.ms}ms` : (r.error || 'failed');
    lines.push(`  [${tag}] ${pad} ${detail}`);
    if (r.pass) r3Pass++;
  }
  if (organs.includes('Spine')) {
    lines.push(`  [N/A]  Spine        (self — verified via health)`);
  }
  lines.push(`  Result: ${r3Pass}/${nonSpine.length} PASS${organs.includes('Spine') ? ' (+1 N/A Spine)' : ''}`);
  lines.push('');

  // Overall
  const allPass = r1Pass === r1.length && r2Pass === r2.length && r3Pass === nonSpine.length;
  lines.push(`=== OVERALL: ${allPass ? 'PASS' : 'FAIL'} (${r1Pass}/${r1.length} alive, ${r3Pass}/${nonSpine.length} communicating) ===`);

  return { text: lines.join('\n'), allPass };
}

// --- Start-all integration ---

function startOrgans(tier, filterOrgans) {
  return new Promise((resolveP, rejectP) => {
    const startScript = resolve(__dirname, 'start-all.js');
    const args = ['--tier', tier];
    if (filterOrgans) args.push('--organs', filterOrgans.join(','));

    const child = spawn('node', [startScript, ...args], { stdio: 'pipe' });

    let resolved = false;

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (text.includes('"start_all_complete"') && !resolved) {
        resolved = true;
        resolveP(child);
      }
    });

    child.on('error', (err) => {
      if (!resolved) { resolved = true; rejectP(err); }
    });

    // Timeout: 3 minutes for full startup (16 organs, Vectr may be slow)
    setTimeout(() => {
      if (!resolved) { resolved = true; resolveP(child); }
    }, 180_000);
  });
}

// --- Main ---

async function main() {
  const { tier, keepRunning, startAll, filterOrgans } = parseArgs();
  const organs = filterOrgans || ALL_ORGANS;
  const spinePort = PORT_REGISTRY.Spine[tier];
  const spineUrl = `http://127.0.0.1:${spinePort}`;

  console.log(`Organ Liveness Verification — ${tier.toUpperCase()} tier`);
  console.log(`Organs: ${organs.length} (${organs.join(', ')})\n`);

  let startChild = null;

  // Optionally start all organs
  if (startAll) {
    console.log('Starting all organs via start-all.js...');
    startChild = await startOrgans(tier, filterOrgans);
    console.log('Organs started. Beginning verification.\n');
  }

  // Round 1
  console.log('Round 1: Checking health endpoints...');
  const r1 = await round1Health(organs, tier);
  const r1Pass = r1.filter(r => r.pass).length;
  console.log(`  ${r1Pass}/${r1.length} healthy\n`);

  // Round 2
  console.log('Round 2: Checking Spine manifest...');
  const r2 = await round2Manifest(organs, spineUrl);
  const r2Pass = r2.filter(r => r.pass).length;
  console.log(`  ${r2Pass}/${r2.length} connected\n`);

  // Round 3
  const nonSpine = organs.filter(o => o !== 'Spine');
  console.log(`Round 3: Running ping-pong (${nonSpine.length} organs)...`);
  const r3 = await round3PingPong(organs, spineUrl);
  const r3Pass = r3.filter(r => r.pass).length;
  console.log(`  ${r3Pass}/${nonSpine.length} responded\n`);

  // Generate report
  const { text: report, allPass } = generateReport(tier, r1, r2, r3, organs);
  console.log(report);

  // Write report to file
  const dataDir = resolve(__dirname, '..', 'data');
  mkdirSync(dataDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = resolve(dataDir, `liveness-report-${ts}.txt`);
  writeFileSync(reportPath, report + '\n');
  console.log(`\nReport written to: ${reportPath}`);

  // Shutdown if not keeping running
  if (startChild && !keepRunning) {
    console.log('\nShutting down organs...');
    startChild.kill('SIGTERM');
    await new Promise(r => setTimeout(r, 3000));
  }

  process.exit(allPass ? 0 : 1);
}

main().catch(err => {
  console.error('Verification failed:', err.message);
  process.exit(1);
});
