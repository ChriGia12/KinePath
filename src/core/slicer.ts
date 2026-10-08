// Planar slicer: intersects the mesh with horizontal planes and chains the segments into
// contours through shared mesh edges, so contours are exact and closed on watertight meshes.
import type { MeshData } from './mesh';
import { pointInPolygon, signedArea, type Vec2 } from './polyline';

export interface Contour {
  pts: Vec2[];
  closed: boolean;
  /** Nesting depth: 0 = outer skin, 1 = hole, 2 = island inside a hole, ... */
  depth: number;
  /** Removable support added under something that hangs (not part of the mesh). */
  support?: boolean;
  /** Walk along the mid-lines of a thin-walled network (lattice.ts): walls may appear twice. */
  lattice?: boolean;
}

export interface Layer {
  z: number;
  contours: Contour[];
}

/** Slice heights: first at zMin + firstLayer, then every layerHeight up to zMax. */
export function layerHeights(zMin: number, zMax: number, layerHeight: number, firstLayer = layerHeight): number[] {
  const out: number[] = [];
  const n = Math.floor((zMax - zMin - firstLayer) / layerHeight + 1e-9);
  for (let i = 0; i <= n; i++) out.push(zMin + firstLayer + i * layerHeight);
  // Slicing exactly at the top face yields nothing: nudge the last plane just below it.
  if (out.length && Math.abs(out[out.length - 1] - zMax) < 1e-6) out[out.length - 1] = zMax - 1e-4;
  return out;
}

export function sliceAt(mesh: MeshData, zs: number[]): Layer[] {
  const p = mesh.positions;
  const ix = mesh.indices;
  const nt = ix.length / 3;
  const nv = p.length / 3;

  const tzMin = new Float64Array(nt);
  const tzMax = new Float64Array(nt);
  for (let t = 0; t < nt; t++) {
    const za = p[ix[t * 3] * 3 + 2];
    const zb = p[ix[t * 3 + 1] * 3 + 2];
    const zc = p[ix[t * 3 + 2] * 3 + 2];
    tzMin[t] = Math.min(za, zb, zc);
    tzMax[t] = Math.max(za, zb, zc);
  }
  // Sweep planes bottom-up keeping only triangles that can cross the current plane.
  const order = Array.from({ length: nt }, (_, i) => i).sort((a, b) => tzMin[a] - tzMin[b]);
  const sortedZ = [...zs].sort((a, b) => a - b);
  const layers: Layer[] = [];
  let cursor = 0;
  let active: number[] = [];

  for (const z of sortedZ) {
    while (cursor < nt && tzMin[order[cursor]] <= z) active.push(order[cursor++]);
    active = active.filter((t) => tzMax[t] > z);
    layers.push({ z, contours: sliceLayer(p, ix, nv, active, z) });
  }
  return layers;
}

function sliceLayer(p: Float32Array, ix: Uint32Array, nv: number, tris: number[], z: number): Contour[] {
  // Each crossed mesh edge is a node; each crossed triangle links its two nodes.
  const nodePos = new Map<number, Vec2>();
  const links = new Map<number, number[]>();
  const addLink = (a: number, b: number) => {
    let la = links.get(a);
    if (!la) links.set(a, (la = []));
    la.push(b);
    let lb = links.get(b);
    if (!lb) links.set(b, (lb = []));
    lb.push(a);
  };

  const crossing = (u: number, v: number): number | null => {
    const zu = p[u * 3 + 2];
    const zv = p[v * 3 + 2];
    // Vertices exactly on the plane count as "below", so no vertex is ever ambiguous.
    if (zu > z === zv > z) return null;
    const key = u < v ? u * nv + v : v * nv + u;
    if (!nodePos.has(key)) {
      const t = (z - zu) / (zv - zu);
      nodePos.set(key, [p[u * 3] + t * (p[v * 3] - p[u * 3]), p[u * 3 + 1] + t * (p[v * 3 + 1] - p[u * 3 + 1])]);
    }
    return key;
  };

  for (const t of tris) {
    const a = ix[t * 3];
    const b = ix[t * 3 + 1];
    const c = ix[t * 3 + 2];
    const hits: number[] = [];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const k = crossing(u, v);
      if (k !== null) hits.push(k);
    }
    if (hits.length === 2 && hits[0] !== hits[1]) addLink(hits[0], hits[1]);
  }

  const visited = new Set<string>();
  const edgeId = (a: number, b: number) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const chains: { nodes: number[]; closed: boolean }[] = [];

  const walk = (start: number): { nodes: number[]; closed: boolean } => {
    const nodes = [start];
    let prev = -1;
    let cur = start;
    for (;;) {
      const next = (links.get(cur) ?? []).find((n) => n !== prev && !visited.has(edgeId(cur, n)));
      if (next === undefined) return { nodes, closed: false };
      visited.add(edgeId(cur, next));
      if (next === start) return { nodes, closed: true };
      nodes.push(next);
      prev = cur;
      cur = next;
    }
  };

  // Open chains first (starting from dead ends) so loops are never cut in the middle.
  for (const [n, l] of links) if (l.length === 1 && !visited.has(edgeId(n, l[0]))) chains.push(walk(n));
  for (const [n, l] of links) if (l.some((m) => !visited.has(edgeId(n, m)))) chains.push(walk(n));

  let contours: Contour[] = chains
    .filter((c) => c.nodes.length >= 2)
    .map((c) => ({ pts: c.nodes.map((k) => nodePos.get(k)!), closed: c.closed, depth: 0 }));

  contours = joinOpenChains(contours, 0.5);
  contours = contours.filter((c) => (c.closed ? c.pts.length >= 3 && Math.abs(signedArea(c.pts)) > 1e-3 : true));
  return classify(contours);
}

/** Close small gaps left by non-manifold or badly welded meshes. */
function joinOpenChains(contours: Contour[], gap: number): Contour[] {
  const closed = contours.filter((c) => c.closed);
  const open = contours.filter((c) => !c.closed).map((c) => c.pts.slice());
  const d = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let merged = true;
  while (merged) {
    merged = false;
    for (let i = 0; i < open.length && !merged; i++) {
      for (let j = 0; j < open.length && !merged; j++) {
        if (i === j) continue;
        const a = open[i];
        const b = open[j];
        if (d(a[a.length - 1], b[0]) < gap) open[i] = [...a, ...b];
        else if (d(a[a.length - 1], b[b.length - 1]) < gap) open[i] = [...a, ...b.slice().reverse()];
        else continue;
        open.splice(j, 1);
        merged = true;
      }
    }
  }
  const result = [...closed];
  for (const pts of open) {
    const isClosed = pts.length >= 3 && d(pts[0], pts[pts.length - 1]) < gap;
    result.push({ pts: isClosed ? pts.slice(0, -1) : pts, closed: isClosed, depth: 0 });
  }
  return result;
}

/** Nesting depth and orientation: outer skins CCW, holes CW. */
export function classify(contours: Contour[]): Contour[] {
  const loops = contours.filter((c) => c.closed);
  for (const c of loops) {
    let depth = 0;
    for (const o of loops) if (o !== c && pointInPolygon(c.pts[0], o.pts)) depth++;
    c.depth = depth;
    const ccw = signedArea(c.pts) > 0;
    if ((depth % 2 === 0) !== ccw) c.pts.reverse();
  }
  return contours;
}
