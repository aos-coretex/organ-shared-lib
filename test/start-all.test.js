import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { topologicalSort, getTransitiveDeps } from '../scripts/start-all.js';

describe('Topological sort', () => {
  it('produces valid boot order respecting dependencies', () => {
    const graph = {
      Spine: [],
      Vectr: ['Spine'],
      Graph: ['Spine'],
      Radiant: ['Spine'],
      Lobe: ['Spine', 'Radiant', 'Graph'],
      Axon: ['Spine', 'Radiant', 'Graph'],
    };

    const order = topologicalSort(graph);

    // Spine must come first (no deps)
    assert.equal(order[0], 'Spine');

    // Radiant and Graph must come before Lobe and Axon
    const radiantIdx = order.indexOf('Radiant');
    const graphIdx = order.indexOf('Graph');
    const lobeIdx = order.indexOf('Lobe');
    const axonIdx = order.indexOf('Axon');

    assert.ok(radiantIdx < lobeIdx, 'Radiant must boot before Lobe');
    assert.ok(graphIdx < lobeIdx, 'Graph must boot before Lobe');
    assert.ok(radiantIdx < axonIdx, 'Radiant must boot before Axon');
    assert.ok(graphIdx < axonIdx, 'Graph must boot before Axon');
  });

  it('detects circular dependencies', () => {
    const graph = {
      A: ['B'],
      B: ['C'],
      C: ['A'],
    };

    assert.throws(
      () => topologicalSort(graph),
      (err) => {
        assert.match(err.message, /Circular dependency/);
        return true;
      },
    );
  });

  it('handles the full boot-graph.json', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const graphPath = resolve(__dirname, '..', 'boot-graph.json');
    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));

    const order = topologicalSort(graph);

    // All 16 organs present
    assert.equal(order.length, 16);

    // Spine first
    assert.equal(order[0], 'Spine');

    // Every organ's deps come before it
    for (const organ of order) {
      const deps = graph[organ];
      const organIdx = order.indexOf(organ);
      for (const dep of deps) {
        const depIdx = order.indexOf(dep);
        assert.ok(depIdx < organIdx, `${dep} (idx ${depIdx}) must come before ${organ} (idx ${organIdx})`);
      }
    }
  });
});

describe('Transitive dependency inclusion', () => {
  it('includes transitive dependencies', () => {
    const graph = {
      Spine: [],
      Graph: ['Spine'],
      Vigil: ['Spine', 'Graph'],
      Glia: ['Spine', 'Vigil'],
    };

    const needed = getTransitiveDeps(graph, ['Glia']);

    assert.ok(needed.has('Glia'));
    assert.ok(needed.has('Vigil'));
    assert.ok(needed.has('Graph'));
    assert.ok(needed.has('Spine'));
    assert.equal(needed.size, 4);
  });
});
