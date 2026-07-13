import { describe, expect, it, vi } from 'vitest';
import type { DistrictDef } from '../src/engine/types';
import { loadWithFallback } from '../src/render/loading';
import { directedRouteNodeIds } from '../src/render/route';

const district: DistrictDef = {
  name: 'Test grid',
  nodes: [
    { id: 'n1', x: 0, y: 0 },
    { id: 'n2', x: 1, y: 0 },
    { id: 'n3', x: 2, y: 0 },
  ],
  edges: [
    { id: 'e12', a: 'n2', b: 'n1', capacity: 1, baseDemand: 0, name: 'Reverse one' },
    { id: 'e23', a: 'n3', b: 'n2', capacity: 1, baseDemand: 0, name: 'Reverse two' },
  ],
  buildings: [
    { id: 'from', kind: 'warehouse', name: 'From', node: 'n1' },
    { id: 'to', kind: 'shop', name: 'To', node: 'n3', goods: ['good'] },
  ],
  goods: [{ id: 'good', name: 'Good', basePrice: 1, dailyDemand: 1, volatility: 0 }],
};

describe('render helpers', () => {
  it('reconstructs an undirected edge route from the manifest origin without jumps', () => {
    expect(directedRouteNodeIds(district, 'from', 'to', ['e12', 'e23'])).toEqual(['n1', 'n2', 'n3']);
    expect(directedRouteNodeIds(district, 'from', 'to', ['e23', 'e12'])).toBeNull();
  });

  it('returns a deterministic fallback when an asset load rejects', async () => {
    const onFailure = vi.fn();
    const fallback = { kind: 'procedural' };
    await expect(
      loadWithFallback(
        () => Promise.reject(new Error('missing glb')),
        () => fallback,
        onFailure,
      ),
    ).resolves.toBe(fallback);
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
