import './style.css';
import { ACCEPTED, combineParts, loadModel, pickPieces, type CellRegion } from './core/loaders';
import { sanitizeProgramName, supportProgramName } from './core/kuka';
import { IDENTITY, applyMatrix, computeBounds, cutByPlane, dropToOrigin, mergeMeshes, meshStats, mulMat3, openEdgeLift, rotX, rotY, rotZ, scale, translate, type Mat3, type MeshData } from './core/mesh';
import type { OrientationCandidate } from './core/orientation';
import { placementOffset } from './core/pipeline';
import { FIXED_ROBOT, validateSettings } from './core/validate';
import { alongPtp, FLANGE_FRAME, KR16, linkTransforms, poseAt, programChangePoses, robotRootFrame, type Joints, type ReachReport } from './core/robot';
import { DEFAULT_PRINT, DEFAULT_ROBOT, type PrintSettings, type RobotSettings } from './core/settings';
import type { Toolpath } from './core/toolpath';
import { cellBodies, type Body, type CollisionReport } from './core/collision';
import type { Zones } from './core/zones';
import type { PartBox } from './core/parts';
import { cutPiece, type SplitPlan } from './core/split';
import { Viewer } from './viewer';
import { applyStatic, getLang, locale, msg, MsgError, setLang, t, tm, type Msg } from './i18n';
import type { WorkerRequest } from './worker';

// ---------- state ----------

const load = <T,>(key: string, def: T): T => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...structuredClone(def), ...JSON.parse(raw) } : structuredClone(def);
  } catch {
    return structuredClone(def);
  }
};
const save = (key: string, v: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
};

const print: PrintSettings = load('gb.print', DEFAULT_PRINT);
if ((print.mode as string) === 'auto') print.mode = 'planar'; // old saved setting
if (typeof print.supports === 'boolean') print.supports = print.supports ? 'inline' : 'none'; // old on/off setting
// The whole mesh is printed: an old saved minimum contour length (10 mm) no longer applies.
try {
  if (localStorage.getItem('gb.meshWhole') !== '1') {
    print.minContourLength = 0;
    localStorage.setItem('gb.meshWhole', '1');
  }
} catch {
  /* storage unavailable */
}
const robot: RobotSettings = load('gb.robot', DEFAULT_ROBOT);
// The cell is fixed (robot, table, controller frames): never take these from old saved settings.
const CELL_KEYS = ['worldBaseX', 'worldBaseY', 'worldBaseZ', 'bedSizeX', 'bedSizeY', 'bedCenterX', 'bedCenterY', 'bedTopZ', 'baseData', 'toolData'] as const;
for (const k of CELL_KEYS) (robot as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULT_ROBOT[k]);
Object.assign(robot, FIXED_ROBOT); // only BASE 1 / TOOL 11 without external axes are modelled
try {
  if (localStorage.getItem('gb.cellVersion') !== '2') {
    robot.originZ = DEFAULT_ROBOT.originZ; // table top moved from a guess (37) to the measured plate (38)
    localStorage.setItem('gb.cellVersion', '2');
  }
} catch {
  /* storage unavailable: defaults already apply */
}

/** One part on the plate: its own file, orientation and position. */
interface Part {
  name: string;
  format: string;
  notes: Msg[];
  /** Original file, kept to save the project. */
  file: { name: string; bytes: ArrayBuffer };
  /** Geometry as read from the file, and the scale applied to it (files in metres: ×1000). */
  original: MeshData;
  scale: number;
  /** The part as printed: original × scale. */
  mesh: MeshData;
  orientations: OrientationCandidate[];
  orientIdx: number;
  manual: Mat3;
  /** Centre in BASE and turn about Z (placement "centre on the point"). */
  x: number;
  y: number;
  rotZ: number;
  /** false until the first analysis has put the part next to the others. */
  placed: boolean;
  /** From a saved project: orientation to pick again once the analysis is done. */
  wantDown?: [number, number, number];
  /** After a cut: the orientation to keep if it prints without supports, otherwise the best one. */
  preferDown?: [number, number, number];
  /** Not printable whole without supports: where to cut it in two (from the analysis). */
  split?: SplitPlan | null;
  /** A piece of a cut part: the file scale and the cuts that made it (scale is then locked). */
  source?: { scale: number; cuts: { n: [number, number, number]; d: number }[] };
}
let parts: Part[] = [];
let active = -1;
const cur = (): Part | undefined => parts[active];
/** Settings are remembered with the position of the first part (the others belong to the plate). */
const saveRobot = () => save('gb.robot', parts[0] ? { ...robot, originX: parts[0].x, originY: parts[0].y, rotationZ: parts[0].rotZ } : robot);
const hasParts = () => parts.length > 0;
let lastSrc = '';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const li = (text: string, className = '') => Object.assign(document.createElement('li'), { textContent: text, className });
const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const viewer = new Viewer($('viewport'));
const offBedOk = $<HTMLInputElement>('offBedOk');
const supportOk = $<HTMLInputElement>('supportOk');
const tiltOk = $<HTMLInputElement>('tiltOk');

// ---------- workers (restarted when a newer request supersedes a running one) ----------

const makeWorker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const pools: Record<'analyze' | 'build', { worker: Worker; busy: boolean }> = {
  analyze: { worker: makeWorker(), busy: false },
  build: { worker: makeWorker(), busy: false },
};
let reqId = 0;

class Superseded extends Error {}

const cancelers: Record<'analyze' | 'build', (() => void) | null> = { analyze: null, build: null };

type RequestBody = WorkerRequest extends infer R ? (R extends unknown ? Omit<R, 'id'> : never) : never;

function run<T>(kind: 'analyze' | 'build', req: RequestBody): Promise<T> {
  const pool = pools[kind];
  if (pool.busy) {
    pool.worker.terminate();
    pool.worker = makeWorker();
    cancelers[kind]?.();
  }
  pool.busy = true;
  const id = ++reqId;
  return new Promise((resolve, reject) => {
    cancelers[kind] = () => reject(new Superseded());
    pool.worker.onmessage = (ev) => {
      if (ev.data.id !== id) return;
      pool.busy = false;
      cancelers[kind] = null;
      if (ev.data.type === 'error') reject(ev.data.msg ? new MsgError(ev.data.msg) : new Error(ev.data.message));
      else resolve(ev.data as T);
    };
    pool.worker.onerror = (e) => {
      pool.busy = false;
      cancelers[kind] = null;
      reject(e.message ? new Error(e.message) : new MsgError(msg('e.worker')));
    };
    pool.worker.postMessage({ ...req, id });
  });
}

/** Text of an error in the current language. */
const errText = (e: unknown): Msg | string => (e instanceof MsgError ? e.m : e instanceof Error ? e.message : String(e));

let busyCount = 0;
async function busy<T>(text: string, fn: () => Promise<T>): Promise<T> {
  busyCount++;
  $('busyText').textContent = text;
  $('busy').hidden = false;
  try {
    return await fn();
  } finally {
    if (--busyCount === 0) $('busy').hidden = true;
  }
}

// ---------- step 1: the parts ----------
// Robot, table and mandrino are fixed in the cell; the user brings the parts to print (meshes
// or BREPs). Every file adds one part with its own orientation and position; all parts are
// printed together, layer by layer. A whole Rhino scene is reduced to the object standing on
// the work table.

let pieceError: Msg | string | undefined;

const fileInput = $<HTMLInputElement>('file');
fileInput.accept = ACCEPTED + ',.kinepath';
const drop = $('drop');
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) openAny(fileInput.files[0]);
  fileInput.value = '';
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('over');
});
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('over');
  const f = e.dataTransfer?.files[0];
  if (f) openAny(f);
});

/** A project file (.kinepath) restores everything; any other file adds a part. */
function openAny(f: File) {
  if (/\.kinepath$/i.test(f.name)) return openProject(f);
  return addPart(f);
}

function setNotes(notes: Msg[], error?: Msg | string) {
  pieceError = error;
  $('modelNotes').replaceChildren(...notes.map((n) => li(tm(n))), ...(error ? [li(tm(error), 'error')] : []));
}

const cellRegion = (): CellRegion => ({
  worldBase: [robot.worldBaseX, robot.worldBaseY, robot.worldBaseZ],
  bedCenter: [robot.bedCenterX, robot.bedCenterY],
  bedSize: [robot.bedSizeX, robot.bedSizeY],
});

/** Reads a file into a part (not analysed yet); throws with a translatable message. */
async function readPart(name: string, bytes: ArrayBuffer): Promise<Part> {
  const model = await busy(t('busy.read', { name }), () => loadModel(new File([bytes], name)));
  const { parts: pieces, note } = pickPieces(model, cellRegion());
  const notes: Msg[] = [];
  if (note) notes.push(note);
  if (!pieces.length) throw new MsgError(note ?? msg('e.noPrintable'));
  // Ignored blocks / curves are the rest of the scene: not worth a note.
  notes.push(...model.notes.filter((n) => n.k !== 'n.blocks' && n.k !== 'n.skipped'));
  const original = combineParts(pieces);
  return {
    name,
    format: model.format,
    notes,
    file: { name, bytes },
    original,
    scale: 1,
    mesh: original,
    orientations: [],
    orientIdx: 0,
    manual: [...IDENTITY] as Mat3,
    x: robot.originX,
    y: robot.originY,
    rotZ: robot.rotationZ,
    placed: false,
  };
}

/** First part on an empty plate: show it at once, before the analysis. */
function showFirstPart(p: Part) {
  $('empty').hidden = true;
  lastSrc = '';
  viewer.setToolpath(null, null, [], [0, 0, 0]);
  viewer.setModel(dropToOrigin(p.mesh), placementOffset(p.mesh, robot), 1);
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, robot.bedTopZ]);
  viewer.fit();
}

async function addPart(file: File) {
  invalidate();
  let part: Part;
  try {
    part = await readPart(file.name, await file.arrayBuffer());
  } catch (e) {
    setNotes(cur()?.notes ?? [], errText(e));
    return;
  }
  if (!hasParts()) {
    robot.programName = sanitizeProgramName(file.name);
    saveRobot();
  }
  parts.push(part);
  selectPart(parts.length - 1);
  if (parts.length === 1) showFirstPart(part);
  fitNext = true;
  await analyze([part]);
}

/** Make part i the one edited by the orientation panel, the position fields and the clicks. */
function selectPart(i: number) {
  active = i;
  const p = cur();
  if (p) Object.assign(robot, { originX: p.x, originY: p.y, rotationZ: p.rotZ });
  renderRobotFields();
  renderParts();
  renderOrientations();
  $('step-orient').hidden = !p?.orientations.length;
  if (p) {
    showModelInfo(p);
    setNotes([...p.notes, ...scaleHints(p)]);
  }
  renderScale();
  renderSplit();
}

// ---------- cut in two pieces ----------
// When a part cannot be printed whole without supports in any orientation, the analysis looks for
// a cut that gives two pieces that can; the plane is shown in the view and one click applies it:
// two parts, each already turned the way it prints best, printed one after the other.


/** Manual cut of the selected part, in the frame of the plate: axis and distance from its start. */
const cutState = { axis: 2 as 0 | 1 | 2, at: 0, touched: false, part: null as Part | null, len: 0 };

/** The selected part as it stands on the plate: rotation from its file, and its extent. */
function placedFrame(p: Part) {
  const M = mulMat3(rotZ(p.rotZ), orientedMatrix(p));
  const bt = computeBounds(applyMatrix(p.mesh, M));
  const mv = (v: number[]) => [0, 1, 2].map((k) => M[k * 3] * v[0] + M[k * 3 + 1] * v[1] + M[k * 3 + 2] * v[2]) as [number, number, number];
  // From the placed part's own frame to BASE (where the view draws it).
  const r = lastBuild;
  const xy = parts.length === 1 && r ? [r.offset[0], r.offset[1]] : [p.x, p.y];
  const base = (q: [number, number, number]): [number, number, number] => [
    q[0] - (bt.min[0] + bt.max[0]) / 2 + xy[0],
    q[1] - (bt.min[1] + bt.max[1]) / 2 + xy[1],
    q[2] - bt.min[2] - print.baseCut + (r?.offset[2] ?? 0),
  ];
  return { M, bt, mv, base };
}

function renderSplit() {
  const p = cur();
  const ready = !!p && p.orientations.length > 0;
  $('cutBox').hidden = !ready;
  viewer.setCutPlane(null);
  if (!p || !ready) return;
  const f = placedFrame(p);
  // Manual cut: back to the middle when another part is selected.
  const len = f.bt.max[cutState.axis] - f.bt.min[cutState.axis];
  // Back to the middle for another part, or when the part was turned (another length).
  if (cutState.part !== p || Math.abs(cutState.len - len) > 0.5) Object.assign(cutState, { part: p, touched: false, at: len / 2 });
  cutState.len = len;
  cutState.at = Math.max(0, Math.min(len, cutState.at));
  $<HTMLSelectElement>('cutAxis').value = String(cutState.axis);
  Object.assign($<HTMLInputElement>('cutPos'), { max: String(len), value: String(cutState.at) });
  Object.assign($<HTMLInputElement>('cutMm'), { max: String(len), value: cutState.at.toFixed(1) });
  $('cutUnit').textContent = t(cutState.axis === 2 ? 'cut.fromBottom' : 'cut.fromStart', { len: Math.round(len) });
  $<HTMLButtonElement>('cutApply').disabled = cutState.at < 1 || cutState.at > len - 1;

  const lift = baseLift(p);
  $('baseRow').hidden = !(lift > 1);
  if (lift > 1) $('baseText').textContent = t('cut.baseText', { z: Math.ceil(lift) });
  const plan = p.split;
  $('splitBox').hidden = !plan;
  const size = 1.3 * Math.max(...[0, 1, 2].map((k) => f.bt.max[k] - f.bt.min[k]));
  if (plan) {
    const pct = Math.round((100 * plan.at) / plan.length);
    $('splitText').textContent = t(plan.valid ? 'split.where' : 'split.wherePartial', { len: Math.round(plan.length), at: Math.round(plan.at), pct });
    $('splitPieces').replaceChildren(
      ...plan.pieces.map((q, i) =>
        li(
          t('split.piece', {
            i: i + 1,
            how: t(q.onCut ? 'split.onCut' : 'split.flip'),
            mode: t(`split.mode.${q.mode}`),
            ok: q.valid ? t('split.ok') : t('split.over', { p: (q.overhang * 100).toFixed(1), n: q.islands }),
          }),
        ),
      ),
    );
  }
  if (!lastBuild) return;
  if (cutState.touched || !plan) {
    if (!cutState.touched) return;
    const c = [0, 1, 2].map((k) => (k === cutState.axis ? f.bt.min[k] + cutState.at : (f.bt.min[k] + f.bt.max[k]) / 2)) as [number, number, number];
    const n: [number, number, number] = [0, 0, 0];
    n[cutState.axis] = 1;
    viewer.setCutPlane(f.base(c), n, size);
    return;
  }
  // Suggested cut (plane given in the frame of the file).
  const b0 = computeBounds(p.mesh);
  const c = [0, 1, 2].map((k) => (k === plan.axis ? plan.d : (b0.min[k] + b0.max[k]) / 2));
  viewer.setCutPlane(f.base(f.mv(c)), f.mv(plan.n), size);
}

/** Cut part p with the plane n·x = d (frame of the file): two pieces, each turned as given. */
async function cutPart(
  p: Part,
  n: [number, number, number],
  d: number,
  downs: [[number, number, number], [number, number, number]],
  mode?: 'spiral' | 'planar',
  /** true: the pieces are turned exactly as given; false: kept only if they print without supports. */
  exact = false,
) {
  const idx = parts.indexOf(p);
  const sides: [number, number, number][] = [[-n[0], -n[1], -n[2]], n];
  const pieces = sides.map((m, i): Part => {
    const dd = i === 0 ? -d : d;
    const mesh = cutPiece(p.mesh, m, dd);
    return {
      ...p,
      name: `${p.name} (${i + 1}/2)`,
      original: mesh,
      mesh,
      scale: 1,
      source: { scale: p.source?.scale ?? p.scale, cuts: [...(p.source?.cuts ?? []), { n: m, d: dd }] },
      orientations: [],
      orientIdx: 0,
      manual: [...IDENTITY] as Mat3,
      ...(exact ? { wantDown: downs[i] } : { preferDown: downs[i] }),
      placed: i === 0, // the first piece keeps the place of the part, the second goes beside it
      split: null,
    };
  }).filter((q) => q.mesh.indices.length > 0);
  if (pieces.length < 2) return;
  parts.splice(idx, 1, ...pieces);
  if (mode && print.mode !== mode) {
    print.mode = mode;
    save('gb.print', print);
    renderPrintFields();
  }
  selectPart(idx);
  fitNext = true;
  await analyze(pieces);
  // The pieces must fit: overlapping or off the table, every part is laid out again.
  if (arrangeNeeded()) {
    arrangeParts();
    selectPart(Math.min(active, parts.length - 1));
    fitNext = true;
    await build();
  }
}

/** Footprint of a part on the plate in BASE: [xMin, yMin, xMax, yMax]. */
function footprint(p: Part): [number, number, number, number] {
  const [w, h] = plannedSize(p);
  return [p.x - w / 2, p.y - h / 2, p.x + w / 2, p.y + h / 2];
}

/** Some parts overlap (closer than a gap that lets the mandrino pass) or leave the table. */
function arrangeNeeded(): boolean {
  if (robot.placement === 'file' || parts.some((p) => !p.orientations.length)) return false;
  const boxes = parts.map(footprint);
  const g = PART_GAP / 2;
  const [bx0, by0] = [robot.bedCenterX - robot.bedSizeX / 2, robot.bedCenterY - robot.bedSizeY / 2];
  const [bx1, by1] = [bx0 + robot.bedSizeX, by0 + robot.bedSizeY];
  if (boxes.some((b) => b[0] < bx0 || b[1] < by0 || b[2] > bx1 || b[3] > by1)) return true;
  return boxes.some((a, i) => boxes.slice(i + 1).some((b) => a[0] - g < b[2] && b[0] - g < a[2] && a[1] - g < b[3] && b[1] - g < a[3]));
}

/**
 * Lays the parts out on the table in the order of the list: side by side along Y (the long side),
 * a new column along X when one is full, PART_GAP apart (less if they would not fit), the whole
 * group centred on the table.
 */
function arrangeParts() {
  const sizes = parts.map(plannedSize);
  const tryGap = (gap: number) => {
    const pos: [number, number][] = [];
    const H = robot.bedSizeY;
    let x = 0;
    let y = 0;
    let col = 0;
    sizes.forEach(([w, h]) => {
      if (y > 0 && y + h > H) {
        x += col + gap;
        y = 0;
        col = 0;
      }
      pos.push([x + w / 2, y + h / 2]);
      y += h + gap;
      col = Math.max(col, w);
    });
    const xs = pos.map((q, i) => [q[0] - sizes[i][0] / 2, q[0] + sizes[i][0] / 2]).flat();
    const ys = pos.map((q, i) => [q[1] - sizes[i][1] / 2, q[1] + sizes[i][1] / 2]).flat();
    const [w, h] = [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
    return { pos, w, h, x0: Math.min(...xs), y0: Math.min(...ys) };
  };
  let lay = tryGap(PART_GAP);
  for (const gap of [40, 20]) if (lay.w > robot.bedSizeX || lay.h > robot.bedSizeY) lay = tryGap(gap);
  parts.forEach((p, i) => {
    p.x = Math.round(lay.pos[i][0] - lay.x0 - lay.w / 2 + robot.bedCenterX);
    p.y = Math.round(lay.pos[i][1] - lay.y0 - lay.h / 2 + robot.bedCenterY);
    p.placed = true;
  });
  saveRobot();
}

function applyManualCut() {
  const p = cur();
  if (!p?.orientations.length) return;
  const f = placedFrame(p);
  const a = cutState.axis;
  // Plane in the frame of the file: (M x)[a] = c  ⇔  row a of M · x = c.
  const n: [number, number, number] = [f.M[a * 3], f.M[a * 3 + 1], f.M[a * 3 + 2]];
  const c = f.bt.min[a] + cutState.at;
  // Both pieces stay turned as the part is now (a horizontal cut: the top piece sits on the cut).
  const O = orientedMatrix(p);
  const down: [number, number, number] = [-O[6], -O[7], -O[8]];
  cutPart(p, n, c, [down, down]);
}
$('cutApply').onclick = applyManualCut;

/** How high the open edge of the placed part rises off the table (0 when it lies flat). */
function baseLift(p: Part): number {
  if (!p.orientations.length) return 0;
  return openEdgeLift(dropToOrigin(applyMatrix(p.mesh, placedFrame(p).M)));
}

/**
 * Cut at the base, keep everything: the part is cut where its open edge stops touching the table;
 * the part above rests on the flat cut, the band below is turned over onto the cut (its curved
 * edge free on top) and printed beside it. The two are joined after printing along the cut.
 */
function applyBaseCut() {
  const p = cur();
  if (!p?.orientations.length) return;
  const lift = Math.ceil(baseLift(p));
  if (lift <= 0) return;
  // This cut keeps everything: the old base cut (which throws material away) is not wanted too.
  if (print.baseCut > 0) {
    print.baseCut = 0;
    save('gb.print', print);
    renderPrintFields();
  }
  const f = placedFrame(p);
  const n: [number, number, number] = [f.M[6], f.M[7], f.M[8]];
  const O = orientedMatrix(p);
  const down: [number, number, number] = [-O[6], -O[7], -O[8]];
  cutPart(p, n, f.bt.min[2] + lift, [[-down[0], -down[1], -down[2]], down], undefined, true);
}
$('baseApply').onclick = applyBaseCut;
$<HTMLSelectElement>('cutAxis').addEventListener('change', (e) => {
  const p = cur();
  cutState.axis = +(e.target as HTMLSelectElement).value as 0 | 1 | 2;
  cutState.touched = true;
  if (p) {
    const f = placedFrame(p);
    cutState.at = (f.bt.max[cutState.axis] - f.bt.min[cutState.axis]) / 2;
  }
  renderSplit();
});
$<HTMLInputElement>('cutPos').addEventListener('input', (e) => {
  Object.assign(cutState, { at: +(e.target as HTMLInputElement).value, touched: true });
  renderSplit();
});
$<HTMLInputElement>('cutMm').addEventListener('change', (e) => {
  const v = parseFloat((e.target as HTMLInputElement).value);
  if (Number.isFinite(v)) Object.assign(cutState, { at: v, touched: true });
  renderSplit();
});

async function applySplit() {
  const p = cur();
  const plan = p?.split;
  if (!p || !plan) return;
  const [lo, hi] = [plan.pieces.find((q) => q.side < 0)!, plan.pieces.find((q) => q.side > 0)!];
  const mode = plan.pieces.every((q) => q.mode === plan.pieces[0].mode) ? plan.pieces[0].mode : undefined;
  await cutPart(p, plan.n, plan.d, [lo.down, hi.down], mode);
}
$('splitApply').onclick = () => applySplit();

// ---------- scale of the selected part ----------
// Drawings sent in metres (1:1000), centimetres or inches arrive far too small: the scale
// multiplies the geometry of the file; position and orientation of the part are kept.

/** A part smaller than 2 mm or larger than 5 m is most likely in the wrong unit. */
function scaleHints(p: Part): Msg[] {
  const size = Math.max(...meshStats(p.mesh).size);
  if (size < 2) return [msg('n.scaleSmall', { s: size.toFixed(3) })];
  if (size > 5000) return [msg('n.scaleBig', { s: Math.round(size) })];
  return [];
}

function renderScale() {
  const p = cur();
  $('scaleRow').hidden = !p;
  if (!p) return;
  const input = $<HTMLInputElement>('scaleInput');
  input.value = String(p.source?.scale ?? p.scale);
  input.classList.remove('invalid');
  // A piece of a cut part keeps the scale of the part it comes from.
  const locked = !!p.source;
  input.disabled = locked;
  document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => (b.disabled = locked));
  $('scaleRow').title = locked ? t('scale.locked') : '';
}

async function setScale(p: Part, s: number) {
  if (!(s > 0) || s === p.scale) return;
  p.scale = s;
  p.mesh = scale(p.original, s);
  // Keep the chosen orientation (found again by its direction) and the position.
  p.wantDown = p.orientations[p.orientIdx]?.down;
  p.orientations = [];
  selectPart(parts.indexOf(p));
  if (parts.length === 1) showFirstPart(p);
  fitNext = true;
  await analyze([p]);
}

$<HTMLInputElement>('scaleInput').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const s = parseFloat(input.value);
  const p = cur();
  if (!p) return;
  if (!(s > 0)) {
    input.classList.add('invalid');
    return;
  }
  input.classList.remove('invalid');
  setScale(p, s);
});
document.querySelectorAll<HTMLButtonElement>('[data-scale]').forEach((b) => {
  b.onclick = () => {
    const p = cur();
    if (p) setScale(p, +b.dataset.scale!);
  };
});

/** Back to the empty plate. */
function clearParts() {
  parts = [];
  active = -1;
  lastBuild = null;
  currentMeta = null;
  invalidate();
  for (const id of ['step-orient', 'step-print', 'step-robot', 'step-out', 'modelInfo', 'vpTools']) $(id).hidden = true;
  $('empty').hidden = false;
  setNotes([]);
  renderParts();
  renderScale();
  renderSplit();
  viewer.setModel(null, [0, 0, 0]);
  viewer.setToolpath(null, null, [], [0, 0, 0]);
  viewer.setZones(null, null, [0, 0, 0]);
  viewer.setCollisions(null);
  viewer.setStartMarker(null);
}

function removePart(i: number) {
  parts.splice(i, 1);
  if (!hasParts()) return clearParts();
  selectPart(Math.min(active, parts.length - 1));
  fitNext = true;
  build();
}

/** Printing order: move part i one place earlier (−1) or later (+1). */
function movePart(i: number, d: -1 | 1) {
  const j = i + d;
  if (j < 0 || j >= parts.length) return;
  [parts[i], parts[j]] = [parts[j], parts[i]];
  if (active === i) active = j;
  else if (active === j) active = i;
  renderParts();
  saveRobot(); // the remembered position is the first part's
  build();
}

function renderParts() {
  $('partList').hidden = !hasParts();
  $('arrangeRow').hidden = !hasParts();
  $<HTMLButtonElement>('saveProject').disabled = !hasParts();
  $('partList').replaceChildren(
    ...parts.map((p, i) => {
      const item = document.createElement('li');
      item.className = i === active ? 'sel' : '';
      // With several parts the number is the printing order.
      const name = Object.assign(document.createElement('span'), { className: 'title', textContent: parts.length > 1 ? `${i + 1}. ${p.name}` : p.name });
      const button = (text: string, title: string, run: () => void, disabled = false) => {
        const b = Object.assign(document.createElement('button'), { className: 'ghost small', textContent: text, title, disabled });
        b.setAttribute('aria-label', title);
        b.onclick = (e) => {
          e.stopPropagation();
          run();
        };
        return b;
      };
      const tools = parts.length > 1 ? [button('↑', t('parts.up'), () => movePart(i, -1), i === 0), button('↓', t('parts.down'), () => movePart(i, 1), i === parts.length - 1)] : [];
      item.append(name, ...tools, button('×', t('parts.remove'), () => removePart(i)));
      item.onclick = () => selectPart(i);
      return item;
    }),
  );
}

function showModelInfo(p: Part) {
  const s = meshStats(p.mesh);
  const rows: [string, string][] = [
    [t('info.format'), p.format],
    [t('info.tris'), s.triangles.toLocaleString(locale())],
    [t('info.size'), `${s.size.map((v) => v.toFixed(1)).join(' × ')} mm`],
    [t('info.closed'), s.openEdges ? t('info.closed.no', { n: s.openEdges }) : t('info.closed.yes')],
    [t('info.volume'), s.openEdges ? '—' : `${(s.volume / 1e6).toFixed(2)} L`],
  ];
  const dl = document.createElement('dl');
  dl.className = 'info';
  for (const [k, v] of rows)
    dl.append(Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v }));
  $('modelInfo').hidden = false;
  $('modelInfo').replaceChildren(dl);
}

// ---------- step 2: orientation (per part) ----------

const orientedMatrix = (p: Part) => mulMat3(p.manual, p.orientations[p.orientIdx].matrix);

/** Size of the part on the plate in its chosen orientation and turn. */
function plannedSize(p: Part): [number, number] {
  const b = computeBounds(applyMatrix(p.mesh, mulMat3(rotZ(p.rotZ), orientedMatrix(p))));
  return [b.max[0] - b.min[0], b.max[1] - b.min[1]];
}

/**
 * Room between two parts: printing the second one, the mandrino (55 mm around the nozzle) must
 * pass beside the first, already finished. The collision check confirms it for the real heights.
 */
const PART_GAP = 70;

/** A new part goes beside the others along Y (the long side of the plate), PART_GAP apart. */
function placeNewPart(p: Part) {
  p.placed = true;
  const others = parts.filter((q) => q !== p && q.placed && q.orientations.length);
  if (!others.length) return;
  const edge = Math.max(...others.map((q) => q.y + plannedSize(q)[1] / 2));
  p.x = others[0].x;
  p.y = Math.round(edge + PART_GAP + plannedSize(p)[1] / 2);
}

/** Analyse the orientations of some parts (all by default), then compute the path. */
async function analyze(which: Part[] = parts) {
  invalidate();
  if (!hasParts()) return;
  if (!checkSettings()) {
    for (const id of ['step-print', 'step-robot', 'step-out']) $(id).hidden = false;
    return;
  }
  for (const p of which) {
    if (!parts.includes(p)) continue;
    const m = p.mesh;
    let res: { orientations: OrientationCandidate[]; split: SplitPlan | null };
    try {
      res = await busy(t('busy.orient'), () => run<{ orientations: OrientationCandidate[]; split: SplitPlan | null }>('analyze', { type: 'analyze', mesh: m, print: { ...print }, downs: p.wantDown ? [p.wantDown] : [] }));
    } catch (e) {
      if (!(e instanceof Superseded) && parts.includes(p)) setNotes(p.notes, errText(e));
      return;
    }
    if (!parts.includes(p)) continue;
    p.orientations = res.orientations;
    p.split = res.split;
    // A saved project brings its orientation back (with its manual turns); otherwise the best one.
    const want = p.wantDown ?? p.preferDown;
    let k = want ? res.orientations.findIndex((o) => o.down[0] * want[0] + o.down[1] * want[1] + o.down[2] * want[2] > 0.999) : -1;
    // A piece of a cut keeps its turn only when it prints without supports that way.
    if (k >= 0 && !p.wantDown && !res.orientations[k].valid) k = -1;
    p.preferDown = undefined;
    if (k >= 0) p.orientIdx = k;
    else {
      p.orientIdx = 0;
      p.manual = [...IDENTITY] as Mat3;
    }
    p.wantDown = undefined;
    if (!p.placed) placeNewPart(p);
  }
  for (const id of ['step-orient', 'step-print', 'step-robot', 'step-out']) $(id).hidden = false;
  selectPart(Math.max(0, Math.min(active, parts.length - 1)));
  return build();
}

function renderOrientations() {
  // The section is folded by default: its title shows the orientation in use.
  const p = cur();
  const list = p?.orientations ?? [];
  const sel = p?.orientIdx ?? 0;
  const label = list[sel] ? t('orient.chosen', { label: tm(list[sel].label) }) : '';
  $('orientChosen').textContent = parts.length > 1 && p ? `${p.name} · ${label}` : label;
  $('orientList').replaceChildren(
    ...list.map((o, i) => {
      const item = document.createElement('li');
      if (i === sel) item.className = 'sel';
      const facts = [
        t('orient.h', { h: o.height.toFixed(0) }),
        t('orient.base', { a: (o.baseArea / 100).toFixed(0) }),
        t('orient.overhang', { p: (o.overhangRatio * 100).toFixed(1) }),
        o.maxIslands > 1 ? t('orient.islands', { n: o.maxIslands }) : t('orient.oneLoop'),
      ].join(' · ');
      const notes = o.notes.map((n) => escapeHtml(tm(n)));
      item.innerHTML =
        `<span class="title">${escapeHtml(tm(o.label))}</span>` +
        (i === 0 ? `<span class="badge">${escapeHtml(t('orient.best'))}</span>` : `<span class="muted">#${i + 1}</span>`) +
        `<span class="sub">${facts}${notes.length ? '<br>' + notes.join(' · ') : ''}</span>`;
      item.onclick = () => {
        if (!p) return;
        p.orientIdx = i;
        p.manual = [...IDENTITY] as Mat3;
        renderOrientations();
        build();
      };
      return item;
    }),
  );
}

document.querySelectorAll<HTMLButtonElement>('[data-rot]').forEach((b) => {
  b.onclick = () => {
    const p = cur();
    if (!p) return;
    const r = { x: rotX, y: rotY, z: rotZ }[b.dataset.rot as 'x' | 'y' | 'z'](90);
    p.manual = mulMat3(r, p.manual);
    build();
  };
});

// ---------- project: save / open (.kinepath) ----------
// Parts (original files), their orientation and position, and all the settings in one file.

interface ProjectFile {
  app: 'KinePath';
  version: 1;
  print: PrintSettings;
  robot: Partial<RobotSettings>;
  parts: {
    name: string;
    data: string;
    down: [number, number, number] | null;
    manual: Mat3;
    x: number;
    y: number;
    rotZ: number;
    scale?: number;
    /** Pieces of a cut part: the cuts applied after scaling. */
    cuts?: { n: [number, number, number]; d: number }[];
  }[];
}

const toBase64 = (b: ArrayBuffer) => {
  const u = new Uint8Array(b);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

function saveProject() {
  if (!hasParts()) return;
  const own = Object.fromEntries(Object.entries(robot).filter(([k]) => !(CELL_KEYS as readonly string[]).includes(k)));
  const data: ProjectFile = {
    app: 'KinePath',
    version: 1,
    print: { ...print },
    robot: own,
    parts: parts.map((p) => ({
      name: p.name,
      data: toBase64(p.file.bytes),
      down: p.orientations[p.orientIdx]?.down ?? null,
      manual: p.manual,
      x: p.x,
      y: p.y,
      rotZ: p.rotZ,
      scale: p.source?.scale ?? p.scale,
      cuts: p.source?.cuts,
    })),
  };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = sanitizeProgramName(robot.programName) + '.kinepath';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function openProject(f: File) {
  let data: ProjectFile;
  try {
    data = JSON.parse(await f.text());
    if (data.app !== 'KinePath' || !Array.isArray(data.parts)) throw new Error();
  } catch {
    setNotes(cur()?.notes ?? [], msg('e.project'));
    return;
  }
  clearParts();
  Object.assign(print, structuredClone(DEFAULT_PRINT), data.print);
  Object.assign(robot, structuredClone(DEFAULT_ROBOT), data.robot);
  for (const k of CELL_KEYS) (robot as unknown as Record<string, unknown>)[k] = structuredClone(DEFAULT_ROBOT[k]);
  Object.assign(robot, FIXED_ROBOT);
  save('gb.print', print);
  saveRobot();
  renderPrintFields();
  const loaded: Part[] = [];
  try {
    for (const sp of data.parts) {
      const p = await readPart(sp.name, fromBase64(sp.data));
      Object.assign(p, { manual: sp.manual, x: sp.x, y: sp.y, rotZ: sp.rotZ, placed: true, wantDown: sp.down ?? undefined });
      if (sp.scale && sp.scale > 0 && sp.scale !== 1) Object.assign(p, { scale: sp.scale, mesh: scale(p.original, sp.scale) });
      if (sp.cuts?.length) {
        const m = sp.cuts.reduce((acc, c) => cutByPlane(acc, c.n, c.d), p.mesh);
        Object.assign(p, { original: m, mesh: m, scale: 1, source: { scale: sp.scale ?? 1, cuts: sp.cuts } });
      }
      loaded.push(p);
    }
  } catch (e) {
    setNotes([], errText(e));
    return;
  }
  parts = loaded;
  if (!hasParts()) return;
  selectPart(0);
  showFirstPart(parts[0]);
  fitNext = true;
  await analyze();
}

$('saveProject').onclick = saveProject;
$('openProject').onclick = () => $<HTMLInputElement>('projectFile').click();
$<HTMLInputElement>('projectFile').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  if (input.files?.[0]) openProject(input.files[0]);
  input.value = '';
});

// ---------- steps 3/4: settings forms ----------

type Field =
  | { group: string }
  | {
      key: string;
      label: string;
      kind: 'number' | 'text' | 'select' | 'check';
      step?: number;
      min?: number;
      options?: [string, string][];
      full?: boolean;
      /** Shown but not editable (see FIXED_ROBOT). */
      locked?: boolean;
    };

const PRINT_FIELDS: Field[] = [
  {
    key: 'mode',
    label: 'f.mode',
    kind: 'select',
    full: true,
    options: [
      ['planar', 'mode.planar'],
      ['spiral', 'mode.spiral'],
      ['zigzag', 'mode.zigzag'],
      ['surface', 'mode.surface'],
    ],
  },
  { key: 'layerHeight', label: 'f.layerHeight', kind: 'number', step: 0.1, min: 0.1 },
  { key: 'layerRamp', label: 'f.layerRamp', kind: 'number', step: 5, min: 0 },
  { key: 'adaptiveLayers', label: 'f.adaptiveLayers', kind: 'check', full: true },
  { key: 'toolTilt', label: 'f.toolTilt', kind: 'check', full: true },
  { key: 'maxTilt', label: 'f.maxTilt', kind: 'number', step: 5, min: 0 },
  {
    key: 'supports',
    label: 'f.supports',
    kind: 'select',
    full: true,
    options: [
      ['none', 'sup.none'],
      ['inline', 'sup.inline'],
      ['separate', 'sup.separate'],
    ],
  },
  { key: 'baseCut', label: 'f.baseCut', kind: 'number', step: 1, min: 0 },
  { key: 'walls', label: 'f.walls', kind: 'number', step: 1, min: 1 },
  { key: 'wallSpacing', label: 'f.wallSpacing', kind: 'number', step: 0.5, min: 0.1 },
  { key: 'tolerance', label: 'f.tolerance', kind: 'number', step: 0.05, min: 0 },
  { key: 'maxSegment', label: 'f.maxSegment', kind: 'number', step: 1, min: 0 },
  { key: 'minContourLength', label: 'f.minContourLength', kind: 'number', step: 1, min: 0 },
  { key: 'maxBridge', label: 'f.maxBridge', kind: 'number', step: 1, min: 0 },
  { key: 'travelLift', label: 'f.travelLift', kind: 'number', step: 1, min: 0 },
  { key: 'overhangAngle', label: 'f.overhangAngle', kind: 'number', step: 1, min: 1 },
  { key: 'thinWallMax', label: 'f.thinWallMax', kind: 'number', step: 1, min: 0 },
  {
    key: 'latticeRetrace',
    label: 'f.latticeRetrace',
    kind: 'select',
    full: true,
    options: [
      ['off', 'lattice.off'],
      ['print', 'lattice.print'],
    ],
  },
  { group: 'g.serpentine' },
  { key: 'fillAngle', label: 'f.fillAngle', kind: 'number', step: 15 },
  { key: 'fillAlternate', label: 'f.fillAlternate', kind: 'check', full: true },
  { key: 'fillAutoAngle', label: 'f.fillAutoAngle', kind: 'check', full: true },
  { key: 'fillPerimeter', label: 'f.fillPerimeter', kind: 'check', full: true },
  { key: 'fillTopSurface', label: 'f.fillTopSurface', kind: 'check', full: true },
  { key: 'surfacePasses', label: 'f.surfacePasses', kind: 'number', step: 1, min: 1 },
  { key: 'surfaceMaxSlope', label: 'f.surfaceMaxSlope', kind: 'number', step: 5, min: 1 },
  { key: 'surfaceTilt', label: 'f.surfaceTilt', kind: 'check', full: true },
  { group: 'g.start' },
  {
    key: 'startMode',
    label: 'f.startMode',
    kind: 'select',
    full: true,
    options: [
      ['auto', 'start.auto'],
      ['point', 'start.point'],
    ],
  },
  { key: 'startX', label: 'f.startX', kind: 'number', step: 5 },
  { key: 'startY', label: 'f.startY', kind: 'number', step: 5 },
];

const ROBOT_FIELDS: Field[] = [
  { group: 'g.program' },
  { key: 'programName', label: 'f.programName', kind: 'text', full: true },
  { key: 'toolNumber', label: 'TOOL_DATA[n]', kind: 'number', step: 1, locked: true },
  { key: 'baseNumber', label: 'BASE_DATA[n]', kind: 'number', step: 1, locked: true },
  { key: 'velCP', label: '$VEL.CP (m/s)', kind: 'number', step: 0.01 },
  { key: 'advance', label: '$ADVANCE', kind: 'number', step: 1 },
  { group: 'g.toolOrient' },
  { key: 'a', label: 'A (°)', kind: 'number', step: 1 },
  { key: 'b', label: 'B (°)', kind: 'number', step: 1 },
  { key: 'c', label: 'C (°)', kind: 'number', step: 1 },
  { group: 'g.external' },
  { key: 'e1', label: 'E1', kind: 'number', step: 1, locked: true },
  { key: 'e2', label: 'E2', kind: 'number', step: 1, locked: true },
  { key: 'e3', label: 'E3', kind: 'number', step: 1, locked: true },
  { key: 'e4', label: 'E4', kind: 'number', step: 1, locked: true },
  { group: 'g.extruder' },
  { key: 'extruderAnout', label: 'f.extruderAnout', kind: 'number', step: 1 },
  { key: 'extruderSpeedAnout', label: 'f.extruderSpeedAnout', kind: 'number', step: 1 },
  { key: 'extruderSpeed', label: 'f.extruderSpeed', kind: 'number', step: 0.1 },
  { key: 'extruderDelay', label: 'f.extruderDelay', kind: 'number', step: 0.5 },
  { key: 'useHoming', label: 'f.useHoming', kind: 'check', full: true },
  {
    key: 'linApprox',
    label: 'f.linApprox',
    kind: 'select',
    full: true,
    options: [
      ['C_DIS', 'approx.cdis'],
      ['none', 'approx.none'],
    ],
  },
  { group: 'g.placement' },
  {
    key: 'placement',
    label: 'f.placement',
    kind: 'select',
    full: true,
    options: [
      ['origin', 'place.origin'],
      ['file', 'place.file'],
    ],
  },
  { key: 'originX', label: 'f.originX', kind: 'number', step: 1 },
  { key: 'originY', label: 'f.originY', kind: 'number', step: 1 },
  { key: 'originZ', label: 'f.originZ', kind: 'number', step: 0.5 },
  { key: 'rotationZ', label: 'f.rotationZ', kind: 'number', step: 15 },
  { group: 'g.safe' },
  ...[1, 2, 3, 4, 5, 6].map((n): Field => ({ key: `safeAxes.${n - 1}`, label: `A${n} (°)`, kind: 'number', step: 1 })),
];

function getPath(obj: Record<string, unknown>, key: string): unknown {
  const [k, i] = key.split('.');
  return i === undefined ? obj[k] : (obj[k] as unknown[])[+i];
}
function setPath(obj: Record<string, unknown>, key: string, v: unknown) {
  const [k, i] = key.split('.');
  if (i === undefined) obj[k] = v;
  else (obj[k] as unknown[])[+i] = v;
}

/** Number fields currently holding no valid number: they block the export. */
const fieldErrors = new Set<string>();

function renderFields(host: HTMLElement, fields: Field[], target: Record<string, unknown>, onChange: (key: string) => void) {
  // Redrawn inputs show the real (valid) internal values again: their pending errors are gone,
  // and the result must be recomputed for those values (the old one was discarded).
  let cleared = false;
  for (const f of fields) if (!('group' in f)) cleared = fieldErrors.delete(f.key) || cleared;
  if (cleared && hasParts()) queueMicrotask(buildSoon);
  host.replaceChildren(
    ...fields.map((f) => {
      if ('group' in f) return Object.assign(document.createElement('div'), { className: 'group', textContent: t(f.group) });
      const wrap = document.createElement('label');
      wrap.className = 'field' + (f.full ? ' full' : '') + (f.kind === 'check' ? ' check' : '');
      const val = getPath(target, f.key);
      let input: HTMLInputElement | HTMLSelectElement;
      if (f.kind === 'select') {
        input = document.createElement('select');
        for (const [v, label] of f.options!) input.append(new Option(t(label), v, false, v === val));
      } else {
        input = document.createElement('input');
        input.type = f.kind === 'check' ? 'checkbox' : f.kind;
        if (f.kind === 'check') input.checked = Boolean(val);
        else input.value = String(val);
        input.step = 'any'; // free decimals; `f.step` only drives the spinner arrows below
        if (f.min !== undefined) input.min = String(f.min);
        if (f.locked) {
          input.disabled = true;
          wrap.title = t('h.fixedCell');
        }
        if (f.kind === 'number' && f.step !== undefined) {
          const step = f.step;
          input.addEventListener('keydown', (e) => {
            const k = (e as KeyboardEvent).key;
            if (k !== 'ArrowUp' && k !== 'ArrowDown') return;
            e.preventDefault();
            const v = parseFloat(input.value) || 0;
            input.value = String(+(v + (k === 'ArrowUp' ? step : -step)).toFixed(4));
            input.dispatchEvent(new Event('change'));
          });
        }
      }
      input.addEventListener('change', () => {
        let v: unknown;
        if (f.kind === 'check') v = (input as HTMLInputElement).checked;
        else if (f.kind === 'number') {
          const n = parseFloat(input.value);
          if (!Number.isFinite(n)) {
            // An empty or invalid field must not leave an old program downloadable.
            fieldErrors.add(f.key);
            input.classList.add('invalid');
            invalidate();
            return;
          }
          fieldErrors.delete(f.key);
          input.classList.remove('invalid');
          v = f.min !== undefined ? Math.max(f.min, n) : n;
        } else v = input.value;
        setPath(target, f.key, v);
        onChange(f.key);
      });
      if (f.kind === 'check') wrap.append(input, t(f.label));
      else wrap.append(t(f.label), input);
      return wrap;
    }),
  );
}

/**
 * Every change (model, orientation, parameters) makes the current .src obsolete at once: the
 * download stays disabled until the latest computation has finished and passed every check.
 * `buildSeq` numbers the computations so a late result of an older one is ignored.
 */
let buildSeq = 0;
function invalidate() {
  buildSeq++;
  lastSrc = '';
  // A confirmation refers to one result: any change asks for it again.
  offBedOk.checked = false;
  supportOk.checked = false;
  tiltOk.checked = false;
  updateExport();
}

let buildTimer = 0;
const buildSoon = () => {
  invalidate();
  clearTimeout(buildTimer);
  buildTimer = window.setTimeout(build, 400);
};

function renderPrintFields() {
  renderFields($('printFields'), PRINT_FIELDS, print as unknown as Record<string, unknown>, (key) => {
    save('gb.print', print);
    if (ANALYSIS_KEYS.includes(key)) analyze();
    else buildSoon();
  });
}
const ANALYSIS_KEYS = ['overhangAngle', 'layerHeight', 'thinWallMax'];
renderPrintFields();

function renderRobotFields() {
  renderFields($('robotFields'), ROBOT_FIELDS, robot as unknown as Record<string, unknown>, () => {
    // Position fields belong to the part being edited.
    const p = cur();
    if (p) Object.assign(p, { x: robot.originX, y: robot.originY, rotZ: robot.rotationZ });
    saveRobot();
    buildSoon();
  });
}
renderRobotFields();

$('resetRobot').onclick = () => {
  const name = robot.programName;
  Object.assign(robot, structuredClone(DEFAULT_ROBOT), { programName: name });
  saveRobot();
  renderRobotFields();
  buildSoon();
};

// ---------- step 5: build ----------

interface BuildMsg {
  xyz: Float32Array;
  ext: Uint8Array;
  cc: Float32Array;
  ptp: Uint8Array;
  sup: Uint8Array;
  prog: Uint8Array;
  meta: Toolpath;
  src: string;
  supportSrc?: string;
  offset: [number, number, number];
  mesh: MeshData;
  min: [number, number, number];
  max: [number, number, number];
  reach: ReachReport;
  errors: Msg[];
  offBed: boolean;
  support: { islands: number; overhang: number } | null;
  zones: Zones;
  collision: CollisionReport | null;
}

/**
 * What goes to the computation. One part: the part and its orientation, exactly as before.
 * Several parts: each one oriented, turned and placed in BASE, merged into one mesh that is
 * printed layer by layer (the computation re-centres it on its own centre).
 */
function assembly(): { mesh: MeshData; matrix: Mat3; robot: RobotSettings; name: string; notes: Msg[]; boxes?: PartBox[] } {
  const name = parts.map((p) => p.name).join(' + ');
  if (parts.length === 1) {
    const p = parts[0];
    return { mesh: p.mesh, matrix: orientedMatrix(p), robot: structuredClone({ ...robot, originX: p.x, originY: p.y, rotationZ: p.rotZ }), name, notes: [] };
  }
  const boxes: PartBox[] = [];
  const placed = parts.map((p) => {
    const m = dropToOrigin(applyMatrix(p.mesh, mulMat3(rotZ(p.rotZ), orientedMatrix(p))));
    const [x, y] = robot.placement === 'file' ? placementOffset(p.mesh, robot) : [p.x, p.y];
    const b = computeBounds(m);
    boxes.push([b.min[0] + x, b.min[1] + y, b.max[0] + x, b.max[1] + y]);
    return translate(m, x, y, 0);
  });
  // Overlapping parts are a blocking error of the build (pipeline.ts).
  const notes: Msg[] = [];
  const all = mergeMeshes(placed);
  const b = computeBounds(all);
  const r = { ...robot, placement: 'origin' as const, originX: (b.min[0] + b.max[0]) / 2, originY: (b.min[1] + b.max[1]) / 2, rotationZ: 0 };
  return { mesh: all, matrix: [...IDENTITY] as Mat3, robot: structuredClone(r), name, notes, boxes };
}
/** Warnings about the arrangement of the parts (overlaps), shown with the result. */
let assemblyNotes: Msg[] = [];

let currentMeta: Toolpath | null = null;
let lastBuild: BuildMsg | null = null;
/** Re-frame the camera only on a new model/orientation, not on every tweak. */
let fitNext = true;

async function build(): Promise<BuildMsg | null> {
  invalidate();
  if (!hasParts()) return null;
  if (!checkSettings()) return null;
  const pending = parts.filter((p) => !p.orientations.length);
  if (pending.length) return (await analyze(pending)) ?? null;
  const seq = buildSeq;
  const job = assembly();
  let r: BuildMsg;
  try {
    r = await busy(t('busy.path'), () =>
      run<BuildMsg>('build', { type: 'build', mesh: job.mesh, matrix: job.matrix, print: { ...print }, robot: job.robot, sourceName: job.name, bodies, partBoxes: job.boxes }),
    );
  } catch (e) {
    if (!(e instanceof Superseded) && seq === buildSeq) $('warnings').replaceChildren(li(tm(errText(e))));
    return null;
  }
  if (seq !== buildSeq) return null;
  assemblyNotes = job.notes;
  lastSrc = r.src;
  currentMeta = r.meta;
  lastBuild = r;
  viewer.setModel(r.mesh, r.offset, parseFloat($<HTMLInputElement>('opacity').value));
  viewer.setBed(robot.bedSizeX, robot.bedSizeY, [robot.bedCenterX, robot.bedCenterY, robot.bedTopZ]);
  viewer.setToolpath(r.xyz, r.ext, r.meta.layerStart, r.offset, r.sup);
  viewer.setStartMarker(r.xyz.length ? [r.xyz[0] + r.offset[0], r.xyz[1] + r.offset[1], r.xyz[2] + r.offset[2]] : null);
  viewer.setZones(r.zones, r.mesh, r.offset);
  viewer.setCollisions(
    r.collision?.points.length
      ? Float32Array.from(r.collision.points.flatMap((i) => [0, 1, 2].map((k) => r.xyz[i * 3 + k] + r.offset[k])))
      : null,
  );
  const slider = $<HTMLInputElement>('layerSlider');
  slider.max = String(Math.max(0, r.meta.layerStart.length - 1));
  slider.value = slider.max;
  updateLayerLabel();
  $('vpTools').hidden = false;
  if (fitNext) viewer.fit();
  fitNext = false;
  resetSim(r);
  renderStats(r);
  renderSplit(); // the cut plane follows the part as it is now placed
  if (!$('srcPreview').hidden) showPreview();
  return r;
}

function updateLayerLabel() {
  if (!currentMeta) return;
  const i = +$<HTMLInputElement>('layerSlider').value;
  const n = currentMeta.layerStart.length;
  // Z of the layer in BASE: height of its first printed point (with several parts printed one
  // after the other the layer numbers run on, the heights start again from the table).
  let z = (lastBuild?.offset[2] ?? 0) + print.firstLayerZ + i * currentMeta.layerHeight;
  const r = lastBuild;
  if (r) {
    const end = i + 1 < n ? currentMeta.layerStart[i + 1] : r.xyz.length / 3;
    for (let k = currentMeta.layerStart[i]; k < end; k++)
      if (r.ext[k]) {
        z = r.xyz[k * 3 + 2] + r.offset[2];
        break;
      }
  }
  const blended = currentMeta.planarLayers !== undefined && i >= currentMeta.planarLayers;
  $('layerOut').textContent =
    currentMeta.mode === 'surface'
      ? t('layer.pass', { i: i + 1, n })
      : blended
        ? t('layer.blend', { i: i + 1, n })
        : t('layer.z', { i: i + 1, n, z: z.toFixed(1) });
}
$<HTMLInputElement>('layerSlider').addEventListener('input', (e) => {
  const layer = +(e.target as HTMLInputElement).value;
  updateLayerLabel();
  if (lastBuild && currentMeta) {
    const n = lastBuild.xyz.length / 3;
    const end = layer + 1 < currentMeta.layerStart.length ? currentMeta.layerStart[layer + 1] : n;
    stopSim();
    setSimIndex(Math.max(0, end - 1));
  }
});

// ---------- simulation: the robot runs the LIN moves of the .src ----------

let simIndex = 0;
let simPos = 0; // mm travelled along the path
let simCum = new Float64Array(0); // cumulative path length per point
let playing = false;
let lastFrame = 0;

function resetSim(r: BuildMsg) {
  const n = r.xyz.length / 3;
  simCum = new Float64Array(n);
  for (let i = 1; i < n; i++)
    simCum[i] = simCum[i - 1] + Math.hypot(r.xyz[i * 3] - r.xyz[i * 3 - 3], r.xyz[i * 3 + 1] - r.xyz[i * 3 - 2], r.xyz[i * 3 + 2] - r.xyz[i * 3 - 1]);
  const slider = $<HTMLInputElement>('simSlider');
  slider.max = String(Math.max(0, n - 1));
  stopSim();
  setSimIndex(n - 1);
}

/** Jump to LIN i. `keepPos` keeps the fractional distance already travelled (used while playing). */
function setSimIndex(i: number, keepPos = false) {
  if (!lastBuild) return;
  const r = lastBuild;
  const n = r.xyz.length / 3;
  simIndex = Math.max(0, Math.min(n - 1, i));
  if (!keepPos) simPos = simCum[simIndex] ?? 0;
  $<HTMLInputElement>('simSlider').value = String(simIndex);
  viewer.showProgress(simIndex);
  const o = r.offset;
  const p: [number, number, number] = [r.xyz[simIndex * 3] + o[0], r.xyz[simIndex * 3 + 1] + o[1], r.xyz[simIndex * 3 + 2] + o[2]];
  const cPt = r.cc[simIndex];
  const c = Number.isFinite(cPt) ? cPt : robot.c;
  const q = poseAt(p, Number.isFinite(cPt) ? { ...robot, c } : robot, robotPose);
  if (q) showRobot(q);
  const f = (v: number) => v.toFixed(1);
  const move = r.ext[simIndex] ? t('sim.print') : r.prog[simIndex] ? t('sim.prog.start') : r.ptp[simIndex] ? t('sim.partChange') : t('sim.travel');
  $('simReadout').innerHTML =
    `${r.ptp[simIndex] ? 'PTP' : 'LIN'} ${simIndex + 1} / ${n} · ${move}\nX ${f(p[0])}  Y ${f(p[1])}  Z ${f(p[2])}  A ${robot.a}  B ${robot.b}  C ${f(c)}\n` +
    (q ? q.map((v, k) => `A${k + 1} ${v.toFixed(1)}°`).join('  ') : `<span class="bad">${escapeHtml(t('sim.unreachable'))}</span>`);
}

function stopSim() {
  playing = false;
  simPtp = null;
  $('playBtn').textContent = t('sim.play');
}

/** Axis speed shown for the PTP moves at ×1 (°/s of the axis that moves most). */
const SIM_PTP_SPEED = 60;
/**
 * A PTP being played: the axes move through `poses` (change of part: straight across; next
 * program: safe position, homing, safe position, first point), then the path goes on at `to`.
 */
let simPtp: { poses: Joints[]; at: number; to: number; program: boolean } | null = null;

/** The PTP that reaches point i, as the robot runs it (null if the axes are not known). */
function ptpInto(r: BuildMsg, i: number): Joints[] | null {
  const j = r.reach.joints;
  const q0 = Array.from(j.subarray(i * 6 - 6, i * 6)) as Joints;
  const q1 = Array.from(j.subarray(i * 6, i * 6 + 6)) as Joints;
  if (!Number.isFinite(q0[0]) || !Number.isFinite(q1[0])) return null;
  return r.prog[i] ? programChangePoses(q0, q1, robot) : [q0, q1];
}

function tick(now: number) {
  if (!playing || !lastBuild) return;
  const r = lastBuild;
  // rAF timestamps can precede the click time: never step backwards, cap long pauses.
  const dt = Math.max(0, Math.min(0.1, (now - lastFrame) / 1000));
  lastFrame = now;
  const speed = +$<HTMLSelectElement>('simSpeed').value;
  if (simPtp) {
    simPtp.at += dt * SIM_PTP_SPEED * speed;
    const s = alongPtp(simPtp.poses, simPtp.at);
    if (s.done) {
      const to = simPtp.to;
      simPtp = null;
      setSimIndex(to);
    } else {
      showRobot(s.q);
      const step = simPtp.program ? t(`sim.prog.${s.leg === 0 ? 'safe' : s.leg === simPtp.poses.length - 2 ? 'start' : 'home'}`) : t('sim.partChange');
      $('simReadout').innerHTML = `PTP · ${escapeHtml(step)}\n` + s.q.map((v, k) => `A${k + 1} ${v.toFixed(1)}°`).join('  ');
    }
    requestAnimationFrame(tick);
    return;
  }
  simPos += dt * robot.velCP * 1000 * speed;
  let i = simIndex;
  while (i < simCum.length - 1 && simCum[i + 1] <= simPos) {
    i++;
    // A PTP is played in the axes, as the robot moves: the path waits at the point before it.
    const poses = r.ptp[i] ? ptpInto(r, i) : null;
    if (poses) {
      if (i - 1 !== simIndex) setSimIndex(i - 1, true);
      simPtp = { poses, at: 0, to: i, program: !!r.prog[i] };
      requestAnimationFrame(tick);
      return;
    }
  }
  if (i !== simIndex) setSimIndex(i, true);
  if (i >= simCum.length - 1) stopSim();
  else requestAnimationFrame(tick);
}

$('playBtn').onclick = () => {
  if (!lastBuild) return;
  if (playing) return stopSim();
  if (simIndex >= simCum.length - 1) setSimIndex(0);
  playing = true;
  $('playBtn').textContent = t('sim.pause');
  lastFrame = performance.now();
  requestAnimationFrame(tick);
};
$<HTMLInputElement>('simSlider').addEventListener('input', (e) => {
  stopSim();
  setSimIndex(+(e.target as HTMLInputElement).value);
});
$<HTMLInputElement>('opacity').addEventListener('input', (e) => viewer.setModelOpacity(+(e.target as HTMLInputElement).value));
$('fitBtn').onclick = () => viewer.fit();
$<HTMLInputElement>('zonesToggle').addEventListener('change', (e) => viewer.setZonesVisible((e.target as HTMLInputElement).checked));

// ---------- fixed robot cell ----------

let robotPose: Joints = [...robot.safeAxes] as Joints;
/** Arm and mandrino samples for the collision check (available once the cell is loaded). */
let bodies: Body[] | undefined;
function showRobot(q: Joints) {
  robotPose = q;
  const f = robotRootFrame(robot);
  viewer.setRobotPose(f.p, f.R, linkTransforms(q), KR16.flangeHome, FLANGE_FRAME);
}
viewer
  .loadCell('./cell')
  .then(({ parts, bin }) => {
    bodies = cellBodies(parts, bin, robot.toolData.slice(0, 3) as [number, number, number]);
    showRobot(robotPose);
    if (!hasParts()) viewer.fit();
    else buildSoon(); // a result computed before the cell was loaded had no collision check
  })
  .catch(() => setNotes([], msg('e.cell')));

// ---------- click-to-place / click-to-start ----------

let pick: 'none' | 'place' | 'start' = 'none';
function setPick(mode: 'none' | 'place' | 'start') {
  pick = pick === mode ? 'none' : mode;
  viewer.setPickMode(pick);
  $('placeBtn').classList.toggle('active', pick === 'place');
  $('startBtn').classList.toggle('active', pick === 'start');
  $('pickHint').hidden = pick === 'none';
  $('pickHint').textContent = pick === 'place' ? t('pick.place') : t('pick.start');
}
$('placeBtn').onclick = () => setPick('place');
$('startBtn').onclick = () => setPick('start');
// ---------- drag parts on the table ----------

/** The part whose footprint contains (x, y) in BASE (the selected one first). */
function partAt(x: number, y: number): Part | undefined {
  if (robot.placement === 'file') return undefined;
  const inside = (p: Part) => {
    if (!p.orientations.length) return false;
    const b = footprint(p);
    return x >= b[0] && x <= b[2] && y >= b[1] && y <= b[3];
  };
  const c = cur();
  return c && inside(c) ? c : parts.find(inside);
}

function fits(b: [number, number, number, number]) {
  const [x0, y0] = [robot.bedCenterX - robot.bedSizeX / 2, robot.bedCenterY - robot.bedSizeY / 2];
  return b[0] >= x0 && b[1] >= y0 && b[2] <= x0 + robot.bedSizeX && b[3] <= y0 + robot.bedSizeY;
}

let drag: { p: Part; from: [number, number]; at: [number, number] } | null = null;
viewer.grab = (x, y) => {
  const p = partAt(x, y);
  if (!p) return false;
  if (p !== cur()) selectPart(parts.indexOf(p));
  drag = { p, from: [x, y], at: [p.x, p.y] };
  viewer.setDragBox(footprint(p), fits(footprint(p)));
  return true;
};
viewer.onDrag = (x, y) => {
  if (!drag) return;
  drag.p.x = Math.round(drag.at[0] + x - drag.from[0]);
  drag.p.y = Math.round(drag.at[1] + y - drag.from[1]);
  viewer.setDragBox(footprint(drag.p), fits(footprint(drag.p)));
};
viewer.onDrop = () => {
  if (!drag) return;
  const { p, at } = drag;
  drag = null;
  viewer.setDragBox(null);
  if (Math.hypot(p.x - at[0], p.y - at[1]) < 1) return;
  Object.assign(robot, { placement: 'origin', originX: p.x, originY: p.y });
  saveRobot();
  renderRobotFields();
  build();
};
$('arrangeBtn').onclick = () => {
  if (!hasParts() || parts.some((p) => !p.orientations.length)) return;
  arrangeParts();
  selectPart(Math.max(0, active));
  fitNext = true;
  build();
};

viewer.onPick = (mode, x, y) => {
  if (mode === 'place') {
    Object.assign(robot, { placement: 'origin', originX: Math.round(x), originY: Math.round(y) });
    const p = cur();
    if (p) Object.assign(p, { x: robot.originX, y: robot.originY });
    saveRobot();
    renderRobotFields();
  } else {
    Object.assign(print, { startMode: 'point', startX: Math.round(x), startY: Math.round(y) });
    save('gb.print', print);
    renderPrintFields();
  }
  setPick('none');
  build();
};

function fmtTime(sec: number) {
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** The figures of the result, shown in step 5 and in the report: [label, value, wide]. */
function statsItems(r: BuildMsg): [string, string, boolean?][] {
  const tp = r.meta;
  const seconds = (tp.printLength + tp.travelLength) / (robot.velCP * 1000) + tp.travels * robot.extruderDelay;
  const kb = new Blob([r.src]).size / 1024;
  const stops = ' ' + (tp.travels ? t('r.stops', { n: tp.travels }) : tp.retraces && print.latticeRetrace !== 'print' ? t('r.noJumps') : t('r.noStops')) + (tp.partChanges ? ' ' + t('r.partChanges', { n: tp.partChanges }) : '') + (tp.retraces ? ' ' + t(print.latticeRetrace === 'print' ? 'r.retracesPrint' : 'r.retraces', { n: tp.retraces }) : '');
  const items: [string, string, boolean?][] = [
    [t('r.mode'), t(`r.mode.${tp.mode}`) + stops, true],
    [t('r.layers'), `${tp.layerCount}`],
    [t('r.points'), (r.xyz.length / 3).toLocaleString(locale())],
    [t('r.length'), `${(tp.printLength / 1000).toFixed(2)} m`],
    [t('r.time'), fmtTime(seconds)],
    [
      t('r.extent'),
      `X ${r.min[0].toFixed(1)} … ${r.max[0].toFixed(1)}\nY ${r.min[1].toFixed(1)} … ${r.max[1].toFixed(1)}\nZ ${r.min[2].toFixed(1)} … ${r.max[2].toFixed(1)}`,
      true,
    ],
    [
      t('r.axes'),
      r.reach.unreachable === r.xyz.length / 3
        ? t('r.axes.none')
        : r.reach.jointMin.map((v, i) => `A${i + 1} ${v.toFixed(0)} … ${r.reach.jointMax[i].toFixed(0)}°`).join('\n'),
      true,
    ],
    [t('r.file'), kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb.toFixed(0)} KB`],
    ...(tp.coverage !== undefined
      ? ([[t('r.coverage'), t('r.coverage.v', { p: Math.round(tp.coverage * 100), a: Math.round((tp.topArea ?? 0) / 100) })]] as [string, string][])
      : []),
    [t('r.material'), `${((tp.printLength * print.layerHeight * print.wallSpacing) / 1e6).toFixed(2)} L`],
  ];
  return items;
}

function renderStats(r: BuildMsg) {
  const tp = r.meta;
  $('stats').replaceChildren(
    ...statsItems(r).map(([k, v, wide]) => {
      const d = document.createElement('div');
      d.className = 'stat' + (wide ? ' wide' : '');
      const val = Object.assign(document.createElement('div'), { className: 'v' + (wide ? ' small' : ''), textContent: v });
      val.style.whiteSpace = 'pre-line';
      d.append(Object.assign(document.createElement('div'), { className: 'k', textContent: k }), val);
      return d;
    }),
  );
  $('warnings').replaceChildren(...r.errors.map((w) => li(tm(w), 'blocked')), ...[...assemblyNotes, ...tp.warnings].map((w) => li(tm(w))));
  updateExport();
}

/** Parameters outside their admitted values, found before computing: nothing was computed. */
let settingsErrors: Msg[] = [];

/** Checks the parameters before any computation; on errors they are listed and the export stays blocked. */
function checkSettings(): boolean {
  settingsErrors = validateSettings(print, robot);
  if (settingsErrors.length) {
    $('warnings').replaceChildren(...settingsErrors.map((w) => li(tm(w), 'blocked')));
    updateExport();
  }
  return !settingsErrors.length;
}

/** Why the current result may not be exported (empty = export allowed). */
function exportBlocks(): string[] {
  const r = lastBuild;
  if (!r || !lastSrc) return [];
  const out: string[] = [];
  if (r.errors.length) out.push(t('out.blockedErrors'));
  // Without the cell the collision check could not run: never export unchecked.
  if (!r.collision) out.push(t('out.blockedNoCell'));
  // A path the robot cannot follow must not reach the controller.
  if (r.reach.unreachable > 0 || r.reach.outOfLimits > 0) out.push(t('out.blocked'));
  if (r.offBed && !offBedOk.checked) out.push(t('out.blockedOffBed'));
  if (r.support && !supportOk.checked) out.push(t('out.blockedSupport'));
  if (tiltNeedsConfirm() && !tiltOk.checked) out.push(t('out.blockedTilt'));
  return out;
}

/** Tilt on, but some points have a slope along X that C cannot follow. */
const tiltNeedsConfirm = () => !!lastBuild && (print.surfaceTilt || print.toolTilt) && (lastBuild.meta.tiltX ?? 0) > 0;

function updateExport() {
  const ready = !!lastSrc && !!lastBuild && fieldErrors.size === 0;
  const blocks = exportBlocks();
  $<HTMLButtonElement>('download').disabled = !ready || blocks.length > 0;
  $('downloadSup').hidden = !lastBuild?.supportSrc;
  $<HTMLButtonElement>('downloadSup').disabled = !ready || blocks.length > 0;
  $<HTMLButtonElement>('reportBtn').disabled = !ready;
  $('offBedRow').hidden = !(ready && lastBuild!.offBed);
  $('supportRow').hidden = !(ready && lastBuild!.support);
  if (lastBuild?.support) $('supportLabel').textContent = t('out.supportConfirm', { n: lastBuild.support.islands, p: lastBuild.support.overhang });
  $('tiltRow').hidden = !(ready && tiltNeedsConfirm());
  if (lastBuild) $('tiltLabel').textContent = t('out.tiltConfirm', { n: lastBuild.meta.tiltX ?? 0 });
  const fields = [...fieldErrors].map((k) => li(t('v.field', { field: `f.${k.split('.')[0]}` }), 'blocked'));
  if (settingsErrors.length) fields.push(li(t('out.blockedParams'), 'blocked'));
  $('exportState').replaceChildren(...fields, ...(ready ? blocks.map((b) => li(b, 'blocked')) : hasParts() && !fields.length ? [li(t('out.stale'))] : []));
}

offBedOk.addEventListener('change', updateExport);
supportOk.addEventListener('change', updateExport);
tiltOk.addEventListener('change', updateExport);
/** Supports in a separate program: the file to print before the part. */
$('downloadSup').onclick = () => {
  const text = lastBuild?.supportSrc;
  if (!text || !lastSrc || exportBlocks().length) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  a.download = supportProgramName(robot.programName) + '.src';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
$('download').onclick = () => {
  if (!lastSrc || !lastBuild || exportBlocks().length) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lastSrc], { type: 'text/plain' }));
  a.download = sanitizeProgramName(robot.programName) + '.src';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

function showPreview() {
  const lines = lastSrc.split('\r\n');
  $('srcPreview').textContent =
    lines.length > 140 ? [...lines.slice(0, 110), `; … ${lines.length - 134} righe …`, ...lines.slice(-24)].join('\n') : lines.join('\n');
}
// ---------- printable report (save as PDF from the print dialog) ----------

/** Every check with its outcome, for the report: [what, ok / confirmed / failed]. */
function reportChecks(r: BuildMsg): [string, 'ok' | 'confirmed' | 'bad'][] {
  const keys = new Set(r.errors.map((e) => e.k));
  const ok = (b: boolean) => (b ? 'ok' : 'bad') as 'ok' | 'bad';
  const conf = (needed: boolean, given: boolean) => (!needed ? 'ok' : given ? 'confirmed' : 'bad') as 'ok' | 'confirmed' | 'bad';
  return [
    [t('rep.c.params'), ok(!settingsErrors.length && !fieldErrors.size)],
    [t('rep.c.reach'), ok(!r.reach.unreachable && !r.reach.outOfLimits)],
    [t('rep.c.table'), ok(!keys.has('v.belowTable'))],
    [t('rep.c.collision'), ok(!!r.collision && !r.collision.count)],
    [t('rep.c.ptp'), ok(!!r.collision && !r.collision.ptp.length)],
    [t('rep.c.bed'), conf(r.offBed, offBedOk.checked)],
    [t('rep.c.support'), conf(!!r.support, supportOk.checked)],
    [t('rep.c.tilt'), conf(tiltNeedsConfirm(), tiltOk.checked)],
  ];
}

function openReport() {
  const r = lastBuild;
  if (!r || !lastSrc) return;
  const w = window.open('', '_blank');
  if (!w) return;
  const e = escapeHtml;
  const img = viewer.snapshot();
  const mark = { ok: '✓', confirmed: '✓*', bad: '✗' };
  const rows = (items: [string, string][]) => items.map(([k, v]) => `<tr><th>${e(k)}</th><td>${e(v).replace(/\n/g, '<br>')}</td></tr>`).join('');
  const partRows = parts.map((p) => {
    const s = meshStats(p.mesh).size.map((v) => v.toFixed(0)).join(' × ');
    const o = p.orientations[p.orientIdx];
    const where = robot.placement === 'file' ? t('rep.fromFile') : `X ${p.x} · Y ${p.y} · ${p.rotZ}°`;
    return `<tr><th>${e(p.name)}</th><td>${e(s)} mm · ${e(o ? tm(o.label) : '')} · ${e(where)}</td></tr>`;
  });
  const settings: [string, string][] = [
    [t('f.mode'), t(`r.mode.${r.meta.mode}`)],
    [t('f.layerHeight'), `${print.layerHeight}`],
    [t('f.wallSpacing'), `${print.wallSpacing}`],
    [t('f.walls'), `${print.walls}`],
    ['$VEL.CP', `${robot.velCP} m/s`],
    ['TOOL / BASE', `TOOL_DATA[${robot.toolNumber}] · BASE_DATA[${robot.baseNumber}]`],
    [t('f.linApprox'), robot.linApprox === 'none' ? t('approx.none') : t('approx.cdis')],
  ];
  const warnings = [...r.errors, ...assemblyNotes, ...r.meta.warnings].map((m) => `<li>${e(tm(m))}</li>`).join('');
  const checks = reportChecks(r)
    .map(([k, v]) => `<li class="${v}"><b>${mark[v]}</b> ${e(k)}</li>`)
    .join('');
  const name = sanitizeProgramName(robot.programName);
  w.document.write(`<!doctype html><html lang="${getLang()}"><head><meta charset="utf-8"><title>${e(name)} — KinePath</title>
<style>
body{font:13px/1.45 system-ui,-apple-system,'Segoe UI',sans-serif;color:#16202b;margin:24px;}
h1{font-size:20px;margin:0}h2{font-size:14px;margin:18px 0 6px;border-bottom:1px solid #dde2e8;padding-bottom:3px}
.sub{color:#5f6d7b;margin:2px 0 12px}img{width:100%;max-height:340px;object-fit:contain;background:#12161c;border-radius:6px}
table{border-collapse:collapse;width:100%}th,td{text-align:left;vertical-align:top;padding:3px 8px 3px 0;border-bottom:1px solid #eef1f4}th{width:34%;font-weight:600}
ul{margin:0;padding-left:18px}.checks{list-style:none;padding:0;columns:2}.checks li{margin:2px 0}.ok b{color:#1f9d73}.confirmed b{color:#a15c00}.bad b{color:#c0264a}
.note{color:#5f6d7b;font-size:11px;margin-top:4px}@media print{body{margin:12mm}h2{break-after:avoid}}
</style></head><body>
<h1>${e(name)}.src</h1>
<p class="sub">${e(t('rep.subtitle', { date: new Date().toLocaleString(locale()) }))}</p>
<img src="${img}" alt="">
<h2>${e(t('rep.parts'))}</h2><table>${partRows.join('')}</table>
<h2>${e(t('rep.checks'))}</h2><ul class="checks">${checks}</ul>
<p class="note">${e(t('rep.confirmedNote'))}</p>
<h2>${e(t('rep.result'))}</h2><table>${rows(statsItems(r).map(([k, v]) => [k, v]))}</table>
<h2>${e(t('rep.settings'))}</h2><table>${rows(settings)}</table>
${warnings ? `<h2>${e(t('rep.warnings'))}</h2><ul>${warnings}</ul>` : ''}
<p class="note">${e(t('rep.dry'))}</p>
</body></html>`);
  w.document.close();
  // The print dialog (where "Save as PDF" is) opens once the image is laid out.
  let printed = false;
  const go = () => {
    if (printed) return;
    printed = true;
    w.focus();
    w.print();
  };
  w.onload = go;
  setTimeout(go, 600);
}
$('reportBtn').onclick = openReport;

$('previewBtn').onclick = () => {
  const pre = $('srcPreview');
  pre.hidden = !pre.hidden;
  if (!pre.hidden) showPreview();
};

// ---------- language ----------

function applyLanguage() {
  applyStatic();
  $('langToggle').textContent = getLang() === 'it' ? 'EN' : 'IT';
  renderPrintFields();
  renderRobotFields();
  renderOrientations();
  renderParts();
  const p = cur();
  if (p) showModelInfo(p);
  setNotes(p ? [...p.notes, ...scaleHints(p)] : [], pieceError);
  renderScale();
  renderSplit();
  if (lastBuild) {
    renderStats(lastBuild);
    setSimIndex(simIndex, true);
    updateLayerLabel();
  }
  if (settingsErrors.length) $('warnings').replaceChildren(...settingsErrors.map((w) => li(tm(w), 'blocked')));
  $('playBtn').textContent = t(playing ? 'sim.pause' : 'sim.play');
  window.kinepathWarn?.(true);
  updateExport();
  if (pick !== 'none') $('pickHint').textContent = pick === 'place' ? t('pick.place') : t('pick.start');
}
$('langToggle').onclick = () => {
  setLang(getLang() === 'it' ? 'en' : 'it');
  applyLanguage();
};
applyLanguage();

// ---------- browser check ----------
// Some browsers (Brave Shields, script blockers) let the page load but stop the computation
// worker: the site then looks dead. The warning lives in index.html so it works even without us.
declare global {
  interface Window {
    kinepathStarted?: boolean;
    kinepathWarn?: (refresh?: boolean) => void;
  }
}
window.kinepathStarted = true;
{
  const probe = makeWorker();
  const fail = () => {
    probe.terminate();
    window.kinepathWarn?.();
  };
  const timer = setTimeout(fail, 15000);
  probe.onmessage = (ev) => {
    if (ev.data?.type !== 'pong') return;
    clearTimeout(timer);
    probe.terminate();
  };
  probe.onerror = () => {
    clearTimeout(timer);
    fail();
  };
  probe.postMessage({ type: 'ping', id: 0 });
}
