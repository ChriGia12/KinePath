// All user-tunable parameters. Robot defaults reproduce Tavolino1.src / CODICE PYTHON.txt.

/**
 * planar: outline per layer, constant Z (Tavolino1) · spiral: outline with Z rising along the
 * turn (vase mode) · zigzag: solid layers filled in serpentine · surface: serpentine over the
 * top surface only, following its height (non-planar).
 */
export type PrintMode = 'planar' | 'spiral' | 'zigzag' | 'surface';

export interface PrintSettings {
  layerHeight: number; // mm
  /** mm: contour layers change layer climbing along this length while printing (0 = vertical step). */
  layerRamp: number;
  /**
   * Contour layers / spiral: non-planar rings that follow the surface, every point one bead from
   * the previous ring (layerHeight in Z on steep walls, wallSpacing sideways on flat areas).
   */
  adaptiveLayers: boolean;
  /**
   * Contour print (`mode: 'planar'`): how it is laid. 'auto' chooses from the part (strategy.ts);
   * 'layers' flat layers with a ramp, 'spiral' vase mode, 'rings' rings following the surface.
   */
  contourStrategy: 'auto' | 'layers' | 'spiral' | 'rings';
  /** Way round every closed loop is printed, seen from above. */
  loopDirection: 'ccw' | 'cw';
  /**
   * Imported path: put its curves in printing order (lowest first, each started nearest to where
   * the one before ended) instead of taking them in the order and with the start points of the file.
   */
  importedExtract: boolean;
  /**
   * Removable supports under what hangs in the air (the mesh is never changed): none, printed in
   * the same program layer by layer, or in a separate program printed before the part.
   */
  supports: 'none' | 'inline' | 'separate';
  /** mm: own parts only — the part is cut this high above its lowest point and rests on the cut (removes material). */
  baseCut: number;
  firstLayerZ: number; // mm, nozzle height of the first layer above the table (Tavolino1: 0.5)
  walls: number; // number of concentric perimeters
  wallSpacing: number; // mm, bead width / distance between perimeters
  tolerance: number; // mm, max chord deviation from the exact contour
  maxSegment: number; // mm, split longer LINs (0 = off)
  mode: PrintMode;
  minContourLength: number; // mm, leave out shorter contours (0 = print everything); reported
  maxBridge: number; // mm, jumps shorter than this keep extruding (like Tavolino layer changes)
  travelLift: number; // mm, Z lift for travels with extruder off
  overhangAngle: number; // deg from vertical considered critical
  thinWallMax: number; // mm, hollow shells up to this thickness print as one mid-line (0 = off)
  /**
   * Thin-walled networks (honeycomb, grid): a wall the single walk must pass twice gets its two
   * passes side by side ('side', two beads wide there), or the second pass with the extruder off
   * ('off', nothing laid twice), or printed over the first ('print').
   */
  latticeRetrace: 'side' | 'off' | 'print';
  /** 'auto': start at the front-left of the part; 'point': start at the contour point nearest (startX, startY) in BASE. */
  fillAngle: number; // deg, direction of serpentine passes in plan
  fillAlternate: boolean; // turn passes 90° on every other layer / pass
  fillAutoAngle: boolean; // zigzag: per layer, the direction (0/45/90/135° from fillAngle) with fewest breaks
  fillPerimeter: boolean; // zigzag: print the outline (walls) before filling
  fillTopSurface: boolean; // zigzag: finish with layers that follow the top surface (non-planar)
  surfacePasses: number; // surface: how many layers stacked on the top surface
  surfaceMaxSlope: number; // surface: faces steeper than this (deg) are walls, not top
  surfaceTilt: boolean; // surface: tilt the tool with C following the surface normal
  /** Every other mode: the tool leans along the wall being printed, up to maxTilt degrees. */
  toolTilt: boolean;
  maxTilt: number;
  startMode: 'auto' | 'point';
  startX: number;
  startY: number;
}

export interface RobotSettings {
  programName: string;
  toolNumber: number;
  baseNumber: number;
  velCP: number; // m/s ($VEL.CP)
  advance: number;
  a: number;
  b: number;
  c: number;
  e1: number;
  e2: number;
  e3: number;
  e4: number;
  extruderAnout: number; // ON/OFF analog out
  extruderSpeedAnout: number; // speed analog out
  extruderSpeed: number; // 10 = 100%
  extruderDelay: number; // s
  useHoming: boolean;
  /** LIN approximation: C_DIS (like Tavolino1, smooth but corners are rounded) or exact stop on every point. */
  linApprox: 'C_DIS' | 'none';
  /**
   * 'file': keep the position the part has in the Rhino file (world) and convert to BASE by
   * subtracting worldBase — same as CODICE PYTHON.txt. 'origin': put the part's bbox
   * center/bottom at originX/Y/Z in the BASE frame.
   */
  placement: 'file' | 'origin';
  worldBaseX: number;
  worldBaseY: number;
  worldBaseZ: number;
  originX: number;
  originY: number;
  originZ: number;
  /** Rotation of the part around its vertical axis on the bed (deg). */
  rotationZ: number;
  bedSizeX: number;
  bedSizeY: number;
  /** Centre of the work table in BASE (the table stays put while the part moves). */
  bedCenterX: number;
  bedCenterY: number;
  /** Top of the work plate in BASE (mm): no toolpath point may go below it. */
  bedTopZ: number;
  safeAxes: [number, number, number, number, number, number];
  /** Controller BASE_DATA[baseNumber] {X,Y,Z,A,B,C}, relative to the robot root. */
  baseData: [number, number, number, number, number, number];
  /** Controller TOOL_DATA[toolNumber] {X,Y,Z,A,B,C}, relative to the flange. */
  toolData: [number, number, number, number, number, number];
}

export const DEFAULT_PRINT: PrintSettings = {
  layerHeight: 1.5,
  layerRamp: 20,
  adaptiveLayers: false,
  contourStrategy: 'auto',
  loopDirection: 'ccw',
  importedExtract: false,
  supports: 'none',
  baseCut: 0,
  firstLayerZ: 0.5,
  walls: 1,
  wallSpacing: 6,
  tolerance: 0.2,
  maxSegment: 0,
  mode: 'planar',
  minContourLength: 0,
  maxBridge: 8,
  travelLift: 10,
  overhangAngle: 45,
  thinWallMax: 10,
  latticeRetrace: 'side',
  fillAngle: 0,
  fillAlternate: true,
  fillAutoAngle: true,
  fillPerimeter: true,
  fillTopSurface: true,
  surfacePasses: 1,
  surfaceMaxSlope: 75,
  surfaceTilt: false,
  toolTilt: false,
  maxTilt: 30,
  startMode: 'auto',
  startX: 0,
  startY: 0,
};

export const DEFAULT_ROBOT: RobotSettings = {
  programName: 'Pezzo1',
  toolNumber: 11,
  baseNumber: 1,
  velCP: 0.8,
  advance: 5,
  a: -180,
  b: 0,
  c: 180,
  e1: 0,
  e2: 0,
  e3: 0,
  e4: 0,
  extruderAnout: 7,
  extruderSpeedAnout: 6,
  extruderSpeed: 2,
  extruderDelay: 1,
  useHoming: true,
  linApprox: 'C_DIS',
  placement: 'origin',
  worldBaseX: 1448,
  worldBaseY: -1000,
  worldBaseZ: 5,
  originX: 5,
  originY: 515,
  originZ: 38, // Z of the part base in BASE (on the plate by default); the plate itself is bedTopZ
  rotationZ: 0,
  bedSizeX: 640,
  bedSizeY: 1350,
  bedCenterX: 0,
  bedCenterY: 450,
  bedTopZ: 38,
  safeAxes: [0, -90, 90, 0, -1, 0],
  // Robot in the Rhino world at (0, −1000, 0) — centred on the table like the BASE, base
  // 32 mm below the top of the tavole. BASE (1448, −1000, 5) in world ⇒ (1448, 0, 5) from the robot.
  baseData: [1448, 0, 5, 0, 0, 0],
  toolData: [372.65, 0, 78.111, 0, 0, 0],
};
