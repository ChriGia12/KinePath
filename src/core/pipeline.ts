// End-to-end build used by the worker: orient → slice → toolpath → KUKA .src.
import { msg, SettingsError, type Msg } from '../i18n';
import { validateSettings } from './validate';
import { supportProgramName, writeKukaSrc } from './kuka';
import { applyMatrix, computeBounds, cutBelow, dropToOrigin, mergeMeshes, mulMat3, openEdgeLift, rotZ, translate, type Mat3, type MeshData } from './mesh';
import type { PrintSettings, RobotSettings } from './settings';
import { reachReport, type ReachReport } from './robot';
import { buildPlanar, buildToolpath, sliceForPrint, spiralRange, type PathPoint, type Toolpath } from './toolpath';
import { riskZones, type Zones } from './zones';
import { boxesOverlap, joinInTurn, printPartsInTurn, splitByBoxes, type PartBox } from './parts';
import { tiltAlongWalls } from './tilt';
import { evaluateOrientation, OVERHANG_LIMIT, supportOk } from './orientation';
import { collisionReport, type Body, type CollisionReport } from './collision';
import { applyEdits, pathSignature, type PathEdits } from './edits';
import { importedToolpath, type ImportedPath } from './imported';
import { resolveStrategy } from './strategy';

export interface BuildResult {
  toolpath: Toolpath;
  src: string;
  /** Supports in a separate program: its .src (print it before the part). */
  supportSrc?: string;
  /** Translation from the local (centered, z=0) frame to the robot BASE frame. */
  offset: [number, number, number];
  /** Oriented mesh in local frame, for the viewer. */
  mesh: MeshData;
  /** Toolpath extents in the BASE frame. */
  min: [number, number, number];
  max: [number, number, number];
  reach: ReachReport;
  /** Problems of the result that block the export (path below the plate). */
  errors: Msg[];
  /** The path leaves the work table: export needs an explicit confirmation. */
  offBed: boolean;
  /** Overhangs or islands that need support in this orientation: export needs a confirmation. */
  support: { islands: number; overhang: number } | null;
  /** Overhangs, islands in mid-air and too-thin walls, drawn on the part (part frame). */
  zones: Zones;
  /** Arm / mandrino against plate and printed part (null when the cell bodies are not given). */
  collision: CollisionReport | null;
  /** Signature of the path as computed (before any change made by hand). */
  baseSig: string;
  /** Changes made by hand applied to the path; `editsDropped`: they no longer fitted it. */
  edited: number;
  editsDropped: boolean;
}

const mergeOrNull = (meshes: MeshData[]) => (meshes.length ? mergeMeshes(meshes) : null);

/** Where the local part frame lands in BASE coordinates. */
export function placementOffset(original: MeshData, r: RobotSettings): [number, number, number] {
  if (r.placement === 'origin') return [r.originX, r.originY, r.originZ];
  // Keep the Rhino world position (bbox center XY, bottom Z) and convert world → BASE.
  const b = computeBounds(original);
  return [
    (b.min[0] + b.max[0]) / 2 - r.worldBaseX,
    (b.min[1] + b.max[1]) / 2 - r.worldBaseY,
    b.min[2] - r.worldBaseZ,
  ];
}

export function runBuild(
  original: MeshData,
  matrix: Mat3,
  print: PrintSettings,
  robot: RobotSettings,
  sourceName: string,
  /** Sampled arm and mandrino (collision.ts cellBodies); without them no collision check. */
  bodies?: Body[],
  /** Several parts: their footprints in BASE, in printing order (one part after the other). */
  partBoxes?: PartBox[],
  /** Changes made by hand to the path (edits.ts): applied only to the path they were made on. */
  edits?: PathEdits,
  /**
   * Parts that are a path made elsewhere (imported.ts), in the frame of `original`: one per part
   * (null for a part to compute). `original` then holds, for them, the beads of the path.
   */
  paths?: (ImportedPath | null)[],
): BuildResult {
  // Parameters are checked before any geometry: an out-of-range value (e.g. thousands of passes)
  // must not start a computation that could take minutes or exhaust memory.
  const invalid = validateSettings(print, robot);
  if (invalid.length) throw new SettingsError(invalid);
  const turn = mulMat3(rotZ(robot.rotationZ), matrix);
  const turned = applyMatrix(original, turn);
  let mesh = dropToOrigin(turned);
  const multi = !!partBoxes && partBoxes.length > 1;
  const imported = !!paths?.some(Boolean);
  // A path made elsewhere is taken as it is: nothing of it is cut away.
  if (imported && print.baseCut > 0) print = { ...print, baseCut: 0 };
  // Base cut (own parts only, chosen on purpose): what is below the plane is not printed.
  if (print.baseCut > 0) mesh = translate(cutBelow(mesh, print.baseCut), 0, 0, -print.baseCut);
  const offset = placementOffset(original, robot);
  const start: [number, number] | undefined =
    print.startMode === 'point' ? [print.startX - offset[0], print.startY - offset[1]] : undefined;
  /**
   * An imported path in the part frame: turned and centred like its beads. Centred on a point,
   * its lowest point is one first-layer height above the table; kept where the file has it,
   * every Z of the file is kept (the world → BASE shift is in `offset`).
   */
  const place = (path: ImportedPath): Toolpath => {
    const b = computeBounds(turned);
    const [cx, cy] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2];
    const n = path.xyz.length / 3;
    const pts: PathPoint[] = [];
    let low = Infinity;
    for (let i = 0; i < n; i++) {
      const [x, y, z] = [path.xyz[i * 3], path.xyz[i * 3 + 1], path.xyz[i * 3 + 2]];
      const q = { x: turn[0] * x + turn[1] * y + turn[2] * z - cx, y: turn[3] * x + turn[4] * y + turn[5] * z - cy, z: turn[6] * x + turn[7] * y + turn[8] * z, e: !!path.ext[i] };
      low = Math.min(low, q.z);
      pts.push(q);
    }
    const dz = robot.placement === 'file' && !multi ? -b.min[2] : print.firstLayerZ - low;
    for (const q of pts) q.z += dz;
    return importedToolpath(pts, print, path.hasExtruder);
  };
  const given = paths?.map((p) => (p ? place(p) : null));
  // What is left to check as a solid (overhangs, risk zones): the parts that are not a path.
  const solid = !imported ? mesh : multi ? mergeOrNull(splitByBoxes(mesh, partBoxes!, offset).filter((m, k) => m && !paths![k]) as MeshData[]) : null;
  // A contour print without an explicit choice: how to lay it is decided from the part (with
  // several parts, each part decides for itself in buildToolpath).
  const choice = multi || imported ? null : resolveStrategy(mesh, print);
  if (choice) print = choice.settings;
  const summary = print.mode === 'surface' || imported ? undefined : sliceForPrint(mesh, print);
  // Supports in a separate program: the part and the supports become two paths, printed one
  // after the other (supports first). Not with several parts or rings following the surface.
  const wantSeparate = print.supports === 'separate';
  const separate = wantSeparate && !multi && !!summary && summary.supportLayers > 0 && !(print.adaptiveLayers && (print.mode === 'planar' || print.mode === 'spiral'));
  let toolpath: Toolpath;
  let partPath: Toolpath | null = null;
  let supportPath: Toolpath | null = null;
  if (separate && summary) {
    const partLayers = summary.layers.map((l) => ({ ...l, contours: l.contours.filter((c) => !c.support) }));
    const spiral = spiralRange(partLayers);
    partPath = buildToolpath(mesh, print, { ...summary, layers: partLayers, supportLayers: 0, spiral, singleLoop: spiral !== null }, start);
    supportPath = { points: [], mode: 'planar', layerCount: 0, layerHeight: print.layerHeight, layerStart: [], printLength: 0, travelLength: 0, travels: 0, warnings: [] };
    const supLayers = summary.layers.map((l) => ({ z: l.z, contours: l.contours.filter((c) => c.support) })).filter((l) => l.contours.length);
    buildPlanar(supportPath, supLayers, print, start ?? [0, 0]);
    supportPath.layerCount = supLayers.length;
    toolpath = joinInTurn(supportPath, partPath);
    toolpath.warnings.push(msg('w.supportsSeparate', { n: supLayers.length, name: supportProgramName(robot.programName) }));
  } else {
    // Several parts: one after the other, each one whole (parts.ts).
    toolpath = multi ? printPartsInTurn(mesh, print, partBoxes!, offset, start, given) : given?.[0] ?? buildToolpath(mesh, print, summary, start);
    if (wantSeparate && summary?.supportLayers) toolpath.warnings.push(msg('w.supportsInline'));
  }
  if (choice?.why) toolpath.warnings.push(choice.why);
  if (print.baseCut > 0) toolpath.warnings.push(msg('w.baseCut', { z: print.baseCut }));
  const zones: Zones = solid && !imported ? riskZones(solid, summary?.layers ?? null, print) : { overhang: new Uint32Array(0), islands: new Float32Array(0), thin: new Float32Array(0) };
  const placed: RobotSettings = { ...robot, originX: offset[0], originY: offset[1], originZ: offset[2] };
  // Tool leaning along the walls (every mode but the surface one, which has its own tilt).
  if (print.toolTilt && toolpath.mode !== 'surface' && !imported) tiltAlongWalls(toolpath, mesh, print);
  // Changes made by hand: only on the very path they were made on, and before every check.
  const baseSig = pathSignature(toolpath);
  let edited = 0;
  let editsDropped = false;
  if (edits?.edits.length) {
    if (partPath || edits.sig !== baseSig) {
      editsDropped = true;
      toolpath.warnings.push(msg(partPath ? 'w.editsSeparate' : 'w.editsDropped'));
    } else {
      edited = applyEdits(toolpath, edits.edits);
      if (edited) toolpath.warnings.push(msg('w.edited', { n: edited }));
    }
  }
  const src = writeKukaSrc(partPath ?? toolpath, placed, { sourceName, layerHeight: print.layerHeight });
  const supportSrc = supportPath?.points.length
    ? writeKukaSrc(supportPath, { ...placed, programName: supportProgramName(robot.programName) }, { sourceName, layerHeight: print.layerHeight })
    : undefined;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of toolpath.points) {
    const v = [p.x + offset[0], p.y + offset[1], p.z + offset[2]];
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], v[k]);
      max[k] = Math.max(max[k], v[k]);
    }
  }
  const errors: Msg[] = [];
  // Overlapping parts would be printed into each other: never exportable.
  partBoxes?.forEach((a, i) =>
    partBoxes.slice(i + 1).forEach((b, k) => {
      if (boxesOverlap(a, b)) errors.push(msg('v.partsOverlap', { a: i + 1, b: i + 2 + k }));
    }),
  );
  const bx0 = robot.bedCenterX - robot.bedSizeX / 2;
  const by0 = robot.bedCenterY - robot.bedSizeY / 2;
  const offBed = min[0] < bx0 || min[1] < by0 || max[0] > bx0 + robot.bedSizeX || max[1] > by0 + robot.bedSizeY;
  if (offBed) toolpath.warnings.push(msg('w.offBed', { sx: robot.bedSizeX, sy: robot.bedSizeY, cx: robot.bedCenterX, cy: robot.bedCenterY }));
  // The plate is fixed: a point below its top would drive the nozzle into it — never exportable.
  const below = toolpath.points.filter((p) => p.z + offset[2] < robot.bedTopZ - 1e-6).length;
  if (below) errors.push(msg('v.belowTable', { n: below, z: robot.bedTopZ, min: min[2].toFixed(1) }));

  const basePts = new Float64Array(toolpath.points.length * 3);
  toolpath.points.forEach((p, i) => basePts.set([p.x + offset[0], p.y + offset[1], p.z + offset[2]], i * 3));
  const cs = Float64Array.from(toolpath.points, (p) => p.c ?? NaN);
  const ptpAt = Uint8Array.from(toolpath.points, (p) => (p.ptp ? 1 : 0));
  const programAt = Uint8Array.from(toolpath.points, (p) => (p.program ? 1 : 0));
  const reach = reachReport(basePts, robot, cs, 20, ptpAt);
  if (reach.unreachable)
    toolpath.warnings.push(msg('w.unreachable', { n: reach.unreachable }));
  if (reach.outOfLimits) toolpath.warnings.push(msg('w.limits', { n: reach.outOfLimits }));
  if (reach.jumps) toolpath.warnings.push(msg('w.jumps', { n: reach.jumps }));
  if (toolpath.tiltX) toolpath.warnings.push(msg('w.tiltX', { n: toolpath.tiltX }));
  // An open edge (hull rim, bowl lip) that touches the table only in part: say where to cut.
  const lift = imported ? 0 : openEdgeLift(mesh);
  if (lift > 1 && print.supports === 'none') toolpath.warnings.push(msg('w.openEdgeLift', { z: Math.ceil(lift) }));
  // Same hard checks as the orientation ranking, on the orientation actually printed. The
  // surface mode prints on top of an existing part: its overhangs are not printed here.
  let support: BuildResult['support'] = null;
  if (toolpath.mode !== 'surface' && solid) {
    const e = evaluateOrientation(solid, [0, 0, -1], print.overhangAngle, print.layerHeight, print.thinWallMax);
    if (!supportOk(e)) {
      const overhang = e.totalArea ? (e.overhangArea / e.totalArea) * 100 : 0;
      support = { islands: e.unsupported, overhang: +overhang.toFixed(1) };
      toolpath.warnings.push(msg('w.support', { n: e.unsupported, p: support.overhang, lim: OVERHANG_LIMIT * 100, a: print.overhangAngle }));
    }
  }
  // Collisions block the export: arm or mandrino into the plate or the part cannot be confirmed.
  let collision: CollisionReport | null = null;
  if (bodies?.length) {
    const ext = Uint8Array.from(toolpath.points, (p) => (p.e ? 1 : 0));
    collision = collisionReport(basePts, ext, reach.joints, bodies, robot, print, { first: reach.first, last: reach.last }, 3, ptpAt, cs, programAt);
    if (collision.count)
      errors.push(msg('v.collision', { n: collision.count, lin: collision.first + 1, what: `c.${collision.what}`, body: collision.body }));
    for (const c of collision.ptp) errors.push(msg('v.ptpCollision', { move: `c.move.${c.move}`, what: `c.${c.what}`, body: c.body }));
  }
  return { toolpath, src, supportSrc, offset, mesh, min, max, reach, errors, offBed, support, zones, collision, baseSig, edited, editsDropped };
}
