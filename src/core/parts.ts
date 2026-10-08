// Several parts on the plate are printed one after the other: the whole first part, then the
// whole second one, and so on. Between two parts the extruder is off and the robot goes straight
// up (LIN, exact stop), moves above the next part with a PTP and goes straight down (LIN) to
// where that part starts; the extruder is switched on again with its first printed move.
import { msg } from '../i18n';
import type { MeshData } from './mesh';
import type { PrintSettings } from './settings';
import type { Vec2 } from './polyline';
import { buildToolpath, type PathPoint, type Toolpath } from './toolpath';

/** Footprint of a part on the plate in BASE: [xMin, yMin, xMax, yMax]. */
export type PartBox = [number, number, number, number];

/** Clearance of the PTP above everything printed so far (mm). */
export const PART_CHANGE_CLEARANCE = 30;

/** Distance from (x, y) to the box (0 inside). */
const boxDistance = (b: PartBox, x: number, y: number) => Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - y, 0, y - b[3]));

/** Two footprints overlap. */
export const boxesOverlap = (a: PartBox, b: PartBox) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/**
 * The mesh split into the parts (part frame + `offset` = BASE): every triangle goes to exactly
 * one part — the first box holding its centre, else the nearest box — so overlapping boxes never
 * print a triangle twice and a triangle outside every box is never lost. null: nothing in that box.
 */
export function splitByBoxes(mesh: MeshData, boxes: PartBox[], offset: [number, number, number]): (MeshData | null)[] {
  const p = mesh.positions;
  const ix = mesh.indices;
  const out = boxes.map(() => ({ remap: new Map<number, number>(), pos: [] as number[], idx: [] as number[] }));
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
    const x = (p[a * 3] + p[b * 3] + p[c * 3]) / 3 + offset[0];
    const y = (p[a * 3 + 1] + p[b * 3 + 1] + p[c * 3 + 1]) / 3 + offset[1];
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < boxes.length && bd > 0; k++) {
      const d = boxDistance(boxes[k], x, y);
      if (d < bd) {
        bd = d;
        best = k;
      }
    }
    const o = out[best];
    for (const v of [a, b, c]) {
      let k = o.remap.get(v);
      if (k === undefined) {
        k = o.pos.length / 3;
        o.remap.set(v, k);
        o.pos.push(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
      }
      o.idx.push(k);
    }
  }
  return out.map((o) => (o.idx.length ? { positions: Float32Array.from(o.pos), indices: Uint32Array.from(o.idx) } : null));
}

/**
 * The toolpath of every part in turn (order of `boxes`), joined by a change of part. `start`:
 * where the first part starts (part frame); each next part starts near where the previous ended.
 */
export function printPartsInTurn(
  mesh: MeshData,
  s: PrintSettings,
  boxes: PartBox[],
  offset: [number, number, number],
  start?: Vec2,
  /** Parts that are a path made elsewhere (imported.ts): its points, used as they are. */
  given?: (Toolpath | null | undefined)[],
): Toolpath {
  const all = splitByBoxes(mesh, boxes, offset);
  const out: Toolpath = {
    points: [],
    mode: s.mode as Toolpath['mode'],
    layerCount: 0,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings: [],
    partChanges: 0,
  };
  const seen = new Set<string>();
  let coveredArea = 0;
  let topArea = 0;
  let zTop = -Infinity;
  let from: Vec2 | undefined = start;
  let first = true;
  all.forEach((m, k) => {
    const tp = given?.[k] ?? (m ? buildToolpath(m, s, undefined, from) : null);
    if (!tp?.points.length) return;
    if (out.points.length) {
      // Change of part: straight up from the last printed point, PTP above where the next part
      // starts; its first point (a non-extruding move down to the start) follows.
      const last = out.points[out.points.length - 1];
      const next = tp.points[0];
      const zSafe = Math.max(zTop, last.z, next.z) + Math.max(s.travelLift, PART_CHANGE_CLEARANCE);
      const lift: PathPoint = { x: last.x, y: last.y, z: zSafe, e: false, c: last.c };
      const over: PathPoint = { x: next.x, y: next.y, z: zSafe, e: false, c: next.c, ptp: true };
      out.travelLength += zSafe - last.z + Math.hypot(next.x - last.x, next.y - last.y) + zSafe - next.z;
      out.points.push(lift, over);
      out.partChanges!++;
    }
    const base = out.points.length;
    // One by one: spreading a long array into push() overflows the argument limit in Safari.
    for (const q of tp.points) out.points.push(q);
    for (const i of tp.layerStart) out.layerStart.push(i + base);
    out.layerCount += tp.layerCount;
    out.printLength += tp.printLength;
    out.travelLength += tp.travelLength;
    out.travels += tp.travels;
    if (first) out.mode = tp.mode;
    first = false;
    if (tp.tiltX) out.tiltX = (out.tiltX ?? 0) + tp.tiltX;
    if (tp.coverage !== undefined && tp.topArea) {
      coveredArea += tp.coverage * tp.topArea;
      topArea += tp.topArea;
    }
    for (const w of tp.warnings) {
      const key = JSON.stringify(w);
      if (!seen.has(key)) {
        seen.add(key);
        out.warnings.push(w);
      }
    }
    for (const p of tp.points) if (p.e) zTop = Math.max(zTop, p.z);
    const end = tp.points[tp.points.length - 1];
    from = [end.x, end.y];
  });
  // A part with nothing left (e.g. lower than the base cut) must not vanish without a word.
  all.forEach((m, k) => {
    if (!m && !given?.[k]) out.warnings.push(msg('w.partEmpty', { i: k + 1 }));
  });
  if (topArea) {
    out.coverage = coveredArea / topArea;
    out.topArea = topArea;
  }
  return out;
}

/**
 * Two programs run one after the other (supports printed first, then the part): one path for the
 * simulation and the checks. Between them the robot does what the two .src files do — the first
 * ends with a PTP to the safe position (and the homing), the second starts with a PTP from the
 * safe position to its first point — so the first point of the second is marked `program`.
 */
export function joinInTurn(first: Toolpath, second: Toolpath): Toolpath {
  if (!first.points.length) return second;
  if (!second.points.length) return first;
  const [start, ...rest] = second.points;
  const points: PathPoint[] = [...first.points, { ...start, ptp: true, program: true }, ...rest];
  const base = first.points.length;
  return {
    ...second,
    points,
    layerStart: [...first.layerStart, ...second.layerStart.map((i) => i + base)],
    layerCount: first.layerCount + second.layerCount,
    printLength: first.printLength + second.printLength,
    travelLength: first.travelLength + second.travelLength,
    travels: first.travels + second.travels,
    warnings: [...second.warnings],
  };
}
