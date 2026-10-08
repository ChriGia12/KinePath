# KinePath

*[Versione italiana](README.md)*

Website that replaces the Rhino/Grasshopper chain for **robotic extrusion 3D printing with KUKA**:

1. you load a **mesh or BREP** model,
2. the site proposes the best **orientation**; you choose the **print mode** (default: contour layers),
3. it computes the **toolpath that follows the contour** of the part within the set tolerance (default 0.2 mm), layer by layer,
4. it exports the **KUKA `.src`** file with the same structure as `Tavolino1.src` (INI, BASE/TOOL, extruder I/O, `LIN … C_DIS`, shutdown, homing).

Everything runs in the browser (TypeScript + Three.js + WebAssembly): the model is never uploaded to a server.

The site is in **Italian and English**: the EN / IT button at the top right switches the whole page (warnings, notes and orientations already computed included) and the choice is saved in the browser.

**Checks before export.** The *Download .src* button stays disabled:
- while a computation is running or after any change, until the latest computation has finished (an outdated result can never be downloaded);
- if a parameter is outside its admitted values ($VEL.CP, ANOUT outputs, n° of layers, safe position and homing pose within the axis limits, …): parameters are checked *before* computing, so an excessive value does not even start it;
- `BASE_DATA[1]`, `TOOL_DATA[11]` and E1–E4 = 0 are locked: they are the only configurations whose measurements the simulation and the reach check know;
- if the robot cannot reach a toolpath point or an intermediate point of a LIN (sampled every 20 mm), or an axis exceeds the KR16 limits;
- if a toolpath point goes below the work table (plate at Z 38 in BASE): this cannot be confirmed;
- if a number field is empty or invalid;
- if the toolpath leaves the work table in plan, if with *tilt tool* some points have a slope along X that cannot be followed, or if in the chosen orientation the part has islands starting in mid-air or more than 2% of its surface overhanging beyond the critical angle: these cases need an explicit confirmation, reset at every change.

**Collisions.** The path is replayed bead by bead: in every pose forearm, wrist (A3–A6) and spindle, sampled from the real cell geometry, must not touch the plate or the material already deposited (4 mm grid; the nozzle, which touches the bead by design, is checked only against the plate). Poses are checked every 3 mm of path, inside long LINs too: an obstacle halfway along a segment whose ends are clear is found. The same check covers the PTP moves of the program: safe position → first point, last point → safe position and homing (axis interpolation, as the controller does, one pose every 0.5° of the axis that moves most). A collision blocks the export and the points involved are shown in magenta in the view.

**Parts to cut.** If a part cannot be printed without supports in any orientation, the site looks by itself for where to cut it in two: it tries planes across the three sides of the part (25 to 75% of its length) and, for each piece, resting on the cut or turned over. If it finds a cut with which both pieces pass the checks (no islands in mid-air, overhangs within the limit), it suggests it in the Model card: where to cut (orange plane in the view), how to place each piece and with which print mode. *Cut in 2 pieces* applies everything: two pieces already oriented, printed one after the other. A cut solid stays closed (the cut becomes a flat face); an open shell stays open. If cutting does not really help, the site does not suggest it. For open shells (a hull without deck) overhangs count both ways: a one-bead shell flatter than the limit sags whether it faces up or down.

**Manual cut.** The *Cut the part* section is always in the Model card: choose the plane (horizontal, or vertical across X or Y of the plate) and the position with the slider or in mm; the plane shows in orange in the view and *Cut here* splits the selected part into two pieces that stay turned as before (with a horizontal cut the top piece rests on the cut). After the cut each piece keeps its turn only if it prints without supports that way, otherwise it takes the best orientation; if the pieces overlap or leave the table, the site lays them out again by itself (side by side along Y, 70 mm apart, in more columns if needed, the group centred). Each piece can then be oriented, placed or cut again, to print the complicated zones apart.

**Cut at the base (losing nothing).** If the open edge of a part touches the table only in part (an upside-down hull whose edge rises towards bow and stern), the cut section offers *Cut at the base* with the height already computed: the part is cut there, the part above rests flat on the cut and the band below is turned over onto the cut (its curved edge free on top) and printed beside it. The whole mesh is printed, in two pieces to glue along the cut, with no steps and no supports.

**Printing direction.** Every closed loop always runs the same way round (counter-clockwise from above), holes and rings following the surface included: at the layer change the ramp carries on forwards on the new loop. Only open arcs (the sections of an open shell) go back and forth, otherwise each layer would need a lifted jump; at the end of an arc the nozzle goes straight up and runs back along the arc above, without lifting. Short links are printed when they lie over printed material (inside closed sections, or along the band of an open arc or of a support, of this layer or the one below); where the mesh has a real gap the robot jumps, because joining the two sides would add material that is not in the mesh.

**Tool tilt along the wall** (every mode but surface): the tool leans like the wall it is printing, up to *Maximum tilt* (30° by default), so on overhangs the bead is pushed against the layer below instead of being laid in the air. Vertical walls and flat lids keep the tool vertical, and the direction is smoothed along the path so that the wrist turns gradually. With A −180 / B 0 the tool can tilt only in the Y-Z plane: slopes along X are reported and need a confirmation, as in surface mode.

**Risk zones.** The part shows in orange the faces overhanging beyond the critical angle, in red the outline of islands starting in mid-air and in yellow the walls thinner than one bead (they would not be printed). They are hidden with the *Risk zones* box.

**The whole mesh is printed.** Every layer prints exactly the section of the mesh: no base invented under the part, no piece cut off or dropped because thin or small (even islands too small for the serpentine are printed with their outline). The site may only move or turn the part and add supports to remove; if something cannot be printed it says so. *Minimum contour* is 0 (print everything): if you raise it, the contours left out are counted in the warnings.

**Limits.** The collision check uses a sampling of the geometry (points every 8 mm on the spindle, 25 mm on the arm) and ignores the upper arm, the base and the boards outside the plate. The check of the intermediate LIN points covers the programmed geometric path, not the blended trajectory the controller runs with `C_DIS` (default, like Tavolino1): with `C_DIS` the robot does not pass exactly through every point; the option *LIN approximation → None* makes the robot stop on every point. Before printing, the `.src` must still be run dry or in the simulation of the real cell.

## Fixed cell

When the site opens it already shows the cell, which cannot be moved or removed:

- **KUKA KR16 R2010** posed with its real kinematics (axes measured from the CAD: A2 at 160/520 mm, upper arm 980 mm, forearm 150/860 mm, flange 153.9 mm from the wrist);
- **spindle** mounted on the flange: its tip matches `TOOL_DATA[11] = {X 372.65, Y 0, Z 78.111}`;
- **boards and work plate** (print table at Z 38 in the BASE frame, 640 × 1350 mm).

The geometry comes from `BASE ROBOT.3dm` and is stored in `public/cell.bin` (≈2 MB). To rebuild it:

```bash
node scripts/build-cell.mjs "/path/BASE ROBOT.3dm"
```

The robot stands in the Rhino world at (0, −1000, 0): the point drawn in `BASE ROBOT.3dm` moved by −1000 in Y, centred on the table like the BASE, with its base 32 mm below the top of the boards. The BASE of the Python post-processor, (1448, −1000, 5) in world coordinates, is therefore at (1448, 0, 5) from the robot.

**Tool orientation.** The spindle axis is the TCP Z axis, as calibrated on the robot: with A = −180°, B = 0° the C parameter tilts the tool (C 180 = vertical pointing down, C 135 ≈ 45°, C 90 / 270 = horizontal). With A −180 / B 0 / C 180 the robot works vertically above the point. The spindle is mounted with its plate on the flange face and its axis parallel to it (KUKA FLANGE frame: Z out of the flange, as in `TOOL_DATA` and in the Mandrino layer drawing): with the tool vertical the flange faces sideways and the wrist is bent, as on the real robot.

**Simulation.** The *▶ Simulate* button makes the robot run the `LIN` moves of the `.src` file, at the real speed ($VEL.CP) multiplied by 1–500×. The part of the path already run is coloured, the rest stays light grey; below you see the current `LIN` line, the X/Y/Z/A/B/C values written in the file and the A1–A6 angles. The slider jumps to any move, the layer slider to the end of a layer. The PTP moves (change of part, change of program with separate supports) are played in the axes, as the controller interpolates them. For every point the site solves the inverse kinematics and flags points out of reach or beyond the axis limits.

## Quick start

1. **Load the part**: a mesh or a BREP. Every file adds a part to the list: the parts are printed one after the other, in the order of the list, each with its own orientation and position (a new part goes beside the others, 70 mm apart, the room the spindle needs to pass beside a finished part; while two parts overlap the export is blocked until you separate them). Parts are moved by **dragging them in the view** (while dragging their footprint shows, green if it fits on the table, red if not); *Arrange on the table* lays them out again at any time. Click a part in the list to edit it, ↑ ↓ to change the printing order, × to remove it. From a `.3dm` with the whole scene only the object standing on the work table is used. **Scale**: below the list, for the selected part (×1000 for files in metres, ×10 in centimetres, ×25.4 in inches, or any value); if a part is smaller than 2 mm or larger than 5 m the site warns that the unit is probably wrong.
2. The site proposes the best orientation of the selected part (Orientation section); choose the print mode in *Printing*.
3. **Place part**: click on the plate in the view to move the centre of the selected part; the rotation on the table is in *KUKA robot and table → Part rotation Z*.
4. **Start point**: click near the contour where printing should start (light blue dot).
5. **Download .src**. **PDF sheet** opens a summary sheet (image, parts, outcome of every check, result, settings) to print or save as PDF.

**Change of part.** With several parts, once a part is finished the site switches the extruder off, goes straight up with a LIN without blending to 30 mm above what is already printed, moves above the next part with a `PTP` and goes down with a LIN where printing resumes (extruder on again). These PTPs go through the collision check as well, with the controller's axis interpolation.

**Ready-made path (from Grasshopper).** For parts whose path is better drawn by hand, load the `.src` (or `.txt`) file written by Grasshopper / KUKA|prc directly, like any part. The site takes the `LIN` points in the order of the file, **as they are**, and does what the Python script used to do, plus the checks: it recomputes the coordinates for the chosen position, sets the tool orientation (A/B/C) and external axes chosen here, and writes the complete program (start, extruder, safe position, homing). Everything else in the file (header, PTPs, speeds, A/B/C) is ignored. If the file has extruder commands (`$OUT[16]`, `$ANOUT[7]`) they are followed; if not, as in raw Grasshopper files, the whole path is printed and the stretches to run with the extruder off are chosen with *Edit path*. The path is moved by dragging it, with *Place part*, with the *Centre X/Y* and *Part rotation Z* fields, and the `.src` is written again at every change: with *Centre on the given point* its lowest point goes *First pass above the table* over the plate; with *Keep file position* the BASE origin (1448 / −1000 / 5) is subtracted from every point, exactly as the script did. All checks (reach, axis limits, points below the plate, collisions) and the simulation apply to the path. The view shows the beads of the path. There is no need to load the mesh of the part too: it would be printed as a second part.

The same goes for the **curves of a Rhino `.3dm` file**: every curve is a printed stretch, in the order of the file (polylines with their own points, other curves sampled within 0.05 mm). The move from one curve to the next is printed when shorter than *Jump without stop* (the climb to the layer above of a path drawn layer by layer), otherwise it is made with the extruder off. The curves are the path in two cases: when they are in a **layer named “Percorso”** (or “Toolpath”), even if the file holds the whole scene with robot, cell and solids — a bake from Grasshopper into the working file —, or when the file holds curves only. Otherwise the solid is the part and the curves are only reported.

**The object as a reference model.** If the file with the path (curves in the “Percorso” layer) also holds the object it was drawn on, the object is imported as a reference: it is shown in the view, it is what rests on the plate, and the path stays **exactly where it is on it**, height included (without the object the lowest point of the path would be laid *First pass above the table* over the plate, losing its true height). From a whole scene the object standing on the work table is taken. The object is **never used to compute a path** and is not printed: it serves to place the path and, with *Lean the tool*, to orient the tool — along the normal where the bead is laid on a surface of the object (a face within 60° of the horizontal), along the wall beside a wall. The collision check considers the material laid by the path, not the reference object: when printing on top of an existing part, keep that part in mind in the dry run.

**The imported path can be changed**, it is not just copied. The site reads it as a series of stretches — a stretch ends where the extruder stops, where a flat layer steps up to the next, or where the path comes back onto the point the stretch started from — and recognises the **closed loops** (also those written without their last side, when from their last corner the path climbs to the start of the layer above).
- **Start point**: once chosen (*Start point* button or the *Start X/Y* fields), every closed loop starts from its point nearest to it, even in the middle of a side; the loop stays the same, only where it begins changes. A path made of **open passes** (a serpentine over a surface, like the Grasshopper Contour on vertical planes) can start from any of its ends: the site picks the one nearest to the chosen point, walking the same passes from the other end — each the other way round, or in reverse order, or both. The order is reversed only when the path is one layer: if it is layered (some of the path lies on top of the rest) it stays bottom-up, and only the ends of the first layer can be chosen. A continuous spiral starts where it starts.
- **Tool leaning along the wall**: the wall is read from the path itself — below every point lies the layer printed before, and the direction from its nearest point to this one is the wall. The tool follows it up to *Maximum tilt*; it stays vertical on the first layer (laid on the plate, no wall below) and where the "wall" would be flatter than 60° from the vertical (the neighbouring passes of a surface made in one layer).
- **Extract the right path** (button below the model): builds the path to print from the curves of the file, instead of repeating them one by one. Flat curves are read as the sections of a part, one layer per height from the bottom up, and treated like the sections the site computes itself: a wall drawn with **two curves one inside the other** (its outer and inner face, up to *Thin walls → mid-line*) becomes **one loop along its mid-line**; loops start one above the other and the same way round (*Way round of the loops*, *Start point*); and where every layer is a single loop the path is **one spiral** climbing from layer to layer by the distance between the curves, with no seams and the extruder never stopping (vase mode), with a flat first turn and a flat closing turn at the top. With *Flat layers* chosen the layers stay flat, joined by the ramp. A climb larger than the step between the layers is never printed across. Curves that are not flat (passes over a surface) are not sections: they keep the order of the file and only the starting end of each is set. The result says how many layers, how many merged loops, how much spiral and the moves with the extruder off before and after; pressing the button again gives the curves of the file back.
- **Position, turn, scale**, tool orientation A/B/C, speed, extruder, and *Edit path* for single stretches.

Cut, part orientation, supports and the choice of print type do not apply: they concern how the site computes a path, and this one is already made.

**Edit path.** If the computed path is not right somewhere, *Edit path* (below the simulation) changes it by hand: give a stretch from its start LIN to its end LIN (*here* takes the LIN shown by the slider) and print it with the extruder off or on, move it by ΔX/ΔY/ΔZ, or delete its points. *Undo last* and *Remove all* go back. Edits are applied to the finished path **before** the checks: reach, axis limits and collisions are run again on the edited path, and the result warns that the printed part may no longer match the mesh. They hold only for the path they were made on: if it changes (a setting, the orientation, the position) they are removed and the site says so. They are not applied with supports in a separate file.

**Projects.** *Save project* downloads a `.kinepath` file with the original files of the parts, their orientation and position and all the settings; *Open project* (or dropping the file on the upload area) brings the site back to exactly that state.

## Supported formats

| Format | How it is read |
|---|---|
| STL, OBJ, PLY | Three.js loaders (units assumed mm) |
| 3DM (Rhino) | rhino3dm: meshes, polysurfaces and extrusions (using the render meshes saved in the file), SubD. Units converted to mm |
| STEP, IGES, BREP | OpenCascade (occt-import-js), 0.1 mm tessellation |
| SRC, TXT (KRL program) | ready-made path: the `LIN` points of the file, used as they are |

The rhino3dm and OpenCascade libraries are served by the site itself (`public/vendor`, copied from `node_modules` at every build): importing needs no CDN and no network.

> `.3dm` polysurfaces without render meshes (files saved with "Save Small") cannot be read: open the file in Rhino in shaded view and save it again, or export STEP.

## How it works

- **Exact slicing**: every layer is the intersection of a plane with the mesh; segments are chained through the mesh topology (shared edges), so contours are closed and follow the real geometry. Douglas–Peucker simplification with adjustable tolerance (default 0.2 mm), optional splitting of long LIN moves (like "Divide Length").
- **Orientation**: tries ±X/±Y/±Z and the largest flat faces of the convex hull. Scored on overhangs beyond the critical angle, islands starting in mid-air, contours per layer (each separate contour = an extruder stop), contact area, height. Before scoring, every orientation goes through the hard checks (no islands in mid-air, overhangs within 2%): those that fail are marked *not valid* and listed last. If none is valid the site says so and export requires the confirmation.
- **Three print types**: *Contour* (follows the walls of the part), *Fill* (every layer solid, in serpentine) and *Surface* (serpentine over the top surface). For the contour, *Contour: how to lay it* is **Automatic** by default: the site chooses from the part and the result says what it chose and why. An open shell (hull, dome) with more than 3% of almost flat surface — where two flat layers would land further apart than a bead, leaving the loops apart — is printed as *rings following the surface*; a closed solid in *flat layers* (its flat lids are not a contour to follow: that is what the fill is for); thin walls and networks along their mid-line. With supports the layers stay flat and the result says so. A manual choice is always possible: flat layers, spiral, rings. *Way round of the loops* sets counter-clockwise or clockwise.
- **Contour layers**: *contour layers* by default (one loop per layer; at the layer change the bead does not go straight up but carries on along the new loop climbing gradually over *Layer change ramp* mm, 20 by default, like one continuous thread; 0 = vertical step like Tavolino1); between separate contours the extruder is switched off, the nozzle lifted and restarted. The other modes (spiral, solid, surface) are chosen from the menu: see the table below. The spiral is used only when every layer is a single contour, otherwise it falls back to planar layers.
- **Verified links**: a connection between two segments is extruded only if it is short (*Jump without stop*, or up to 8 beads between neighbouring serpentine passes) **and** stays on the material along its whole length (inside the layer section, or on the top surface in surface mode), with a margin of at most 1 mm. All others become lifted travels with the extruder off. The heuristic choices (pass direction, order) are made only among paths whose links passed this check.
- **Curves following the surface** (option of *contour layers* and *spiral*): with planar layers the whole ring has one Z, so on shallow surfaces (domes, hulls) the rings drift apart and on steep ones they squash. With the option the rings are not flat: **every point** is one bead from the previous ring, measured along the surface, and the distance accounts for the bead width: one layer height in Z on steep walls, one bead width sideways on flat areas (beads side by side, not overlapping), in between Δz = min(layer height; bead width · tan slope). The rings go up until the whole surface is closed (flat lids too). In contour layers a ring moves to the next one with a short printed step (continuous bead); in spiral it is one path where every turn climbs towards the next ring point by point. The rings always go round the part: as long as the sections are not complete loops (an open edge that is not flat, a part touching the table at a point) the bottom is printed as in contour layers, with the base of the first full outline, and the rings start from the first complete loop. The computation uses fast marching on the mesh, with large triangles split to half a bead.
- **Supports**: *none*, *in the same program* (layer by layer) or *in a separate file* printed before the part. For every layer the part that does not rest on the layer below (beyond the critical angle) is found; that area goes down to the table as a column. Each column gets its outline and, in wide areas (the flat top of a shell, the underside of a cap), a sparse zig-zag every 3 beads, as one continuous line; nearby columns are merged into one block. A separation layer is left under the part, so the support comes off cleanly. With the separate file two programs are downloaded, `name_SUP.src` (supports, run first) and `name.src` (the part, identical to the one without supports); simulation and collision check run them in sequence as the robot does (end of the supports → safe position → homing → safe position → first point of the part), with the supports already printed as an obstacle; the simulation plays these PTP moves in the axes. The name of the support program stays within the 24 KRL characters: the part's name is shortened to leave room for `_SUP`. The separate file is not possible with several parts or with curves following the surface: then the supports go in the same program. In the view the supports are grey.
- **Cut the base** (own parts only): the part is cut at this height and rests on the cut. It removes material: the result warns that the printed part is not the whole mesh.
- **Thin walls and networks**: where the part is at most *Thin walls → mid-line* thick (10 mm by default) the outline is not printed — that would lay two overlapping beads — but **one bead along the mid-line**. This holds for a hollow shell, a single wall and a **network** (honeycomb, grid, ribs): the walls become a graph of mid-lines meeting at junctions, and the site walks it with **one path per layer**, without jumping from cell to cell. A graph can be drawn in one stroke without passing twice only when at most two junctions have an odd number of walls (Euler); in a honeycomb every junction has three, so some walls must be passed again: the site picks the shortest set of walls to make twice and, by default, lays **two beads side by side** there, half a bead each side of the mid-line: the extruder never stops and no bead lies on another (that wall comes out two beads wide, so wider than the mesh: it is the only way to make a honeycomb in one stroke, as 3D printers do). In *Networks* you can choose instead to pass again **with the extruder off, without lifting** (no wall gets double material, but the extruder stops and restarts at every pass) or to pass again printing over the first bead. The next layer starts where the one below ended, straight up. Mid-lines are found by thinning the section on a 0.4 mm grid and then centring every point exactly between the two faces of its wall; if they do not cover the whole section, the section is printed as it was.
- **Multiple walls**: inward offsets with Clipper.

### Print modes

| Mode | What it does |
|---|---|
| Contour · flat layers | the contour of every layer at constant Z, +layer height at each layer (like Tavolino1) |
| Contour · spiral | as above but Z rises along the turn (vase mode), no seam |
| Contour · rings following the surface | non-planar rings, every point one bead from the previous ring (see above) |
| Fill (solid serpentine) | the solid part with a continuous serpentine (pass after pass, like a lawn mower), optional outer contour. Whole planar layers up to below the lowest point of the top surface; then, with *blended layers*, N non-planar layers that go from flat to the shape of the surface (layer k at cut height + (surface − cut)·k/N): each covers the whole section, only its thickness changes (≈ ½–1½ layer heights), the last one is the real surface. No islands form and the extruder never stops (saddle: 13 planar + 17 blended, 0 stops). Automatic pass direction (0/45/90/135°, fewest breaks) |
| Surface (top, serpentine) | non-planar: the serpentine follows the top surface of the part (faces steeper than *max slope* are sides and are excluded), half a bead from the border; several stacked layers with *n° of layers*. With *tilt tool* the C parameter follows the slope in the Y-Z plane (C = 180° − arccos(Nz) for slopes along Y, as in the A −180 / B 0 calibration); a slope along X cannot be expressed with C alone and is reported. Without the option the tool stays vertical. The result shows the *coverage*: the share of the top surface actually covered by the union of the deposited beads (≤ 2 mm grid), so local holes lower it; it is a grid measure, not a continuous check of every point |

## Position on the robot

Two modes (section *KUKA robot and table*):

- **Centre on the given point**: the centre of the part goes to `X/Y` and its base to *Part Z in BASE* (default 38, i.e. resting on the plate); the first pass is 0.5 mm above → Z 38.5 like Tavolino1. The field moves the part, not the plate: the plate and its grid always stay at Z 38, so a part placed lower is seen sinking into the table and export is blocked.
- **Keep the file position**: uses the position of the part in the Rhino file and subtracts the BASE origin in world coordinates (default 1448 / −1000 / 5, from the Python post-processor).

The controller data (`BASE_DATA[1]`, `TOOL_DATA[11]`, E1–E4 = 0) are fixed and used for the simulation and the reach check. The `.src` calls the controller's `BASE_DATA[1]` and `TOOL_DATA[11]` and, apart from the `LIN`/`PTP` moves, is byte-for-byte identical to `Tavolino1.src`.

All parameters are saved in the browser.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npm test         # engine tests (slicing, toolpath, orientation, KUKA writer)
npm run test:ui  # UI tests in a real browser (Playwright, Chromium)
npm run build    # static site in dist/
```

**Reference part.** `tests/data/sella.stp` goes through the whole chain (STEP import, orientation, toolpath in the three modes, checks, `.src`) and the result is compared with the one saved in `tests/golden/`. If a change alters even one line of the `.src` the test fails; when the change is intended, the references are regenerated with:

```bash
npx vitest run -u
```

Optional test on a real Rhino file:

```bash
GB_SAMPLE_3DM="/path/file.3dm" GB_SAMPLE_LAYER="Livello 04" GB_SAMPLE_INDEX=0 npx vitest run tests/real-file.test.ts
```

Every push to `main` runs the tests and publishes the site on GitHub Pages.

## Structure

```
src/core/loaders.ts      file import → mesh (per layer/object)
src/core/mesh.ts         indexed mesh, vertex welding, transforms
src/core/slicer.ts       plane/mesh intersection → closed contours
src/core/walls.ts        inner walls and shell mid-line (Clipper)
src/core/lattice.ts      thin-walled networks: mid-lines and single path
src/core/strategy.ts     automatic choice of how to lay the contour
src/core/edits.ts        edits made by hand to the path
src/core/imported.ts     ready-made path: reads the LINs of a .src
src/core/orientation.ts  orientation analysis
src/core/toolpath.ts     toolpath: contour layers, spiral, solid, surface
src/core/zigzag.ts       serpentine fill and pass ordering
src/core/surface.ts      top surface: projection, normals, C parameter
src/core/kuka.ts         KRL .src writer
src/core/pipeline.ts     orientation → toolpath → .src
src/worker.ts            computation in a Web Worker
src/viewer.ts            3D view, clicks on the table
src/core/robot.ts        KUKA frames, KR16 forward/inverse kinematics
scripts/build-cell.mjs   extracts robot, boards and spindle from BASE ROBOT.3dm
public/cell.*            fixed cell
src/main.ts              user interface
src/i18n.ts              IT / EN translations
```
