// Tool tilt for every print mode (contour layers, spiral, rings, serpentine): the spindle leans
// along the wall it is printing, as much as the wall leans out of the vertical (up to maxTilt), so
// on an overhang the bead is pushed against the layer below instead of being laid in the air.
//
// For each path point the nearest face of the part gives the wall; the tool axis follows the wall
// upwards (the vertical projected on the wall plane). Flat lids of solids and points far from any
// wall (inside a fill) keep the tool vertical. The direction is smoothed along the path so that
// the wrist turns gradually. With A −180 / B 0 only C tilts the tool, in the Y-Z plane: a lean
// along X is left out and counted (tiltX), as in the surface mode.
import { cFromNormal } from './surface';
import { computeBounds, isOpenMesh, type MeshData } from './mesh';
import type { PrintSettings } from './settings';
import { countTiltX, type Toolpath } from './toolpath';

type V3 = [number, number, number];

/** Distance from q to the triangle (a, b, c). */
export function pointTriangle(q: V3, a: V3, b: V3, c: V3): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap = [q[0] - a[0], q[1] - a[1], q[2] - a[2]];
  const dot = (u: number[], v: number[]) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (s: number, t: number) => Math.hypot(a[0] + s * ab[0] + t * ac[0] - q[0], a[1] + s * ab[1] + t * ac[1] - q[1], a[2] + s * ab[2] + t * ac[2] - q[2]);
  if (d1 <= 0 && d2 <= 0) return at(0, 0);
  const bp = [q[0] - b[0], q[1] - b[1], q[2] - b[2]];
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(1, 0);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return at(d1 / (d1 - d3), 0);
  const cp = [q[0] - c[0], q[1] - c[1], q[2] - c[2]];
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(0, 1);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return at(0, d2 / (d2 - d6));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return at(1 - w, w);
  }
  const den = 1 / (va + vb + vc);
  return at(vb * den, vc * den);
}

/** Nearest-face lookup on a uniform grid of the triangles' bounding boxes. */
export class FaceGrid {
  private cells = new Map<number, number[]>();
  private readonly min: V3;
  constructor(
    private readonly m: MeshData,
    private readonly cell: number,
  ) {
    const b = computeBounds(m);
    this.min = b.min as V3;
    const p = m.positions;
    const ix = m.indices;
    for (let t = 0; t < ix.length / 3; t++) {
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < 3; k++)
        for (let j = 0; j < 3; j++) {
          lo[j] = Math.min(lo[j], p[ix[t * 3 + k] * 3 + j]);
          hi[j] = Math.max(hi[j], p[ix[t * 3 + k] * 3 + j]);
        }
      const [i0, j0, k0] = lo.map((v, j) => Math.floor((v - this.min[j]) / cell));
      const [i1, j1, k1] = hi.map((v, j) => Math.floor((v - this.min[j]) / cell));
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++)
          for (let k = k0; k <= k1; k++) {
            const key = this.key(i, j, k);
            (this.cells.get(key) ?? this.cells.set(key, []).get(key)!).push(t);
          }
    }
  }
  private key(i: number, j: number, k: number) {
    return (i + 1024) * 4194304 + (j + 1024) * 2048 + (k + 1024);
  }
  /** Nearest face within `radius` of q, or −1. */
  nearest(q: V3, radius: number): number {
    const p = this.m.positions;
    const ix = this.m.indices;
    const v = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
    let best = -1;
    let bd = radius;
    const lo = q.map((x, j) => Math.floor((x - radius - this.min[j]) / this.cell));
    const hi = q.map((x, j) => Math.floor((x + radius - this.min[j]) / this.cell));
    const seen = new Set<number>();
    for (let i = lo[0]; i <= hi[0]; i++)
      for (let j = lo[1]; j <= hi[1]; j++)
        for (let k = lo[2]; k <= hi[2]; k++)
          for (const t of this.cells.get(this.key(i, j, k)) ?? []) {
            if (seen.has(t)) continue;
            seen.add(t);
            const d = pointTriangle(q, v(ix[t * 3]), v(ix[t * 3 + 1]), v(ix[t * 3 + 2]));
            if (d < bd) {
              bd = d;
              best = t;
            }
          }
    return best;
  }
}

/** Smoothing window along the path (mm): the wrist turns over this length. */
const SMOOTH = 15;

/** Sets the C of every point of the path (mesh: the part in the path's own frame). */
export function tiltAlongWalls(tp: Toolpath, mesh: MeshData, s: PrintSettings): void {
  const pts = tp.points;
  if (!pts.length || s.maxTilt <= 0) return;
  const grid = new FaceGrid(mesh, Math.max(4, 2 * s.wallSpacing));
  const radius = 1.5 * Math.max(s.wallSpacing, s.layerHeight);
  // The contour is cut at mid-bead, the nozzle sits lower by this much.
  const lift = s.layerHeight / 2 - s.firstLayerZ;
  const closed = !isOpenMesh(mesh);
  const p = mesh.positions;
  const ix = mesh.indices;
  const maxTilt = (s.maxTilt * Math.PI) / 180;
  const dirs = pts.map((q): V3 => {
    const t = grid.nearest([q.x, q.y, q.z + lift], radius);
    if (t < 0) return [0, 0, 1];
    const [a, b, c] = [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]];
    const u = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const w = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const [nx, ny, nz] = [n[0] / len, n[1] / len, n[2] / len];
    // Lids of a solid (and true flats) are not walls to lean along.
    if (1 - nz * nz < 1e-4 || (closed && Math.abs(nz) > 0.95)) return [0, 0, 1];
    // Up along the wall: the vertical projected on the wall plane.
    const v: V3 = [-nz * nx, -nz * ny, 1 - nz * nz];
    const h = Math.hypot(v[0], v[1]);
    if (h < 1e-9) return [0, 0, 1];
    const lean = Math.min(Math.atan2(h, v[2]), maxTilt);
    return [(v[0] / h) * Math.sin(lean), (v[1] / h) * Math.sin(lean), Math.cos(lean)];
  });
  assignTilt(tp, dirs);
}

/**
 * Tool tilt for a path laid on an object that is given with it (an imported path with its
 * reference model): at every point the nearest face of the object tells how to hold the tool.
 * On a surface the bead is laid on (a face within 60° of the horizontal) the tool stands along
 * its normal; beside a wall it leans along the wall, as in tiltAlongWalls. Both up to maxTilt;
 * far from any face the tool stays vertical. Returns how many points got a lean.
 */
export function tiltOnObject(tp: Toolpath, mesh: MeshData, s: Pick<PrintSettings, 'maxTilt' | 'wallSpacing' | 'layerHeight'>): number {
  const pts = tp.points;
  if (!pts.length || s.maxTilt <= 0) return 0;
  const grid = new FaceGrid(mesh, Math.max(4, 2 * s.wallSpacing));
  const radius = Math.max(10, 3 * s.layerHeight, 1.5 * s.wallSpacing);
  const p = mesh.positions;
  const ix = mesh.indices;
  const maxTilt = (s.maxTilt * Math.PI) / 180;
  let leaning = 0;
  const dirs = pts.map((q): V3 => {
    const t = grid.nearest([q.x, q.y, q.z], radius);
    if (t < 0) return [0, 0, 1];
    const [a, b, c] = [ix[t * 3], ix[t * 3 + 1], ix[t * 3 + 2]];
    const u = [p[b * 3] - p[a * 3], p[b * 3 + 1] - p[a * 3 + 1], p[b * 3 + 2] - p[a * 3 + 2]];
    const w = [p[c * 3] - p[a * 3], p[c * 3 + 1] - p[a * 3 + 1], p[c * 3 + 2] - p[a * 3 + 2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    let [nx, ny, nz] = [n[0] / len, n[1] / len, n[2] / len];
    // The axis to follow: the normal of a surface (turned upwards), or up along a wall.
    let v: V3;
    if (Math.abs(nz) >= 0.5) {
      if (nz < 0) [nx, ny, nz] = [-nx, -ny, -nz];
      v = [nx, ny, nz];
    } else v = [-nz * nx, -nz * ny, 1 - nz * nz];
    const h = Math.hypot(v[0], v[1]);
    if (h < 1e-9 || v[2] <= 0) return [0, 0, 1];
    const lean = Math.min(Math.atan2(h, v[2]), maxTilt);
    if (lean > 0.02) leaning++;
    return [(v[0] / h) * Math.sin(lean), (v[1] / h) * Math.sin(lean), Math.cos(lean)];
  });
  assignTilt(tp, dirs);
  return leaning;
}

/**
 * Sets the C of every point from the direction the tool axis should have there (unit vectors,
 * part frame): smoothed along the path so the wrist turns gradually, then turned into C.
 */
export function assignTilt(tp: Toolpath, dirs: V3[]): void {
  const pts = tp.points;
  // Smooth along the path (box filter over ±SMOOTH/2 mm of path length).
  const cum = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y, pts[i].z - pts[i - 1].z);
  let lo = 0;
  let hi = 0;
  const sum = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    while (hi < pts.length && cum[hi] <= cum[i] + SMOOTH / 2) {
      for (let k = 0; k < 3; k++) sum[k] += dirs[hi][k];
      hi++;
    }
    while (cum[lo] < cum[i] - SMOOTH / 2) {
      for (let k = 0; k < 3; k++) sum[k] -= dirs[lo][k];
      lo++;
    }
    const l = Math.hypot(sum[0], sum[1], sum[2]) || 1;
    const d: V3 = [sum[0] / l, sum[1] / l, sum[2] / l];
    pts[i].c = cFromNormal(d);
    countTiltX(tp, d);
  }
}
