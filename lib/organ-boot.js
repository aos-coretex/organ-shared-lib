/**
 * Organ boot factory — the single entry point for all DIO organs (except Spine).
 *
 * createOrgan(config) executes a 13-step boot sequence:
 *  1.  Log organ_booting
 *  2.  Check dependencies via Spine
 *  3.  Create Express app with JSON parsing and structured logging
 *  4.  Mount organ-specific routes
 *  5.  Mount /health endpoint
 *  6.  Mount /introspect endpoint
 *  7.  Start HTTP server
 *  8.  Create Spine client and register mailbox
 *  9.  Connect WebSocket (with live loop dispatch)
 *  10. Send subscription filters
 *  11. Start live loop (drain-process-ack)
 *  12. Call onStartup callback
 *  13. Log organ_started
 *
 * Returns: { app, server, spine, loop, shutdown }
 */

import express from 'express';
import { createSpineClient } from './spine-client.js';
import { createHealthRouter } from './health.js';
import { createIntrospectRouter } from './introspect.js';
import { createLiveLoop } from './live-loop.js';
import { checkDependencies } from './dependency-check.js';

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

function loggingMiddleware(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const entry = {
      timestamp: new Date().toISOString(),
      method: req.method,
      path: req.originalUrl || req.path,
      status: res.statusCode,
      duration_ms: Date.now() - start,
    };
    process.stdout.write(JSON.stringify(entry) + '\n');
  });
  next();
}

/**
 * @param {object} config
 * @param {string} config.name           - Organ name (e.g. "Radiant")
 * @param {number} config.port           - HTTP port (e.g. 4006)
 * @param {string} config.binding        - Bind address (default "127.0.0.1")
 * @param {string} config.spineUrl       - Spine server URL (default "http://127.0.0.1:4000")
 * @param {function} config.routes       - (app) => void — mount organ-specific Express routes
 * @param {function} config.onMessage    - async (envelope) => object|null ��� directed message handler
 * @param {function} config.onBroadcast  - async (envelope) => void — broadcast handler (optional)
 * @param {object[]} config.subscriptions - WebSocket subscription filters (optional)
 * @param {string[]} config.dependencies - Organ names that must be alive before boot
 * @param {function} config.onStartup   - async ({ spine, app }) => void — post-boot init (optional)
 * @param {function} config.onShutdown   - async () => void — pre-shutdown cleanup (optional)
 * @param {function} config.healthCheck  - async () => object — organ-specific /health checks (optional)
 * @param {function} config.introspectCheck - async () => object — organ-specific /introspect extras (optional)
 * @param {number} config.drainInterval  - Live loop drain interval in ms (default 1000)
 * @returns {Promise<{ app, server, spine, loop, shutdown }>}
 */
export async function createOrgan(config) {
  const {
    name,
    port,
    binding = '127.0.0.1',
    spineUrl = 'http://127.0.0.1:4000',
    routes,
    onMessage = async () => null,
    onBroadcast,
    subscriptions = [],
    dependencies = [],
    onStartup,
    onShutdown,
    healthCheck = async () => ({}),
    introspectCheck = async () => ({}),
    drainInterval = 1000,
  } = config;

  const startTime = Date.now();
  let connectedSince = null;

  // Step 1: Log booting
  log('organ_booting', { organ: name, port });

  // Step 2: Check dependencies
  await checkDependencies(spineUrl, dependencies);

  // Step 3: Create Express app with middleware
  const app = express();
  app.use(express.json());
  app.use(loggingMiddleware);

  // Step 8: Create Spine client (created early so health/introspect can reference it)
  const spine = createSpineClient({ serverUrl: spineUrl, organName: name });

  // Variable to hold loop reference (set after loop starts)
  let loop = null;

  // Step 5: Mount /health (BEFORE organ routes — infrastructure, not overridable)
  const healthRouter = createHealthRouter(async () => {
    const checks = await healthCheck();
    const stats = loop ? loop.getStats() : { loop_iteration: 0, last_message_ts: null };
    return {
      organ: name,
      uptime_s: Math.floor((Date.now() - startTime) / 1000),
      loop_iteration: stats.loop_iteration,
      spine_connected: spine.isConnected(),
      checks,
    };
  });
  app.use(healthRouter);

  // Step 6: Mount /introspect (BEFORE organ routes — infrastructure, not overridable)
  const introspectRouter = createIntrospectRouter(async () => {
    const extra = await introspectCheck();
    const stats = loop ? loop.getStats() : { loop_iteration: 0, last_message_ts: null };
    return {
      organ: name,
      mailbox_depth: 0, // TODO: track from drain results
      last_message_ts: stats.last_message_ts,
      loop_iteration: stats.loop_iteration,
      spine_connected: spine.isConnected(),
      connected_since: connectedSince,
      extra,
    };
  });
  app.use(introspectRouter);

  // Step 4: Mount organ-specific routes (after health/introspect)
  if (routes) {
    routes(app);
  }

  // Step 7: Start HTTP server
  const server = await new Promise((resolve, reject) => {
    const srv = app.listen(port, binding, () => {
      log('organ_http_listening', { organ: name, port, binding });
      resolve(srv);
    });
    srv.on('error', reject);
  });

  // Step 8 (continued): Register mailbox
  await spine.register();

  // Step 10: Send subscription filters
  for (const filter of subscriptions) {
    spine.subscribe(filter);
  }

  // Step 9 + 11: Start live loop (connects WebSocket internally)
  connectedSince = new Date().toISOString();
  loop = createLiveLoop({
    spine,
    onMessage,
    onBroadcast,
    drainInterval,
    drainLimit: 10,
  });

  // Step 12: Post-boot initialization
  if (onStartup) {
    await onStartup({ spine, app });
  }

  // Step 13: Log started
  log('organ_started', { organ: name, port, spine_connected: true });

  // --- Shutdown ---

  let shutdownCalled = false;

  async function shutdown() {
    if (shutdownCalled) return;
    shutdownCalled = true;

    log('organ_shutting_down', { organ: name });

    // Stop live loop
    if (loop) loop.stop();

    // Organ-specific cleanup
    if (onShutdown) {
      try {
        await onShutdown();
      } catch (err) {
        log('organ_shutdown_error', { organ: name, error: err.message });
      }
    }

    // Close Spine connection
    spine.close();

    // Close HTTP server
    await new Promise((resolve) => {
      server.close(resolve);
    });

    log('organ_stopped', { organ: name });
  }

  // Wire SIGTERM and SIGINT
  const onSignal = () => shutdown().then(() => process.exit(0));
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  return { app, server, spine, loop, shutdown };
}
