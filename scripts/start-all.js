#!/usr/bin/env node

/**
 * Topological startup orchestrator for all DIO organs.
 *
 * Usage:
 *   node scripts/start-all.js [--tier aos|saas] [--organs organ1,organ2,...] [--timeout <seconds>]
 *
 * Reads boot-graph.json, topologically sorts organs, then spawns each in order.
 * Each organ must be healthy before the next starts.
 */

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- Port registry (from organ-registry.md) ---

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

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

// --- Topological sort (Kahn's algorithm) ---

export function topologicalSort(graph) {
  const inDegree = new Map();
  const adjacency = new Map();

  // Initialize
  for (const node of Object.keys(graph)) {
    if (!inDegree.has(node)) inDegree.set(node, 0);
    if (!adjacency.has(node)) adjacency.set(node, []);

    for (const dep of graph[node]) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      if (!adjacency.has(dep)) adjacency.set(dep, []);
      adjacency.get(dep).push(node);
      inDegree.set(node, inDegree.get(node) + 1);
    }
  }

  // Start with nodes that have zero in-degree
  const queue = [];
  for (const [node, deg] of inDegree) {
    if (deg === 0) queue.push(node);
  }

  const sorted = [];
  while (queue.length > 0) {
    // Sort queue for deterministic order
    queue.sort();
    const node = queue.shift();
    sorted.push(node);

    for (const neighbor of adjacency.get(node)) {
      const newDeg = inDegree.get(neighbor) - 1;
      inDegree.set(neighbor, newDeg);
      if (newDeg === 0) queue.push(neighbor);
    }
  }

  if (sorted.length !== inDegree.size) {
    const remaining = [...inDegree.keys()].filter(n => !sorted.includes(n));
    throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`);
  }

  return sorted;
}

/**
 * Get transitive dependencies for a set of organs.
 */
export function getTransitiveDeps(graph, organs) {
  const needed = new Set();

  function walk(organ) {
    if (needed.has(organ)) return;
    needed.add(organ);
    for (const dep of (graph[organ] || [])) {
      walk(dep);
    }
  }

  for (const organ of organs) {
    walk(organ);
  }

  return needed;
}

// --- Health polling ---

async function waitForHealth(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

// --- Resolve organ project directory ---

function resolveOrganDir(organName, baseDir) {
  const lower = organName.toLowerCase();
  return resolve(baseDir, `AOS-organ-${lower}`, `AOS-organ-${lower}-src`);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);

  // Parse arguments
  let tier = 'aos';
  let filterOrgans = null;
  let timeoutMs = 60_000; // default 60s per organ

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && args[i + 1]) {
      tier = args[++i];
    } else if (args[i] === '--organs' && args[i + 1]) {
      filterOrgans = args[++i].split(',').map(s => s.trim());
    } else if (args[i] === '--timeout' && args[i + 1]) {
      timeoutMs = parseInt(args[++i], 10) * 1000;
    }
  }

  // Per-organ timeout overrides (Vectr needs longer for model loading)
  const TIMEOUT_OVERRIDES = {
    Vectr: 120_000,
  };

  if (tier !== 'aos' && tier !== 'saas') {
    console.error('Invalid tier. Use --tier aos or --tier saas');
    process.exit(1);
  }

  // Load boot graph
  const graphPath = resolve(__dirname, '..', 'boot-graph.json');
  const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));

  // Filter to requested organs + transitive dependencies
  let targetGraph = graph;
  if (filterOrgans) {
    const needed = getTransitiveDeps(graph, filterOrgans);
    targetGraph = {};
    for (const organ of needed) {
      targetGraph[organ] = (graph[organ] || []).filter(d => needed.has(d));
    }
  }

  // Topological sort
  const order = topologicalSort(targetGraph);

  log('start_all_begin', { tier, organs: order, count: order.length });

  const baseDir = resolve(__dirname, '..', '..');
  const spineUrl = `http://127.0.0.1:${PORT_REGISTRY.Spine[tier]}`;
  const children = [];
  let started = 0;
  let failed = 0;

  for (const organ of order) {
    const ports = PORT_REGISTRY[organ];
    if (!ports) {
      log('start_all_skip', { organ, reason: 'no port allocation' });
      continue;
    }

    const port = ports[tier];
    const organDir = resolveOrganDir(organ, baseDir);

    log('start_all_starting', { organ, port, dir: organDir });

    const envVars = {
      ...process.env,
      [`${organ.toUpperCase()}_PORT`]: String(port),
      SPINE_URL: spineUrl,
    };

    // Spine uses SPINE_PORT, not SPINE_PORT from env
    if (organ === 'Spine') {
      envVars.SPINE_PORT = String(port);
    }

    const child = spawn('node', ['server/index.js'], {
      cwd: organDir,
      env: envVars,
      stdio: 'inherit',
    });

    children.push({ organ, child, port });

    // Wait for health (per-organ timeout override or global default)
    const organTimeout = TIMEOUT_OVERRIDES[organ] || timeoutMs;
    const healthy = await waitForHealth(`http://127.0.0.1:${port}/health`, organTimeout);
    if (healthy) {
      log('start_all_organ_ready', { organ, port });
      started++;
    } else {
      log('start_all_organ_timeout', { organ, port });
      failed++;
    }
  }

  log('start_all_complete', { started, failed, total: order.length });

  if (failed > 0) {
    console.error(`\nWARNING: ${failed} organ(s) failed to start.`);
  }

  // Keep process alive — forward SIGINT/SIGTERM to children
  const cleanup = () => {
    for (const { child } of children) {
      child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 5000);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
}

// Only run main when executed directly (not imported for tests)
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
