// Turns the part into an ordered robot path: contour layers (planar or spiral / vase mode),
// solid serpentine layers, or a non-planar serpentine over the top surface.
import { msg, type Msg } from '../i18n';
import { computeBounds, type MeshData } from './mesh';
import { densify, pointInPolygon, polylineLength, rotateToNearest, signedArea, simplifyClosed, simplifyOpen, type Vec2 } from './polyline';
import type { PrintMode, PrintSettings } from './settings';
import { cFromNormal, HeightField, topSurfacePasses, type SurfaceOptions, type SurfacePoint, type SurfaceRun } from './surface';
import { sliceAt, type Contour, type Layer } from './slicer';
import { buildWalls, collapseThinWalls, coverContours, islands, offsetContours } from './walls';
import { collapseLattices } from './lattice';
import { resolveStrategy } from './strategy';
import { scanFill, serpentine } from './zigzag';
import { buildRings } from './rings';
import { addSupports } from './supports';

export interface PathPoint {
  x: number;
  y: number;
  z: number;
  /** true when the move that reaches this point deposits material */
  e: boolean;
  /** tool tilt C for this point (surface mode with tilt); otherwise the robot setting */
  c?: number;
  /** printing a removable support, not the part */
  support?: boolean;
  /** reached with a PTP (move between two parts, above them) instead of a LIN */
  ptp?: boolean;
  /**
   * first point of the next program (supports in a separate file, then the part): the robot ends
   * the previous program (PTP to the safe position, homing) and starts this one (PTP from the
   * safe position to here). Always together with `ptp`.
   */
  program?: boolean;
}

export interface Toolpath {
  points: PathPoint[];
  /** 'imported': a path made elsewhere and taken as it is (imported.ts). */
  mode: PrintMode | 'imported';
  layerCount: number;
  layerHeight: number;
  /** index in `points` where each layer starts (for the viewer's layer slider) */
  layerStart: number[];
  printLength: number; // mm
  travelLength: number; // mm
  travels: number;
  warnings: Msg[];
  /** Solid serpentine: layers from this index on are blended (non-planar). */
  planarLayers?: number;
  /** Surface mode: share of the top surface covered by the passes (0…1), and that surface's plan area (mm²). */
  coverage?: number;
  topArea?: number;
  /** Tilt on: points whose slope along X cannot be followed with C (> 5°). */
  tiltX?: number;
  /** Several parts: moves from one part to the next (PTP above the parts, extruder off). */
  partChanges?: number;
  /** Thin-walled networks: walls passed a second time (extruder off unless set to print them). */
  retraces?: number;
}

export interface LayerSummary {
  layers: Layer[];
  singleLoop: boolean; // spiral possible (see spiralRange)
  /** Layers [from, to] printable as one continuous spiral; the others are printed planar. */
  spiral: [number, number] | null;
  maxIslands: number;
  openLayers: number; // layers with open contours (non-watertight mesh)
  emptyLayers: number;
  /** Contours shorter than minContourLength left out (only if the user set a minimum). */
  dropped: number;
  /** Layers where supports were added. */
  supportLayers: number;
  /** Layers with a thin-walled network printed along its mid-lines (lattice.ts). */
  latticeLayers: number;
}

/** Contour taken at mid-bead height (i + ½)·h; nozzle at firstLayerZ + i·h above the table. */
export function sliceForPrint(mesh: MeshData, s: PrintSettings): LayerSummary {
  const b = computeBounds(mesh);
  const height = b.max[2] - b.min[2];
  const n = Math.max(1, Math.round(height / s.layerHeight));
  const zs = Array.from({ length: n }, (_, i) => b.min[2] + (i + 0.5) * s.layerHeight);
  const raw = sliceAt(mesh, zs);
  // The whole mesh is printed: every section as it is (no base invented under it, no sliver
  // dropped). Only a minimum length set on purpose by the user leaves contours out, and says so.
  let dropped = 0;
  const thin = s.mode === 'zigzag' ? 0 : s.thinWallMax;
  const layers = raw.map((l, i) => ({
    z: s.firstLayerZ + i * s.layerHeight,
    // A solid filled layer must keep its real outline: no shell → mid-line collapse there.
    contours: collapseLattices(collapseThinWalls(l.contours, thin), thin).filter((c) => {
      const keep = polylineLength(c.pts, c.closed) >= s.minContourLength;
      if (!keep) dropped++;
      return keep;
    }),
  }));
  let maxIslands = 0;
  let openLayers = 0;
  let emptyLayers = 0;
  let latticeLayers = 0;
  for (const l of layers) {
    const outers = l.contours.filter((c) => c.closed && c.depth % 2 === 0).length;
    maxIslands = Math.max(maxIslands, outers);
    if (l.contours.some((c) => !c.closed && !c.lattice)) openLayers++;
    if (l.contours.some((c) => c.lattice)) latticeLayers++;
    if (!l.contours.length) emptyLayers++;
  }
  // Supports are added after the counts above: they are not part of the mesh.
  const supportLayers = s.supports !== 'none' ? addSupports(layers, s.layerHeight, s.wallSpacing, s.overhangAngle) : 0;
  const spiral = supportLayers ? null : spiralRange(layers);
  return { layers, singleLoop: spiral !== null, spiral, maxIslands, openLayers, emptyLayers, dropped, supportLayers, latticeLayers };
}

const isSingleLoop = (l: Layer) => l.contours.length === 1 && l.contours[0].closed;

/**
 * Longest run of single-loop layers. Spiral is used when that run covers ≥ 90% of the part
 * and only bottom/top layers fall outside it (e.g. rounded rims that slice into slivers).
 */
export function spiralRange(layers: Layer[]): [number, number] | null {
  let bestA = -1;
  let bestB = -2;
  let start = -1;
  for (let i = 0; i < layers.length; i++) {
    if (!isSingleLoop(layers[i])) {
      start = -1;
      continue;
    }
    if (start < 0) start = i;
    if (i - start > bestB - bestA) {
      bestA = start;
      bestB = i;
    }
  }
  if (bestA < 0) return null;
  return bestB - bestA + 1 >= Math.max(1, 0.9 * layers.length) ? [bestA, bestB] : null;
}

/** Spiral only when the part allows it; otherwise the chosen mode. */
export function resolveMode(summary: LayerSummary, s: PrintSettings): PrintMode {
  if (s.mode === 'spiral') return summary.singleLoop && s.walls === 1 ? 'spiral' : 'planar';
  return s.mode;
}

export function buildToolpath(
  mesh: MeshData,
  s: PrintSettings,
  summaryIn?: LayerSummary,
  /** Seam target in the mesh's own frame; defaults to the front-left corner. */
  startTarget?: Vec2,
): Toolpath {
  // A contour print without an explicit choice: how to lay it is decided from the part.
  const chosen = resolveStrategy(mesh, s);
  if (chosen.settings !== s) {
    const tp = buildToolpath(mesh, chosen.settings, chosen.settings.mode === s.mode && !chosen.settings.adaptiveLayers ? summaryIn : undefined, startTarget);
    if (chosen.why) tp.warnings.push(chosen.why);
    return tp;
  }
  const b0 = computeBounds(mesh);
  if (s.mode === 'surface') return buildSurface(mesh, s, startTarget ?? [b0.min[0], b0.min[1]]);
  // Contour layers / spiral following the surface: rings at a constant bead distance (rings.ts).
  if (s.adaptiveLayers && (s.mode === 'planar' || s.mode === 'spiral'))
    return buildRings(mesh, s, startTarget ?? [b0.min[0], b0.min[1]], s.mode === 'spiral');
  const summary = summaryIn ?? sliceForPrint(mesh, s);
  const mode = resolveMode(summary, s);
  const warnings: Msg[] = [];
  if (s.mode === 'spiral' && mode !== 'spiral')
    warnings.push(msg('w.spiralImpossible'));
  if (summary.openLayers)
    warnings.push(msg('w.openLayers', { n: summary.openLayers }));
  if (summary.emptyLayers) warnings.push(msg('w.emptyLayers', { n: summary.emptyLayers }));
  if (summary.dropped) warnings.push(msg('w.dropped', { n: summary.dropped, mm: s.minContourLength }));
  if (summary.supportLayers) warnings.push(msg('w.supports', { n: summary.supportLayers }));
  if (summary.latticeLayers) warnings.push(msg('w.lattice', { n: summary.latticeLayers }));

  const b = computeBounds(mesh);
  const start: Vec2 = startTarget ?? [b.min[0], b.min[1]];
  const tp: Toolpath = {
    points: [],
    mode,
    layerCount: summary.layers.length,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings,
  };
  if (mode === 'spiral' && summary.spiral) {
    const [a, b] = summary.spiral;
    let cur = buildPlanar(tp, summary.layers.slice(0, a), s, start);
    cur = buildSpiral(tp, summary.layers.slice(a, b + 1), s, cur);
    buildPlanar(tp, summary.layers.slice(b + 1), s, cur);
    if (a > 0 || b < summary.layers.length - 1)
      warnings.push(msg('w.spiralRange', { a: a + 1, b: b + 1, n: summary.layers.length - (b - a + 1) }));
  } else if (mode === 'zigzag') buildZigzag(tp, mesh, summary.layers, s, start);
  else buildPlanar(tp, summary.layers, s, start);
  return tp;
}

function push(tp: Toolpath, p: PathPoint) {
  const last = tp.points[tp.points.length - 1];
  if (last) {
    if (Math.abs(last.x - p.x) < 1e-4 && Math.abs(last.y - p.y) < 1e-4 && Math.abs(last.z - p.z) < 1e-4) return;
    const d = Math.hypot(p.x - last.x, p.y - last.y, p.z - last.z);
    if (p.e) tp.printLength += d;
    else tp.travelLength += d;
  }
  tp.points.push(p);
}

function prepareLoop(c: Contour, s: PrintSettings, near: Vec2): Vec2[] {
  // Every loop is printed the same way round (counter-clockwise from above unless set otherwise),
  // holes included.
  const ccw = signedArea(c.pts) < 0 ? [...c.pts].reverse() : c.pts;
  const simple = simplifyClosed(s.loopDirection === 'cw' ? [...ccw].reverse() : ccw, s.tolerance);
  return densify(rotateToNearest(simple, near), s.maxSegment, true);
}

/** Checks that a straight connection a→b lies on material (the layer region, or the top surface). */
type Inside = (a: Vec2, b: Vec2) => boolean;

/** Below this hop the nozzle stays on the same spot (seam on the same vertical): always printed. */
const SAME_SPOT = 0.5;

/**
 * Printed links may graze the region border by this much: the bead is centred on the contour.
 * Gaps narrower than twice this are closed by the bead anyway.
 */
const linkMargin = (s: PrintSettings) => Math.min(1, s.wallSpacing / 4);

/** `Inside` for a planar region, grown by the link margin (computed on first use). */
function insideRegion(region: Contour[], s: PrintSettings): Inside {
  let grown: Contour[] | null = null;
  return (a, b) => segmentInside(a, b, (grown ??= offsetContours(region, linkMargin(s))));
}

/**
 * `Inside` on the union of two regions: the layer being printed and the one below. The step from
 * one layer to the next starts on the previous layer and ends on the new one — on a dome or a
 * hull the new layer is smaller, so the step lies on the layer below, which carries it.
 */
function insideLayers(layer: Contour[], below: Contour[], s: PrintSettings): Inside {
  // Closed sections cover their inside; open arcs and supports a band one bead wide.
  let grown: Contour[][] | null = null;
  const on = (q: Vec2, region: Contour[]) => {
    let inside = false;
    for (const c of region) if (c.closed && pointInPolygon(q, c.pts)) inside = !inside;
    return inside;
  };
  return (a, b) => {
    grown ??= [layer, below].filter((r) => r.length).map((r) => coverContours(r, linkMargin(s), s.wallSpacing / 2 + linkMargin(s)));
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 1; k < n; k++) {
      const q: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
      if (!grown.some((g) => on(q, g))) return false;
    }
    return true;
  };
}

/**
 * A connection is extruded only when it is verified: short enough (`maxBridge`, or up to 8 beads
 * for the serpentine fill when `long`) and lying on material along its whole length. Anything
 * else becomes a lifted travel with the extruder off. The heuristics (fill direction, order)
 * choose among paths whose links went through this same check.
 */
export function linkPrintable(a: Vec2, b: Vec2, s: PrintSettings, inside: Inside | undefined, long = false): boolean {
  const hop = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (hop <= SAME_SPOT) return true;
  if (!inside || hop > (long ? Math.max(s.maxBridge, 8 * s.wallSpacing) : s.maxBridge)) return false;
  return inside(a, b);
}

/** Reach `to` either extruding (verified link, see linkPrintable) or with a lifted travel. */
function moveTo(tp: Toolpath, to: Vec2, z: number, s: PrintSettings, c?: number, inside?: Inside, long = false) {
  const last = tp.points[tp.points.length - 1];
  if (!last) {
    push(tp, { x: to[0], y: to[1], z, e: false, c });
    return;
  }
  if (linkPrintable([last.x, last.y], to, s, inside, long)) {
    push(tp, { x: to[0], y: to[1], z, e: true, c });
    return;
  }
  tp.travels++;
  const zUp = Math.max(last.z, z) + s.travelLift;
  push(tp, { x: last.x, y: last.y, z: zUp, e: false, c: last.c });
  push(tp, { x: to[0], y: to[1], z: zUp, e: false, c });
  push(tp, { x: to[0], y: to[1], z, e: false, c });
}

function nearestIndex(contours: Contour[], cur: Vec2): number {
  let bi = 0;
  let bd = Infinity;
  contours.forEach((c, i) => {
    for (const p of c.pts) {
      const d = Math.hypot(p[0] - cur[0], p[1] - cur[1]);
      if (d < bd) {
        bd = d;
        bi = i;
      }
    }
  });
  return bi;
}

/**
 * Points of a loop climbing from `fromZ` to their own height over the first `length` mm (in plan)
 * of the loop, then on at their height. `zOf` gives the height of point i. The point where the
 * ramp ends is added exactly, so the climb is one straight diagonal.
 */
export function rampPoints(pts: Vec2[], zOf: (i: number) => number, fromZ: number, length: number): PathPoint[] {
  const out: PathPoint[] = [];
  const lift0 = fromZ - zOf(0);
  let s0 = 0;
  out.push({ x: pts[0][0], y: pts[0][1], z: zOf(0) + lift0, e: true });
  for (let i = 1; i < pts.length; i++) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    const s1 = s0 + seg;
    if (s0 < length && s1 > length && seg > 0) {
      const f = (length - s0) / seg;
      const z = zOf(i - 1) + f * (zOf(i) - zOf(i - 1));
      out.push({ x: pts[i - 1][0] + f * (pts[i][0] - pts[i - 1][0]), y: pts[i - 1][1] + f * (pts[i][1] - pts[i - 1][1]), z, e: true });
    }
    out.push({ x: pts[i][0], y: pts[i][1], z: zOf(i) + lift0 * Math.max(0, 1 - s1 / length), e: true });
    s0 = s1;
  }
  return out;
}

export function buildPlanar(tp: Toolpath, layers: Layer[], s: PrintSettings, start: Vec2): Vec2 {
  let cur: Vec2 = start;
  let below: Contour[] = [];
  for (const layer of layers) {
    tp.layerStart.push(tp.points.length);
    const closed = layer.contours.filter((c) => c.closed);
    const inside = insideLayers(layer.contours, below, s);
    if (layer.contours.length) below = layer.contours;
    // A walk right above where the layer below ended goes first: no jump to come back to it.
    const walks = new Set(layer.contours.filter((c) => c.lattice));
    for (let near = true; near && walks.size; ) {
      near = false;
      for (const c of walks) {
        const ends = [c.pts[0], c.pts[c.pts.length - 1]];
        if (Math.min(...ends.map((q) => Math.hypot(q[0] - cur[0], q[1] - cur[1]))) > Math.max(s.wallSpacing, s.maxBridge)) continue;
        walks.delete(c);
        cur = printLattice(tp, c, layer.z, s, cur, inside);
        near = true;
        break;
      }
    }
    for (const wall of buildWalls(closed, s.walls, s.wallSpacing)) {
      const pending = [...wall];
      while (pending.length) {
        const loop = prepareLoop(pending.splice(nearestIndex(pending, cur), 1)[0], s, cur);
        const last = tp.points[tp.points.length - 1];
        // Layer change: no vertical step at the seam — the bead goes on along the new loop and
        // climbs to the new height over the first `layerRamp` mm, like one continuous thread. The
        // step to the new loop lies on the layer just printed (checked), so it may be as long as
        // a serpentine link (8 beads): on a flat top the loops move apart more than `maxBridge`.
        const change = layer.z > (last?.z ?? Infinity);
        if (s.layerRamp > 0 && last?.e && change && linkPrintable([last.x, last.y], loop[0], s, inside, true)) {
          // The climb starts where the last layer ended: the step to the new loop already rises.
          const ring: Vec2[] = [[last.x, last.y], ...loop, loop[0]];
          for (const q of rampPoints(ring, () => layer.z, last.z, s.layerRamp).slice(1)) push(tp, q);
        } else {
          moveTo(tp, loop[0], layer.z, s, undefined, inside);
          for (let i = 1; i < loop.length; i++) push(tp, { x: loop[i][0], y: loop[i][1], z: layer.z, e: true });
          push(tp, { x: loop[0][0], y: loop[0][1], z: layer.z, e: true });
        }
        cur = loop[0];
      }
    }
    // Open arcs (sections of an open shell) and supports, nearest first.
    const openOnes = layer.contours.filter((c) => !c.closed && (!c.lattice || walks.has(c)));
    while (openOnes.length) {
      let bi = 0;
      let bd = Infinity;
      openOnes.forEach((o, k) => {
        const loop = o.pts.length > 3 && Math.hypot(o.pts[0][0] - o.pts[o.pts.length - 1][0], o.pts[0][1] - o.pts[o.pts.length - 1][1]) < 1e-6;
        const ends = loop ? o.pts : [o.pts[0], o.pts[o.pts.length - 1]];
        let d = Infinity;
        for (const q of ends) d = Math.min(d, Math.hypot(q[0] - cur[0], q[1] - cur[1]));
        if (d < bd) [bd, bi] = [d, k];
      });
      const c = openOnes.splice(bi, 1)[0];
      if (c.lattice) {
        cur = printLattice(tp, c, layer.z, s, cur, inside);
        continue;
      }
      let pts = densify(simplifyOpen(c.pts, s.tolerance), s.maxSegment, false);
      // A support outline is a loop written as a path: start it where the nozzle is.
      const ring = pts.length > 3 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
      if (ring) {
        const loop = rotateToNearest(pts.slice(0, -1), cur);
        pts = [...loop, loop[0]];
      }
      const dStart = Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]);
      const dEnd = Math.hypot(pts[pts.length - 1][0] - cur[0], pts[pts.length - 1][1] - cur[1]);
      if (dEnd < dStart) pts = pts.reverse();
      const last = tp.points[tp.points.length - 1];
      const sup = c.support ? { support: true } : {};
      const hop = last ? Math.hypot(pts[0][0] - last.x, pts[0][1] - last.y) : Infinity;
      if (!c.support && last?.e && !last.support && layer.z > last.z && hop <= Math.max(s.wallSpacing, s.maxBridge)) {
        // Open arc on top of the arc of the layer below: it ended right under this start. Up
        // straight to the new layer, then back along the arc (an open arc goes back and forth).
        if (hop > 1e-6) push(tp, { x: pts[0][0], y: pts[0][1], z: last.z, e: true });
        push(tp, { x: pts[0][0], y: pts[0][1], z: layer.z, e: true });
      } else {
        moveTo(tp, pts[0], layer.z, s, undefined, inside);
        if (c.support) tp.points[tp.points.length - 1].support = true; // the move onto the support prints support
      }
      for (let i = 1; i < pts.length; i++) push(tp, { x: pts[i][0], y: pts[i][1], z: layer.z, e: true, ...sup });
      cur = pts[pts.length - 1];
    }
  }
  return cur;
}

/**
 * The walk along a thin-walled network: one continuous move at the layer height, started from its
 * end nearest to the nozzle, so on the next layer it runs back from where this one ended, right
 * above it. A wall the walk must pass twice (`latticeRetrace`):
 *  - 'side': the two passes are laid side by side, half a bead each side of the mid-line — the
 *    extruder never stops and no bead lies on another (that wall comes out two beads wide);
 *  - 'off': the second pass is made with the extruder off, without lifting;
 *  - 'print': the second pass is printed over the first.
 */
function printLattice(tp: Toolpath, c: Contour, z: number, s: PrintSettings, cur: Vec2, inside: Inside): Vec2 {
  let pts = c.pts;
  const closed = Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-6;
  if (closed) {
    const loop = rotateToNearest(pts.slice(0, -1), cur);
    pts = [...loop, loop[0]];
  } else if (Math.hypot(pts[pts.length - 1][0] - cur[0], pts[pts.length - 1][1] - cur[1]) < Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1])) pts = [...pts].reverse();
  const key = (a: Vec2, b: Vec2) => {
    const [p, q] = a[0] < b[0] || (a[0] === b[0] && a[1] <= b[1]) ? [a, b] : [b, a];
    return `${p[0].toFixed(3)},${p[1].toFixed(3)},${q[0].toFixed(3)},${q[1].toFixed(3)}`;
  };
  const n = pts.length;
  const keys = pts.map((q, i) => (i ? key(pts[i - 1], q) : ''));
  const total = new Map<string, number>();
  for (let i = 1; i < n; i++) total.set(keys[i], (total.get(keys[i]) ?? 0) + 1);
  // For every segment: is it the second pass over its wall, and (side by side) where it is laid.
  const seen = new Map<string, Vec2>();
  const repeat: boolean[] = [false];
  const shift: (Vec2 | null)[] = [null];
  for (let i = 1; i < n; i++) {
    const d: Vec2 = [pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]];
    const len = Math.hypot(d[0], d[1]) || 1;
    const first = seen.get(keys[i]);
    repeat.push(!!first);
    if (!first) seen.set(keys[i], d);
    if (s.latticeRetrace !== 'side' || (total.get(keys[i]) ?? 0) < 2) {
      shift.push(null);
      continue;
    }
    // Keep left; a second pass in the same direction as the first keeps right.
    const same = !!first && first[0] * d[0] + first[1] * d[1] > 0;
    const sign = same ? -1 : 1;
    shift.push([(-d[1] / len) * sign, (d[0] / len) * sign]);
  }
  // Where each pass is laid: on the mid-line, or half a bead beside it (corners mitred).
  const half = s.wallSpacing / 2;
  const out: { p: Vec2; e: boolean }[] = [];
  for (let i = 1; i < n; i++) {
    const e = !repeat[i] || s.latticeRetrace !== 'off';
    const sh = shift[i];
    if (!sh) {
      if (!out.length) out.push({ p: pts[i - 1], e: false });
      // After a pass laid beside the mid-line: back onto the junction first, so this wall is straight.
      else if (shift[i - 1]) out.push({ p: pts[i - 1], e: true });
      out.push({ p: pts[i], e });
      continue;
    }
    const at = (v: number, other: Vec2 | null): Vec2 => {
      // Vertex shared with the next/previous segment of the same run: average of the two normals.
      let nx = sh[0];
      let ny = sh[1];
      if (other) {
        const [mx, my] = [sh[0] + other[0], sh[1] + other[1]];
        const m = Math.hypot(mx, my);
        if (m > 0.2) {
          const k = Math.min(2, 2 / m); // mitre length 1 / cos(half angle), at most 2
          [nx, ny] = [(mx / m) * k, (my / m) * k];
        }
      }
      return [pts[v][0] + nx * half, pts[v][1] + ny * half];
    };
    const prevRun = i > 1 && shift[i - 1] && repeat[i - 1] === repeat[i] ? shift[i - 1] : null;
    const nextRun = i < n - 1 && shift[i + 1] && repeat[i + 1] === repeat[i] ? shift[i + 1] : null;
    const a = at(i - 1, prevRun);
    if (!out.length) out.push({ p: a, e: false });
    else if (!prevRun) out.push({ p: a, e: true }); // the short step from the mid-line onto the side
    out.push({ p: at(i, nextRun), e: true });
  }
  if (!out.length) return cur;
  const last = tp.points[tp.points.length - 1];
  const start = out[0].p;
  const hop = last ? Math.hypot(start[0] - last.x, start[1] - last.y) : Infinity;
  if (last && z > last.z && hop <= Math.max(s.wallSpacing, s.maxBridge)) {
    // On top of where the layer below ended: straight up, then on along the walk.
    if (hop > 1e-6) push(tp, { x: start[0], y: start[1], z: last.z, e: true });
    push(tp, { x: start[0], y: start[1], z, e: true });
  } else moveTo(tp, start, z, s, undefined, inside, true); // on the layer below: as long as a serpentine link
  let again = false;
  for (let i = 1; i < n; i++) {
    if (repeat[i] && !again) tp.retraces = (tp.retraces ?? 0) + 1;
    again = repeat[i];
  }
  for (let k = 1; k < out.length; k++)
    for (const q of densify([out[k - 1].p, out[k].p], s.maxSegment, false).slice(1)) push(tp, { x: q[0], y: q[1], z, e: out[k].e });
  return out[out.length - 1].p;
}

/** Vase mode: Z rises continuously along each contour, so there is no seam and no stop. */
function buildSpiral(tp: Toolpath, layers: Layer[], s: PrintSettings, start: Vec2): Vec2 {
  let cur: Vec2 = start;
  const h = s.layerHeight;
  let below: Contour[] = [];
  layers.forEach((layer, li) => {
    tp.layerStart.push(tp.points.length);
    const loop = prepareLoop(layer.contours[0], s, cur);
    const ring = [...loop, loop[0]];
    const inside = insideLayers(layer.contours, below, s);
    below = layer.contours;
    if (li === 0) {
      // Flat first layer for adhesion.
      moveTo(tp, loop[0], layer.z, s, undefined, inside);
      for (let i = 1; i < ring.length; i++) push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z, e: true });
    } else {
      const total = polylineLength(ring, false);
      let acc = 0;
      moveTo(tp, loop[0], layer.z - h, s, undefined, inside);
      for (let i = 1; i < ring.length; i++) {
        acc += Math.hypot(ring[i][0] - ring[i - 1][0], ring[i][1] - ring[i - 1][1]);
        push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z - h + (h * acc) / total, e: true });
      }
    }
    if (li === layers.length - 1 && li > 0) {
      // Flat closing lap to level the rim.
      for (let i = 1; i < ring.length; i++) push(tp, { x: ring[i][0], y: ring[i][1], z: layer.z, e: true });
    }
    cur = loop[0];
  });
  return cur;
}

/** Pass direction of layer i: the chosen angle, turned 90° on every other layer if alternating. */
const passAngle = (s: PrintSettings, i: number) => s.fillAngle + (s.fillAlternate && i % 2 ? 90 : 0);

/** True when the segment a→b stays inside the region (even-odd over its loops), sampled every mm. */
function segmentInside(a: Vec2, b: Vec2, region: Contour[]): boolean {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
  for (let k = 1; k < n; k++) {
    const q: Vec2 = [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n];
    let inside = false;
    for (const c of region) if (c.closed && pointInPolygon(q, c.pts)) inside = !inside;
    if (!inside) return false;
  }
  return true;
}

/** `Inside` on the top surface: every sample of the link must lie over a top face (not a side). */
function onTopSurface(hf: HeightField, s: PrintSettings): Inside {
  const minNz = Math.cos((s.surfaceMaxSlope * Math.PI) / 180);
  return (a, b) => {
    const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])));
    for (let k = 1; k < n; k++) {
      const t = hf.top(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n);
      if (!t || t.n[2] < minNz) return false;
    }
    return true;
  };
}

/** Print surface runs (non-planar) raised by dz, with optional C from the normal. */
function printSurfaceRuns(tp: Toolpath, runs: SurfaceRun[], dz: number, s: PrintSettings, cur: Vec2, inside: Inside): Vec2 {
  const end = (r: SurfaceRun, e: 'a' | 'b'): Vec2 => {
    const q = e === 'a' ? r.pts[0] : r.pts[r.pts.length - 1];
    return [q.x, q.y];
  };
  for (const [run, flip, link] of serpentine(runs, cur, end)) {
    const pts = flip ? [...run.pts].reverse() : run.pts;
    const cOf = (q: SurfacePoint) => {
      if (!s.surfaceTilt) return undefined;
      countTiltX(tp, q.n);
      return cFromNormal(q.n);
    };
    moveTo(tp, [pts[0].x, pts[0].y], pts[0].z + dz, s, cOf(pts[0]), inside, link);
    for (const q of pts.slice(1)) push(tp, { x: q.x, y: q.y, z: q.z + dz, e: true, c: cOf(q) });
    cur = [pts[pts.length - 1].x, pts[pts.length - 1].y];
  }
  return cur;
}

const surfaceOptions = (s: PrintSettings, k: number): SurfaceOptions => ({
  spacing: s.wallSpacing,
  angle: passAngle(s, k),
  maxSlope: s.surfaceMaxSlope,
  tolerance: s.tolerance,
  minLength: s.minContourLength,
  inset: s.wallSpacing / 2,
});

/** Height and tool tilt of a point of the current layer. */
type ZAt = (x: number, y: number) => { z: number; c?: number } | null;

/**
 * Print a polyline at the heights given by `zAt`. Planar layers pass a constant height and the
 * vertices are used as they are; blended (non-planar) layers are sampled every `step` mm along
 * the line and simplified in the (distance, z) profile with the contour tolerance.
 */
function printLine(tp: Toolpath, line: Vec2[], zAt: ZAt, s: PrintSettings, step: number, inside: Inside, long: boolean): Vec2 {
  let pts: { p: Vec2; z: number; c?: number }[] = [];
  const add = (p: Vec2) => {
    const h = zAt(p[0], p[1]);
    if (h) pts.push({ p, ...h });
  };
  if (step <= 0) line.forEach(add);
  else {
    add(line[0]);
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1], line[i]];
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
      for (let k = 1; k <= n; k++) add([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
    }
    let d = 0;
    const prof: Vec2[] = pts.map((q, i) => [(d += i ? Math.hypot(q.p[0] - pts[i - 1].p[0], q.p[1] - pts[i - 1].p[1]) : 0), q.z]);
    const keep = new Set(simplifyOpen(prof, s.tolerance).map((k) => prof.indexOf(k)));
    pts = pts.filter((_, i) => keep.has(i));
  }
  if (!pts.length) return line[line.length - 1];
  moveTo(tp, pts[0].p, pts[0].z, s, pts[0].c, inside, long);
  for (const q of pts.slice(1)) push(tp, { x: q.p[0], y: q.p[1], z: q.z, e: true, c: q.c });
  return pts[pts.length - 1].p;
}

/** Top surface height range over the part (faces flatter than the max slope). */
function topRange(hf: HeightField, mesh: MeshData, s: PrintSettings): [number, number] | null {
  const b = computeBounds(mesh);
  const step = Math.max(1, s.wallSpacing / 2);
  const minNz = Math.cos((s.surfaceMaxSlope * Math.PI) / 180);
  let lo = Infinity;
  let hi = -Infinity;
  for (let x = b.min[0] + step / 2; x < b.max[0]; x += step)
    for (let y = b.min[1] + step / 2; y < b.max[1]; y += step) {
      const t = hf.top(x, y);
      if (!t || t.n[2] < minNz) continue;
      lo = Math.min(lo, t.z);
      hi = Math.max(hi, t.z);
    }
  return lo <= hi ? [lo, hi] : null;
}

/**
 * Solid part in serpentine, one continuous path per region from bottom to top.
 *
 * Planar layers are printed full (the whole section, no islands) up to a cut height below the
 * lowest point of the top surface. With the top finish on, the rest is printed in N blended
 * non-planar layers: layer k lies at zCut + (top − zCut)·k/N, so every layer still covers the
 * whole section — only its thickness varies (≈ ½ to 1½ layer heights) — and the last one is
 * the real top surface. A flat top needs no blended layers: the part is all planar.
 */
function buildZigzag(tp: Toolpath, mesh: MeshData, layers: Layer[], s: PrintSettings, start: Vec2) {
  const h = s.layerHeight;
  const w = s.wallSpacing;
  const squash = 1 - s.firstLayerZ / h; // nozzle sits this fraction of a layer below the bead top
  const hf = s.fillTopSurface ? new HeightField(mesh) : null;
  const range = hf ? topRange(hf, mesh, s) : null;
  let n = 0;
  let zCut = Infinity;
  if (range && range[1] - range[0] > 0.25 * h) {
    n = Math.ceil((range[1] - range[0]) / h);
    zCut = Math.max(0, Math.floor((range[0] - 0.5 * h * n) / h + 1e-9) * h);
    n = Math.max(n, Math.round((range[1] - zCut) / h / 1.5)); // keep the thickest spot ≤ ~1½ layers
  }
  let cur: Vec2 = start;
  let prevAngle: number | null = null;
  let printed = 0;
  let lastRegion: Contour[] = layers[0]?.contours.filter((c) => c.closed) ?? [];

  const fillRegionOf = (island: Contour[]) => (s.fillPerimeter ? offsetContours(island, -(s.walls - 0.5) * w) : island);
  const fillOf = (island: Contour[], angle: number) => scanFill(fillRegionOf(island), w, angle, s.fillPerimeter ? w / 4 : w / 2);
  const insideOf = new Map<Contour[], Inside>();
  const insideIsland = (island: Contour[]) => insideOf.get(island) ?? insideOf.set(island, insideRegion(island, s)).get(island)!;
  // Pass direction: fixed (alternating 90° if asked) or automatic — the one of 0/45/90/135°
  // whose serpentine breaks least (excluding the previous layer's direction when alternating).
  const chooseAngle = (parts: Contour[][], li: number) => {
    let angle = passAngle(s, li);
    if (s.fillAutoAngle && parts.length) {
      // Breaks = links that fail the same check used when printing (linkPrintable).
      const breaks = (a: number) =>
        parts.reduce((m, g) => {
          let end: Vec2 | null = null;
          let n = 0;
          for (const [p, flip] of serpentine(fillOf(g, a), cur, (q, e) => q[e])) {
            const [pa, pb] = flip ? [p.b, p.a] : [p.a, p.b];
            if (end && !linkPrintable(end, pa, s, insideIsland(g), true)) n++;
            end = pb;
          }
          return m + n;
        }, 0);
      const cands = [0, 45, 90, 135].map((a) => (s.fillAngle + a) % 180).filter((a) => !s.fillAlternate || prevAngle === null || a !== prevAngle);
      angle = cands.reduce((best, a) => (breaks(a) < breaks(best) ? a : best), cands[0]);
    }
    if (parts.length) prevAngle = angle;
    return angle;
  };

  /** One layer: island by island, outline(s) then serpentine fill, all at heights from zAt. */
  const printLayer = (region: Contour[], li: number, zAt: ZAt, step: number) => {
    tp.layerStart.push(tp.points.length);
    printed++;
    // Islands smaller than ~3×3 beads cannot be filled with passes: they are still printed, as
    // their outline (the mesh is printed whole).
    const all = islands(region);
    const small = all.filter((g) => Math.abs(signedArea(g[0].pts)) < 9 * w * w);
    for (const g of small)
      for (const c of g) {
        const loop = prepareLoop(c, s, cur);
        printLine(tp, [...loop, loop[0]], zAt, s, step, insideRegion(g, s), false);
        cur = loop[0];
      }
    const parts = all.filter((g) => !small.includes(g));
    const angle = chooseAngle(parts, li);
    while (parts.length) {
      const island = parts.splice(nearestIndex(parts.map((p) => p[0]), cur), 1)[0];
      if (s.fillPerimeter)
        for (const wall of buildWalls(island, s.walls, w)) {
          const pending = [...wall];
          while (pending.length) {
            const loop = prepareLoop(pending.splice(nearestIndex(pending, cur), 1)[0], s, cur);
            printLine(tp, [...loop, loop[0]], zAt, s, step, insideIsland(island), false);
            cur = loop[0];
          }
        }
      // Passes keep half a bead from the region edge; with perimeters their ends overlap the
      // perimeter bead by a quarter bead so the two fuse. Links are printed only when verified
      // to stay inside the island (up to 8 beads), otherwise the nozzle travels lifted.
      for (const [p, flip] of serpentine(fillOf(island, angle), cur, (q, e) => q[e])) {
        const [a, b] = flip ? [p.b, p.a] : [p.a, p.b];
        const line = step > 0 ? [a, b] : densify([a, b], s.maxSegment, false);
        cur = printLine(tp, line, zAt, s, step, insideIsland(island), true);
      }
    }
  };

  layers.forEach((layer, li) => {
    const beadTop = layer.z + (h - s.firstLayerZ);
    if (beadTop > zCut + 1e-6) return;
    const region = layer.contours.filter((c) => c.closed);
    if (region.length) lastRegion = region;
    printLayer(region, li, () => ({ z: layer.z }), 0);
  });

  tp.planarLayers = printed;
  if (n > 0 && hf) {
    const step = Math.max(0.5, Math.min(2, w / 4));
    for (let k = 1; k <= n; k++) {
      const f = k / n;
      const zAt: ZAt = (x, y) => {
        const t = hf.top(x, y);
        if (!t) return null;
        const beadTop = zCut + (t.z - zCut) * f;
        const thick = (t.z - zCut) / n;
        // Normal of the blended layer: the top surface slope scaled by f.
        const g = [(-t.n[0] / t.n[2]) * f, (-t.n[1] / t.n[2]) * f];
        const len = Math.hypot(g[0], g[1], 1);
        const nrm: [number, number, number] = [-g[0] / len, -g[1] / len, 1 / len];
        if (s.surfaceTilt) countTiltX(tp, nrm);
        const c = s.surfaceTilt ? cFromNormal(nrm) : undefined;
        return { z: beadTop - thick * squash, c };
      };
      printLayer(lastRegion, layers.length + k, zAt, step);
    }
  }
  tp.layerCount = printed;
}

/**
 * Non-planar: serpentine over the top surface only, printed on top of an existing part. Every
 * point takes the surface height (+ first-layer offset, + one layer height per extra pass).
 */
function buildSurface(mesh: MeshData, s: PrintSettings, start: Vec2): Toolpath {
  const tp: Toolpath = {
    points: [],
    mode: 'surface',
    layerCount: s.surfacePasses,
    layerHeight: s.layerHeight,
    layerStart: [],
    printLength: 0,
    travelLength: 0,
    travels: 0,
    warnings: [],
  };
  const hf = new HeightField(mesh);
  const onTop = onTopSurface(hf, s);
  let cur: Vec2 = start;
  for (let k = 0; k < s.surfacePasses; k++) {
    tp.layerStart.push(tp.points.length);
    const runs = topSurfacePasses(mesh, surfaceOptions(s, k), hf);
    if (!runs.length) {
      tp.warnings.push(msg('w.noTopSurface'));
      break;
    }
    cur = printSurfaceRuns(tp, runs, s.firstLayerZ + k * s.layerHeight, s, cur, onTop);
    if (k === 0) [tp.coverage, tp.topArea] = surfaceCoverage(mesh, runs, s, hf);
  }
  if (tp.coverage !== undefined && tp.coverage < 0.8) tp.warnings.push(msg('w.coverage', { p: Math.round(tp.coverage * 100) }));
  return tp;
}

/** Slope along X that C cannot express (with A −180 / B 0, C tilts only in the Y-Z plane). */
const TILT_X_LIMIT = Math.tan((5 * Math.PI) / 180);
export function countTiltX(tp: Toolpath, n: [number, number, number]) {
  if (Math.abs(n[0]) / Math.max(1e-9, n[2]) > TILT_X_LIMIT) tp.tiltX = (tp.tiltX ?? 0) + 1;
}

/**
 * Real coverage of the top surface: a grid (≤ 2 mm cells) over the part; a cell belongs to the
 * top surface when the surface above it is flatter than the max slope, and it is covered when
 * its centre lies within half a bead of some pass. Overlaps count once and holes show up.
 * Returns [covered share, top surface plan area in mm²].
 */
export function surfaceCoverage(mesh: MeshData, runs: SurfaceRun[], s: PrintSettings, hf: HeightField): [number, number] {
  const b = computeBounds(mesh);
  const cell = Math.max(0.5, Math.min(2, s.wallSpacing / 3));
  const nx = Math.ceil((b.max[0] - b.min[0]) / cell);
  const ny = Math.ceil((b.max[1] - b.min[1]) / cell);
  const minNz = Math.cos((s.surfaceMaxSlope * Math.PI) / 180);
  const top = new Uint8Array(nx * ny);
  const hit = new Uint8Array(nx * ny);
  let total = 0;
  for (let j = 0; j < ny; j++)
    for (let i = 0; i < nx; i++) {
      const t = hf.top(b.min[0] + (i + 0.5) * cell, b.min[1] + (j + 0.5) * cell);
      if (t && t.n[2] >= minNz) {
        top[j * nx + i] = 1;
        total++;
      }
    }
  const r = s.wallSpacing / 2;
  for (const run of runs)
    for (let k = 1; k < run.pts.length; k++) {
      const [ax, ay, bx, by] = [run.pts[k - 1].x, run.pts[k - 1].y, run.pts[k].x, run.pts[k].y];
      const i0 = Math.max(0, Math.floor((Math.min(ax, bx) - r - b.min[0]) / cell));
      const i1 = Math.min(nx - 1, Math.floor((Math.max(ax, bx) + r - b.min[0]) / cell));
      const j0 = Math.max(0, Math.floor((Math.min(ay, by) - r - b.min[1]) / cell));
      const j1 = Math.min(ny - 1, Math.floor((Math.max(ay, by) + r - b.min[1]) / cell));
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const px = b.min[0] + (i + 0.5) * cell, py = b.min[1] + (j + 0.5) * cell;
          const u = l2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
          if (Math.hypot(px - ax - u * dx, py - ay - u * dy) <= r) hit[j * nx + i] = 1;
        }
    }
  let covered = 0;
  for (let c = 0; c < top.length; c++) if (top[c] && hit[c]) covered++;
  return [total ? covered / total : 0, total * cell * cell];
}
