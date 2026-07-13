import type { DistrictDef } from '../engine/types';

/** Reconstruct an edge-id route in its actual travel direction. */
export function directedRouteNodeIds(
  district: DistrictDef,
  fromBuildingId: string,
  toBuildingId: string,
  edgeIds: readonly string[],
): string[] | null {
  const from = district.buildings.find((building) => building.id === fromBuildingId);
  const to = district.buildings.find((building) => building.id === toBuildingId);
  if (!from || !to) return null;

  const edges = new Map(district.edges.map((edge) => [edge.id, edge]));
  const nodes = [from.node];
  let current = from.node;
  for (const edgeId of edgeIds) {
    const edge = edges.get(edgeId);
    if (!edge) return null;
    if (edge.a === current) current = edge.b;
    else if (edge.b === current) current = edge.a;
    else return null;
    nodes.push(current);
  }
  return current === to.node ? nodes : null;
}
