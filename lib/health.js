/**
 * Health endpoint factory for DIO organs.
 *
 * Creates a standard GET /health endpoint with uniform response schema
 * across all 16 organs. Organ-specific checks are injected via callback.
 *
 * Status logic:
 *   ok       — Spine connected AND all organ-specific checks pass
 *   degraded — Spine connected but some checks report issues
 *   down     — Spine disconnected OR any critical check failed
 */

import { Router } from 'express';

/**
 * @param {function} getHealthState - async () => {
 *   organ: string,
 *   uptime_s: number,
 *   loop_iteration: number,
 *   spine_connected: boolean,
 *   checks: object
 * }
 * @returns {Router}
 */
export function createHealthRouter(getHealthState) {
  const router = Router();

  router.get('/health', async (_req, res) => {
    try {
      const state = await getHealthState();

      // Determine status from spine connection and checks
      let status = 'ok';
      if (!state.spine_connected) {
        status = 'down';
      } else if (state.checks) {
        const checkValues = Object.values(state.checks);
        const hasCriticalFailure = checkValues.some(v => v === 'down' || v === 'error');
        const hasDegradation = checkValues.some(v => v === 'degraded' || v === 'warning');
        if (hasCriticalFailure) {
          status = 'down';
        } else if (hasDegradation) {
          status = 'degraded';
        }
      }

      res.json({
        status,
        organ: state.organ,
        uptime_s: state.uptime_s,
        loop_iteration: state.loop_iteration,
        spine_connected: state.spine_connected,
        checks: state.checks || {},
      });
    } catch (err) {
      res.status(500).json({
        status: 'down',
        error: err.message,
      });
    }
  });

  return router;
}
