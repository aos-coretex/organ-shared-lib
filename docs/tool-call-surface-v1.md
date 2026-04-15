# Tool-Call Surface — v1.0 Wire Contract

> **Authoritative spec** for the `tool_call_request` / `tool_call_response` OTM pair
> dispatched through Spine for MCP tool calls.
>
> Origin: MP-TOOL-1 relay t8r-1 (foundation). This relay owns `tool_call_response`.
> The request side is documented authoritatively in the **repair-mcp-router-05**
> completion report (correlation-id semantics and PascalCase dispatch invariant).

## Scope

This contract covers the **payload** of the two OTMs. Spine envelope shape (headers,
source/target organ, message_id, correlation_id, reply_to) is governed by Spine
itself and is unchanged by MP-TOOL-1.

- **`tool_call_request`** — emitted by MCP-Router; target is the organ that owns the tool.
- **`tool_call_response`** — emitted by the target organ (or by the organ-shared-lib
  universal fallback); target is `reply_to` from the request envelope.

Both OTMs are directed (never broadcast). Response correlation is by `correlation_id
= request.message_id`.

## Request payload — `tool_call_request`

Request shape (summary — see repair-mcp-router-05 for the full contract):

```json
{
  "event_type": "tool_call_request",
  "tool": "<organ>__<action>",
  "params": { ... }
}
```

The `tool` string is the canonical Claude-Code-visible tool name after the
`mcp__mcp-router__` prefix is stripped (e.g. `graph__get_stats`). MCP-Router
resolves the tool via `config/tool-declarations.json`, composes the OTM, and
sets `reply_to` to its own organ name.

## Response payload — `tool_call_response` (v1.0) — this relay OWNS

All responses share these four required fields:

| Field | Type | Notes |
|---|---|---|
| `event_type` | `"tool_call_response"` (const) | Always this exact string |
| `schema_version` | `"1.0"` (const) | Revision bumps require a new MP |
| `status` | enum (see below) | Closed enum — 6 values |
| `tool` | string | Echo of the request's `tool` name |

Additional fields are conditional on `status`:

| Status | Required extra fields | Semantics |
|---|---|---|
| `SUCCESS` | `data` (any) | Tool executed; data carries the result |
| `NOT_IMPLEMENTED` | `reason` (string) | Universal fallback; organ does not handle `tool_call_request` |
| `TOOL_NOT_FOUND` | `reason` (string) | Organ handles `tool_call_request` but the tool name is unknown |
| `TOOL_ERROR` | `error.code`, `error.message` | Tool executed but threw |
| `TOOL_TIMEOUT` | `elapsed_ms`, `limit_ms` | Per-tool timeout exceeded |
| `ORGAN_DEGRADED` | `checks_status` | Organ's `/health` reports non-ok; fail-closed |

Optional `meta` field (plain object) is permitted on any status for diagnostic
attribution (timings, source, cache hit/miss, etc.).

No nested OTM envelope may appear inside `tool_call_response` (see D7 below).

### Status enum (closed)

```js
export const TOOL_STATUS = Object.freeze({
  SUCCESS: 'SUCCESS',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
  TOOL_NOT_FOUND: 'TOOL_NOT_FOUND',
  TOOL_ERROR: 'TOOL_ERROR',
  TOOL_TIMEOUT: 'TOOL_TIMEOUT',
  ORGAN_DEGRADED: 'ORGAN_DEGRADED',
});
```

**The enum is closed.** Adding a seventh status requires an RFI.

## D7 scope — synthesis, not transitivity (RFI-2)

D7 — "tool methods MUST use HTTP for any cross-organ data need; NO Spine OTM
emissions inside tool methods" — governs what the tool method **synthesizes**,
not what its callees do. A tool method may delegate to organ internals whose
established contracts include Spine emissions (e.g., `indexDocument`'s
canonical lifecycle broadcast) — those stay. A tool method MUST NOT construct
and emit a Spine OTM itself.

Dead Spine emissions in callee code paths (fire-and-forget with no consumer)
MUST be removed per RFI-2 — they are D7 violations with no functional benefit
and accumulate cognitive load.

**R7 conformance scan audit pattern:** grep `spine.send` across every
tool-callable function's call tree. Broadcasts that are part of a canonical
lifecycle contract are OK. Directed OTMs are candidates for review.

## Correlation pattern (direct-reply via Spine)

Responses are **directed Spine OTMs**, not HTTP callbacks. The live-loop in
`organ-shared-lib/lib/live-loop.js` wraps the handler's returned payload into
a directed OTM:

```js
await spine.send({
  type: 'OTM',
  source_organ: envelope.target_organ,    // the answering organ
  target_organ: envelope.reply_to,        // the requester (MCP-Router)
  correlation_id: envelope.message_id,    // match request message_id
  payload: <tool_call_response payload>,
});
```

This mirrors the existing ping/pong pattern (`live-loop.js:54-75`). Organs do
not call MCP-Router over HTTP for replies.

## D7 — tool methods MUST NOT emit Spine OTMs

A tool method invoked as part of a `tool_call_request` handler:

- **MAY** read from the local database or call internal helpers.
- **MAY** issue HTTP requests to other organs (cross-organ reads follow binding decision #3).
- **MUST NOT** synthesize or emit Spine OTMs of any kind (directed or broadcast).

Rationale: tool calls are **synchronous request/response** from the MCP-Router
agent's perspective. Emitting a Spine OTM inside the method creates untracked
async work that escapes the correlation pattern and can produce stale results,
duplicate deliveries, and unattributable side effects. If a tool requires
emitting an OTM to function, the tool is misdeclared — remove it from
`tool-declarations.json` or refactor it to an asynchronous submission pattern
outside the tool-call surface.

## Per-tool timeout policy

Resolved by RFI-1 reply (ESB Architect session-9, 2026-04-15):

- **Default (no `timeout_ms` declared):** 25,000 ms.
- **Organ-level override present, tool-level absent:** tool inherits
  `organ.timeout_ms - 2000 ms`.
- **Tool-level `timeout_ms` declared:** that value IS the absolute limit.
- **Invariant (asserted in tests):** for any tool with an explicit `timeout_ms`,
  `tool.timeout_ms ≤ organ.timeout_ms - 2000 ms` so the handler's `TOOL_TIMEOUT`
  response always wins the race against MCP-Router's envelope `MESSAGE_TIMEOUT`.

There is **no hard ceiling** on `timeout_ms`. The ESB architect's earlier 28s
ceiling was superseded once w5s-2 scaled the MCP-Router envelope per-organ. The
envelope is now the single source of truth; the per-tool limit is simply
envelope − 2000 ms buffer.

If a tool's organ has no envelope (no organ-level `timeout_ms`) AND the tool
legitimately needs > 25,000 ms, an RFI-2 is required — do not silently bump.

## Factory wiring (D1)

`createOrgan(config)` in `organ-shared-lib/lib/organ-boot.js` accepts:

```js
config.toolCallHandler  // async (envelope) => tool_call_response payload
```

- When supplied, it is the per-organ handler and fully replaces the fallback.
- When absent, the factory installs `createToolFallbackHandler(config.name)`
  which returns a well-formed `NOT_IMPLEMENTED` payload so every organ responds
  well-formed regardless of per-organ wiring status.

Override semantics are **pure shadow** — the custom handler fully replaces the
default (no chaining, no middleware stack). This matches the existing
`onMessage` dispatch model (single callback, no map) and mirrors the ping/pong
interception shape.

### Interception point

Live-loop intercepts `envelope.payload.event_type === 'tool_call_request'`
BEFORE dispatching to `config.onMessage`. This means the organ's main
`onMessage` handler never sees `tool_call_request` — it is the factory's
responsibility to compose the response and send the reply.

## Envelope-vs-payload contract

Helper constructors in `@coretex/organ-boot/tool-errors` (`success`, `notImplemented`,
`toolNotFound`, `toolError`, `toolTimeout`, `organDegraded`) return **payload**
objects. Callers (per-organ handlers, fallback handler) return the payload from
the handler; **the live-loop wraps it into the OTM envelope**. Returning a full
envelope from a handler triggers double-wrapping and fails Spine schema
validation — this is a documented systemic relay bug (see `live-loop.js:22-30`
`onMessage` JSDoc).

## Producers (RFI-3 + RFI-4)

**MCP-Router `call-translator`:** dual-emits request payload fields for
backwards-compat. Canonical new-world fields are `tool` (full `<organ>__<action>`)
and `params`. Legacy `action` (= spine_event_type) and `parameters` are retained
for pre-MP-TOOL-1 consumer compat; scheduled for cleanup in a future
`repair-mcp-router-NN` once grep confirms zero readers in production telemetry.

**Correlation ID location (RFI-4):** canonical location is **envelope top**,
matching the ping/pong precedent in `live-loop.js`. MCP-Router's existing
`call-translator` sends OTMs with `correlation_id` inside the payload — legacy
producer contract. Consumer (`handleResponse`) does defensive OR-read:
`envelope.payload?.correlation_id || envelope.correlation_id`. A follow-on
`repair-mcp-router-NN` will canonicalize once all producers migrate to
envelope top.

**MCP-Router caller-facing surface:** after the organ replies with a
tool_call_response payload, MCP-Router's `handleResponse` unwraps to a
structured shape: `{status, data, error, tool, elapsed_ms, meta}`. Callers of
`POST /call` receive this under `result`. Skipped internal fields:
`event_type` (always `tool_call_response`) and `schema_version` (always
`'1.0'` at v1).

## Related artifacts

- `organ-shared-lib/lib/tool-errors.js` — enum + helper constructors
- `organ-shared-lib/lib/tool-response-schema.js` — payload validator
- `organ-shared-lib/lib/tool-fallback-handler.js` — universal fallback
- `organ-shared-lib/lib/organ-boot.js` — factory wiring
- `organ-shared-lib/lib/live-loop.js` — interception + OTM wrapping
- `mcp-router/config/tool-declarations.json` — schema with `method` + `timeout_ms`
- `repair-mcp-router-05` completion report — authoritative for `tool_call_request` side
- RFI-1 reply (t8r-1, 2026-04-15) — timeout policy rationale + declaration audit

## Binding decisions cited

- **D1** (factory-level default with per-organ override) — meta MP-TOOL-1 §3.
- **D2** (directed `tool_call_response` keyed by `correlation_id`) — binding decision #7.
- **D3** (closed error enum) — binding decision #12 (event-type strings as protocol identifiers).
- **D4** (`method` field on every declaration) — binding decision #1 (no backwards compat).
- **D5** (zero tool exemptions) — this relay's audit removed 7 blocked tools;
  capability buildout tracked by follow-on C2A `c2a-mcp-tools-02`.
- **D7** (tool methods MUST NOT emit Spine OTMs) — binding decisions #7 + #3.
- **Timeout policy** — RFI-1 reply supersedes the earlier 28s ceiling.
