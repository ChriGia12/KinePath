// Collision check of the arm and the mandrino against the work plate and the material already
// deposited, along the print path (LIN) and on the PTP moves to and from the safe position.
// Bodies are point samples of the cell meshes (public/cell.bin); the printed part is a voxel set
// grown bead by bead while the path is replayed.
import { FLANGE_FRAME, KR16, linkTransforms, poseAt, programChangePoses, robotRootFrame, type Joints } from './robot';
import type { PrintSettings, RobotSettings } from './settings';

type V3 = [number, number, number];

/** Cell part as stored in public/cell.json (offsets into public/cell.bin). */
export interface CellPart {
  name: string;
  kind: 'static' | 'link' | 'tool';
  color: string;
  link?: number;
  positions: [number, number];
  indices: [number, number];
}

/**
 * Point samples of a moving body in its link-home frame (the frame linkTransforms moves).
 * `needle`: the nozzle tip region, which touches the bead on purpose — checked only against
 * the plate.
 */
export interface Body {
  name: string;
  link: number;
  needle: boolean;
  pts: Float32Array;
}

/** Around the TCP the needle and the nozzle touch the bead on purpose (mm). */
export const NEEDLE_LENGTH = 45;

/** Keep one vertex per `cell`-mm grid cell: a light but faithful sampling of the surface. */
function downsample(pos: Float32Array, cell: number): number[] {
  const seen = new Set<string>();
  const out: number[] = [];
  for (let i = 0; i < pos.length; i += 3) {
    const key = `${Math.floor(pos[i] / cell)},${Math.floor(pos[i + 1] / cell)},${Math.floor(pos[i + 2] / cell)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pos[i], pos[i + 1], pos[i + 2]);
  }
  return out;
}

/**
 * Bodies to check, from the cell: forearm and wrist links (A3…A6) and the mandrino, which is
 * drawn in the KUKA FLANGE frame and moved here into the link-6 home frame. `tip` is the TCP in
 * the FLANGE frame (TOOL_DATA).
 */
export function cellBodies(parts: CellPart[], bin: ArrayBuffer, tip: V3): Body[] {
  const bodies: Body[] = [];
  for (const part of parts) {
    const pos = new Float32Array(bin, part.positions[0], part.positions[1]);
    if (part.kind === 'link' && part.link !== undefined && part.link >= 3) {
      bodies.push({ name: part.name, link: part.link, needle: false, pts: Float32Array.from(downsample(pos, 25)) });
    } else if (part.kind === 'tool') {
      const F = FLANGE_FRAME;
      const h = KR16.flangeHome;
      const body: number[] = [];
      const needle: number[] = [];
      const s = downsample(pos, 8);
      for (let i = 0; i < s.length; i += 3) {
        const [x, y, z] = [s[i], s[i + 1], s[i + 2]];
        const near = Math.hypot(x - tip[0], y - tip[1], z - tip[2]) < NEEDLE_LENGTH;
        (near ? needle : body).push(
          h[0] + F[0] * x + F[1] * y + F[2] * z,
          h[1] + F[3] * x + F[4] * y + F[5] * z,
          h[2] + F[6] * x + F[7] * y + F[8] * z,
        );
      }
      bodies.push({ name: part.name, link: 6, needle: false, pts: Float32Array.from(body) });
      bodies.push({ name: 'ugello', link: 6, needle: true, pts: Float32Array.from(needle) });
    }
  }
  return bodies;
}

const VOXEL = 4; // mm
const vkey = (ix: number, iy: number, iz: number) => (ix + 2048) * 16777216 + (iy + 2048) * 4096 + (iz + 2048);

/** Obstacles in BASE: the work plate and the printed material (voxels). */
/** Body points are checked in groups of this many: a group too far to touch anything is skipped. */
const GROUP = 24;

export class Obstacles {
  private voxels = new Set<number>();
  private readonly bed: [number, number, number, number];
  private readonly root: { p: V3; R: number[] };
  /** Per body: for every group of GROUP consecutive points, the centre (link frame) and radius of a ball holding them. */
  private readonly groups: Float64Array[];
  /** Box of the voxels filled so far (voxel indices; empty while lo > hi). */
  private lo: [number, number, number] = [Infinity, Infinity, Infinity];
  private hi: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  constructor(
    private readonly r: RobotSettings,
    private readonly bodies: Body[],
  ) {
    this.bed = [r.bedCenterX - r.bedSizeX / 2, r.bedCenterY - r.bedSizeY / 2, r.bedCenterX + r.bedSizeX / 2, r.bedCenterY + r.bedSizeY / 2];
    this.root = robotRootFrame(r);
    this.groups = bodies.map((b) => {
      const n = b.pts.length / 3;
      const g = new Float64Array(Math.ceil(n / GROUP) * 4);
      for (let k = 0; k * GROUP < n; k++) {
        const [from, to] = [k * GROUP, Math.min(n, (k + 1) * GROUP)];
        let [cx, cy, cz] = [0, 0, 0];
        for (let i = from; i < to; i++) {
          cx += b.pts[i * 3];
          cy += b.pts[i * 3 + 1];
          cz += b.pts[i * 3 + 2];
        }
        [cx, cy, cz] = [cx / (to - from), cy / (to - from), cz / (to - from)];
        let rad = 0;
        for (let i = from; i < to; i++) rad = Math.max(rad, Math.hypot(b.pts[i * 3] - cx, b.pts[i * 3 + 1] - cy, b.pts[i * 3 + 2] - cz));
        // A little larger than needed: the skip must never leave out a point that could touch.
        g.set([cx, cy, cz, rad + 0.01], k * 4);
      }
      return g;
    });
  }

  /** Material of one bead along a→b (BASE): nozzle `firstLayerZ` above the bead bottom. */
  addBead(a: V3, b: V3, s: Pick<PrintSettings, 'layerHeight' | 'firstLayerZ' | 'wallSpacing'>) {
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / (VOXEL / 2)));
    const hw = s.wallSpacing / 2;
    for (let k = 0; k <= n; k++) {
      const x = a[0] + ((b[0] - a[0]) * k) / n;
      const y = a[1] + ((b[1] - a[1]) * k) / n;
      const z = a[2] + ((b[2] - a[2]) * k) / n;
      const z0 = Math.floor((z - s.firstLayerZ) / VOXEL);
      const z1 = Math.floor((z - s.firstLayerZ + s.layerHeight) / VOXEL);
      for (let ix = Math.floor((x - hw) / VOXEL); ix <= Math.floor((x + hw) / VOXEL); ix++)
        for (let iy = Math.floor((y - hw) / VOXEL); iy <= Math.floor((y + hw) / VOXEL); iy++)
          for (let iz = z0; iz <= z1; iz++) this.voxels.add(vkey(ix, iy, iz));
      const [i0, i1, j0, j1] = [Math.floor((x - hw) / VOXEL), Math.floor((x + hw) / VOXEL), Math.floor((y - hw) / VOXEL), Math.floor((y + hw) / VOXEL)];
      this.lo = [Math.min(this.lo[0], i0), Math.min(this.lo[1], j0), Math.min(this.lo[2], z0)];
      this.hi = [Math.max(this.hi[0], i1), Math.max(this.hi[1], j1), Math.max(this.hi[2], z1)];
    }
  }

  /** What the arm hits in pose q, or null. `part`: also check the printed material. */
  hit(q: Joints, part: boolean): { what: 'plate' | 'part'; body: string } | null {
    const T = linkTransforms(q);
    const { p: o, R } = this.root;
    const top = this.r.bedTopZ - 1; // 1 mm tolerance on the plate
    const [bx0, by0, bx1, by1] = this.bed;
    // Box of the filled voxels in mm (a point is in a filled voxel only inside it).
    const [vx0, vy0, vz0] = [this.lo[0] * VOXEL, this.lo[1] * VOXEL, this.lo[2] * VOXEL];
    const [vx1, vy1, vz1] = [(this.hi[0] + 1) * VOXEL, (this.hi[1] + 1) * VOXEL, (this.hi[2] + 1) * VOXEL];
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      const m = T[b.link];
      const pts = b.pts;
      const g = this.groups[bi];
      const material = part && !b.needle;
      for (let i = 0; i < pts.length; i += 3) {
        if (i % (GROUP * 3) === 0) {
          // A whole group at once: if the ball holding its points is clear of the plate and of
          // the box of the printed material, none of them can touch — skip to the next group.
          const k = (i / (GROUP * 3)) * 4;
          const gx0 = m[0] * g[k] + m[1] * g[k + 1] + m[2] * g[k + 2] + m[3];
          const gy0 = m[4] * g[k] + m[5] * g[k + 1] + m[6] * g[k + 2] + m[7];
          const gz0 = m[8] * g[k] + m[9] * g[k + 1] + m[10] * g[k + 2] + m[11];
          const gx = R[0] * gx0 + R[1] * gy0 + R[2] * gz0 + o[0];
          const gy = R[3] * gx0 + R[4] * gy0 + R[5] * gz0 + o[1];
          const gz = R[6] * gx0 + R[7] * gy0 + R[8] * gz0 + o[2];
          const rad = g[k + 3];
          const offPlate = gz - rad >= top || gx + rad <= bx0 || gx - rad >= bx1 || gy + rad <= by0 || gy - rad >= by1;
          const offMaterial = !material || gz - rad >= vz1 || gz + rad < vz0 || gx - rad >= vx1 || gx + rad < vx0 || gy - rad >= vy1 || gy + rad < vy0;
          if (offPlate && offMaterial) {
            i += (GROUP - 1) * 3;
            continue;
          }
        }
        const x0 = m[0] * pts[i] + m[1] * pts[i + 1] + m[2] * pts[i + 2] + m[3];
        const y0 = m[4] * pts[i] + m[5] * pts[i + 1] + m[6] * pts[i + 2] + m[7];
        const z0 = m[8] * pts[i] + m[9] * pts[i + 1] + m[10] * pts[i + 2] + m[11];
        const x = R[0] * x0 + R[1] * y0 + R[2] * z0 + o[0];
        const y = R[3] * x0 + R[4] * y0 + R[5] * z0 + o[1];
        const z = R[6] * x0 + R[7] * y0 + R[8] * z0 + o[2];
        if (z < top && x > bx0 && x < bx1 && y > by0 && y < by1) return { what: 'plate', body: b.name };
        if (part && !b.needle && this.voxels.has(vkey(Math.floor(x / VOXEL), Math.floor(y / VOXEL), Math.floor(z / VOXEL))))
          return { what: 'part', body: b.name };
      }
    }
    return null;
  }
}

export interface CollisionReport {
  /** Path points where the arm or the mandrino hits the plate or the printed part. */
  count: number;
  /** Index of the first one (−1 if none), what is hit and by which body. */
  first: number;
  what: 'plate' | 'part' | null;
  body: string;
  /** Up to 500 colliding path indices, for the viewer. */
  points: number[];
  /** PTP moves (start, end, homing, change of part) that hit something: move name, what, body. */
  ptp: { move: 'start' | 'end' | 'home' | 'change'; what: 'plate' | 'part'; body: string }[];
}

/**
 * Replays the path: before checking pose i the beads up to i are deposited. Poses are checked
 * every `step` mm of nozzle motion, inside long LINs too (an obstacle halfway along a segment
 * whose ends are clear is still found; it is reported at the end of that LIN). Then the PTP moves of the program (joint interpolation):
 * safe → first point, last point → safe, safe → homing (A3 = 0) → safe.
 */
export function collisionReport(
  pts: ArrayLike<number>,
  ext: ArrayLike<number | boolean>,
  joints: Float64Array,
  bodies: Body[],
  r: RobotSettings,
  s: Pick<PrintSettings, 'layerHeight' | 'firstLayerZ' | 'wallSpacing'>,
  ends: { first: Joints | null; last: Joints | null },
  step = 3,
  /** Points reached with a PTP (change of part): the arm moves in joint space to them. */
  ptpAt?: ArrayLike<number | boolean>,
  /** C of every point (NaN: the robot's C), interpolated along a LIN like the controller does. */
  cs?: ArrayLike<number>,
  /**
   * Points where the next program starts (supports in a separate file): the end of the previous
   * one (PTP to safe, homing) and the start of the next (safe → PTP to the point) are checked
   * with everything printed so far as an obstacle.
   */
  programAt?: ArrayLike<number | boolean>,
): CollisionReport {
  const rep: CollisionReport = { count: 0, first: -1, what: null, body: '', points: [], ptp: [] };
  const obs = new Obstacles(r, bodies);
  const n = pts.length / 3;
  const at = (i: number): V3 => [pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]];
  let checkedAt: V3 | null = null;

  const ptp = (move: 'start' | 'end' | 'home' | 'change', a: Joints, b: Joints, part: boolean) => {
    const steps = Math.max(2, Math.ceil(Math.max(...a.map((v, k) => Math.abs(b[k] - v))) / 0.5)); // every 0.5° of the largest axis (≈ 10 mm at the tool)
    for (let k = 1; k < steps; k++) {
      const q = a.map((v, j) => v + ((b[j] - v) * k) / steps) as Joints;
      const h = obs.hit(q, part);
      if (h) {
        rep.ptp.push({ move, ...h });
        return;
      }
    }
  };
  const safe = [...r.safeAxes] as Joints;
  const home = [safe[0], safe[1], 0, safe[3], safe[4], safe[5]] as Joints;
  if (ends.first) ptp('start', safe, ends.first, false);

  const cAt = (i: number) => {
    const c = cs?.[i];
    return c !== undefined && Number.isFinite(c) ? c : r.c;
  };
  const record = (i: number, h: { what: 'plate' | 'part'; body: string }) => {
    rep.count++;
    if (rep.first < 0) Object.assign(rep, { first: i, what: h.what, body: h.body });
    if (rep.points.length < 500) rep.points.push(i);
  };

  for (let i = 0; i < n; i++) {
    const p = at(i);
    const q = Array.from(joints.subarray(i * 6, i * 6 + 6)) as Joints;
    const q0 = i > 0 ? (Array.from(joints.subarray(i * 6 - 6, i * 6)) as Joints) : null;
    // Inside a LIN longer than `step`: poses every `step` mm, the bead laid up to each of them.
    let laidFrom = i > 0 ? at(i - 1) : p;
    let hitInside = false;
    if (i > 0 && !ptpAt?.[i] && q0 && Number.isFinite(q0[0])) {
      const a = laidFrom;
      const parts = Math.ceil(Math.hypot(p[0] - a[0], p[1] - a[1], p[2] - a[2]) / step);
      let prev = q0;
      for (let k = 1; k < parts && !hitInside; k++) {
        const f = k / parts;
        const m: V3 = [a[0] + (p[0] - a[0]) * f, a[1] + (p[1] - a[1]) * f, a[2] + (p[2] - a[2]) * f];
        if (ext[i]) obs.addBead(laidFrom, m, s);
        laidFrom = m;
        const qm = poseAt(m, { ...r, c: cAt(i - 1) + (cAt(i) - cAt(i - 1)) * f }, prev);
        if (!qm) continue; // unreachable: reported by reachReport
        prev = qm;
        const h = obs.hit(qm, true);
        if (h) {
          record(i, h);
          hitInside = true;
        }
      }
      if (parts > 1) checkedAt = laidFrom;
    }
    if (i > 0 && ext[i]) obs.addBead(laidFrom, p, s);
    if (!Number.isFinite(q[0])) continue; // unreachable: reported by reachReport
    if (programAt?.[i] && q0 && Number.isFinite(q0[0])) {
      const poses = programChangePoses(q0, q, r);
      for (let k = 1; k < poses.length; k++) ptp(k === 1 ? 'end' : k === poses.length - 1 ? 'start' : 'home', poses[k - 1], poses[k], true);
    } else if (ptpAt?.[i] && q0) {
      if (Number.isFinite(q0[0]) && rep.ptp.filter((c) => c.move === 'change').length < 3) ptp('change', q0, q, true);
    }
    if (hitInside) continue; // this LIN is already counted
    if (checkedAt && i < n - 1 && Math.hypot(p[0] - checkedAt[0], p[1] - checkedAt[1], p[2] - checkedAt[2]) < step) continue;
    checkedAt = p;
    const h = obs.hit(q, true);
    if (!h) continue;
    record(i, h);
  }

  if (ends.last) ptp('end', ends.last, safe, true);
  if (r.useHoming) ptp('home', safe, home, true);
  return rep;
}
