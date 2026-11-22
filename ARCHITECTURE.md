# GeoFE Web — 2D geotechnical FE program (ADONIS-style workflow)

Original browser implementation of the workflow of a 2D geotechnical FE code:
Geometry → Mesh → Material → Boundary/Loads → Initial stress → Solve (static / FOS by strength reduction) → Plot.
No ADONIS code, art or branding is copied; the UI is our own.

Tech: plain JavaScript ES modules (no TypeScript, no framework, no bundler required), served by Vite dev server
(`npm run dev`, port 5190). Unit tests: `node --test tests/` (Node 24). Heavy compute runs in a Web Worker.
Every module under `src/core`, `src/mesh`, `src/fem`, `src/post` MUST be DOM-free so it runs in Node and in a Worker.
Units: SI with kN, m, kPa (stress), kN/m³ (unit weight). Coordinates: x right, y UP. Gravity acts in −y.

## Directory ownership
| Dir | Owner module | Contents |
|---|---|---|
| `src/core/` | contract (orchestrator) | `model.js` (schema + factory + validation), `geom.js` (shared 2D geometry helpers) |
| `src/mesh/` | Mesher | `mesher.js` — model → mesh |
| `src/fem/` | Solver | elements, material models, assembly, sparse solver, staged static + SRM FOS, `worker.js` |
| `src/post/` | Post-processing | result field derivation (DOM-free) `fields.js`; canvas renderers `render.js` (takes a CanvasRenderingContext2D, no other DOM) |
| `src/ui/` | UI | editor canvas, toolbars, panels, dialogs, info panel, command line |
| `src/app/` | Integration | `main.js` wiring, `api.js` scripting API, `io.js` save/load JSON |
| `examples/` | anyone | example models as JSON (`*.json` conforming to model schema) |
| `tests/` | per module | `tests/<module>.test.js` with `node:test` + `node:assert/strict` |

## Model schema (src/core/model.js is the source of truth)
```js
model = {
  version: 1,
  title: 'string',
  units: { length: 'm', force: 'kN', stress: 'kPa' },
  settings: {
    analysis: 'static',            // 'static' | 'fos'
    planeStrain: true,
    gravity: 9.81,                 // only magnitude matters for display; unit weights are given directly in kN/m3
    elementType: 'T6',             // 'T3' | 'T6'  (T6 = 6-node quadratic triangle, recommended)
    meshSize: 2.0,                 // target element edge length (m)
    tolerance: 1e-3,               // relative force-residual tolerance
    maxIterations: 200,            // per load step
    loadSteps: 10,                 // load increments per stage
    fos: { min: 0.5, max: 5.0, tol: 0.005, maxBisections: 30, tensionCutoff: true }
  },
  // Geometry: a set of closed polygonal REGIONS. Regions share edges exactly (same vertex coords) where they touch.
  // The union of regions is the soil domain. Each region gets one material.
  regions: [ { id: 'R1', name: 'Clay', points: [[x,y], ...] /* CCW, no repeat of first pt */, materialId: 'M1' } ],
  // Optional internal lines that the mesh must conform to (e.g. excavation boundaries, wall lines)
  lines: [ { id: 'L1', points: [[x,y],[x,y]] } ],
  materials: [ {
    id: 'M1', name: 'Clay', color: '#c8a26b',
    model: 'linear-elastic' | 'mohr-coulomb',
    E: 20000,        // kPa
    nu: 0.3,
    gammaUnsat: 18,  // kN/m3 (above water table)
    gammaSat: 20,    // kN/m3 (below water table)
    c: 10,           // kPa   (mohr-coulomb)
    phi: 30,         // deg
    psi: 0,          // deg dilation
    tensile: 0,      // kPa tensile strength (used if settings.fos.tensionCutoff)
    K0: null,        // null → 1 - sin(phi) (Jaky)
    drainage: 'drained'
  } ],
  // Boundary conditions. Geometric primitives are resolved to mesh nodes at solve time.
  boundaries: [
    { id:'B1', type:'fixity', target:{ kind:'auto' /* bottom fixed xy, sides fixed x */ } },
    { id:'B2', type:'fixity', target:{ kind:'segment', p1:[x,y], p2:[x,y] }, fixX:true, fixY:false },
    { id:'B3', type:'fixity', target:{ kind:'point', p:[x,y] }, fixX:true, fixY:true }
  ],
  loads: [
    { id:'P1', type:'point', p:[x,y], fx:0, fy:-100 },                        // kN/m (per m out of plane)
    { id:'Q1', type:'distributed', p1:[x,y], p2:[x,y], qx1:0, qy1:-50, qx2:0, qy2:-50 } // kPa, linear variation, global axes
  ],
  water: { enabled: false, gammaW: 9.81, phreatic: [[x,y], ...] /* polyline, left→right in x */ },
  // Staged construction. If empty, a single stage 'Initial' with all regions active and all loads active is used.
  stages: [ { id:'S0', name:'Initial', initial:'k0' | 'gravity', activeRegions:['R1',...], activeLoads:['P1',...], resetDisplacements: true } ]
}
```
`src/core/model.js` exports: `createEmptyModel()`, `createExampleSlope()`, `createExampleFooting()`, `validateModel(model) → {ok, errors[]}`,
`newId(prefix, existingArray)`, `cloneModel(m)`, `defaultMaterial(overrides)`, `materialColor(i)`, `effectiveStages(model)` (solver MUST use this).
`src/core/geom.js` exports: `polygonArea(pts)` (signed, CCW positive), `pointInPolygon(p, pts)`, `distPointSegment(p,a,b)`,
`projectOnSegment(p,a,b) → {t, point, dist}`, `bbox(ptsArray) → {xmin,ymin,xmax,ymax}`, `segIntersect(a,b,c,d) → point|null`,
`polylineYAt(polyline, x) → y|null` (linear interp, clamps beyond ends to end values).

## Mesh format (output of `src/mesh/mesher.js`)
```js
generateMesh(model, opts?) → mesh = {
  type: 'T3' | 'T6',
  nodes: Float64Array (2*nNodes, x0,y0,x1,y1,...),
  elements: Int32Array (nen*nEl) — T3: [n0,n1,n2] CCW; T6: [n0,n1,n2, n3(mid 0-1), n4(mid 1-2), n5(mid 2-0)],
  nen: 3 | 6,
  elementRegion: Int32Array (nEl) — index into model.regions,
  boundaryEdges: Array<[a,b]> outer boundary corner-node pairs of the union domain (for plotting),
  stats: { nNodes, nElements, minAngle, maxAspect, warnings?: string[] },
  snaps?: [{ from:[x,y], to:[x,y] }]   // points a hair off an edge that were moved onto it (loads are projected the same way)
}
```
Mesh requirements: conforming across region interfaces and to `model.lines`, all region vertices are nodes, quality triangles
(min angle ≥ ~20° where geometry allows), sizes ≈ `settings.meshSize` with optional local refinement near point loads / footing edges
(`opts.refine: [{p:[x,y], size, radius}]`). Deterministic (no Math.random without seed). Must handle ~20k elements in < 2 s in Node.

## Solver API (`src/fem/`)
```js
// src/fem/solver.js
solve(model, mesh, { onProgress?(msg:{stage, step, iter, residual, fos?, text}), shouldCancel?() → bool }) → results
results = {
  ok: boolean, message: string,
  analysis: 'static' | 'fos',
  fos: number | null,               // factor of safety (SRM), else null
  fosHistory: [{ srf, converged, maxDisp, iterations }],
  warnings: string[],               // informational messages (T3 locking, submerged ground surface, load not on the mesh); UI logs them
  stages: [ {
    id, name,
    displacement: Float64Array(2*nNodes),     // ux,uy per node (stage cumulative unless resetDisplacements)
    // Gauss-point data (3 GP per T6 element, 1 per T3); ordering elem-major
    gp: { x: Float64Array, y: Float64Array, elem: Int32Array,
          sxx, syy, sxy, szz: Float64Array,     // EFFECTIVE stress, kPa, tension positive
          pore: Float64Array,                    // pore pressure, kPa, compression positive
          plastic: Uint8Array,                   // 0 elastic, 1 shear yield, 2 tension yield
          eps_xx, eps_yy, gxy: Float64Array },  // total strain; gxy = ENGINEERING shear strain gamma_xy
    reactions: Float64Array(2*nNodes),
    activeElements: Uint8Array(nEl),
    converged: boolean, steps: [{loadFactor, iterations, residual}]
  } ]
}
```
Formulation: small-strain, plane strain, displacement-based, T6 with 3-point Gauss (also T3), Mohr-Coulomb elastic-perfectly-plastic
with non-associated flow (psi), principal-stress-space return mapping (apex/edge returns) + optional tension cutoff,
modified Newton–Raphson (or consistent tangent) with load stepping and adaptive step cutting. Gravity loading or K0 procedure
for initial stresses. Hydrostatic pore pressure from phreatic line (effective-stress analysis, drained). Strength reduction:
c/SRF, tan(phi)/SRF, tan(psi)/SRF (psi ≤ phi_red), raised by continuation from the SRF = 1 state (increment
halved on failure) until bracket ≤ tol (cold bisection trials between min and 1 if SRF = 1 fails); non-convergence = failure.
Sparse direct solver: symmetric skyline/profile LDLᵀ with RCM reordering (or banded) for SPD systems; must solve 40k DOF quickly.
`src/fem/worker.js`: Web Worker wrapper, messages `{cmd:'solve', model, mesh}` → posts `{type:'progress',...}`, `{type:'done', results}`
(transfer typed-array buffers), `{type:'error', message}`; `{cmd:'cancel'}`.

## Post-processing API
`src/post/fields.js` (DOM-free):
`nodalField(mesh, stageResult, name) → Float64Array(nNodes)` for names:
`ux, uy, umag, sxx, syy, sxy, szz, s1, s3, p (mean eff), q (deviatoric), pore, eps_xx, eps_yy, gamma_xy, eps_shear (max shear strain), eps_vol, plastic`
(GP → node by element-averaged extrapolation / patch averaging). Also `principalStresses(sxx,syy,sxy)`, `fieldInfo(name) → {label, unit}`.
`src/post/render.js`: pure functions given a 2D context + a view transform object `{scale, ox, oy}` with `toScreen([x,y]) → [sx,sy]`:
`drawMesh(ctx, view, mesh, opts)`, `drawContours(ctx, view, mesh, values, {min,max,colormap, nLevels})` (smooth per-triangle gradient
fill by subdividing T6 into 4 T3 sub-triangles and drawing filled banded contours), `drawDeformed(ctx, view, mesh, disp, scale, opts)`,
`drawVectors(ctx, view, mesh, disp)`, `drawPlasticPoints(ctx, view, stageResult)`, `drawPrincipalStressCrosses(...)`, `drawLegend(ctx, x,y,w,h, min,max, colormap, title, unit)`,
`colormaps` (`rainbow`, `viridis`, `jet`). Also `sampleAlongLine(mesh, values, p1, p2, n) → [{s, x, y, v}]` for line plots (DOM-free, in fields.js).

## UI (src/ui/) — look & feel
Desktop-CAD-style layout: top menu bar (File, Geometry, Mesh, Material, Boundary, Loads, Water, Stages, Solve, Plot, View, Help),
icon toolbar, left Info panel (model summary: analysis mode, units, mesh stats, materials, BCs, results summary), central canvas with
axes/ruler grid, snapping, zoom (wheel) / pan (middle-drag or hand tool), right "Command Panel" with mode buttons
(Geometry, Mesh, Material, Boundary, Loads/Water, Settings, Solve, Plot), bottom Command Line (JavaScript console bound to `window.geo` API),
status bar with cursor coordinates. Dialogs for materials/settings. Solve progress dialog with cancel.
Geometry tools: draw polygon region (click points, close by clicking first point/Enter), rectangle, edit/move vertex,
delete, add internal line, coordinate-table edit of a region. Assign material by clicking a region. Boundary: auto fixity, fix segment,
point load, distributed load (click two points). Water: draw phreatic polyline. Plot mode: field dropdown, deformed toggle + scale,
plastic points, vectors, mesh on/off, line-plot tool (draw a section → chart in a small dialog).
`src/ui/` exports `createUI(rootEl, appState)` where appState = shared store (see src/app/state.js, owned by Integration):
`{ model, mesh, results, selection, mode, view, subscribe(fn), set(patch), notify() }`.

## Scripting API (src/app/api.js), exposed as `window.geo`
`geo.newModel()`, `geo.region(points, materialId?)`, `geo.material({...})`, `geo.assign(regionId, materialId)`, `geo.fixAuto()`,
`geo.fix(p1,p2,{x,y})`, `geo.pointLoad(p, fx, fy)`, `geo.lineLoad(p1,p2,qx,qy)`, `geo.water(polyline)`, `geo.set(path, value)`,
`geo.mesh({size, type})`, `await geo.solve()`, `geo.fos()`, `geo.plot(field)`, `geo.example('slope'|'footing')`, `geo.model` (getter), `geo.export()`.
