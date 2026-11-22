# GeoFE Web

A browser-based 2D geotechnical finite element program. It follows the workflow of desktop geotechnical FE codes
(geometry, mesh, materials, boundary conditions and loads, staged analysis, factor of safety by strength reduction,
plots), but is an original implementation: plain JavaScript ES modules, no framework, no FE library. The mesher,
the solver and the post-processor are written from scratch and run in Node as well as in the browser.

## Features

- **Geometry**: polygon and rectangle regions, internal lines, vertex editing (shared vertices move together),
  snapping, undo/redo, coordinate-table editing. Regions that touch stay conforming (T-junctions and crossings are
  resolved automatically).
- **Mesh**: constrained Delaunay + Ruppert/Ungor refinement with exact predicates. T3 or T6 elements, minimum angle
  about 30 degrees on the examples, conforming to region interfaces and internal lines, local refinement around loads,
  RCM numbering. About 23k T6 elements in 0.1 s.
- **Material models**: linear elastic and Mohr-Coulomb (non-associated flow, tension cut-off), unit weights above and
  below the water table, K0 (Jaky or user value).
- **Boundary conditions and loads**: automatic fixity, fixed segments or points, point loads, linearly varying
  distributed loads, hydrostatic pore pressure from a phreatic line.
- **Staged construction**: K0 or gravity initial stress, activating and deactivating regions and loads per stage,
  optional displacement reset.
- **Solver**: plane strain, modified Newton-Raphson with L-BFGS acceleration, load stepping with step cutting,
  skyline LDL^T / sparse Cholesky (nested dissection) direct solvers. Runs in a Web Worker with progress and cancel.
- **Factor of safety**: strength reduction (c/SRF, tan(phi)/SRF, tan(psi)/SRF) by continuation: the SRF is raised in
  increments from the SRF = 1 equilibrium state (increment doubled after each success, halved after a failure) until
  the bracket is narrower than `fos.tol`.
- **Plots**: 18 result fields (displacements, stresses, principal stresses, p, q, pore pressure, strains, plastic
  fraction), banded contours with legend, deformed mesh, displacement vectors, plastic points, value probe,
  line-section charts, PNG export, rainbow / viridis / jet colour maps.
- **Command line**: a JavaScript console bound to the scripting API `window.geo`.

## Running

```bash
npm install          # only dependency: vite (dev server / bundler)
npm run dev          # http://localhost:5190
npm test             # unit and integration tests (node:test, no browser needed)
npm run e2e          # Playwright smoke test: starts vite on :5192, drives Chromium, writes tests/e2e/screens/*.png
npm run build        # production bundle in dist/ (the solver worker is bundled automatically)
```

The e2e test needs Playwright and a Chromium build. It looks for `$PLAYWRIGHT_PATH`, `node_modules/playwright`,
`/tmp/pw/node_modules/playwright` and some sibling projects; install one with
`mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright && npx playwright install chromium`. `E2E_PORT` changes the port.

The app opens with the slope example. Typical session: press `F9` to mesh, `Ctrl+Enter` to solve, then look at the
Plot mode. `F1` lists all keyboard shortcuts.

### Scripting (command line, `Ctrl+backtick`)

```js
geo.example('footing'); geo.mesh({ size: 1 }); await geo.solve(); geo.plot('syy')

// build a model from scratch
geo.newModel('Layered')
const sand = geo.material({ name: 'Sand', E: 3e4, nu: 0.3, c: 1, phi: 33, gammaUnsat: 18 })
geo.rect(0, 0, 20, 10, sand)
geo.fixAuto()
geo.lineLoad([8, 10], [12, 10], 0, -100)
geo.mesh({ size: 1 }); await geo.solve()
geo.range('uy')                         // { min, max, label, unit }
geo.section('syy', [10, 0], [10, 10])   // values along a line
geo.set('settings.analysis', 'fos'); await geo.solve(); geo.fos()
```

`geo.help()` prints the full list: `example newModel material region rect line assign remove fixAuto fix fixPoint
pointLoad lineLoad water stage set get mesh solve cancel fos plot range field section export load save validate`.
Editing methods return ids and are undoable.

## Architecture

```
index.html                 entry page
src/core/                  model schema, examples factories, validation, 2D geometry helpers (DOM-free)
src/mesh/                  mesher: PSLG, exact predicates, Delaunay, Ruppert/Ungor refinement, T6, RCM (DOM-free)
src/fem/                   elements, Mohr-Coulomb, assembly, skyline + sparse solvers, staged / FOS solver, worker
src/post/                  fields.js (nodal fields, sampling; DOM-free), render.js (canvas contours, legend, ...)
src/ui/                    canvas editor, tools, panels, dialogs, command line, styles
src/app/                   integration: state store, services (mesh/worker), api (window.geo), io, examples, main
examples/*.json            bundled models (slope, footing, excavation, embankment)
tests/                     node:test suites per module + integration.test.js + e2e/smoke.mjs
ARCHITECTURE.md            the binding data contracts between the modules
```

Data flow: the UI edits `state.model` in place and calls `state.modelChanged()`, which invalidates mesh and results.
`services.generateMesh()` runs the mesher on the main thread (milliseconds), `services.solve()` posts
`{model, mesh}` to `src/fem/worker.js` (a module Web Worker), forwards progress messages, and stores the results.
Cancel terminates the worker. Without `Worker` (Node) the solver runs in-process, which is what the integration tests do.
The plot reads `state.results` through `post/fields.js` and draws with `post/render.js`.

## Verification

All numbers below are produced by the test suites (`npm test`: 6 files, 158 tests, one of them skipped unless
`FEM_PERF_FULL=1`).

| Check | Result |
|---|---|
| Elastic column (T3, T6) | settlement error ~1e-14 relative; sigma_xx/sigma_yy = nu/(1-nu) to 1e-9 |
| Patch test, distorted mesh (T3, T6) | uniform stress/strain reproduced to 1e-7 |
| Pure bending beam, distorted T6 mesh | matches the exact solution to 1e-6 |
| Prandtl strip footing, c-phi=0 | q_ult / c = 5.20 (exact 5.14, accepted band 5.0 - 5.6) |
| Cohesionless slope, c=0, phi=30 | FOS 1.160 (infinite slope: 1.155) |
| Example slope (c=10, phi=20, 1:2) | FOS 1.360 on the default mesh (913 T6 elements), 6 trials, about 0.6 s; T3 mesh of the same size: 1.59 (+17 %, see Known limitations) |
| Hydrostatic stresses | effective stress = (gamma_sat - gamma_w) z, pore pressure on the phreatic line |
| K0 stage | zero displacement, exact overburden stress profile, support reactions equal the weight (also with water) |
| Submerged ground (phreatic line above the surface) | effective stress (gamma_sat - gamma_w) z from the surface, reactions = soil + water weight; lake against the example slope: reactions equal soil weight + hydrostatic thrust |
| FOS independent of last-stage definition | gravity, K0 and "gravity + unchanged stage" setups agree within the bisection tolerance (1.380 / 1.380 / 1.380 for the test slope) |
| Return mapping | closest-point property (associated flow), admissibility on random states |
| Mesh | total area equals union area to 1e-15 relative; min angle 34.2 deg (slope), 33.1 deg (footing), 32.3 deg (excavation), 29.7 deg (embankment); vertices up to ~1e-3 m off a neighbouring edge are merged, loads a hair off the surface are projected onto it |
| Mesh speed | 22,950 T6 elements / 46,301 nodes in 75 - 160 ms |
| Solve speed | 40,602 DOF elastic solve about 0.9 s |
| Footing example, vertical equilibrium | reactions 3921.1 kN/m vs. load + weight 3920 kN/m |
| Post-processing | linear stress fields extrapolated exactly to T6 nodes (1e-11); contour bands tile the area to 1e-10 |

The FOS depends on the mesh, as usual for strength reduction with low-order elements: for the example slope 1.42 at
h = 3 m, 1.36 at 1.5 m, 1.345 at 1.0 m and 1.34 at 0.8 m (T6, 3-point Gauss; in Node the 1.0 m mesh, 2070 elements,
takes about 2 s and the 0.8 m mesh, 3191 elements, about 4 s).

### Bundled examples

| File | What it shows |
|---|---|
| `examples/slope.json` | homogeneous slope (c=10, phi=20), FOS by strength reduction: 1.360 |
| `examples/footing.json` | 2 m strip load (80 kPa) on sand over clay with a water table, static |
| `examples/excavation.json` | two stages: K0 stress state, then excavate a 4 m pit with a surcharge beside it (heave about 3 cm) |
| `examples/embankment.json` | 4 m fill built in a second stage on soft clay with a water table (settlement about 0.12 m) |

## Known limitations

- Plane strain only; the `planeStrain` setting is ignored. Drained (effective stress) analysis with hydrostatic pore
  pressure only: no consolidation. A phreatic line above the ground surface is treated as standing water: its
  hydrostatic pressure acts on the free soil surface (a warning is logged), but there is no free-surface or wave model.
- T3 (linear) elements lock volumetrically under plastic flow and overestimate collapse loads and the FOS (about
  +15 - 25 % FOS, up to +25 % bearing capacity); use T6 for failure analyses. The solver logs a warning for T3 with
  Mohr-Coulomb or FOS analyses.
- Element edges are straight, so there is no curved-boundary support. Regions must not overlap.
- The strength-reduction FOS is mesh dependent (see above). With a `k0` initial stage on a sloping ground surface
  the K0 state is not in equilibrium with the geometry, so use gravity initial stress for slopes.
- The solver is synchronous inside the worker, so cancelling terminates the worker (no partial results).
- Loads close to the collapse load make the load stepping stall: the bundled footing uses 80 kPa because the
  factory example's 150 kPa is above the limit load on fine meshes (limit load factor 0.7 - 0.77 for h <= 0.5 m).
- Touch pinch-zoom is not implemented.
