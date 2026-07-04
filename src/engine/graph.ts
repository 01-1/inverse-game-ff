import type { DistrictDef, EdgeDef, NodeDef } from './types';

/** Adjacency-indexed view of the district road graph with routing helpers. */
export class RoadGraph {
  readonly nodes: Map<string, NodeDef>;
  readonly edges: Map<string, EdgeDef>;
  /** node id -> list of incident edges. */
  readonly incident: Map<string, EdgeDef[]>;

  constructor(district: DistrictDef) {
    this.nodes = new Map(district.nodes.map((n) => [n.id, n]));
    this.edges = new Map(district.edges.map((e) => [e.id, e]));
    this.incident = new Map();
    for (const n of district.nodes) this.incident.set(n.id, []);
    for (const e of district.edges) {
      this.incidentOf(e.a).push(e);
      this.incidentOf(e.b).push(e);
    }
  }

  private incidentOf(nodeId: string): EdgeDef[] {
    const list = this.incident.get(nodeId);
    if (!list) throw new Error(`Unknown node in edge: ${nodeId}`);
    return list;
  }

  node(id: string): NodeDef {
    const n = this.nodes.get(id);
    if (!n) throw new Error(`Unknown node: ${id}`);
    return n;
  }

  edge(id: string): EdgeDef {
    const e = this.edges.get(id);
    if (!e) throw new Error(`Unknown edge: ${id}`);
    return e;
  }

  edgeLength(e: EdgeDef): number {
    const a = this.node(e.a);
    const b = this.node(e.b);
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  otherEnd(e: EdgeDef, nodeId: string): string {
    return e.a === nodeId ? e.b : e.a;
  }

  /**
   * Deterministic Dijkstra over edge lengths. Returns edge ids of the
   * shortest path from `from` to `to`, skipping `closed` edges.
   * Ties are broken by node id order for determinism.
   */
  shortestPath(from: string, to: string, closed?: ReadonlySet<string>): string[] | null {
    if (from === to) return [];
    const dist = new Map<string, number>();
    const prevEdge = new Map<string, string>();
    const visited = new Set<string>();
    dist.set(from, 0);

    while (true) {
      // Extract min (linear scan; graphs are small). Tie-break on id.
      let cur: string | null = null;
      let best = Infinity;
      for (const [id, d] of dist) {
        if (visited.has(id)) continue;
        if (d < best || (d === best && cur !== null && id < cur)) {
          best = d;
          cur = id;
        }
      }
      if (cur === null) return null;
      if (cur === to) break;
      visited.add(cur);
      for (const e of this.incidentOf(cur)) {
        if (closed?.has(e.id)) continue;
        const nb = this.otherEnd(e, cur);
        if (visited.has(nb)) continue;
        const nd = best + this.edgeLength(e);
        const old = dist.get(nb);
        if (old === undefined || nd < old - 1e-9) {
          dist.set(nb, nd);
          prevEdge.set(nb, e.id);
        }
      }
    }

    const path: string[] = [];
    let at = to;
    while (at !== from) {
      const eid = prevEdge.get(at);
      if (!eid) return null;
      path.push(eid);
      at = this.otherEnd(this.edge(eid), at);
    }
    path.reverse();
    return path;
  }
}
