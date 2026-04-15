/**
 * Live loop engine for DIO organs.
 *
 * Implements the drain-process-ack cycle that every organ runs:
 * 1. Register WebSocket handlers for real-time push (directed + broadcast)
 * 2. Start periodic drain timer to poll Spine mailbox
 * 3. For each drained message: call onMessage, collect ack IDs
 * 4. Ack successfully processed messages
 *
 * Error isolation: if onMessage throws for one message, that message is NOT
 * acked (Spine will redeliver on next drain). Remaining messages continue processing.
 *
 * On Spine disconnect: drain skips silently. Messages persist in Spine's store.
 */

function log(event, data = {}) {
  const entry = { timestamp: new Date().toISOString(), event, ...data };
  process.stdout.write(JSON.stringify(entry) + '\n');
}

/**
 * @param {object} config
 * @param {object} config.spine         - Spine client instance
 * @param {function} config.onMessage   - async (envelope) => object|null — directed message handler.
 *                                        Returns an OTM PAYLOAD object (must include `event_type`),
 *                                        not a full envelope. When envelope.reply_to is set, live-loop
 *                                        wraps the returned payload as `payload` of an OTM addressed
 *                                        to reply_to. Returning a full envelope triggers
 *                                        envelope-as-payload double-wrapping and fails Spine schema
 *                                        validation. Return null to suppress the auto-reply.
 * @param {function} config.onBroadcast - async (envelope) => void — broadcast handler (optional)
 * @param {function} config.toolCallHandler - async (envelope) => object — tool_call_request handler.
 *                                        MP-TOOL-1 (binding decision D1): intercepted BEFORE
 *                                        onMessage, mirroring the ping/pong pattern. Returns a
 *                                        tool_call_response PAYLOAD (live-loop does the envelope
 *                                        wrapping). Organ-boot supplies a NOT_IMPLEMENTED fallback
 *                                        by default; per-organ implementations override via
 *                                        createOrgan(config.toolCallHandler).
 * @param {number} config.drainInterval - Drain poll interval in ms (default 1000)
 * @param {number} config.drainLimit    - Max messages per drain (default 10)
 * @returns {{ getStats: function, stop: function }}
 */
export function createLiveLoop(config) {
  const {
    spine,
    onMessage,
    onBroadcast,
    toolCallHandler,
    drainInterval = 1000,
    drainLimit = 10,
  } = config;

  let loopIteration = 0;
  let lastMessageTs = null;
  let drainTimer = null;
  let stopped = false;

  // repair-mcp-tool-surface-01 Defect 1: pick the caller's correlation_id if
  // provided (envelope-top per Spine schema, or payload-nested for legacy
  // producers like MCP-Router's call-translator), else fall back to the
  // incoming envelope's Spine-assigned message_id. Backwards-compatible — when
  // no caller-supplied correlation_id exists, behaviour is unchanged.
  function correlationIdFor(envelope) {
    return envelope.correlation_id
      || envelope.payload?.correlation_id
      || envelope.message_id;
  }

  // --- OTM-level ping/pong ---
  // Auto-respond to event_type: "ping" before reaching the organ's onMessage.
  // Every organ gets ping/pong for free — no organ-specific code needed.

  function isPing(envelope) {
    return envelope.payload?.event_type === 'ping';
  }

  async function handlePing(envelope) {
    if (envelope.reply_to) {
      try {
        await spine.send({
          type: 'OTM',
          source_organ: envelope.target_organ,
          target_organ: envelope.reply_to,
          correlation_id: correlationIdFor(envelope),
          payload: { event_type: 'pong', data: envelope.payload.data || {} },
        });
      } catch (err) {
        log('live_loop_ping_reply_error', {
          message_id: envelope.message_id,
          error: err.message,
        });
      }
    }
  }

  // --- OTM-level tool_call_request interception (MP-TOOL-1 D1) ---
  // Intercept before user's onMessage. Mirrors ping/pong pattern. toolCallHandler
  // is always defined when organ-boot.js creates the loop (factory supplies a
  // NOT_IMPLEMENTED fallback by default). If toolCallHandler is absent (e.g.
  // live-loop instantiated directly in tests), tool_call_request falls through
  // to onMessage unchanged — preserving backwards compatibility for callers
  // that don't use the factory.

  function isToolCallRequest(envelope) {
    return envelope.payload?.event_type === 'tool_call_request';
  }

  async function handleToolCallRequest(envelope) {
    if (!toolCallHandler) return false; // not handled — caller falls through
    try {
      const responsePayload = await toolCallHandler(envelope);
      if (responsePayload && envelope.reply_to) {
        await spine.send({
          type: 'OTM',
          source_organ: envelope.target_organ,
          target_organ: envelope.reply_to,
          correlation_id: correlationIdFor(envelope),
          payload: responsePayload,
        });
      }
    } catch (err) {
      log('live_loop_tool_call_error', {
        message_id: envelope.message_id,
        error: err.message,
      });
    }
    return true; // handled (even on error — do not fall through)
  }

  // --- WebSocket push handling ---
  // The spine client dispatches directed → onMessage, broadcast → onBroadcast.
  // We handle them here for real-time processing (separate from the drain cycle).

  async function handleWsMessage(envelope) {
    lastMessageTs = new Date().toISOString();

    // Ping intercept — respond before user handler
    if (isPing(envelope)) {
      await handlePing(envelope);
      return;
    }

    // tool_call_request intercept — respond before user handler (MP-TOOL-1 D1)
    if (isToolCallRequest(envelope)) {
      const handled = await handleToolCallRequest(envelope);
      if (handled) return;
    }

    try {
      const result = await onMessage(envelope);

      // If handler returned a response AND envelope has reply_to, send reply OTM
      if (result && envelope.reply_to) {
        await spine.send({
          type: 'OTM',
          source_organ: envelope.target_organ,
          target_organ: envelope.reply_to,
          correlation_id: correlationIdFor(envelope),
          payload: result,
        });
      }
    } catch (err) {
      log('live_loop_ws_message_error', {
        message_id: envelope.message_id,
        error: err.message,
      });
    }
  }

  async function handleWsBroadcast(envelope) {
    lastMessageTs = new Date().toISOString();
    if (onBroadcast) {
      try {
        await onBroadcast(envelope);
      } catch (err) {
        log('live_loop_ws_broadcast_error', {
          message_id: envelope.message_id,
          error: err.message,
        });
      }
    }
  }

  // --- Drain cycle ---

  async function drainCycle() {
    if (stopped) return;
    if (!spine.isConnected()) return; // skip silently when disconnected

    loopIteration++;
    const ackedIds = [];

    try {
      const result = await spine.drain(drainLimit);
      const messages = result.messages || [];

      for (const envelope of messages) {
        lastMessageTs = new Date().toISOString();

        // Ping intercept — respond before user handler
        if (isPing(envelope)) {
          await handlePing(envelope);
          ackedIds.push(envelope.message_id);
          continue;
        }

        // tool_call_request intercept (MP-TOOL-1 D1) — handle + ack + continue
        if (isToolCallRequest(envelope)) {
          const handled = await handleToolCallRequest(envelope);
          if (handled) {
            ackedIds.push(envelope.message_id);
            continue;
          }
        }

        try {
          const response = await onMessage(envelope);

          // If handler returned a response AND envelope has reply_to, send reply OTM
          if (response && envelope.reply_to) {
            await spine.send({
              type: 'OTM',
              source_organ: envelope.target_organ,
              target_organ: envelope.reply_to,
              correlation_id: correlationIdFor(envelope),
              payload: response,
            });
          }

          ackedIds.push(envelope.message_id);
        } catch (err) {
          // Do NOT ack — message will be redelivered next drain
          log('live_loop_drain_message_error', {
            message_id: envelope.message_id,
            error: err.message,
            loop_iteration: loopIteration,
          });
        }
      }

      if (ackedIds.length > 0) {
        await spine.ack(ackedIds);
      }
    } catch (err) {
      // Drain itself failed (Spine unreachable, etc.) — skip silently
      log('live_loop_drain_error', {
        error: err.message,
        loop_iteration: loopIteration,
      });
    }
  }

  // --- Control ---

  function start() {
    // Connect WebSocket with our handlers
    spine.connect({
      onMessage: handleWsMessage,
      onBroadcast: handleWsBroadcast,
    });

    // Start periodic drain
    drainTimer = setInterval(drainCycle, drainInterval);

    log('live_loop_started', { drain_interval_ms: drainInterval, drain_limit: drainLimit });
  }

  function stop() {
    stopped = true;
    if (drainTimer) {
      clearInterval(drainTimer);
      drainTimer = null;
    }
    log('live_loop_stopped', { loop_iteration: loopIteration });
  }

  function getStats() {
    return {
      loop_iteration: loopIteration,
      last_message_ts: lastMessageTs,
    };
  }

  // Auto-start
  start();

  return { getStats, stop };
}
