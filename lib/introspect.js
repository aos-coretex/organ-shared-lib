/**
 * Introspection endpoint factory for DIO organs.
 *
 * Creates a standard GET /introspect endpoint with uniform response schema
 * across all 16 organs. Organ-specific extras are injected via callback.
 */

import { Router } from 'express';

/**
 * @param {function} getIntrospectState - async () => {
 *   organ: string,
 *   mailbox_depth: number,
 *   last_message_ts: string|null,
 *   loop_iteration: number,
 *   spine_connected: boolean,
 *   connected_since: string|null,
 *   extra: object
 * }
 * @returns {Router}
 */
export function createIntrospectRouter(getIntrospectState) {
  const router = Router();

  router.get('/introspect', async (_req, res) => {
    try {
      const state = await getIntrospectState();

      res.json({
        organ: state.organ,
        mailbox_depth: state.mailbox_depth ?? 0,
        last_message_ts: state.last_message_ts ?? null,
        loop_iteration: state.loop_iteration ?? 0,
        spine_connected: state.spine_connected ?? false,
        connected_since: state.connected_since ?? null,
        extra: state.extra || {},
      });
    } catch (err) {
      res.status(500).json({
        error: 'INTROSPECT_UNAVAILABLE',
        message: err.message,
      });
    }
  });

  return router;
}
