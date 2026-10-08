// A contour print is laid in the way that suits the part, chosen from the part itself.
import { describe, expect, it } from 'vitest';
import { applyEdits, pathSignature } from '../src/core/edits';
import { weld, type MeshData } from '../src/core/mesh';
import { DEFAULT_PRINT } from '../src/core/settings';
import { resolveStrategy, shallowShare } from '../src/core/strategy';
import { buildToolpath } from '../src/core/toolpath';
import { box, cylinder } from './fixtures';

/** An open dome (no bottom): steep at the rim, almost flat at the top. */
function dome(r = 60, seg = 48, rings = 24): MeshData {
  const pos: number[] = [];
  const idx: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const a = ((i / rings) * Math.PI) / 2;
    for (let j = 0; j < seg; j++) {
      const b = (j / seg) * Math.PI * 2;
      pos.push(r * Math.cos(a) * Math.cos(b), r * Math.cos(a) * Math.sin(b), r * Math.sin(a));
    }
  }
  for (let i = 0; i < rings; i++)
    for (let j = 0; j < seg; j++) {
      const [a, b, c, d] = [i * seg + j, i * seg + ((j + 1) % seg), (i + 1) * seg + ((j + 1) % seg), (i + 1) * seg + j];
      idx.push(a, b, c, a, c, d);
    }
  return weld({ positions: new Float32Array(pos), indices: new Uint32Array(idx) });
}

describe('how a contour print is laid', () => {
  it('an open shell with almost flat areas: rings following the surface, and the result says why', () => {
    const m = dome();
    expect(shallowShare(m, DEFAULT_PRINT)).toBeGreaterThan(0.03);
    const r = resolveStrategy(m, DEFAULT_PRINT);
    expect(r.settings.adaptiveLayers).toBe(true);
    expect(r.why?.k).toBe('i.autoRings');
    expect(buildToolpath(m, DEFAULT_PRINT).warnings.map((w) => w.k)).toContain('i.autoRings');
  });

  it('a closed solid: flat layers', () => {
    for (const m of [weld(box(60, 60, 30)), weld(cylinder(40, 30, 60))]) {
      const r = resolveStrategy(m, DEFAULT_PRINT);
      expect(r.settings.adaptiveLayers).toBe(false);
      expect(r.settings.mode).toBe('planar');
      expect(r.why).toBeNull();
    }
  });

  it('with supports the layers stay flat, and the result says the rings were left out', () => {
    const r = resolveStrategy(dome(), { ...DEFAULT_PRINT, supports: 'inline' });
    expect(r.settings.adaptiveLayers).toBe(false);
    expect(r.why?.k).toBe('i.autoRingsSupports');
  });

  it('an explicit choice is always respected', () => {
    const m = dome();
    expect(resolveStrategy(m, { ...DEFAULT_PRINT, contourStrategy: 'layers' }).settings.adaptiveLayers).toBe(false);
    expect(resolveStrategy(weld(box(60, 60, 30)), { ...DEFAULT_PRINT, contourStrategy: 'rings' }).settings.adaptiveLayers).toBe(true);
    expect(resolveStrategy(weld(cylinder(40, 40, 60)), { ...DEFAULT_PRINT, contourStrategy: 'spiral' }).settings.mode).toBe('spiral');
    expect(buildToolpath(weld(cylinder(40, 40, 60)), { ...DEFAULT_PRINT, contourStrategy: 'spiral' }).mode).toBe('spiral');
    // the other print types are never touched
    expect(resolveStrategy(m, { ...DEFAULT_PRINT, mode: 'zigzag' }).settings.mode).toBe('zigzag');
  });

  it('loops can be printed the other way round', () => {
    const turn = (dir: 'ccw' | 'cw') => {
      const tp = buildToolpath(weld(cylinder(40, 40, 6)), { ...DEFAULT_PRINT, loopDirection: dir, layerRamp: 0 });
      const loop = tp.points.filter((p) => p.z === tp.points[0].z);
      let a = 0;
      for (let i = 1; i < loop.length; i++) a += loop[i - 1].x * loop[i].y - loop[i].x * loop[i - 1].y;
      return Math.sign(a);
    };
    expect(turn('ccw')).toBe(1);
    expect(turn('cw')).toBe(-1);
  });
});

describe('changes made by hand to a path', () => {
  const path = () => buildToolpath(weld(box(60, 60, 6)), { ...DEFAULT_PRINT, layerRamp: 0 });

  it('a stretch can be printed or not', () => {
    const tp = path();
    const before = tp.printLength;
    expect(applyEdits(tp, [{ op: 'extruder', from: 2, to: 3, on: false }])).toBe(1);
    expect([tp.points[2].e, tp.points[3].e]).toEqual([false, false]);
    expect(tp.printLength).toBeLessThan(before);
    applyEdits(tp, [{ op: 'extruder', from: 2, to: 3, on: true }]);
    expect(tp.printLength).toBeCloseTo(before, 6);
  });

  it('a stretch can be moved', () => {
    const tp = path();
    const z = tp.points[4].z;
    applyEdits(tp, [{ op: 'shift', from: 4, to: 5, dx: 1, dy: -2, dz: 0.5 }]);
    expect(tp.points[4].z).toBeCloseTo(z + 0.5, 9);
    expect(applyEdits(tp, [{ op: 'shift', from: 4, to: 5, dx: NaN, dy: 0, dz: 0 }])).toBe(0);
  });

  it('points can be taken out: the layers still start where they did, nothing is printed across the gap', () => {
    const tp = path();
    const n = tp.points.length;
    const second = tp.layerStart[1];
    applyEdits(tp, [{ op: 'delete', from: 2, to: 3 }]);
    expect(tp.points.length).toBe(n - 2);
    expect(tp.layerStart[1]).toBe(second - 2);
    expect(tp.points[2].e).toBe(false);
    // never fewer than two points
    expect(applyEdits(tp, [{ op: 'delete', from: 0, to: tp.points.length - 1 }])).toBe(0);
  });

  it('the signature changes when the path does', () => {
    const a = pathSignature(path());
    expect(pathSignature(path())).toBe(a);
    expect(pathSignature(buildToolpath(weld(box(60, 61, 6)), { ...DEFAULT_PRINT, layerRamp: 0 }))).not.toBe(a);
  });
});
