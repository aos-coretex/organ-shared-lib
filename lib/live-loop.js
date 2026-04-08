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
 * @param {function} config.onMessage   - async (envelope) => object|null — directed message handler
 * @param {function} config.onBroadcast - async (envelope) => void — broadcast handler (optional)
 * @param {number} config.drainInterval - Drain poll interval in ms (default 1000)
 * @param {number} config.drainLimit    - Max messages per drain (default 10)
 * @returns {{ getStats: function, stop: function }}
 */
export function createLiveLoop(config) {
  const {
    spine,
    onMessage,
    onBroadcast,
    drainInterval = 1000,
    drainLimit = 10,
  } = config;

  let loopIteration = 0;
  let lastMessageTs = null;
  let drainTimer = null;
  let stopped = false;

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
          correlation_id: envelope.message_id,
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

    try {
      const result = await onMessage(envelope);

      // If handler returned a response AND envelope has reply_to, send reply OTM
      if (result && envelope.reply_to) {
        await spine.send({
          type: 'OTM',
          source_organ: envelope.target_organ,
          target_organ: envelope.reply_to,
          correlation_id: envelope.message_id,
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

        try {
          const response = await onMessage(envelope);

          // If handler returned a response AND envelope has reply_to, send reply OTM
          if (response && envelope.reply_to) {
            await spine.send({
              type: 'OTM',
              source_organ: envelope.target_organ,
              target_organ: envelope.reply_to,
              correlation_id: envelope.message_id,
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
