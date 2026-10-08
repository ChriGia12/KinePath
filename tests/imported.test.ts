// A path made elsewhere (a KRL program from Grasshopper) is taken as it is: the site places it,
// checks it and writes the complete program around it — what the Python post-processor did.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellBodies, type CellPart } from '../src/core/collision';
import rhino3dm from 'rhino3dm';
import { curvesToPath, moveSeam, parseSrc, pathProxy, pathUnits, reorderPath, tiltFromPath, importedToolpath } from '../src/core/imported';
import { parse3dm } from '../src/core/loaders';
import type { PathPoint } from '../src/core/toolpath';
import { computeBounds, IDENTITY, weld, type Mat3 } from '../src/core/mesh';
import { runBuild } from '../src/core/pipeline';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';
import { box } from './fixtures';

const header = JSON.parse(readFileSync('public/cell.json', 'utf8')) as { parts: CellPart[] };
const cell = readFileSync('public/cell.bin');
const bodies = cellBodies(header.parts, cell.buffer.slice(cell.byteOffset, cell.byteOffset + cell.byteLength), [372.65, 0, 78.111]);
const I = [...IDENTITY] as Mat3;

/** What KUKA|prc writes: world coordinates (BASE at 1448, −1000, 5), its own A/B/C, no extruder. */
const lin = (x: number, y: number, z: number) => `LIN {X ${x.toFixed(3)}, Y ${y.toFixed(3)}, Z ${z}, A -167.186, B 0, C 180, E1 1050, E2 0, E3 0, E4 0} C_DIS`;
function grasshopper(): string {
  const rows = ['DEF prova ( )', ';FOLD INI', 'BAS (#INITMOV,0)', ';ENDFOLD', '$VEL.CP=0.2', 'PTP $AXIS_ACT ; skip BCO quickly', 'PTP {A1 0, A2 -90, A3 90, A4 0, A5 30, A6 0}'];
  // three square loops 80 mm wide, 1.5 mm apart in Z, centred on world (1458, -480)
  for (let k = 0; k < 3; k++) for (const [x, y] of [[-40, -40], [40, -40], [40, 40], [-40, 40], [-40, -40]]) rows.push(lin(1458 + x, -480 + y, 43.5 + k * 1.5));
  return [...rows, 'END'].join('\r\n');
}

describe('reading a program made elsewhere', () => {
  const path = parseSrc(grasshopper())!;

  it('takes the LIN points in order and nothing else', () => {
    expect(path.xyz.length / 3).toBe(15);
    expect([...path.xyz.slice(0, 3)]).toEqual([1418, -520, 43.5]);
    // no extruder commands in the file: every move prints, except the one to the first point
    expect(path.hasExtruder).toBe(false);
    expect([...path.ext]).toEqual([0, ...Array(14).fill(1)]);
  });

  it('follows the extruder commands when the file has them', () => {
    const src = ['$OUT[16]=FALSE', lin(0, 0, 10), '$ANOUT[7]=1', lin(50, 0, 10), '$OUT[16]=FALSE', lin(50, 50, 30), '$OUT[16]=TRUE', lin(0, 50, 10)].join('\n');
    const p = parseSrc(src)!;
    expect(p.hasExtruder).toBe(true);
    expect([...p.ext]).toEqual([0, 1, 0, 1]);
  });

  it('a file without LIN moves is refused', () => {
    expect(parseSrc('DEF x ( )\nPTP {A1 0, A2 -90}\nEND')).toBeNull();
  });

  it('the beads of the path are a mesh as large as the path, one bead wider', () => {
    const b = computeBounds(pathProxy(path, DEFAULT_PRINT));
    expect(b.max[0] - b.min[0]).toBeCloseTo(80 + DEFAULT_PRINT.wallSpacing, 3);
    expect(b.min[2]).toBeCloseTo(43.5 - DEFAULT_PRINT.firstLayerZ, 3);
  });
});

describe('the program written around an imported path', () => {
  const path = parseSrc(grasshopper())!;
  const proxy = pathProxy(path, DEFAULT_PRINT);
  const linesOf = (src: string) => src.split('\r\n').filter((l) => l.startsWith('LIN {'));
  const xyz = (l: string) => ['X', 'Y', 'Z'].map((a) => parseFloat(new RegExp(`${a} (-?[\\d.]+)`).exec(l)![1]));

  it('kept where the file has it: world → BASE, exactly what the Python script did', () => {
    const r = runBuild(proxy, I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, placement: 'file' }, 'prova.src', bodies, undefined, undefined, [path]);
    const lins = linesOf(r.src);
    // the first point is written twice (PTP then LIN): 15 points → 15 LIN lines
    expect(lins.length).toBe(15);
    expect(xyz(lins[0])).toEqual([1418 - 1448, -520 + 1000, 43.5 - 5]);
    expect(xyz(lins[14])).toEqual([1418 - 1448, -520 + 1000, 46.5 - 5]);
    // tool orientation and external axes are the site's, not the file's
    expect(lins[0]).toContain('A -180.000, B 0.000, C 180.000, E1 0.000');
    // and the program is complete: safe position, extruder, homing
    expect(r.src).toContain('PTP {A1 0.000, A2 -90.000, A3 90.000');
    expect(r.src).toContain('ACCENSIONE ESTRUSORE');
    expect(r.src).toContain('; HOMING');
    expect(r.src.trimEnd().endsWith('END')).toBe(true);
    expect(r.toolpath.mode).toBe('imported');
    expect(r.errors).toEqual([]);
    expect(r.reach.unreachable).toBe(0);
    expect(r.collision?.count).toBe(0);
  });

  it('centred on a point: the path goes where the part is put, its first layer just above the table', () => {
    const robot = { ...DEFAULT_ROBOT, originX: 20, originY: 600 };
    const r = runBuild(proxy, I, DEFAULT_PRINT, robot, 'prova.src', bodies, undefined, undefined, [path]);
    const pts = linesOf(r.src).map(xyz);
    expect(Math.min(...pts.map((p) => p[0]))).toBeCloseTo(20 - 40, 3);
    expect(Math.max(...pts.map((p) => p[1]))).toBeCloseTo(600 + 40, 3);
    expect(Math.min(...pts.map((p) => p[2]))).toBeCloseTo(DEFAULT_ROBOT.originZ + DEFAULT_PRINT.firstLayerZ, 3);
    expect(Math.max(...pts.map((p) => p[2]))).toBeCloseTo(DEFAULT_ROBOT.originZ + DEFAULT_PRINT.firstLayerZ + 3, 3);
  });

  it('turned on the plate: the path turns with it', () => {
    const r = runBuild(proxy, I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, originX: 0, originY: 500, rotationZ: 45 }, 'prova.src', bodies, undefined, undefined, [path]);
    const pts = linesOf(r.src).map(xyz);
    // a square turned by 45° spans its diagonal
    expect(Math.max(...pts.map((p) => p[0])) - Math.min(...pts.map((p) => p[0]))).toBeCloseTo(80 * Math.SQRT2, 2);
  });

  it('a path that would go into the table is not exportable', () => {
    const low = parseSrc([lin(1458, -480, 30), lin(1500, -480, 30)].join('\n'))!;
    const r = runBuild(pathProxy(low, DEFAULT_PRINT), I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, placement: 'file' }, 'x.src', bodies, undefined, undefined, [low]);
    expect(r.errors.map((e) => e.k)).toContain('v.belowTable');
  });

  it('a move that does not print at the start does not switch the extruder on and off', () => {
    const src = ['$OUT[16]=FALSE', lin(1458, -480, 60), lin(1458, -480, 43.5), '$OUT[16]=TRUE', lin(1500, -480, 43.5)].join('\n');
    const p = parseSrc(src)!;
    const r = runBuild(pathProxy(p, DEFAULT_PRINT), I, DEFAULT_PRINT, { ...DEFAULT_ROBOT, placement: 'file' }, 'x.src', bodies, undefined, undefined, [p]);
    expect(r.src).not.toContain('; ACCENSIONE ESTRUSORE');
    expect(r.src).toContain('RIACCENSIONE ESTRUSORE');
  });
});

describe('a path with the object it was drawn on', () => {
  // the object: a 100 mm block standing in the Rhino world, its base at Z 5; the path: two loops
  // around it, 1.5 and 3 mm above its base
  const block = box(100, 100, 50, 1400, -500, 5);
  const loops = [6.5, 8].map((z) => Float32Array.from([[1400, -500], [1500, -500], [1500, -400], [1400, -400], [1400, -500]].flatMap(([x, y]) => [x, y, z])));
  const path = { ...curvesToPath(loops, 8)!, ref: true };
  const zs = (src: string) => src.split('\r\n').filter((l) => l.startsWith('LIN {')).map((l) => ['X', 'Y', 'Z'].map((a) => parseFloat(new RegExp(`${a} (-?[\\d.]+)`).exec(l)![1])));

  it('the object rests on the plate and the path keeps its height on it', () => {
    const robot = { ...DEFAULT_ROBOT, originX: 0, originY: 500 };
    const r = runBuild(block, I, DEFAULT_PRINT, robot, 'p.3dm', bodies, undefined, undefined, [path]);
    const pts = zs(r.src);
    // 1.5 mm above the base of the object, which is on the plate (Z 38): not pushed down to 0.5
    expect(Math.min(...pts.map((p) => p[2]))).toBeCloseTo(38 + 1.5, 3);
    expect(Math.max(...pts.map((p) => p[2]))).toBeCloseTo(38 + 3, 3);
    // around the object, centred where the object is put
    expect([Math.min(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[0]))]).toEqual([-50, 50]);
    expect([Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[1]))]).toEqual([450, 550]);
    // the object is shown, and is never printed: only the 10 points of the two loops
    expect(r.toolpath.points.length).toBe(10);
    expect(r.toolpath.mode).toBe('imported');
    expect(r.mesh.indices.length).toBe(block.indices.length);
  });

  it('the tool can stand along the normal of the object where the path is laid on its surface', () => {
    // a ramp: a quad rising 30° along Y (normal leaning 30° towards −Y), and passes drawn on it
    const rise = Math.tan(Math.PI / 6) * 100;
    const ramp = weld({ positions: new Float32Array([0, 0, 0, 100, 0, 0, 100, 100, rise, 0, 100, rise]), indices: new Uint32Array([0, 1, 2, 0, 2, 3]) });
    const passes = [20, 40, 60, 80].map((y) => Float32Array.from([[10, y], [90, y]].flatMap(([x, yy]) => [x, yy, (yy / 100) * rise])));
    const onRamp = { ...curvesToPath(passes, 0)!, ref: true };
    const tilt = (maxTilt: number) => runBuild(ramp, I, { ...DEFAULT_PRINT, toolTilt: true, maxTilt }, { ...DEFAULT_ROBOT, originX: 0, originY: 500 }, 'r.3dm', undefined, undefined, undefined, [onRamp]);
    const r = tilt(45);
    expect(r.toolpath.warnings.map((w) => w.k)).toContain('i.tiltOnObject');
    // every pass leans 30° from the vertical, all the same way (the slope is along Y: C can follow it)
    const cs = r.toolpath.points.filter((p) => p.e).map((p) => p.c!);
    for (const c of cs) expect(Math.abs(Math.abs(c - 180) - 30)).toBeLessThan(0.5);
    expect(new Set(cs.map((c) => Math.sign(c - 180))).size).toBe(1);
    expect(r.toolpath.tiltX ?? 0).toBe(0);
    // never more than the maximum tilt
    for (const p of tilt(15).toolpath.points.filter((q) => q.e)) expect(Math.abs(Math.abs(p.c! - 180) - 15)).toBeLessThan(0.5);
  });

  it('without the object the lowest point of the path is laid just above the plate', () => {
    const alone = { ...path, ref: false };
    const r = runBuild(pathProxy(alone, DEFAULT_PRINT), I, DEFAULT_PRINT, DEFAULT_ROBOT, 'p.3dm', bodies, undefined, undefined, [alone]);
    expect(Math.min(...zs(r.src).map((p) => p[2]))).toBeCloseTo(38 + DEFAULT_PRINT.firstLayerZ, 3);
  });
});

describe('an imported path can be changed, not only copied', () => {
  /** `layers` square loops 80 mm wide, each closed on its first point, stepping straight up. */
  const squares = (layers: number, closing = true): PathPoint[] => {
    const pts: PathPoint[] = [];
    for (let k = 0; k < layers; k++)
      for (const [x, y] of [[-40, -40], [40, -40], [40, 40], [-40, 40], ...(closing ? [[-40, -40]] : [])]) pts.push({ x, y, z: 0.5 + k * 1.5, e: pts.length > 0 });
    return pts;
  };
  const printed = (pts: PathPoint[]) => pts.reduce((a, p, i) => (i && p.e ? a + Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y, p.z - pts[i - 1].z) : a), 0);

  it('its closed loops are recognised, layer after layer', () => {
    const units = pathUnits(squares(3));
    expect(units.map((u) => [u.from, u.to, u.closed])).toEqual([[0, 4, true], [5, 9, true], [10, 14, true]]);
    // loops written without their last side (the path climbs along it to the next layer) still close
    expect(pathUnits(squares(3, false)).map((u) => u.closed)).toEqual([true, true, true]);
    // open arcs printed back and forth are not loops
    const arcs: PathPoint[] = [];
    for (let k = 0; k < 3; k++) for (const x of k % 2 ? [80, 40, 0] : [0, 40, 80]) arcs.push({ x, y: x === 40 ? 20 : 0, z: 0.5 + k * 1.5, e: arcs.length > 0 });
    expect(pathUnits(arcs).map((u) => u.closed)).toEqual([false, false, false]);
    expect(moveSeam(arcs, [40, 30]).points).toEqual(arcs);
  });

  it('the start point moves: every loop starts from the point nearest to the one chosen', () => {
    const pts = squares(3);
    const r = moveSeam(pts, [40, 40]);
    expect(r.moved).toBe(3);
    expect(r.open).toBe(0);
    const units = pathUnits(r.points);
    for (const u of units) expect([r.points[u.from].x, r.points[u.from].y]).toEqual([40, 40]);
    // the same loops are printed, whole: same length on every layer
    expect(printed(r.points)).toBeCloseTo(printed(pts), 6);
    // on the middle of a side too: the loop is opened there
    const mid = moveSeam(pts, [0, -45]);
    const u0 = pathUnits(mid.points)[0];
    expect([mid.points[u0.from].x, mid.points[u0.from].y]).toEqual([0, -40]);
    expect(printed(mid.points)).toBeCloseTo(printed(pts), 6);
  });

  it('a continuous spiral has no loop to restart from: it is left as it is, and that is said', () => {
    const spiral: PathPoint[] = Array.from({ length: 400 }, (_, i) => ({ x: 40 * Math.cos(i / 20), y: 40 * Math.sin(i / 20), z: 0.5 + i * 0.01, e: i > 0 }));
    const r = moveSeam(spiral, [0, 40]);
    expect(r.moved).toBe(0);
    expect(r.points).toEqual(spiral);
  });

  it('a path of open passes (a serpentine over a surface) can start from any of its four ends', () => {
    // 5 passes along X, 10 mm apart in Y, walked back and forth; one layer, lying on a steep slope
    // (a pass further down the slope is lower, but it is not a layer underneath)
    const passes = [0, 1, 2, 3, 4].map((k) => Float32Array.from((k % 2 ? [100, 0] : [0, 100]).flatMap((x) => [x, k * 10, 5 + x * 0.4])));
    const path = curvesToPath(passes, 12)!;
    const pts: PathPoint[] = Array.from({ length: path.xyz.length / 3 }, (_, i) => ({ x: path.xyz[i * 3], y: path.xyz[i * 3 + 1], z: path.xyz[i * 3 + 2], e: !!path.ext[i] }));
    expect(pts.slice(1).every((p) => p.e)).toBe(true); // one continuous line
    const start = (target: [number, number], breaks?: Uint32Array) => {
      const r = moveSeam(pts, target, { bead: 6, join: 12, breaks });
      // always the same passes, all printed, in one line
      expect(printed(r.points)).toBeCloseTo(printed(pts), 6);
      expect(r.points.slice(1).every((p) => p.e)).toBe(true);
      return [r.points[0].x, r.points[0].y, r.ends];
    };
    expect(start([-5, -5], path.breaks)).toEqual([0, 0, 0]); // as drawn
    expect(start([105, -5], path.breaks)).toEqual([100, 0, 1]); // every pass the other way
    expect(start([105, 45], path.breaks)).toEqual([100, 40, 2]); // backwards
    expect(start([-5, 45], path.breaks)).toEqual([0, 40, 3]); // backwards, every pass the other way
    // without knowing the passes (one unbroken line from a .src): its two ends
    expect(start([105, 45])).toEqual([100, 40, 2]);
    expect(start([-5, 5])).toEqual([0, 0, 0]);
    // the corner (100, 0) is no end of that line: it starts from the nearer of its two ends
    expect(start([105, -5])).toEqual([100, 40, 2]);
  });

  it('a layered path of open arcs keeps its order: only the first layer can give the start', () => {
    const arcs: PathPoint[] = [];
    for (let k = 0; k < 4; k++) for (const x of k % 2 ? [80, 40, 0] : [0, 40, 80]) arcs.push({ x, y: 0, z: 0.5 + k * 1.5, e: arcs.length > 0 });
    // near the other end of the first arc: every arc is walked the other way, bottom layer first
    const r = moveSeam(arcs, [85, 0], { bead: 6, join: 8 });
    expect([r.points[0].x, r.points[0].z, r.ends]).toEqual([80, 0.5, 1]);
    expect(r.points.map((p) => p.z)).toEqual(arcs.map((p) => p.z));
    expect(r.points.slice(1).every((p) => p.e)).toBe(true);
  });

  it('through the whole build: the program starts where chosen and says so', () => {
    const path = parseSrc(grasshopper())!;
    const print = { ...DEFAULT_PRINT, startMode: 'point' as const, startX: 5 + 40, startY: 515 + 40 };
    const r = runBuild(pathProxy(path, print), I, print, DEFAULT_ROBOT, 'prova.src', bodies, undefined, undefined, [path]);
    expect(r.toolpath.warnings.map((w) => w.k)).toContain('i.seamMoved');
    const first = r.toolpath.points[0];
    expect([first.x + r.offset[0], first.y + r.offset[1]]).toEqual([45, 555]);
    expect(r.errors).toEqual([]);
    expect(r.collision?.count).toBe(0);
  });

  it('the tool can lean along the wall: the wall is read from the path itself', () => {
    const ring = (r: number, z: number, first: boolean): PathPoint[] => Array.from({ length: 49 }, (_, i) => ({ x: r * Math.cos((i / 48) * 2 * Math.PI), y: r * Math.sin((i / 48) * 2 * Math.PI), z, e: !(first && i === 0) }));
    // a cone: every layer 2 mm narrower than the one below, 1.5 mm higher → walls lean inwards
    const cone = importedToolpath(Array.from({ length: 10 }, (_, k) => ring(60 - 2 * k, 0.5 + 1.5 * k, k === 0)).flat(), DEFAULT_PRINT, true);
    // every layer leans but the first, laid on the plate: nothing below to lean against
    expect(tiltFromPath(cone, DEFAULT_PRINT)).toBe(cone.points.length - 49);
    const c = cone.points.map((p) => p.c!);
    expect(Math.max(...c.map((v) => Math.abs(v - 180)))).toBeGreaterThan(20); // leaning by up to maxTilt (30°)
    expect(Math.max(...c.map((v) => Math.abs(v - 180)))).toBeLessThan(30.5);
    // a straight tube: walls are vertical, the tool stays vertical
    const tube = importedToolpath(Array.from({ length: 10 }, (_, k) => ring(60, 0.5 + 1.5 * k, k === 0)).flat(), DEFAULT_PRINT, true);
    expect(tiltFromPath(tube, DEFAULT_PRINT)).toBe(0);
    expect(tube.points.every((p) => Math.abs(p.c! - 180) < 0.5)).toBe(true);
  });
});

describe('the curves of an imported path put in printing order', () => {
  const pt = (p: PathPoint[]) => p.map((q) => [q.x, q.y, q.z]);
  /** A square loop 80 mm wide at height z, written from corner `from`, clockwise or not. */
  const square = (z: number, from: number, cw = false, size = 80): Float32Array => {
    const c = [[0, 0], [size, 0], [size, size], [0, size]];
    const order = Array.from({ length: 5 }, (_, k) => c[(from + (cw ? -k : k) + 8) % 4]);
    return Float32Array.from(order.flatMap(([x, y]) => [x, y, z]));
  };
  const toPts = (curves: Float32Array[], join = 8) => {
    const path = curvesToPath(curves, join)!;
    const pts: PathPoint[] = Array.from({ length: path.xyz.length / 3 }, (_, i) => ({ x: path.xyz[i * 3], y: path.xyz[i * 3 + 1], z: path.xyz[i * 3 + 2], e: !!path.ext[i] }));
    const b = [...path.breaks!];
    return { pts, ranges: b.map((f, k): [number, number] => [f, (b[k + 1] ?? pts.length) - 1]) };
  };
  const off = (p: PathPoint[]) => p.filter((q, i) => i > 0 && !q.e).length;

  it('loops saved top first, each from a different corner and some the other way round: bottom first, one line', () => {
    // five layers, saved from the top down; start corners all over, every other loop clockwise
    const { pts, ranges } = toPts([4, 3, 2, 1, 0].map((k) => square(1 + 1.5 * k, k % 4, k % 2 === 1)));
    expect(off(pts)).toBe(4); // as saved: a jump onto every loop
    const r = reorderPath(pts, ranges, { join: 8, direction: 'ccw' })!;
    expect(r.sorted).toBe(true);
    expect([r.before, r.after]).toEqual([4, 0]);
    expect(off(r.points)).toBe(0);
    // lowest first, never down again
    const zs = r.points.map((q) => q.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    // every loop starts right above where the one below started, and is whole: same corners
    const firsts = [...r.breaks].map((i) => [r.points[i].x, r.points[i].y]);
    expect(new Set(firsts.map((f) => f.join())).size).toBe(1);
    for (const z of [1, 2.5, 4, 5.5, 7]) {
      const loop = r.points.filter((q) => q.z === z);
      expect(new Set(loop.map((q) => `${q.x},${q.y}`)).size).toBe(4);
      expect(loop.length).toBe(5);
      // all counter-clockwise
      let a = 0;
      for (let i = 1; i < loop.length; i++) a += loop[i - 1].x * loop[i].y - loop[i].x * loop[i - 1].y;
      expect(a).toBeGreaterThan(0);
    }
  });

  it('two walls per layer: the nearer one first, both before going up', () => {
    const inner = (z: number) => Float32Array.from([[5, 5], [75, 5], [75, 75], [5, 75], [5, 5]].flatMap(([x, y]) => [x, y, z]));
    const { pts, ranges } = toPts([square(1, 2), inner(1), square(2.5, 0), inner(2.5)]);
    const r = reorderPath(pts, ranges, { join: 8, target: [80, 80] })!;
    expect(r.after).toBe(0);
    // starts at the corner chosen, and a level is finished before the next one begins
    expect(pt(r.points)[0]).toEqual([80, 80, 1]);
    const zs = r.points.map((q) => q.z);
    expect(zs).toEqual([...zs].sort((a, b) => a - b));
    expect(r.points.filter((q) => q.z === 1).length).toBe(10);
  });

  it('a gap in height larger than a layer is not printed across', () => {
    // a loop 6 mm below the rest (layers 1.5 mm apart): the nozzle goes up with the extruder off
    const { pts, ranges } = toPts([square(1, 0), square(7, 0), square(8.5, 0), square(10, 0)]);
    const r = reorderPath(pts, ranges, { join: 8 })!;
    expect(r.after).toBe(1);
    const up = r.points.findIndex((q) => q.z === 7);
    expect(r.points[up].e).toBe(false);
  });

  it('passes over a surface are not flat: their order is kept, each starts from its nearer end', () => {
    // four passes all drawn left to right on a slope: as saved, a jump back before every pass
    const passes = [0, 1, 2, 3].map((k) => Float32Array.from([0, 100].flatMap((x) => [x, k * 6, 5 + x * 0.2])));
    const { pts, ranges } = toPts(passes);
    expect(off(pts)).toBe(3);
    const r = reorderPath(pts, ranges, { join: 8 })!;
    expect(r.sorted).toBe(false);
    expect(r.after).toBe(0);
    expect(r.points.filter((_, i) => i % 2 === 0).map((q) => q.y)).toEqual([0, 6, 12, 18]);
    expect(r.points.map((q) => q.x)).toEqual([0, 100, 100, 0, 0, 100, 100, 0]); // back and forth
  });

  it('through the build, extracted: off by default (the curves as they are), on when asked', () => {
    const curves = [4, 3, 2, 1, 0].map((k) => square(1 + 1.5 * k, k % 4));
    const path = curvesToPath(curves, 8)!;
    const asIs = runBuild(pathProxy(path, DEFAULT_PRINT), I, DEFAULT_PRINT, DEFAULT_ROBOT, 'p.3dm', bodies, undefined, undefined, [path]);
    expect(asIs.toolpath.travels).toBe(4);
    const print = { ...DEFAULT_PRINT, importedExtract: true };
    const r = runBuild(pathProxy(path, print), I, print, DEFAULT_ROBOT, 'p.3dm', bodies, undefined, undefined, [path]);
    expect(r.toolpath.travels).toBe(0);
    expect(r.toolpath.mode).toBe('imported');
    expect(r.toolpath.warnings.find((w) => w.k === 'i.extractedSpiral')?.p).toMatchObject({ n: 5, layers: 5, spiral: 5, before: 4, after: 0 });
    expect(r.errors).toEqual([]);
    expect(r.collision?.count).toBe(0);
  });
});

describe('the path extracted from curves drawn layer by layer', () => {
  // a wall 4 mm thick drawn as two loops per layer (its outer and its inner face), 20 layers 1.5 mm
  // apart, saved in no particular order and each loop from a different corner
  const face = (half: number, z: number, from: number): Float32Array => {
    const c = [[-half, -half], [half, -half], [half, half], [-half, half]];
    return Float32Array.from(Array.from({ length: 5 }, (_, k) => c[(from + k) % 4]).flatMap(([x, y]) => [x, y, z]));
  };
  const curves: Float32Array[] = [];
  for (let k = 0; k < 20; k++) curves.push(face(40, 1 + 1.5 * ((k * 7) % 20), k % 4), face(36, 1 + 1.5 * ((k * 7) % 20), (k + 2) % 4));
  const path = curvesToPath(curves, 8)!;
  const print = { ...DEFAULT_PRINT, importedExtract: true };
  const r = runBuild(pathProxy(path, print), I, print, { ...DEFAULT_ROBOT, originX: 0, originY: 500 }, 'p.3dm', bodies, undefined, undefined, [path]);
  const pts = r.toolpath.points;

  it('one loop per layer along the middle of the wall, not its two faces', () => {
    expect(r.toolpath.layerCount).toBe(20);
    expect(r.toolpath.warnings.find((w) => w.k === 'i.extractedSpiral')?.p).toMatchObject({ n: 40, layers: 20, merged: 20, spiral: 20 });
    // every point is 38 mm from the centre along X or Y: half-way between the faces at 36 and 40
    for (const p of pts) expect(Math.abs(Math.max(Math.abs(p.x), Math.abs(p.y)) - 38)).toBeLessThan(0.05);
    // half the length the two faces would take (plus the closing lap on the rim)
    expect(r.toolpath.printLength).toBeLessThan(21.5 * 8 * 38);
  });

  it('one thread climbing from layer to layer: the extruder never stops, the path never goes down', () => {
    expect(r.toolpath.travels).toBe(0);
    expect(pts.slice(1).every((p) => p.e)).toBe(true);
    for (let i = 1; i < pts.length; i++) expect(pts[i].z).toBeGreaterThanOrEqual(pts[i - 1].z - 1e-9);
    // a flat first layer, then 1.5 mm up for every turn
    expect(pts[0].z).toBeCloseTo(DEFAULT_PRINT.firstLayerZ, 6);
    expect(pts[pts.length - 1].z).toBeCloseTo(DEFAULT_PRINT.firstLayerZ + 19 * 1.5, 6);
    const turn = r.toolpath.layerStart;
    for (let k = 2; k < turn.length; k++) expect(pts[turn[k]].z - pts[turn[k - 1]].z).toBeCloseTo(1.5, 6);
    expect(r.errors).toEqual([]);
    expect(r.collision?.count).toBe(0);
  });

  it('with flat layers asked for, the layers are flat and joined by the ramp', () => {
    const flat = { ...print, contourStrategy: 'layers' as const };
    const f = runBuild(pathProxy(path, flat), I, flat, { ...DEFAULT_ROBOT, originX: 0, originY: 500 }, 'p.3dm', bodies, undefined, undefined, [path]);
    expect(f.toolpath.warnings.map((w) => w.k)).toContain('i.extracted');
    expect(f.toolpath.travels).toBe(0);
    // 20 flat layers; from one to the next the bead climbs 1.5 mm along the ramp (20 mm), still printing
    const fp = f.toolpath.points;
    expect(new Set(fp.map((p) => +p.z.toFixed(3))).size).toBe(20);
    const ramps = fp.filter((p, i) => i > 0 && p.e && Math.abs(p.z - fp[i - 1].z - 1.5) < 1e-6 && Math.abs(Math.hypot(p.x - fp[i - 1].x, p.y - fp[i - 1].y) - DEFAULT_PRINT.layerRamp) < 1e-6);
    expect(ramps.length).toBe(19);
  });

  it('a loop far below the rest is not joined to it by a bead in the air', () => {
    const low = curvesToPath([face(40, 1, 0), face(36, 1, 0), ...[0, 1, 2, 3].flatMap((k) => [face(40, 10 + 1.5 * k, 0), face(36, 10 + 1.5 * k, 0)])], 8)!;
    const g = runBuild(pathProxy(low, print), I, print, { ...DEFAULT_ROBOT, originX: 0, originY: 500 }, 'p.3dm', bodies, undefined, undefined, [low]);
    const up = g.toolpath.points.findIndex((p) => p.z > 5);
    expect(g.toolpath.points[up].e).toBe(false);
    expect(g.toolpath.travels).toBe(1);
  });
});

describe('a path drawn as curves in a Rhino file', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rhino = (await (rhino3dm as any)()) as any;
  const polyline = (pts: number[][]) => {
    const pl = new rhino.Polyline();
    for (const p of pts) pl.add(p[0], p[1], p[2]);
    return pl.toPolylineCurve();
  };
  const file = (withMesh: boolean) => {
    const doc = new rhino.File3dm();
    doc.objects().addCurve(polyline([[0, 0, 1], [50, 0, 1], [50, 50, 1], [0, 50, 1], [0, 0, 1]]), null);
    doc.objects().addCurve(polyline([[0, 0, 2.5], [50, 0, 2.5], [50, 50, 2.5]]), null);
    doc.objects().addCurve(new rhino.Circle(20).toNurbsCurve(), null);
    if (withMesh) {
      const m = new rhino.Mesh();
      for (const v of [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]]) m.vertices().add(v[0], v[1], v[2]);
      for (const f of [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]) m.faces().addTriFace(f[0], f[1], f[2]);
      doc.objects().addMesh(m, null);
    }
    return new Uint8Array(doc.toByteArray());
  };

  it('curves only: they are the path, in the order of the file', () => {
    const model = parse3dm(rhino, file(false));
    expect(model.parts.length).toBe(0);
    expect(model.curves!.length).toBe(3);
    expect(model.curves![0].length / 3).toBe(5);
    // the circle is sampled finely: every point within 0.05 mm of radius 20
    const circle = model.curves![2];
    expect(circle.length / 3).toBeGreaterThan(40);
    for (let i = 0; i < circle.length; i += 3) expect(Math.abs(Math.hypot(circle[i], circle[i + 1]) - 20)).toBeLessThan(0.05);
    const path = curvesToPath(model.curves!)!;
    // every curve printed, the move onto a curve with the extruder off
    const starts = (p: { ext: Uint8Array }) => [...p.ext].map((e, i) => (e ? -1 : i)).filter((i) => i >= 0);
    expect(starts(path)).toEqual([0, 5, 8]);
    // a short step to the next curve (1.5 mm up to the next layer) is printed: the extruder stays on
    expect(starts(curvesToPath(model.curves!, 8)!)).toEqual([0, 8]);
  });

  it('curves in a layer named «Percorso» are the path even in a file with solids and other curves', () => {
    const doc = new rhino.File3dm();
    for (const name of ['Predefinita', 'Percorso stampa']) {
      const layer = new rhino.Layer();
      layer.name = name;
      doc.layers().add(layer);
    }
    const onPath = new rhino.ObjectAttributes();
    onPath.layerIndex = doc.layers().count - 1;
    // a guide curve on the default layer, then two path curves, then a solid
    doc.objects().addCurve(polyline([[0, 0, 0], [500, 0, 0], [500, 500, 0]]), null);
    doc.objects().addCurve(polyline([[0, 0, 1], [50, 0, 1], [50, 50, 1], [0, 50, 1], [0, 0, 1]]), onPath);
    doc.objects().addCurve(polyline([[0, 0, 2.5], [50, 0, 2.5], [50, 50, 2.5], [0, 50, 2.5], [0, 0, 2.5]]), onPath);
    const m = new rhino.Mesh();
    for (const v of [[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]]) m.vertices().add(v[0], v[1], v[2]);
    for (const f of [[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]]) m.faces().addTriFace(f[0], f[1], f[2]);
    doc.objects().addMesh(m, null);
    const model = parse3dm(rhino, new Uint8Array(doc.toByteArray()));
    expect(model.pathLayer).toBe('Percorso stampa');
    expect(model.curves!.length).toBe(2);
    expect(model.notes.map((n) => n.k)).not.toContain('n.curvesIgnored');
    expect(curvesToPath(model.curves!)!.xyz.length / 3).toBe(10);
  });

  it('with a solid in the file the solid is the part, and the curves are reported', () => {
    const model = parse3dm(rhino, file(true));
    expect(model.parts.length).toBe(1);
    expect(model.notes.map((n) => n.k)).toContain('n.curvesIgnored');
  });
});

