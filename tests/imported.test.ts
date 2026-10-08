// A path made elsewhere (a KRL program from Grasshopper) is taken as it is: the site places it,
// checks it and writes the complete program around it — what the Python post-processor did.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { cellBodies, type CellPart } from '../src/core/collision';
import { parseSrc, pathProxy } from '../src/core/imported';
import { computeBounds, IDENTITY, type Mat3 } from '../src/core/mesh';
import { runBuild } from '../src/core/pipeline';
import { DEFAULT_PRINT, DEFAULT_ROBOT } from '../src/core/settings';

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
