// Thin-walled networks (a honeycomb, a grid, ribs, a single thin wall): a section whose walls are
// about one bead thick everywhere is not printed as loops around every cell — each wall would be
// laid twice and the nozzle would jump from cell to cell. Its walls are reduced to their mid-lines
// (a graph: walls meeting at junctions) and the whole graph is printed as one walk per layer.
//
// A graph can be drawn in one stroke without passing twice anywhere only when at most two of its
// junctions have an odd number of walls (Euler). A honeycomb has three walls at every junction, so
// some walls must be passed twice: the shortest set of them is chosen (route inspection), and the
// second pass over a wall is flagged by the path builder (extruder off, or printed, as set).
import { signedArea, simplifyOpen, type Vec2 } from './polyline';
import { classify, type Contour } from './slicer';
import { coverContours, differenceContours, islands, offsetContours } from './walls';

export interface WallGraph {
  nodes: Vec2[];
  /** Walls: mid-line from node a to node b (pts includes both node positions). */
  edges: { a: number; b: number; pts: Vec2[] }[];
}

/** Raster cell used to find the mid-lines (mm): mid-lines are within about half of it. */
export const LATTICE_RES = 0.4;
const MAX_CELLS = 6e6;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);
const pathLength = (pts: Vec2[]) => pts.reduce((s, p, i) => (i ? s + dist(p, pts[i - 1]) : 0), 0);

function distToLoops(q: Vec2, loops: Vec2[][]): number {
  let best = Infinity;
  for (const l of loops)
    for (let i = 0; i < l.length; i++) {
      const a = l[i];
      const b = l[(i + 1) % l.length];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = dx * dx + dy * dy;
      const t = len ? Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / len)) : 0;
      best = Math.min(best, Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]));
    }
  return best;
}

/**
 * Mid-lines of a region (outer loop + holes, even-odd) as a graph. The region is drawn on a grid,
 * thinned to a one-cell skeleton (Zhang–Suen) and the skeleton is read as nodes (ends, junctions)
 * joined by walls.
 */
export function centerlineGraph(loops: Vec2[][], res = LATTICE_RES): WallGraph {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const l of loops)
    for (const [x, y] of l) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  if (!(x1 > x0) || !(y1 > y0)) return { nodes: [], edges: [] };
  let r = res;
  while (((x1 - x0) / r + 5) * ((y1 - y0) / r + 5) > MAX_CELLS) r *= 1.5;
  const pad = 2;
  const nx = Math.ceil((x1 - x0) / r) + 2 * pad + 1;
  const ny = Math.ceil((y1 - y0) / r) + 2 * pad + 1;
  const g = new Uint8Array(nx * ny);
  const px = (i: number) => x0 + (i - pad) * r;
  const py = (j: number) => y0 + (j - pad) * r;

  // Fill (even-odd over all the loops) at cell centres.
  for (let j = 0; j < ny; j++) {
    const y = py(j);
    const xs: number[] = [];
    for (const l of loops)
      for (let i = 0; i < l.length; i++) {
        const a = l[i];
        const b = l[(i + 1) % l.length];
        if (a[1] > y === b[1] > y) continue;
        xs.push(a[0] + ((y - a[1]) / (b[1] - a[1])) * (b[0] - a[0]));
      }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / r + pad));
      const i1 = Math.min(nx - 1, Math.floor((xs[k + 1] - x0) / r + pad));
      for (let i = i0; i <= i1; i++) g[j * nx + i] = 1;
    }
  }

  // Neighbours clockwise from north: N, NE, E, SE, S, SW, W, NW.
  const off = [-nx, -nx + 1, 1, nx + 1, nx, nx - 1, -1, -nx - 1];
  let live: number[] = [];
  for (let k = 0; k < g.length; k++) if (g[k]) live.push(k);
  // Zhang–Suen thinning: peel border cells in two alternating passes until one cell wide.
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      const gone: number[] = [];
      for (const k of live) {
        const n = off.map((o) => g[k + o]);
        const b = n[0] + n[1] + n[2] + n[3] + n[4] + n[5] + n[6] + n[7];
        if (b < 2 || b > 6) continue;
        let a = 0;
        for (let i = 0; i < 8; i++) if (!n[i] && n[(i + 1) % 8]) a++;
        if (a !== 1) continue;
        if (pass === 0 ? n[0] * n[2] * n[4] || n[2] * n[4] * n[6] : n[0] * n[2] * n[6] || n[0] * n[4] * n[6]) continue;
        gone.push(k);
      }
      if (gone.length) {
        changed = true;
        for (const k of gone) g[k] = 0;
        live = live.filter((k) => g[k]);
      }
    }
  }
  // Staircase corners left two cells thick: a cell with two orthogonal neighbours that touch each
  // other diagonally is not needed when nothing else hangs on it.
  for (const k of live) {
    const n = off.map((o) => g[k + o]);
    for (let q = 0; q < 8; q += 2)
      if (n[q] && n[(q + 2) % 8] && !n[(q + 4) % 8] && !n[(q + 6) % 8] && !n[(q + 5) % 8]) {
        g[k] = 0;
        break;
      }
  }
  live = live.filter((k) => g[k]);
  if (!live.length) return { nodes: [], edges: [] };

  const at = (k: number): Vec2 => [px(k % nx), py(Math.floor(k / nx))];
  const nbrs = (k: number) => off.map((o) => k + o).filter((m) => g[m]);
  // Nodes: ends (one neighbour) and junctions (three or more; touching junction cells are one node).
  const nodeOf = new Map<number, number>();
  const nodes: Vec2[] = [];
  for (const k of live) {
    if (nodeOf.has(k) || nbrs(k).length < 3) continue;
    const cells = [k];
    nodeOf.set(k, nodes.length);
    for (let h = 0; h < cells.length; h++)
      for (const m of nbrs(cells[h]))
        if (!nodeOf.has(m) && nbrs(m).length >= 3) {
          nodeOf.set(m, nodes.length);
          cells.push(m);
        }
    const c = cells.map(at);
    nodes.push([c.reduce((s, p) => s + p[0], 0) / c.length, c.reduce((s, p) => s + p[1], 0) / c.length]);
  }
  for (const k of live)
    if (!nodeOf.has(k) && nbrs(k).length <= 1) {
      nodeOf.set(k, nodes.length);
      nodes.push(at(k));
    }

  const edges: WallGraph['edges'] = [];
  const seen = new Set<number>();
  const trace = (from: number, first: number) => {
    const pts: Vec2[] = [nodes[nodeOf.get(from)!]];
    let prev = from;
    let cur = first;
    while (!nodeOf.has(cur)) {
      seen.add(cur);
      pts.push(at(cur));
      const next = nbrs(cur).find((m) => m !== prev && (nodeOf.has(m) || !seen.has(m)));
      if (next === undefined) {
        // A chain that stops without a node (should not happen): end it here.
        nodeOf.set(cur, nodes.length);
        nodes.push(at(cur));
        break;
      }
      prev = cur;
      cur = next;
    }
    const b = nodeOf.get(cur)!;
    pts.push(nodes[b]);
    edges.push({ a: nodeOf.get(from)!, b, pts });
  };
  const direct = new Set<string>();
  for (const [k, a] of [...nodeOf])
    for (const m of nbrs(k)) {
      const b = nodeOf.get(m);
      if (b === undefined) {
        if (!seen.has(m)) trace(k, m);
      } else if (b !== a) {
        // Two nodes side by side (an end right beside a junction): a wall with no cell between.
        const key = a < b ? `${a}|${b}` : `${b}|${a}`;
        if (!direct.has(key)) {
          direct.add(key);
          edges.push({ a, b, pts: [nodes[a], nodes[b]] });
        }
      }
    }
  // Rings without any junction: start anywhere.
  for (const k of live)
    if (!nodeOf.has(k) && !seen.has(k)) {
      nodeOf.set(k, nodes.length);
      nodes.push(at(k));
      const first = nbrs(k)[0];
      if (first !== undefined) trace(k, first);
    }

  for (const e of edges) e.pts = simplifyOpen(e.pts, 0.75 * r);
  return refine(prune({ nodes, edges }, loops, r), loops, r);
}

/** Segments of the loops in buckets, to cast short rays across a wall. */
function segmentGrid(loops: Vec2[][], cell: number) {
  const grid = new Map<string, [Vec2, Vec2][]>();
  for (const l of loops)
    for (let i = 0; i < l.length; i++) {
      const seg: [Vec2, Vec2] = [l[i], l[(i + 1) % l.length]];
      const [i0, i1] = [Math.floor(Math.min(seg[0][0], seg[1][0]) / cell), Math.floor(Math.max(seg[0][0], seg[1][0]) / cell)];
      const [j0, j1] = [Math.floor(Math.min(seg[0][1], seg[1][1]) / cell), Math.floor(Math.max(seg[0][1], seg[1][1]) / cell)];
      for (let a = i0; a <= i1; a++)
        for (let b = j0; b <= j1; b++) {
          const k = `${a},${b}`;
          if (!grid.has(k)) grid.set(k, []);
          grid.get(k)!.push(seg);
        }
    }
  /** Distance from p along the unit direction d to the first segment, up to `reach` (Infinity: none). */
  return (p: Vec2, d: Vec2, reach: number): number => {
    const q: Vec2 = [p[0] + d[0] * reach, p[1] + d[1] * reach];
    let best = Infinity;
    for (let a = Math.floor(Math.min(p[0], q[0]) / cell); a <= Math.floor(Math.max(p[0], q[0]) / cell); a++)
      for (let b = Math.floor(Math.min(p[1], q[1]) / cell); b <= Math.floor(Math.max(p[1], q[1]) / cell); b++)
        for (const [u, v] of grid.get(`${a},${b}`) ?? []) {
          const [ex, ey] = [v[0] - u[0], v[1] - u[1]];
          const den = d[0] * ey - d[1] * ex;
          if (Math.abs(den) < 1e-12) continue;
          const t = ((u[0] - p[0]) * ey - (u[1] - p[1]) * ex) / den;
          const w = ((u[0] - p[0]) * d[1] - (u[1] - p[1]) * d[0]) / den;
          if (t >= 0 && t <= reach && w >= 0 && w <= 1) best = Math.min(best, t);
        }
    return best;
  };
}

/**
 * The skeleton of a grid is within a cell of the true mid-line and bends a little where walls
 * meet. Each point is moved to the exact middle of its wall (same distance to both faces, measured
 * across the wall), and each junction to where the straight runs of its walls meet.
 */
function refine(g: WallGraph, loops: Vec2[][], r: number): WallGraph {
  const ray = segmentGrid(loops, 8);
  const reach = 40;
  const nodes = g.nodes.map((p): Vec2 => [...p]);
  const radius = nodes.map((p) => distToLoops(p, loops));
  const centred = (pts: Vec2[]): Vec2[] =>
    pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return p;
      const [a, b] = [pts[i - 1], pts[i + 1]];
      const len = dist(a, b);
      if (len < 1e-9) return p;
      const n: Vec2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      const [left, right] = [ray(p, n, reach), ray(p, [-n[0], -n[1]], reach)];
      const shift = (left - right) / 2;
      return Number.isFinite(shift) && Math.abs(shift) <= 3 * r ? ([p[0] + n[0] * shift, p[1] + n[1] * shift] as Vec2) : p;
    });
  /**
   * A bend in a wall: across the bend the wall measures wider, and the skeleton cuts the corner.
   * The points of the bend are replaced by the point where the straight runs before and after
   * it meet.
   */
  const corners = (pts: Vec2[]): Vec2[] => {
    if (pts.length < 12) return pts;
    const width = pts.map((p, i) => {
      if (i === 0 || i === pts.length - 1) return NaN;
      const [a, b] = [pts[i - 1], pts[i + 1]];
      const len = dist(a, b) || 1;
      const n: Vec2 = [-(b[1] - a[1]) / len, (b[0] - a[0]) / len];
      return ray(p, n, reach) + ray(p, [-n[0], -n[1]], reach);
    });
    const sorted = width.filter((w) => Number.isFinite(w)).sort((a, b) => a - b);
    if (!sorted.length) return pts;
    const usual = sorted[Math.floor(sorted.length / 2)];
    const wide = width.map((w) => !(w <= 1.08 * usual + 0.1));
    const out: Vec2[] = [];
    const run = 4; // points of straight wall wanted on each side of a bend
    for (let i = 0; i < pts.length; i++) {
      if (!wide[i] || i === 0 || i === pts.length - 1) {
        out.push(pts[i]);
        continue;
      }
      let j = i;
      while (j < pts.length - 1 && wide[j]) j++;
      // pts[i-1] is the last point before the bend, pts[j] the first after it.
      const before = i - 1 - run >= 0 && !wide.slice(i - 1 - run, i).some((w, k) => w && i - 1 - run + k > 0);
      const after = j + run <= pts.length - 1 && !wide.slice(j, j + run + 1).some((w, k) => w && j + k < pts.length - 1);
      let meet: Vec2 | null = null;
      if (before && after) {
        const [p1, p2, p3, p4] = [pts[i - 1 - run], pts[i - 1], pts[j], pts[j + run]];
        const [d1x, d1y, d2x, d2y] = [p2[0] - p1[0], p2[1] - p1[1], p4[0] - p3[0], p4[1] - p3[1]];
        const den = d1x * d2y - d1y * d2x;
        if (Math.abs(den) > 1e-6 * Math.hypot(d1x, d1y) * Math.hypot(d2x, d2y)) {
          const t = ((p3[0] - p2[0]) * d2y - (p3[1] - p2[1]) * d2x) / den;
          const q: Vec2 = [p2[0] + d1x * t, p2[1] + d1y * t];
          if (dist(q, p2) <= 2 * usual && dist(q, p3) <= 2 * usual) meet = q;
        }
      }
      if (meet) out.push(meet);
      else for (let k = i; k < j; k++) out.push(pts[k]);
      i = j - 1;
    }
    return out;
  };
  // Points every ~1 mm along each wall, centred twice.
  const edges = g.edges.map((e) => {
    const dense: Vec2[] = [e.pts[0]];
    for (let i = 1; i < e.pts.length; i++) {
      const n = Math.max(1, Math.ceil(dist(e.pts[i - 1], e.pts[i])));
      for (let k = 1; k <= n; k++) dense.push([e.pts[i - 1][0] + ((e.pts[i][0] - e.pts[i - 1][0]) * k) / n, e.pts[i - 1][1] + ((e.pts[i][1] - e.pts[i - 1][1]) * k) / n]);
    }
    return { a: e.a, b: e.b, pts: corners(centred(centred(dense))) };
  });
  // Junctions: where the straight runs of the walls, taken clear of the junction, meet.
  const clear = (v: number) => 1.5 * radius[v] + 2 * r;
  const ends = (e: (typeof edges)[number], v: number) => (e.a === v ? e.pts : [...e.pts].reverse());
  const degree = new Map<number, number>();
  for (const e of edges) for (const v of [e.a, e.b]) degree.set(v, (degree.get(v) ?? 0) + 1);
  for (let v = 0; v < nodes.length; v++) {
    if ((degree.get(v) ?? 0) < 3) continue;
    let [sxx, sxy, syy, bx, by, used] = [0, 0, 0, 0, 0, 0];
    for (const e of edges) {
      if (e.a !== v && e.b !== v) continue;
      for (const pts of e.a === e.b ? [e.pts, [...e.pts].reverse()] : [ends(e, v)]) {
        // The run between `clear` and twice that from the junction.
        let s = 0;
        let first: Vec2 | null = null;
        let last: Vec2 | null = null;
        for (let i = 1; i < pts.length; i++) {
          s += dist(pts[i - 1], pts[i]);
          if (s < clear(v)) continue;
          first ??= pts[i];
          last = pts[i];
          if (s > 2 * clear(v) + 2) break;
        }
        if (!first || !last || dist(first, last) < 1) continue;
        const l = dist(first, last);
        const [dx, dy] = [(last[0] - first[0]) / l, (last[1] - first[1]) / l];
        // Distance² to the line through `first` along d: (I − d dᵀ).
        const [mxx, mxy, myy] = [1 - dx * dx, -dx * dy, 1 - dy * dy];
        sxx += mxx;
        sxy += mxy;
        syy += myy;
        bx += mxx * first[0] + mxy * first[1];
        by += mxy * first[0] + myy * first[1];
        used++;
      }
    }
    const det = sxx * syy - sxy * sxy;
    if (used < 2 || Math.abs(det) < 1e-6) continue;
    const q: Vec2 = [(syy * bx - sxy * by) / det, (sxx * by - sxy * bx) / det];
    if (dist(q, nodes[v]) <= radius[v] + 2 * r) nodes[v] = q;
  }
  // Each wall: from its junction straight to the first point clear of it, then along the mid-line.
  for (const e of edges) {
    const trim = (pts: Vec2[], v: number) => {
      if ((degree.get(v) ?? 0) < 3) return pts;
      let s = 0;
      let i = 1;
      for (; i < pts.length - 1; i++) {
        s += dist(pts[i - 1], pts[i]);
        if (s >= clear(v)) break;
      }
      return [nodes[v], ...pts.slice(i)];
    };
    let pts = trim(e.pts, e.a);
    pts = trim([...pts].reverse(), e.b).reverse();
    pts[0] = nodes[e.a];
    pts[pts.length - 1] = nodes[e.b];
    e.pts = simplifyOpen(pts, 0.1);
  }
  return { nodes, edges };
}

/**
 * Removes the stubs the thinning leaves towards corners: a dead-end wall whose end lies inside
 * the material already covered around its junction adds nothing. Real dead-end walls stay.
 */
function prune(g: WallGraph, loops: Vec2[][], r: number): WallGraph {
  let edges = g.edges.filter((e) => !(e.a === e.b && pathLength(e.pts) < 4 * r));
  const radius = new Map<number, number>();
  const rad = (n: number) => {
    if (!radius.has(n)) radius.set(n, distToLoops(g.nodes[n], loops));
    return radius.get(n)!;
  };
  for (let again = true; again; ) {
    again = false;
    const deg = new Map<number, number>();
    for (const e of edges) for (const n of [e.a, e.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    const keep = edges.filter((e) => {
      for (const [tip, base] of [[e.a, e.b], [e.b, e.a]])
        if (deg.get(tip) === 1 && (deg.get(base) ?? 0) >= 3 && dist(g.nodes[tip], g.nodes[base]) + rad(tip) <= 1.1 * rad(base) + r) return false;
      return true;
    });
    if (keep.length !== edges.length) {
      edges = keep;
      again = true;
    }
    // A junction left with two walls is no junction: its two walls are one.
    const at = new Map<number, number[]>();
    edges.forEach((e, i) => {
      for (const n of e.a === e.b ? [e.a] : [e.a, e.b]) at.set(n, [...(at.get(n) ?? []), i]);
    });
    for (const [n, list] of at) {
      if (list.length !== 2) continue;
      const [e1, e2] = [edges[list[0]], edges[list[1]]];
      if (e1.a === e1.b || e2.a === e2.b) continue;
      const p1 = e1.b === n ? e1.pts : [...e1.pts].reverse();
      const p2 = e2.a === n ? e2.pts : [...e2.pts].reverse();
      const merged = { a: e1.b === n ? e1.a : e1.b, b: e2.a === n ? e2.b : e2.a, pts: simplifyOpen([...p1, ...p2.slice(1)], 0.75 * r) };
      edges = edges.filter((e) => e !== e1 && e !== e2);
      edges.push(merged);
      again = true;
      break;
    }
  }
  return { nodes: g.nodes, edges };
}

/**
 * One walk per connected piece of the graph that passes along every wall, repeating as little
 * length as possible. The walk is open (from one odd junction to another) when the graph has odd
 * junctions, closed otherwise. Returned as polylines; repeated walls appear twice in them.
 */
export function routeGraph(g: WallGraph): Vec2[][] {
  const n = g.nodes.length;
  const adj: number[][] = Array.from({ length: n }, () => []);
  g.edges.forEach((e, i) => {
    adj[e.a].push(i);
    if (e.b !== e.a) adj[e.b].push(i);
  });
  const len = g.edges.map((e) => pathLength(e.pts));
  const other = (i: number, v: number) => (g.edges[i].a === v ? g.edges[i].b : g.edges[i].a);
  const comp = new Int32Array(n).fill(-1);
  const walks: Vec2[][] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || !adj[s].length) continue;
    const members = [s];
    comp[s] = s;
    for (let h = 0; h < members.length; h++)
      for (const i of adj[members[h]]) {
        const m = other(i, members[h]);
        if (comp[m] < 0) {
          comp[m] = s;
          members.push(m);
        }
      }
    const degree = (v: number) => adj[v].reduce((d, i) => d + (g.edges[i].a === g.edges[i].b ? 2 : 1), 0);
    const odd = members.filter((v) => degree(v) % 2 === 1);

    // Shortest paths between the odd junctions (Dijkstra; the graphs are small).
    const from = new Map<number, { d: Float64Array; via: Int32Array }>();
    for (const o of odd) {
      const d = new Float64Array(n).fill(Infinity);
      const via = new Int32Array(n).fill(-1);
      const done = new Uint8Array(n);
      d[o] = 0;
      for (;;) {
        let u = -1;
        for (const v of members) if (!done[v] && (u < 0 || d[v] < d[u])) u = v;
        if (u < 0 || d[u] === Infinity) break;
        done[u] = 1;
        for (const i of adj[u]) {
          const v = other(i, u);
          if (d[u] + len[i] < d[v]) {
            d[v] = d[u] + len[i];
            via[v] = i;
          }
        }
      }
      from.set(o, { d, via });
    }
    // Pair the odd junctions: nearest first, then swaps while they shorten the total.
    const pairs: [number, number][] = [];
    const free = new Set(odd);
    const all: [number, number, number][] = [];
    for (let i = 0; i < odd.length; i++) for (let j = i + 1; j < odd.length; j++) all.push([from.get(odd[i])!.d[odd[j]], odd[i], odd[j]]);
    all.sort((a, b) => a[0] - b[0]);
    for (const [, a, b] of all)
      if (free.has(a) && free.has(b)) {
        pairs.push([a, b]);
        free.delete(a);
        free.delete(b);
      }
    const D = (a: number, b: number) => from.get(a)!.d[b];
    for (let better = true, guard = 0; better && guard < 50; guard++) {
      better = false;
      for (let i = 0; i < pairs.length; i++)
        for (let j = i + 1; j < pairs.length; j++) {
          const [a, b] = pairs[i];
          const [c, d] = pairs[j];
          const now = D(a, b) + D(c, d);
          if (D(a, c) + D(b, d) < now - 1e-9) {
            pairs[i] = [a, c];
            pairs[j] = [b, d];
            better = true;
          } else if (D(a, d) + D(b, c) < now - 1e-9) {
            pairs[i] = [a, d];
            pairs[j] = [b, c];
            better = true;
          }
        }
    }
    // The pair farthest apart is left alone: the walk starts at one of them and ends at the other.
    let ends: [number, number] | null = null;
    if (pairs.length) {
      let far = 0;
      pairs.forEach((p, i) => {
        if (D(p[0], p[1]) > D(pairs[far][0], pairs[far][1])) far = i;
      });
      ends = pairs.splice(far, 1)[0];
    }
    // Walls passed twice: those on the path between the two junctions of every other pair.
    const twice = new Uint8Array(g.edges.length);
    for (const [a, b] of pairs) {
      const { via } = from.get(a)!;
      for (let v = b; v !== a; ) {
        const i = via[v];
        twice[i] ^= 1;
        v = other(i, v);
      }
    }
    // Hierholzer on the walls counted once or twice.
    const left = g.edges.map((e, i) => (comp[e.a] === s ? 1 + twice[i] : 0));
    const next = new Int32Array(n);
    const stack: { v: number; e: number }[] = [{ v: ends ? ends[0] : s, e: -1 }];
    const order: { v: number; e: number }[] = [];
    while (stack.length) {
      const top = stack[stack.length - 1];
      let moved = false;
      while (next[top.v] < adj[top.v].length) {
        const i = adj[top.v][next[top.v]];
        if (left[i] > 0) {
          left[i]--;
          stack.push({ v: other(i, top.v), e: i });
          moved = true;
          break;
        }
        next[top.v]++;
      }
      if (!moved) order.push(stack.pop()!);
    }
    order.reverse();
    const pts: Vec2[] = [g.nodes[order[0].v]];
    for (let k = 1; k < order.length; k++) {
      const e = g.edges[order[k].e];
      const seg = e.a === order[k - 1].v ? e.pts : [...e.pts].reverse();
      for (let q = 1; q < seg.length; q++) pts.push(seg[q]);
    }
    if (pts.length >= 2) walks.push(pts);
  }
  return walks;
}

const cache = new Map<string, Vec2[][] | null>();

/**
 * Replaces every island of the layer whose walls are all thinner than `maxThickness` with the
 * walk along its mid-lines (open contours flagged `lattice`). Islands with one hole only are
 * shells, handled by collapseThinWalls. Nothing is left out: if the mid-lines do not cover the
 * whole island it is kept as it is.
 */
export function collapseLattices(contours: Contour[], maxThickness: number): Contour[] {
  if (maxThickness <= 0) return contours;
  const out = contours.filter((c) => !c.closed);
  let found = false;
  for (const isl of islands(contours)) {
    const walks = isl.length === 2 ? null : latticeWalks(isl, maxThickness);
    if (!walks) {
      out.push(...isl);
      continue;
    }
    found = true;
    for (const pts of walks) out.push({ pts, closed: false, depth: isl[0].depth, lattice: true });
  }
  return found ? classify(out) : contours;
}

function latticeWalks(isl: Contour[], maxThickness: number): Vec2[][] | null {
  const key = isl.map((c) => c.pts.map((p) => `${p[0].toFixed(3)},${p[1].toFixed(3)}`).join(' ')).join('|') + '#' + maxThickness;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Outer loop counter-clockwise, holes clockwise, whatever depth the island sits at.
  const loops = isl.map((c, i) => ({ pts: (signedArea(c.pts) > 0) === (i === 0) ? c.pts : [...c.pts].reverse(), closed: true, depth: i ? 1 : 0 }));
  let walks: Vec2[][] | null = null;
  // Thin everywhere: nothing is left of it once shrunk by half the thickness.
  if (!offsetContours(loops, -maxThickness / 2).length) {
    const w = routeGraph(centerlineGraph(loops.map((l) => l.pts)));
    // A speck too small to have a mid-line stays the loop it was.
    if (w.length && w.every((pts) => pathLength(pts) >= 4 * LATTICE_RES)) {
      // Every point of the island must be near a mid-line (as near as the corner of a square wall
      // end is to it), or the island is printed as it was.
      const lines = w.map((pts) => ({ pts, closed: false, depth: 0 }));
      const missed = differenceContours(loops, coverContours(lines, 0, (maxThickness / 2) * Math.SQRT2 + 2 * LATTICE_RES));
      const area = missed.reduce((a, c) => a + (c.depth % 2 ? -1 : 1) * Math.abs(signedArea(c.pts)), 0);
      if (area < 1) walks = w;
    }
  }
  if (cache.size > 64) cache.clear();
  cache.set(key, walks);
  return walks;
}
