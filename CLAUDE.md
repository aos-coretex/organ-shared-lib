# Organ Shared Boot Library

## What this is

Shared boot library for all DIO organs (except Spine, which is the bus itself). Every organ imports this library and calls `createOrgan()` with its specific config — eliminating duplicated boot code across 15 organs.

## Architecture

- **Runtime:** Node.js, Express 5, ES modules (`import`, not `require`)
- **Test runner:** Node.js built-in (`node --test`)
- **Wire protocol:** Compatible with Spine ESB WebSocket protocol (register/subscribe/ack actions)
- **Logging:** Structured JSON to stdout (same pattern as Spine)

## Modules

| Module | Export | Purpose |
|---|---|---|
| `lib/organ-boot.js` | `createOrgan(config)` | Main factory — boots an organ with full lifecycle |
| `lib/spine-client.js` | `createSpineClient(opts)` | Enhanced Spine client (HTTP + WS + auto-reconnect + heartbeat) |
| `lib/health.js` | `createHealthRouter(fn)` | Standard `/health` endpoint factory |
| `lib/introspect.js` | `createIntrospectRouter(fn)` | Standard `/introspect` endpoint factory |
| `lib/live-loop.js` | `createLiveLoop(config)` | Drain-process-ack engine |
| `lib/dependency-check.js` | `checkDependencies(url, deps, opts)` | Verify organ dependencies via Spine |
| `lib/urn.js` | `generateUrn(namespace)` | URN generation (`urn:llm-ops:<ns>:<ts>-<rand>`) |
| `lib/llm-client.js` | `createLLMClient(config)` | Per-agent LLM client (Anthropic + OpenAI-compatible, usage tracking, graceful degradation) |

## LLM Client Consumers

The `llm-client.js` module serves **7 probabilistic organs with 17+ LLM agents**:

| Organ | Agents | MP |
|---|---|---|
| Radiant | Phase 2 dream consolidation (1) | MP-4 l4e-2 |
| Minder | Deriver, deduction, induction, dialectic, card generator (5) | MP-4 l4e-2 |
| Lobe | Constitutional classifier, cross-pollinator, session synthesizer (3) | MP-4 l4e-3 |
| Soul | Behavioral observer, consistency checker, evolution analyst, persona dream (4) | MP-7 |
| Cortex | Strategic assessment (1+) | MP-12 |
| Nomos | Nomos-Evidence, advisory opinions (2) | MP-9 |
| Arbiter | Clause matching (1) | MP-8 |

## Usage by organs

Organs reference this library via relative path in their `package.json`:
```json
{ "@coretex/organ-boot": "file:../../organ-shared-lib" }
```

## Running

```bash
npm install    # Install dependencies
npm test       # Run all unit tests
```

## Zero Cross-Contamination Rules

- Never reference `ai-kb.db` or `AI-Datastore/`
- Never reference `AOS-software-dev/` paths
- Never use ports 3800-3851 (monolith range)
- Never import from monolith packages
