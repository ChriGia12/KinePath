// Changes made by hand to a computed path: a stretch printed or not, moved, or taken out. They
// are applied to the finished path before it is checked (reach, collisions) and written, so an
// edited path goes through exactly the same checks as a computed one.
import type { Toolpath } from './toolpath';

/** `from`…`to`: path points, 0-based and inclusive, in the path as it was when the edit was made. */
export type PathEdit =
  | { op: 'extruder'; from: number; to: number; on: boolean }
  | { op: 'shift'; from: number; to: number; dx: number; dy: number; dz: number }
  | { op: 'delete'; from: number; to: number };

export interface PathEdits {
  /** Signature of the computed path the edits belong to (see pathSignature). */
  sig: string;
  edits: PathEdit[];
}

/** Identifies a computed path: an edit list is applied only to the path it was made on. */
export function pathSignature(tp: Toolpath): string {
  let [x, y, z, e] = [0, 0, 0, 0];
  for (const p of tp.points) {
    x += p.x;
    y += p.y;
    z += p.z;
    if (p.e) e++;
  }
  return `${tp.points.length}:${e}:${x.toFixed(1)}:${y.toFixed(1)}:${z.toFixed(1)}`;
}

/**
 * Applies the edits in order. Returns how many were applied; edits that no longer fit the path
 * (out of range, or that would leave fewer than two points) are skipped.
 */
export function applyEdits(tp: Toolpath, edits: PathEdit[]): number {
  let applied = 0;
  for (const ed of edits) {
    const n = tp.points.length;
    const from = Math.max(0, Math.min(ed.from, ed.to));
    const to = Math.min(n - 1, Math.max(ed.from, ed.to));
    if (!(from <= to)) continue;
    if (ed.op === 'extruder') {
      // The extruder state of a point is that of the move reaching it: the first point has none.
      for (let i = Math.max(1, from); i <= to; i++) tp.points[i] = { ...tp.points[i], e: ed.on };
    } else if (ed.op === 'shift') {
      if (![ed.dx, ed.dy, ed.dz].every(Number.isFinite)) continue;
      for (let i = from; i <= to; i++) tp.points[i] = { ...tp.points[i], x: tp.points[i].x + ed.dx, y: tp.points[i].y + ed.dy, z: tp.points[i].z + ed.dz };
    } else {
      const count = to - from + 1;
      if (n - count < 2) continue;
      tp.points.splice(from, count);
      tp.layerStart = tp.layerStart.map((i) => (i > to ? i - count : Math.min(i, from)));
      // The point after the gap is reached from the one before it: not with the extruder on
      // across whatever was taken out, unless that is asked with an 'extruder' edit.
      if (from > 0 && from < tp.points.length) tp.points[from] = { ...tp.points[from], e: false };
    }
    applied++;
  }
  if (applied) {
    tp.printLength = 0;
    tp.travelLength = 0;
    for (let i = 1; i < tp.points.length; i++) {
      const [a, b] = [tp.points[i - 1], tp.points[i]];
      const d = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
      if (b.e) tp.printLength += d;
      else tp.travelLength += d;
    }
  }
  return applied;
}
