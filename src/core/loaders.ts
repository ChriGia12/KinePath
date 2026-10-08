// File importers → parts in mm, Z up. Mesh formats via three.js loaders; Rhino .3dm via
// rhino3dm (meshes + cached render meshes of Breps/Extrusions); STEP/IGES/BREP via OpenCascade.
// Every object keeps its layer so the user can pick the piece out of a whole robot-cell scene.
import { msg, MsgError, type Msg } from '../i18n';
import { BufferGeometry, Mesh as ThreeMesh, type Object3D } from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';
import { OBJLoader } from 'three/examples/jsm/loaders/OBJLoader.js';
import { PLYLoader } from 'three/examples/jsm/loaders/PLYLoader.js';
import { computeBounds, mergeMeshes, orientOutward, weld, type MeshData } from './mesh';

// Served by the site itself (scripts/copy-vendor.mjs): no CDN, no network needed to import.
const vendor = (file: string) => new URL(`vendor/${file}`, document.baseURI).href;

export const ACCEPTED = '.stl,.obj,.ply,.3dm,.step,.stp,.iges,.igs,.brep,.src,.txt';

export interface ModelPart {
  id: number;
  layer: string;
  name: string;
  type: string;
  visible: boolean;
  mesh: MeshData;
}

export interface LoadedModel {
  format: string;
  parts: ModelPart[];
  notes: Msg[];
  /** Curves of the file as polylines (x, y, z triples, mm), in the order of the file. */
  curves?: Float32Array[];
  /**
   * The curves come from a layer named as a path (PATH_LAYER): they are the path to print even
   * when the file holds solids too (a whole Rhino scene with the path baked into it).
   */
  pathLayer?: string;
}

/** A layer with one of these words in its name holds the path to print. */
export const PATH_LAYER = /percorso|toolpath|kinepath/i;

function fromGeometry(g: BufferGeometry): MeshData {
  const pos = g.getAttribute('position');
  const positions = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    positions[i * 3] = pos.getX(i);
    positions[i * 3 + 1] = pos.getY(i);
    positions[i * 3 + 2] = pos.getZ(i);
  }
  const index = g.getIndex();
  const indices = index ? new Uint32Array(index.array) : Uint32Array.from({ length: pos.count }, (_, i) => i);
  return { positions, indices };
}

function fromObject3D(root: Object3D): ModelPart[] {
  root.updateMatrixWorld(true);
  const parts: ModelPart[] = [];
  root.traverse((o) => {
    if ((o as ThreeMesh).isMesh) {
      const g = (o as ThreeMesh).geometry.clone();
      g.applyMatrix4(o.matrixWorld);
      parts.push({ id: parts.length, layer: o.name || 'Oggetto', name: o.name, type: 'type.mesh', visible: true, mesh: fromGeometry(g) });
    }
  });
  return parts;
}

// ---------- Rhino .3dm ----------

// rhino3dm is loaded at runtime from the CDN, so it is untyped here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

let rhinoPromise: Promise<Any> | null = null;
export function loadRhino(): Promise<Any> {
  rhinoPromise ??= import(/* @vite-ignore */ vendor('rhino3dm.module.min.js')).then((m) => m.default());
  return rhinoPromise;
}

const UNIT_TO_MM: Record<string, number> = {
  Millimeters: 1,
  Centimeters: 10,
  Meters: 1000,
  Inches: 25.4,
  Feet: 304.8,
};

function rhinoMeshToData(m: Any): MeshData | null {
  if (!m) return null;
  const json: Any = m.toThreejsJSON();
  const data = json.data ?? json;
  const pos = data.attributes?.position?.array;
  if (!pos?.length) return null;
  const positions = Float32Array.from(pos);
  const idx = data.index?.array;
  const indices = idx ? Uint32Array.from(idx) : Uint32Array.from({ length: positions.length / 3 }, (_, i) => i);
  return { positions, indices };
}

/**
 * A curve as a polyline: its own points when it is one, otherwise sampled finely enough to stay
 * within 0.05 mm of the curve.
 */
function curvePoints(g: Any): Float32Array | null {
  const out: number[] = [];
  if (g.isPolyline?.() && g.pointCount) {
    for (let i = 0; i < g.pointCount; i++) out.push(...(g.point(i) as number[]));
  } else {
    const dom = g.domain as [number, number] | undefined;
    if (!dom || !(dom[1] > dom[0]) || !g.pointAt) return null;
    const at = (t: number) => g.pointAt(t) as [number, number, number];
    const split = (t0: number, p0: number[], t1: number, p1: number[], depth: number) => {
      const tm = (t0 + t1) / 2;
      const pm = at(tm);
      const chord = Math.hypot(p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]);
      const off = Math.hypot(pm[0] - (p0[0] + p1[0]) / 2, pm[1] - (p0[1] + p1[1]) / 2, pm[2] - (p0[2] + p1[2]) / 2);
      if (depth < 14 && (off > 0.05 || (depth < 3 && chord > 1e-9))) {
        split(t0, p0, tm, pm, depth + 1);
        split(tm, pm, t1, p1, depth + 1);
      } else out.push(...p1);
    };
    const spans = Math.max(1, (g.spanCount as number) || 1) * 2;
    let p0 = at(dom[0]);
    out.push(...p0);
    for (let k = 1; k <= spans; k++) {
      const [t0, t1] = [dom[0] + ((dom[1] - dom[0]) * (k - 1)) / spans, dom[0] + ((dom[1] - dom[0]) * k) / spans];
      const p1 = at(t1);
      split(t0, p0, t1, p1, 0);
      p0 = p1;
    }
  }
  return out.length >= 6 && out.every(Number.isFinite) ? Float32Array.from(out) : null;
}

export function parse3dm(rhino: Any, bytes: Uint8Array): LoadedModel {
  const doc = rhino.File3dm.fromByteArray(bytes);
  if (!doc) throw new MsgError(msg('e.3dm'));
  const notes: Msg[] = [];
  const unit = doc.settings().modelUnitSystem;
  let unitScale = 1;
  for (const [k, v] of Object.entries(UNIT_TO_MM)) if (rhino.UnitSystem[k] === unit) unitScale = v;

  const layerTable = doc.layers();
  const layers: { path: string; visible: boolean }[] = [];
  for (let i = 0; i < layerTable.count; i++) {
    const l = layerTable.get(i);
    layers.push({ path: l.fullPath ?? l.name, visible: l.visible !== false });
  }

  const parts: ModelPart[] = [];
  const curves: Float32Array[] = [];
  const pathCurves: Float32Array[] = [];
  let pathLayer: string | undefined;
  let skipped = 0;
  let blocks = 0;
  let brepsNoMesh = 0;
  const objects = doc.objects();
  for (let i = 0; i < objects.count; i++) {
    const obj = objects.get(i);
    const g = obj.geometry();
    const attr = obj.attributes();
    const type = g.objectType;
    const meshes: MeshData[] = [];
    let typeName = '';
    if (type === rhino.ObjectType.Mesh) {
      typeName = 'type.mesh';
      const d = rhinoMeshToData(g);
      if (d) meshes.push(d);
    } else if (type === rhino.ObjectType.Brep) {
      typeName = 'type.brep';
      const faces = g.faces();
      for (let f = 0; f < faces.count; f++) {
        const d = rhinoMeshToData(faces.get(f).getMesh(rhino.MeshType.Any));
        if (d) meshes.push(d);
      }
      if (!meshes.length) brepsNoMesh++;
    } else if (type === rhino.ObjectType.Extrusion) {
      typeName = 'type.extrusion';
      const d = rhinoMeshToData(g.getMesh(rhino.MeshType.Any));
      if (d) meshes.push(d);
      else brepsNoMesh++;
    } else if (type === rhino.ObjectType.SubD) {
      typeName = 'type.subd';
      const d = rhinoMeshToData(rhino.Mesh.createFromSubDControlNet?.(g));
      if (d) meshes.push(d);
    } else if (type === rhino.ObjectType.Curve) {
      const c = curvePoints(g);
      if (c) {
        const scaled = unitScale === 1 ? c : c.map((v) => v * unitScale);
        curves.push(scaled);
        const name = layers[attr.layerIndex]?.path ?? '';
        if (PATH_LAYER.test(name)) {
          pathCurves.push(scaled);
          pathLayer ??= name;
        }
      } else skipped++;
      continue;
    } else if (type === rhino.ObjectType.InstanceReference) {
      blocks++;
      continue;
    } else {
      skipped++;
      continue;
    }
    if (!meshes.length) continue;
    const mesh = mergeMeshes(meshes);
    if (unitScale !== 1) for (let k = 0; k < mesh.positions.length; k++) mesh.positions[k] *= unitScale;
    const layer = layers[attr.layerIndex] ?? { path: 'Senza layer', visible: true };
    parts.push({
      id: parts.length,
      layer: layer.path,
      name: attr.name || '',
      type: typeName,
      visible: layer.visible && attr.visible !== false,
      mesh,
    });
  }
  if (brepsNoMesh)
    notes.push(msg('n.brepNoMesh', { n: brepsNoMesh }));
  if (blocks) notes.push(msg('n.blocks', { n: blocks }));
  if (skipped) notes.push(msg('n.skipped', { n: skipped }));
  if (unitScale !== 1) notes.push(msg('n.units', { s: unitScale }));
  // A file of curves only is a path made by hand (imported.ts); with solids too, the solids are the part.
  if (!parts.length && !curves.length) throw new MsgError(msg('e.3dmEmpty'));
  // Curves in a layer named as a path are the path, whatever else the file holds.
  if (pathLayer) return { format: '3DM', parts, notes, curves: pathCurves, pathLayer };
  if (parts.length && curves.length) notes.push(msg('n.curvesIgnored', { n: curves.length }));
  return { format: '3DM', parts, notes, curves };
}

// ---------- STEP / IGES / BREP ----------

let occtPromise: Promise<Any> | null = null;
function loadOcct(): Promise<Any> {
  occtPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = vendor('occt-import-js.js');
    s.onload = () =>
      (window as Any).occtimportjs({ locateFile: (f: string) => vendor(f) }).then(resolve, reject);
    s.onerror = () => reject(new MsgError(msg('e.occtLoad')));
    document.head.appendChild(s);
  });
  return occtPromise;
}

async function parseCad(bytes: Uint8Array, ext: string): Promise<LoadedModel> {
  return cadToModel(await loadOcct(), bytes, ext);
}

/** STEP / IGES / BREP through an OpenCascade instance (occt-import-js), 0.1 mm tessellation. */
export function cadToModel(occt: Any, bytes: Uint8Array, ext: string): LoadedModel {
  const params = { linearUnit: 'millimeter', linearDeflectionType: 'absolute_value', linearDeflection: 0.1, angularDeflection: 0.2 };
  const res =
    ext === 'brep'
      ? occt.ReadBrepFile(bytes, params)
      : ext === 'iges' || ext === 'igs'
        ? occt.ReadIgesFile(bytes, params)
        : occt.ReadStepFile(bytes, params);
  if (!res.success || !res.meshes.length) throw new MsgError(msg('e.occt'));
  const parts: ModelPart[] = res.meshes.map((m: Any, i: number) => ({
    id: i,
    layer: m.name || `Solido ${i + 1}`,
    name: m.name || '',
    type: 'type.brep',
    visible: true,
    mesh: { positions: Float32Array.from(m.attributes.position.array), indices: Uint32Array.from(m.index.array) },
  }));
  return { format: ext.toUpperCase(), parts, notes: [msg('n.brep')] };
}

// ---------- entry points ----------

export async function loadModel(file: File): Promise<LoadedModel> {
  const ext = file.name.split('.').pop()!.toLowerCase();
  const buf = await file.arrayBuffer();
  const single = (mesh: MeshData, format: string, notes: Msg[]): LoadedModel => ({
    format,
    notes,
    parts: [{ id: 0, layer: file.name, name: file.name, type: 'type.mesh', visible: true, mesh }],
  });
  switch (ext) {
    case 'stl':
      return single(fromGeometry(new STLLoader().parse(buf)), 'STL', [msg('n.stl')]);
    case 'ply':
      return single(fromGeometry(new PLYLoader().parse(buf)), 'PLY', []);
    case 'obj':
      return { format: 'OBJ', parts: fromObject3D(new OBJLoader().parse(new TextDecoder().decode(buf))), notes: [msg('n.obj')] };
    case '3dm':
      return parse3dm(await loadRhino(), new Uint8Array(buf));
    case 'step':
    case 'stp':
    case 'iges':
    case 'igs':
    case 'brep':
      return parseCad(new Uint8Array(buf), ext);
    default:
      throw new MsgError(msg('e.format', { ext, list: ACCEPTED }));
  }
}

/** Merge the chosen parts into one clean, welded, outward-facing mesh. */
export function combineParts(parts: ModelPart[]): MeshData {
  if (!parts.length) throw new MsgError(msg('e.noParts'));
  const mesh = orientOutward(weld(mergeMeshes(parts.map((p) => p.mesh)), 1e-3));
  if (!mesh.indices.length) throw new MsgError(msg('e.noTris'));
  return mesh;
}

export function partSize(p: ModelPart): [number, number, number] {
  const b = computeBounds(p.mesh);
  return [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]];
}

const TYPE_PRIORITY: Record<string, number> = { 'type.mesh': 0, 'type.brep': 1, 'type.extrusion': 2, 'type.subd': 3 };

export interface CellRegion {
  /** BASE origin in world coordinates (worldBaseX/Y/Z). */
  worldBase: [number, number, number];
  bedCenter: [number, number];
  bedSize: [number, number];
}

type Box = ReturnType<typeof computeBounds>;
const CELL_LAYER = /base di lavorazione|robot|kuka|mandrino|dima|cella/i;
const volume = (b: Box) => (b.max[0] - b.min[0]) * (b.max[1] - b.min[1]) * (b.max[2] - b.min[2]);

/** One object per group of objects occupying the same box (same piece saved as mesh, BREP, SubD…), preferring meshes. */
function dedupe(items: { p: ModelPart; b: Box }[]): { parts: ModelPart[]; b: Box }[] {
  const groups: { b: Box; items: ModelPart[] }[] = [];
  for (const { p, b } of items) {
    const tol = 0.05 * Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]);
    const g = groups.find((g) => [0, 1, 2].every((k) => Math.abs(g.b.min[k] - b.min[k]) <= tol && Math.abs(g.b.max[k] - b.max[k]) <= tol));
    if (g) g.items.push(p);
    else groups.push({ b, items: [p] });
  }
  return groups.map((g) => ({
    b: g.b,
    parts: [g.items.sort((a, c) => (TYPE_PRIORITY[a.type] ?? 9) - (TYPE_PRIORITY[c.type] ?? 9) || c.mesh.indices.length - a.mesh.indices.length)[0]],
  }));
}

/**
 * The robot cell is fixed, so a Rhino file may be the whole scene (robot, table, fixtures…).
 * The piece is what stands on the work table: keep objects whose box lies inside the table
 * area (world → BASE) and rests near its surface; drop duplicates and small leftovers.
 * Files with a few objects (a piece or a set of pieces) are taken as they are.
 */
export function pickPieces(model: LoadedModel, cell: CellRegion): { parts: ModelPart[]; note: Msg | null } {
  // A file with a few objects is the piece itself (e.g. a BREP split in solids): merge them all.
  if (model.parts.length <= 5) {
    const g = dedupe(model.parts.map((p) => ({ p, b: computeBounds(p.mesh) })));
    return { parts: g.flatMap((x) => x.parts), note: null };
  }
  const [wx, wy, wz] = cell.worldBase;
  const margin = 0.1;
  const x0 = cell.bedCenter[0] - (cell.bedSize[0] / 2) * (1 + margin) + wx;
  const x1 = cell.bedCenter[0] + (cell.bedSize[0] / 2) * (1 + margin) + wx;
  const y0 = cell.bedCenter[1] - (cell.bedSize[1] / 2) * (1 + margin) + wy;
  const y1 = cell.bedCenter[1] + (cell.bedSize[1] / 2) * (1 + margin) + wy;
  const onTable = model.parts
    .map((p) => ({ p, b: computeBounds(p.mesh) }))
    .filter(({ b }) => b.min[0] >= x0 && b.max[0] <= x1 && b.min[1] >= y0 && b.max[1] <= y1 && b.min[2] >= wz - 20 && b.min[2] <= wz + 150);
  let groups = dedupe(onTable.filter(({ p }) => !CELL_LAYER.test(p.layer)));
  // A fixture or old table model has the piece standing inside its bounding box: drop it.
  const inside = (i: Box, o: Box) => [0, 1, 2].every((k) => i.min[k] >= o.min[k] - 1 && i.max[k] <= o.max[k] + 1);
  groups = groups.filter((g) => !groups.some((o) => o !== g && inside(o.b, g.b))).sort((a, b) => volume(b.b) - volume(a.b));
  if (!groups.length)
    return {
      parts: [],
      note: msg('n.sceneEmpty', { n: model.parts.length }),
    };
  // One piece only: the biggest object standing on the table.
  const parts = groups[0].parts;
  const names = parts.map((p) => p.layer).join('", "');
  return { parts, note: msg('n.scenePicked', { n: model.parts.length, names }) };
}
