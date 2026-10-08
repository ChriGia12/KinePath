// How a contour print is laid, chosen from the part itself. "Contour" is one print type for the
// user; under it the path may be flat layers, a spiral, or rings that follow the surface. With
// `contourStrategy: 'auto'` the choice is made here and the reason is reported with the result.
import { msg, type Msg } from '../i18n';
import { isOpenMesh, type MeshData } from './mesh';
import type { PrintSettings } from './settings';

/** Share of the surface, above which flat layers would leave gaps, that makes rings worth it. */
export const SHALLOW_SHARE = 0.03;

/**
 * Share of the mesh area so close to horizontal that two flat layers one above the other land
 * further apart than a bead: printed as flat layers, the beads there do not touch and the shell
 * has gaps. On a face with unit normal n, layers `h` apart are h·|nz| / √(1 − nz²) apart in plan.
 * Faces that are exactly flat are left out.
 */
export function shallowShare(mesh: MeshData, s: Pick<PrintSettings, 'layerHeight' | 'wallSpacing'>): number {
  const p = mesh.positions;
  const ix = mesh.indices;
  let total = 0;
  let shallow = 0;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
    const [ux, uy, uz] = [p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]];
    const [vx, vy, vz] = [p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]];
    const [nx, ny, nz] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const area = Math.hypot(nx, ny, nz) / 2;
    if (!(area > 0)) continue;
    total += area;
    const side = Math.hypot(nx, ny);
    // A truly flat face (a lid) is not counted: it is a bridge over the inside, not a slope the
    // rings can climb one bead at a time.
    if (side > 0.01 * area * 2 && s.layerHeight * Math.abs(nz) > s.wallSpacing * side) shallow += area;
  }
  return total ? shallow / total : 0;
}

/**
 * The settings the path is actually built with. Only a contour print (`mode: 'planar'`) without an
 * explicit choice is decided here; the result has `contourStrategy: 'layers'`, so resolving it
 * again changes nothing.
 *
 *  - an open shell (a hull, a dome) with almost flat areas → rings following the surface: flat
 *    layers would leave gaps there. Not with supports, which are built on flat layers.
 *  - a closed solid → flat layers: its flat lids are not a contour to follow (that is a fill).
 *  - a spiral is used only when asked: flat layers already climb along a ramp like one thread.
 */
export function resolveStrategy(mesh: MeshData, s: PrintSettings): { settings: PrintSettings; why: Msg | null } {
  if (s.mode !== 'planar' || s.adaptiveLayers || s.contourStrategy === 'layers') return { settings: s, why: null };
  const done = { ...s, contourStrategy: 'layers' as const };
  if (s.contourStrategy === 'spiral') return { settings: { ...done, mode: 'spiral' }, why: null };
  if (s.contourStrategy === 'rings') return { settings: { ...done, adaptiveLayers: true }, why: null };
  const share = shallowShare(mesh, s);
  if (share > SHALLOW_SHARE && isOpenMesh(mesh)) {
    if (s.supports === 'none') return { settings: { ...done, adaptiveLayers: true }, why: msg('i.autoRings', { p: Math.round(share * 100) }) };
    return { settings: done, why: msg('i.autoRingsSupports', { p: Math.round(share * 100) }) };
  }
  return { settings: done, why: null };
}
