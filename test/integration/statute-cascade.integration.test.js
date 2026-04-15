/**
 * Integration test — statute-cascade against live rtime Graph.
 *
 * READ-ONLY. Graph has no DELETE endpoint and /query is SELECT-only, so writing
 * synthetic test-fixture concepts would leave them in the database permanently.
 * Instead this test verifies the resolver correctly navigates the live Graph's
 * current governance state — which after g7c-1 is "Constitution-only, no
 * statutes seeded." That state IS the "Vivan with no statutes" case (MP-17
 * completion criterion #12), so the integration test doubles as criterion
 * coverage.
 *
 * Semantic coverage of merge rules, constitutional lock, and full cascade is
 * in `test/statute-cascade.test.js` via mocked graphClient — exhaustive.
 *
 * NOT run by default (lives under `test/integration/` which is not matched by
 * `node --test test/*.test.js`). Invoke explicitly:
 *
 *     node --test test/integration/statute-cascade.integration.test.js
 *
 * Skips gracefully if Graph is unreachable at the default rtime URL.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { createGraphClient } from '../../lib/graph-client.js';
import { resolveCascade } from '../../lib/statute-cascade.js';
import { constitutionUrn } from '../../lib/governance-urn.js';

const GRAPH_BASE = process.env.GRAPH_BASE_URL || 'http://127.0.0.1:4020';
const SYNTHETIC_PERSONA = 'urn:llm-ops:persona:test-fixture-nonexistent-persona';

describe('statute-cascade integration (live Graph, read-only)', () => {
  let graphReachable = false;
  let graph;

  before(async () => {
    graph = createGraphClient({ baseUrl: GRAPH_BASE, organName: 'TestHarness-statute-cascade' });
    try {
      const h = await graph.healthCheck();
      graphReachable = h?.status === 'ok' || h?.status === 'degraded';
    } catch {
      graphReachable = false;
    }
  });

  it('resolves Constitution-only for a persona with no bindings (post-g7c-1 baseline)', async (t) => {
    if (!graphReachable) return t.skip(`Graph not reachable at ${GRAPH_BASE}`);

    const result = await resolveCascade({ personaUrn: SYNTHETIC_PERSONA, graphClient: graph });

    // Constitution is the only layer present in live Graph after g7c-1.
    assert.deepEqual(
      result.layersApplied,
      [{ layer: 'constitution', urn: constitutionUrn() }],
      'Expected Constitution-only chain; statutes are not seeded until Senate publishes them.',
    );

    // Scaffold Constitution has no `constraints` block (only `sections`), so
    // effective governance is the empty object and no fields are locked.
    assert.deepEqual(
      result.effectiveGovernance,
      {},
      'Scaffold Constitution contains no constraints block — effective governance should be empty.',
    );
    assert.deepEqual(result.constitutionFieldsLocked, []);
  });

  it('round-trip confirms the Constitution concept is queryable at canonical URN', async (t) => {
    if (!graphReachable) return t.skip(`Graph not reachable at ${GRAPH_BASE}`);

    const row = await graph.queryConcept(constitutionUrn());
    assert.ok(row, 'Constitution concept should exist in Graph (seeded by MP-17 relay g7c-1)');
    assert.equal(row.urn, constitutionUrn());
    assert.equal(row.data.type, 'constitution');
    assert.equal(row.data.REQUIRES_HUMAN_AUTHORSHIP, true);
  });
});
