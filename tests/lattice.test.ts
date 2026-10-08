// Thin-walled networks (honeycomb, grid, a single thin wall) are printed along the mid-lines of
// their walls, as one walk per layer: no wall laid twice, no jump from cell to cell.
import { describe, expect, it } from 'vitest';
import { centerlineGraph, collapseLattices, routeGraph } from '../src/core/lattice';
import { weld, type MeshData } from '../src/core/mesh';
import { signedArea, type Vec2 } from '../src/core/polyline';
import { classify, type Contour } from '../src/core/slicer';
import { DEFAULT_PRINT } from '../src/core/settings';
import { buildToolpath, sliceForPrint } from '../src/core/toolpath';
import { coverContours } from '../src/core/walls';

const T = 6; // wall thickness = one bead
const R = 22; // cell: centre to corner of the hole

/** A honeycomb section: `cols` × `rows` hexagonal holes, walls T thick everywhere. */
function honeycomb(cols: number, rows: number): Vec2[][] {
  const pitch = Math.sqrt(3) * R + T; // centre to centre of touching cells
  const holes: Vec2[][] = [];
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      const cx = c * pitch + (r % 2 ? pitch / 2 : 0);
      const cy = r * pitch * (Math.sqrt(3) / 2);
      holes.push(Array.from({ length: 6 }, (_, k): Vec2 => [cx + R * Math.cos((k * Math.PI) / 3 + Math.PI / 6), cy + R * Math.sin((k * Math.PI) / 3 + Math.PI / 6)]));
    }
  // The outline follows the cells, one wall away from them.
  const outline = coverContours(holes.map((pts) => ({ pts, closed: true, depth: 0 })), T, 0).filter((c) => c.depth === 0);
  return [outline[0].pts, ...holes];
}

/** The side walls of a prism over these loops (enough for the slicer: every section is the loops). */
function prism(loops: Vec2[][], h: number): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const l of loops) {
    const base = pos.length / 3;
    for (const [x, y] of l) pos.push(x, y, 0, x, y, h);
    for (let i = 0; i < l.length; i++) {
      const j = (i + 1) % l.length;
      const [a, b, c, d] = [base + i * 2, base + j * 2, base + j * 2 + 1, base + i * 2 + 1];
      idx.push(a, b, c, a, c, d);
    }
  }
  return weld({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

const contoursOf = (loops: Vec2[][]): Contour[] => classify(loops.map((pts) => ({ pts: pts.map((p): Vec2 => [...p]), closed: true, depth: 0 })));
const length = (pts: Vec2[]) => pts.reduce((s, p, i) => (i ? s + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
function distToLoops(q: Vec2, loops: Vec2[][]): number {
  let best = Infinity;
  for (const l of loops)
    for (let i = 0; i < l.length; i++) {
      const [a, b] = [l[i], l[(i + 1) % l.length]];
      const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
      const t = Math.max(0, Math.min(1, ((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / (dx * dx + dy * dy)));
      best = Math.min(best, Math.hypot(a[0] + t * dx - q[0], a[1] + t * dy - q[1]));
    }
  return best;
}

describe('mid-lines of a honeycomb', () => {
  const loops = honeycomb(3, 3);
  const g = centerlineGraph(loops);

  it('every wall becomes one mid-line, in the middle of the wall', () => {
    expect(g.edges.length).toBeGreaterThan(20);
    for (const e of g.edges)
      for (const q of e.pts.slice(1, -1)) expect(Math.abs(distToLoops(q, loops) - T / 2)).toBeLessThan(0.6);
  });

  it('walls meet three at a time, never more', () => {
    const deg = new Map<number, number>();
    for (const e of g.edges) for (const n of [e.a, e.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    expect(Math.max(...deg.values())).toBe(3);
    expect([...deg.values()].filter((d) => d === 1)).toEqual([]); // no stubs left towards the corners
  });

  it('one walk passes along every wall, repeating only what it must', () => {
    const walks = routeGraph(g);
    expect(walks.length).toBe(1);
    const walls = g.edges.reduce((s, e) => s + length(e.pts), 0);
    const walked = length(walks[0]);
    expect(walked).toBeGreaterThanOrEqual(walls - 1e-6);
    // three walls at every junction: about a third of the length is passed twice, not more
    expect(walked).toBeLessThan(1.4 * walls);
  });
});

describe('a honeycomb is printed in one go', () => {
  const loops = honeycomb(3, 3);
  const mesh = prism(loops, 6);
  const s = { ...DEFAULT_PRINT, layerHeight: 1.5 };

  it('the section is replaced by the walk; a thick part is left alone', () => {
    const lattice = collapseLattices(contoursOf(loops), s.thinWallMax);
    expect(lattice.map((c) => !!c.lattice)).toEqual([true]);
    const block: Vec2[] = [[0, 0], [60, 0], [60, 60], [0, 60]];
    const thick = collapseLattices(contoursOf([block, [[20, 20], [40, 20], [40, 40], [20, 40]], [[5, 5], [10, 5], [10, 10], [5, 10]]]), s.thinWallMax);
    expect(thick.every((c) => c.closed && !c.lattice)).toBe(true);
  });

  it('no jump: the nozzle never lifts, layer after layer', () => {
    const tp = buildToolpath(mesh, s);
    expect(sliceForPrint(mesh, s).latticeLayers).toBe(4);
    expect(tp.travels).toBe(0);
    const zs = new Set(tp.points.map((p) => +p.z.toFixed(3)));
    expect(zs.size).toBe(4); // only the four layer heights: never above them
    expect(tp.warnings.map((w) => w.k)).toContain('w.lattice');
    expect(tp.warnings.map((w) => w.k)).not.toContain('w.openLayers');
  });

  it('no wall is laid twice: the second pass over a wall has the extruder off', () => {
    const tp = buildToolpath(mesh, s);
    const walls = centerlineGraph(loops).edges.reduce((a, e) => a + length(e.pts), 0);
    // printed length per layer = the walls once (plus the 1.5 mm steps between layers)
    expect(tp.printLength / 4).toBeGreaterThan(walls - 1);
    expect(tp.printLength / 4).toBeLessThan(walls + 3);
    expect(tp.retraces).toBeGreaterThan(0);
    const again = buildToolpath(mesh, { ...s, latticeRetrace: 'print' });
    expect(again.points.slice(1).every((p) => p.e)).toBe(true);
    expect(again.printLength).toBeGreaterThan(1.1 * tp.printLength);
  });

  it('every printed point is in the middle of a wall', () => {
    const tp = buildToolpath(mesh, s);
    for (const p of tp.points) expect(Math.abs(distToLoops([p.x, p.y], loops) - T / 2)).toBeLessThan(0.7);
  });
});

describe('other thin shapes', () => {
  it('a single thin wall is one pass along its middle, back and forth layer after layer', () => {
    const wall: Vec2[] = [[0, 0], [120, 0], [120, 6], [0, 6]];
    const tp = buildToolpath(prism([wall], 4.5), { ...DEFAULT_PRINT, layerHeight: 1.5 });
    expect(tp.travels).toBe(0);
    expect(tp.retraces ?? 0).toBe(0);
    for (const p of tp.points) expect(Math.abs(p.y - 3)).toBeLessThan(0.5);
    expect(tp.printLength).toBeLessThan(3 * 120);
  });

  it('a square grid: four walls at the crossings, one stroke with no repeat inside', () => {
    const cell: Vec2[][] = [];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) cell.push([[6 + i * 36, 6 + j * 36], [36 + i * 36, 6 + j * 36], [36 + i * 36, 36 + j * 36], [6 + i * 36, 36 + j * 36]]);
    const loops: Vec2[][] = [[[0, 0], [114, 0], [114, 114], [0, 114]], ...cell];
    expect(Math.abs(signedArea(loops[0]))).toBeGreaterThan(0);
    const g = centerlineGraph(loops);
    const deg = new Map<number, number>();
    for (const e of g.edges) for (const n of [e.a, e.b]) deg.set(n, (deg.get(n) ?? 0) + 1);
    expect(Math.max(...deg.values())).toBe(4);
    expect(routeGraph(g).length).toBe(1);
  });
});
