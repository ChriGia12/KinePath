// A path made elsewhere (Grasshopper / KUKA|prc, or any KRL program): its LIN points are taken as
// they are — the site does not compute the path, it places it on the plate, checks it (reach,
// axis limits, collisions), simulates it and writes the complete program around it.
import { msg } from '../i18n';
import type { MeshData } from './mesh';
import type { PrintSettings } from './settings';
import type { PathPoint, Toolpath } from './toolpath';

export interface ImportedPath {
  /** x, y, z of every LIN point, in the coordinates of the file. */
  xyz: Float32Array;
  /** 1 when the move reaching the point prints. */
  ext: Uint8Array;
  /** The file switches the extruder itself ($OUT[16] / $ANOUT[7]); otherwise every move prints. */
  hasExtruder: boolean;
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
