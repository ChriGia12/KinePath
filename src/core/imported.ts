// A path made elsewhere (Grasshopper / KUKA|prc, or any KRL program): its LIN points are taken as
// they are — the site does not compute the path, it places it on the plate, checks it (reach,
// axis limits, collisions), simulates it and writes the complete program around it.
import { msg } from '../i18n';
import type { MeshData } from './mesh';
import type { PrintSettings } from './settings';
import { assignTilt } from './tilt';
import type { PathPoint, Toolpath } from './toolpath';

export interface ImportedPath {
  /** x, y, z of every LIN point, in the coordinates of the file. */
  xyz: Float32Array;
  /** 1 when the move reaching the point prints. */
  ext: Uint8Array;
  /** The file switches the extruder itself ($OUT[16] / $ANOUT[7]); otherwise every move prints. */
  hasExtruder: boolean;
  /**
   * The mesh given with the path is the object it was drawn on (a reference, never used to compute
   * a path): the object rests on the plate and the path keeps its place on it, height included.
   */
  ref?: boolean;
}

const NUM = String.raw`(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)`;
const AXIS = { x: new RegExp(String.raw`\bX\s*${NUM}`), y: new RegExp(String.raw`\bY\s*${NUM}`), z: new RegExp(String.raw`\bZ\s*${NUM}`) };

/**
 * The LIN points of a KRL program, in order. Everything else in the file (header, PTPs, speeds,
 * A/B/C, external axes) is left out: the site writes those itself. null: no LIN move found.
 */
export function parseSrc(text: string): ImportedPath | null {
  const lines = text.split(/\r?\n/);
  const switches = /^\s*\$(?:OUT\[16\]\s*=\s*(TRUE|FALSE)|ANOUT\[7\]\s*=\s*([\d.]+))/i;
  const hasExtruder = lines.some((l) => switches.test(l));
  const xyz: number[] = [];
  const ext: number[] = [];
  let on = !hasExtruder;
  for (const line of lines) {
    const sw = switches.exec(line);
    if (sw) {
      on = sw[1] ? sw[1].toUpperCase() === 'TRUE' : parseFloat(sw[2]) > 0;
      continue;
    }
    const lin = /^\s*LIN\s*\{([^}]*)\}/i.exec(line);
    if (!lin) continue;
    const [x, y, z] = [AXIS.x.exec(lin[1]), AXIS.y.exec(lin[1]), AXIS.z.exec(lin[1])];
    if (!x || !y || !z) continue;
    const p = [parseFloat(x[1]), parseFloat(y[1]), parseFloat(z[1])];
    const n = xyz.length;
    if (n && Math.abs(xyz[n - 3] - p[0]) < 1e-6 && Math.abs(xyz[n - 2] - p[1]) < 1e-6 && Math.abs(xyz[n - 1] - p[2]) < 1e-6) continue;
    xyz.push(...p);
    ext.push(on && n > 0 ? 1 : 0);
  }
  if (xyz.length < 6) return null;
  return { xyz: Float32Array.from(xyz), ext: Uint8Array.from(ext), hasExtruder };
}

/**
 * The beads of the path as a mesh, to show it, drag it and place it like a part: for every
 * printed stretch a strip one bead wide, from `firstLayerZ` below the nozzle up one layer height.
 * Long paths are drawn with fewer, longer strips.
 */
export function pathProxy(path: ImportedPath, s: Pick<PrintSettings, 'wallSpacing' | 'layerHeight' | 'firstLayerZ'>, maxStrips = 6000): MeshData {
  const { xyz, ext } = path;
  const n = xyz.length / 3;
  let total = 0;
  for (let i = 1; i < n; i++) total += Math.hypot(xyz[i * 3] - xyz[i * 3 - 3], xyz[i * 3 + 1] - xyz[i * 3 - 2], xyz[i * 3 + 2] - xyz[i * 3 - 1]);
  const minLen = total / maxStrips;
  const pos: number[] = [];
  const idx: number[] = [];
  const half = s.wallSpacing / 2;
  const strip = (a: number, b: number) => {
    const [ax, ay, az, bx, by, bz] = [xyz[a * 3], xyz[a * 3 + 1], xyz[a * 3 + 2], xyz[b * 3], xyz[b * 3 + 1], xyz[b * 3 + 2]];
    const len = Math.hypot(bx - ax, by - ay);
    // A vertical move has no direction in plan: a square post.
    const [nx, ny] = len > 1e-6 ? [(-(by - ay) / len) * half, ((bx - ax) / len) * half] : [half, 0];
    const [tx, ty] = len > 1e-6 ? [0, 0] : [0, half];
    const base = pos.length / 3;
    for (const [x, y, z] of [[ax - tx, ay - ty, az], [bx + tx, by + ty, bz]])
      for (const side of [-1, 1])
        for (const up of [0, 1]) pos.push(x + nx * side, y + ny * side, z - s.firstLayerZ + up * s.layerHeight);
    // corners: 0 a−low, 1 a−high, 2 a+low, 3 a+high, 4 b−low, 5 b−high, 6 b+low, 7 b+high
    for (const f of [0, 4, 6, 0, 6, 2, 1, 3, 7, 1, 7, 5, 0, 1, 5, 0, 5, 4, 2, 6, 7, 2, 7, 3, 0, 2, 3, 0, 3, 1, 4, 5, 7, 4, 7, 6]) idx.push(base + f);
  };
  let from = 0;
  for (let i = 1; i < n; i++) {
    if (!ext[i]) {
      from = i;
      continue;
    }
    const d = Math.hypot(xyz[i * 3] - xyz[from * 3], xyz[i * 3 + 1] - xyz[from * 3 + 1], xyz[i * 3 + 2] - xyz[from * 3 + 2]);
    if (d < minLen && i < n - 1 && ext[i + 1]) continue;
    strip(from, i);
    from = i;
  }
  // A path that never prints (a dry run): still something to show and place.
  if (!idx.length) for (let i = 1; i < n; i += Math.max(1, Math.floor(n / maxStrips))) strip(i - 1, i);
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) };
}

/** The imported points as a path of the site (points already in the part frame). */
export function importedToolpath(points: PathPoint[], s: PrintSettings, hasExtruder: boolean): Toolpath {
  const tp: Toolpath = { points, mode: 'imported', layerCount: 0, layerHeight: s.layerHeight, layerStart: [], printLength: 0, travelLength: 0, travels: 0, warnings: [] };
  // "Layers" for the slider: a new one every time the path has climbed half a layer height.
  let top = -Infinity;
  points.forEach((p, i) => {
    if (i) {
      const d = Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y, p.z - points[i - 1].z);
      if (p.e) tp.printLength += d;
      else tp.travelLength += d;
      if (!p.e && points[i - 1].e) tp.travels++;
    }
    if (p.e && p.z > top + s.layerHeight / 2) {
      tp.layerStart.push(i);
      top = p.z;
    }
  });
  if (!tp.layerStart.length) tp.layerStart.push(0);
  tp.layerCount = tp.layerStart.length;
  tp.warnings.push(msg(hasExtruder ? 'i.imported' : 'i.importedAllOn', { n: points.length }));
  return tp;
}

/** A stretch of an imported path: a loop that closes on itself, or an open run. */
export interface Unit {
  /** Points `from`…`to` of the path, inclusive. */
  from: number;
  to: number;
  closed: boolean;
}

/** Two points this close are the same point of a loop (mm). */
const CLOSE = 0.5;

/**
 * The path read as stretches. A stretch ends where the extruder stops, where a flat layer steps
 * up to the next one, or where the path comes back onto the point the stretch started from: then
 * it is a closed loop. A loop written without its last side — from its last corner the path goes
 * straight to the start of the next layer, right above its own start — is closed too: that side
 * is printed, as the climb to the next layer.
 */
export function pathUnits(pts: PathPoint[]): Unit[] {
  const units: Unit[] = [];
  const n = pts.length;
  const d3 = (a: PathPoint, b: PathPoint) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const above = (a: PathPoint, b: PathPoint) => Math.hypot(a.x - b.x, a.y - b.y) <= 2 * CLOSE;
  let s = 0;
  let len = 0;
  let flat = true;
  let implied = false; // the last stretch ended was a loop without its last side
  const end = (to: number, closed: boolean) => {
    if (to > s) units.push({ from: s, to, closed });
  };
  for (let i = 1; i < n; i++) {
    if (i === s) continue; // the move reaching a new stretch belongs to no stretch
    const dz = Math.abs(pts[i].z - pts[i - 1].z);
    const step = flat && dz > 0.3 && i - 1 > s;
    if (!pts[i].e || step) {
      // Stepping up onto the point above this stretch's start: a loop missing its last side.
      implied = step && pts[i].e && len > 10 * CLOSE && i - 1 - s >= 2 && above(pts[i], pts[s]);
      end(i - 1, implied);
      [s, len, flat] = [i, 0, true];
      continue;
    }
    len += d3(pts[i], pts[i - 1]);
    if (dz > 0.05) flat = false;
    if (len > 10 * CLOSE && d3(pts[i], pts[s]) < CLOSE) {
      end(i, true);
      [s, len, flat, implied] = [i + 1, 0, true, false];
    }
  }
  // The last stretch has no layer above to tell: it is a loop like the one before it, if that was one.
  const prev = units[units.length - 1];
  if (s < n - 1) end(n - 1, implied && !!prev && n - 1 - s >= 2 && above(pts[s], pts[prev.from]));
  return units;
}

/**
 * The same path with every closed loop started from its point nearest to `target` (x, y in the
 * frame of the points). Open stretches are left as they are: an open line starts where it starts.
 * Returns the points and how many loops were moved, and how many stretches could not be.
 */
export function moveSeam(pts: PathPoint[], target: [number, number]): { points: PathPoint[]; moved: number; open: number } {
  const units = pathUnits(pts);
  const out: PathPoint[] = [];
  let at = 0;
  let moved = 0;
  let open = 0;
  for (const u of units) {
    for (; at < u.from; at++) out.push(pts[at]);
    at = u.to + 1;
    if (!u.closed) {
      open++;
      for (let i = u.from; i <= u.to; i++) out.push(pts[i]);
      continue;
    }
    // The loop without its repeated closing point.
    const dup = Math.hypot(pts[u.to].x - pts[u.from].x, pts[u.to].y - pts[u.from].y, pts[u.to].z - pts[u.from].z) < CLOSE;
    const loop = pts.slice(u.from, dup ? u.to : u.to + 1);
    // Nearest point of the loop to the target: on a side, not only at a corner.
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = 0; i < loop.length; i++) {
      const [a, b] = [loop[i], loop[(i + 1) % loop.length]];
      const [dx, dy] = [b.x - a.x, b.y - a.y];
      const l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((target[0] - a.x) * dx + (target[1] - a.y) * dy) / l2)) : 0;
      const d = Math.hypot(a.x + t * dx - target[0], a.y + t * dy - target[1]);
      if (d < best.d) best = { d, i, t };
    }
    const [a, b] = [loop[best.i], loop[(best.i + 1) % loop.length]];
    const on = (t: number): PathPoint => ({ ...a, x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), z: a.z + t * (b.z - a.z), e: true });
    // Start on a corner when the nearest point is (almost) one, otherwise on the side itself.
    const side = Math.hypot(b.x - a.x, b.y - a.y);
    const start = best.t * side < CLOSE ? best.i : (1 - best.t) * side < CLOSE ? (best.i + 1) % loop.length : -1;
    const ring: PathPoint[] = [];
    if (start >= 0) for (let k = 0; k <= loop.length; k++) ring.push({ ...loop[(start + k) % loop.length], e: true });
    else {
      ring.push(on(best.t));
      for (let k = 1; k <= loop.length; k++) ring.push({ ...loop[(best.i + k) % loop.length], e: true });
      ring.push(on(best.t));
    }
    // The move reaching the loop prints or not as the move reaching it did in the file.
    ring[0].e = pts[u.from].e;
    if (start !== 0) moved++;
    for (const q of ring) out.push(q);
  }
  for (; at < pts.length; at++) out.push(pts[at]);
  return { points: out, moved, open };
}

type V3 = [number, number, number];
const EMPTY: number[] = [];

/**
 * Tool leaning along the wall, found from the path itself: under every point lies the layer
 * printed below it, and the direction from the nearest point of that layer up to this one is the
 * wall. The tool axis follows it, up to `maxTilt` from the vertical. Where nothing lies below (the
 * first layer, laid on the plate) the tool stays vertical, and a "wall" flatter than 60° from the
 * vertical is not one (see below). Returns how many points got a lean.
 */
export function tiltFromPath(tp: Toolpath, s: Pick<PrintSettings, 'maxTilt' | 'layerHeight' | 'wallSpacing'>): number {
  const pts = tp.points;
  if (pts.length < 2 || s.maxTilt <= 0) return 0;
  // Samples every ~2 mm of the printed path, in buckets.
  const cell = 8;
  const grid = new Map<number, number[]>();
  // Bucket of a cell as one number (cells are within ±2000 of the origin: ±16 m).
  const bucket = (i: number, j: number, k: number) => ((i + 2048) * 4096 + (j + 2048)) * 4096 + (k + 2048);
  const sx: number[] = [];
  const sy: number[] = [];
  const sz: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (!pts[i].e) continue;
    const [a, b] = [pts[i - 1], pts[i]];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z) / 2));
    for (let k = 0; k <= n; k++) {
      const [x, y, z] = [a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, a.z + ((b.z - a.z) * k) / n];
      const key = bucket(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key)!.push(sx.length);
      sx.push(x);
      sy.push(y);
      sz.push(z);
    }
  }
  const reach = Math.max(8, 4 * s.layerHeight, 1.5 * s.wallSpacing);
  const gap = 0.4; // a sample this much lower is another layer, not this one
  const maxTilt = (s.maxTilt * Math.PI) / 180;
  let leaning = 0;
  const dirs = pts.map((p): V3 => {
    let below = { d: Infinity, k: -1 };
    // Only the cells that can hold a sample within reach and at least `gap` lower.
    const [i0, i1] = [Math.floor((p.x - reach) / cell), Math.floor((p.x + reach) / cell)];
    const [j0, j1] = [Math.floor((p.y - reach) / cell), Math.floor((p.y + reach) / cell)];
    const [k0, k1] = [Math.floor((p.z - reach) / cell), Math.floor((p.z - gap) / cell)];
    for (let i = i0; i <= i1; i++)
      for (let j = j0; j <= j1; j++)
        for (let k = k0; k <= k1; k++)
          for (const q of grid.get(bucket(i, j, k)) ?? EMPTY) {
            const dz = p.z - sz[q];
            if (dz < gap) continue;
            const d = Math.hypot(p.x - sx[q], p.y - sy[q], dz);
            if (d < below.d && d <= reach) below = { d, k: q };
          }
    // Nothing below (the first layer, laid on the plate): no wall to lean against, tool vertical.
    if (below.k < 0) return [0, 0, 1];
    const [vx, vy, vz] = [p.x - sx[below.k], p.y - sy[below.k], p.z - sz[below.k]];
    const h = Math.hypot(vx, vy);
    if (h < 1e-6 || vz <= 0) return [0, 0, 1];
    // Flatter than 60° from the vertical it is no wall: the pass beside this one on a slope (a
    // surface printed in one layer), not a layer below. The tool stays vertical there.
    const raw = Math.atan2(h, vz);
    if (raw > Math.PI / 3) return [0, 0, 1];
    const lean = Math.min(raw, maxTilt);
    if (lean > 0.02) leaning++;
    return [(vx / h) * Math.sin(lean), (vy / h) * Math.sin(lean), Math.cos(lean)];
  });
  assignTilt(tp, dirs);
  return leaning;
}

/**
 * Curves (polylines as x, y, z triples) as a path: each curve is printed, in the order given. The
 * move from the end of one to the start of the next is printed too when it is no longer than
 * `join` (the step up to the next layer of a path drawn layer by layer); a longer one is made
 * with the extruder off.
 */
export function curvesToPath(curves: ArrayLike<number>[], join = 0): ImportedPath | null {
  const xyz: number[] = [];
  const ext: number[] = [];
  for (const c of curves) {
    for (let i = 0; i + 2 < c.length; i += 3) {
      const n = xyz.length;
      const hop = n ? Math.hypot(xyz[n - 3] - c[i], xyz[n - 2] - c[i + 1], xyz[n - 1] - c[i + 2]) : Infinity;
      if (hop < 1e-3) continue;
      xyz.push(c[i], c[i + 1], c[i + 2]);
      ext.push(i === 0 ? (hop <= join ? 1 : 0) : 1);
    }
  }
  if (xyz.length < 6) return null;
  return { xyz: Float32Array.from(xyz), ext: Uint8Array.from(ext), hasExtruder: true };
}
