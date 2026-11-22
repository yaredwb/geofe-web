// Tests for the DOM-free UI helpers: view transforms, grid, snapping, hit-testing, model edits, glyphs, formatting.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEmptyModel, createExampleFooting, createExampleSlope, validateModel } from '../src/core/model.js';
import { polygonArea } from '../src/core/geom.js';
import * as vm from '../src/ui/viewmath.js';
import * as ed from '../src/ui/edit.js';
import * as gl from '../src/ui/glyphs.js';
import * as fm from '../src/ui/format.js';

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} !~ ${b}`);

test('view transform round trip, y up', () => {
  const v = vm.makeView({ scale: 12.5, ox: 40, oy: 300 });
  const s = v.toScreen([3, 4]);
  near(s[0], 3 * 12.5 + 40); near(s[1], -4 * 12.5 + 300);
  const m = v.toModel(s);
  near(m[0], 3); near(m[1], 4);
});

test('zoomAbout keeps cursor model point fixed', () => {
  const view = { scale: 10, ox: 30, oy: 200 };
  const before = vm.makeView(view).toModel([123, 77]);
  const z = vm.zoomAbout(view, 123, 77, 1.7);
  near(z.scale, 17);
  const after = vm.makeView(z).toModel([123, 77]);
  near(before[0], after[0], 1e-9); near(before[1], after[1], 1e-9);
});

test('zoom limits clamp', () => {
  assert.equal(vm.zoomAbout({ scale: 1e6, ox: 0, oy: 0 }, 0, 0, 10).scale, vm.MAX_SCALE);
  assert.equal(vm.zoomAbout({ scale: 1e-4, ox: 0, oy: 0 }, 0, 0, 0.1).scale, vm.MIN_SCALE);
});

test('zoomExtents fits and centres bbox', () => {
  const rect = { x: 40, y: 0, w: 800, h: 400 };
  const v = vm.zoomExtents({ xmin: 0, ymin: 0, xmax: 60, ymax: 20 }, rect, 0.05);
  const view = vm.makeView(v);
  const a = view.toScreen([0, 0]), b = view.toScreen([60, 20]);
  assert.ok(a[0] >= rect.x && b[0] <= rect.x + rect.w && b[1] >= rect.y && a[1] <= rect.y + rect.h);
  near((a[0] + b[0]) / 2, rect.x + rect.w / 2, 1e-6);
  near((a[1] + b[1]) / 2, rect.y + rect.h / 2, 1e-6);
  // degenerate bbox does not blow up
  const d = vm.zoomExtents({ xmin: 5, ymin: 5, xmax: 5, ymax: 5 }, rect);
  assert.ok(Number.isFinite(d.scale) && d.scale > 0);
});

test('niceStep / gridSteps / ticks', () => {
  assert.equal(vm.niceStep(0.7), 1);
  assert.equal(vm.niceStep(1.2), 2);
  assert.equal(vm.niceStep(3), 5);
  assert.equal(vm.niceStep(7), 10);
  assert.equal(vm.niceStep(0.013), 0.02);
  const g = vm.gridSteps(10, 70); // 7 model units per 70 px -> 10
  assert.equal(g.major, 10); assert.equal(g.minor, 2);
  const g2 = vm.gridSteps(35, 70); // 2 -> minor 0.5
  assert.equal(g2.major, 2); assert.equal(g2.minor, 0.5);
  assert.deepEqual(vm.ticks(-1, 5, 2), [0, 2, 4]);
  assert.deepEqual(vm.ticks(0, 0.5, 0.1), [0, 0.1, 0.2, 0.3, 0.4, 0.5]);
});

test('snapToGrid cleans float noise', () => {
  assert.deepEqual(vm.snapToGrid([0.30000001, 0.7000001], 0.1), [0.3, 0.7]);
  assert.deepEqual(vm.snapToGrid([12.4, -3.6], 5), [10, -5]);
});

test('snapPoint priority vertex > edge > grid, exact coordinates reused', () => {
  const m = createEmptyModel();
  m.regions.push({ id: 'R1', name: 'A', materialId: 'M1', points: [[0, 0], [10.123, 0], [10.123, 5.5], [0, 5.5]] });
  const geom = vm.collectSnapGeometry(m);
  const base = { scale: 10, gridStep: 1, snapGrid: true, snapGeom: true, geom };
  // 0.4 px away from vertex -> vertex with exact coordinate (not grid-rounded)
  let r = vm.snapPoint([10.1, 0.05], base);
  assert.equal(r.kind, 'vertex'); assert.deepEqual(r.p, [10.123, 0]);
  // near the vertical edge, away from vertices -> edge, y snaps to grid point lying on the edge
  r = vm.snapPoint([10.2, 2.3], base);
  assert.equal(r.kind, 'edge'); assert.equal(r.p[0], 10.123); assert.equal(r.p[1], 2);
  // far from geometry -> grid
  r = vm.snapPoint([20.4, 20.6], base);
  assert.equal(r.kind, 'grid'); assert.deepEqual(r.p, [20, 21]);
  // geometry snapping off
  r = vm.snapPoint([10.1, 0.05], { ...base, snapGeom: false });
  assert.equal(r.kind, 'grid');
  // all off
  r = vm.snapPoint([1.234, 5.678], { ...base, snapGrid: false, snapGeom: false });
  assert.equal(r.kind, 'none'); assert.deepEqual(r.p, [1.234, 5.678]);
  // edge point not on grid: slanted edge
  m.regions.push({ id: 'R2', name: 'B', materialId: 'M1', points: [[20, 0], [30, 0], [25, 7]] });
  const g2 = vm.collectSnapGeometry(m);
  r = vm.snapPoint([27.6, 3.9], { ...base, geom: g2, snapGrid: false });
  assert.equal(r.kind, 'edge');
});

test('hit testing: vertex, region, line, edge', () => {
  const m = createExampleFooting();
  let h = vm.hitVertex(m, [20.05, 6.05], 0.2);
  assert.ok(h); assert.equal(h.owner, 'region'); assert.deepEqual(h.point, [20, 6]);
  assert.equal(vm.hitVertex(m, [5, 5], 0.2), null);
  assert.equal(vm.hitRegion(m, [5, 8]).id, 'R1');
  assert.equal(vm.hitRegion(m, [5, 3]).id, 'R2');
  assert.equal(vm.hitRegion(m, [-5, 3]), null);
  m.lines.push({ id: 'L1', points: [[2, 2], [8, 2]] });
  assert.equal(vm.hitLine(m, [5, 2.05], 0.1).id, 'L1');
  assert.equal(vm.hitLine(m, [5, 3], 0.1), null);
  const e = vm.hitEdge(m, [10, 0.03], 0.1);
  assert.equal(e.id, 'R2'); assert.equal(e.edgeIndex, 0); near(e.point[1], 0);
});

test('modelBBox and centroid', () => {
  const m = createExampleSlope();
  assert.deepEqual(vm.modelBBox(m), { xmin: 0, ymin: 0, xmax: 60, ymax: 20 });
  assert.deepEqual(vm.modelBBox(createEmptyModel()), null);
  const c = vm.polygonCentroid([[0, 0], [4, 0], [4, 2], [0, 2]]);
  near(c[0], 2); near(c[1], 1);
});

test('addRegion: CCW orientation, default material, validate', () => {
  const m = createEmptyModel();
  const r = ed.addRegion(m, [[0, 0], [0, 5], [10, 5], [10, 0]]); // CW input
  assert.ok(polygonArea(r.points) > 0);
  assert.equal(m.materials.length, 1);
  assert.equal(r.materialId, m.materials[0].id);
  ed.addAutoFixity(m);
  assert.equal(validateModel(m).ok, true);
  assert.equal(ed.addAutoFixity(m), null); // no duplicate
});

test('polygonProblem detects degenerate and self-intersecting rings', () => {
  assert.ok(ed.polygonProblem([[0, 0], [1, 1]]));
  assert.ok(ed.polygonProblem([[0, 0], [1, 1], [2, 2]]));
  assert.ok(ed.polygonProblem([[0, 0], [2, 2], [2, 0], [0, 2]])); // bow tie
  assert.equal(ed.polygonProblem([[0, 0], [2, 0], [2, 2], [0, 2]]), null);
  assert.equal(ed.dedupeRing([[0, 0], [1, 0], [1, 0], [1, 1], [0, 0]]).length, 3);
});

test('adjacent region sharing a partial edge gets conforming vertices (T-junction inserted)', () => {
  const m = createEmptyModel();
  ed.addRectangleRegion(m, [0, 0], [10, 10]);
  // second region sits on top of the right half of the first region's... place it on the right side edge, partially
  ed.addRectangleRegion(m, [10, 2], [15, 6]);
  const r1 = m.regions[0];
  // vertices (10,2) and (10,6) must have been inserted into R1's right edge
  const has = (r, p) => r.points.some((q) => q[0] === p[0] && q[1] === p[1]);
  assert.ok(has(r1, [10, 2]) && has(r1, [10, 6]));
  assert.equal(r1.points.length, 6);
  // orientation retained (still CCW) and ring order along the edge is monotone
  assert.ok(polygonArea(r1.points) > 0);
  const idx = (p) => r1.points.findIndex((q) => q[0] === p[0] && q[1] === p[1]);
  assert.ok(idx([10, 0]) < idx([10, 2]) && idx([10, 2]) < idx([10, 6]) && idx([10, 6]) < idx([10, 10]));
  assert.equal(ed.conformAll(m), 0); // idempotent
});

test('internal line end on region edge inserts vertex; moveVertexEverywhere moves shared coordinates', () => {
  const m = createExampleFooting();
  const line = ed.addLine(m, [[5, 6], [5, 10]]);
  // (5,6) lies on R1/R2 shared edge y=6 -> inserted in both
  assert.ok(m.regions[0].points.some((p) => p[0] === 5 && p[1] === 6));
  assert.ok(m.regions[1].points.some((p) => p[0] === 5 && p[1] === 6));
  assert.equal(line.points.length, 2);
  m.loads.push({ id: 'P1', type: 'point', p: [5, 10], fx: 0, fy: -10 });
  ed.moveVertexEverywhere(m, [5, 6], [5, 6.5]);
  assert.ok(m.regions[0].points.some((p) => p[0] === 5 && p[1] === 6.5));
  assert.ok(m.regions[1].points.some((p) => p[0] === 5 && p[1] === 6.5));
  assert.deepEqual(m.lines[0].points[0], [5, 6.5]);
  ed.moveVertexEverywhere(m, [5, 10], [5, 9]);
  assert.deepEqual(m.loads.find((l) => l.id === 'P1').p, [5, 9]);
  assert.deepEqual(m.lines[0].points[1], [5, 9]);
});

test('deleteVertexEverywhere refuses to degrade a triangle; insertVertexAt', () => {
  const m = createEmptyModel();
  ed.addRegion(m, [[0, 0], [4, 0], [0, 3]]);
  assert.equal(ed.deleteVertexEverywhere(m, [0, 0]), false);
  assert.equal(m.regions[0].points.length, 3);
  const m2 = createExampleFooting();
  assert.equal(ed.insertVertexAt(m2, [7, 6]), 2); // shared edge between R1 and R2
  assert.equal(ed.deleteVertexEverywhere(m2, [7, 6]), true);
  assert.equal(m2.regions[0].points.length, 4);
});

test('delete helpers clean stage references', () => {
  const m = createExampleFooting();
  m.stages = [{ id: 'S0', name: 'a', initial: 'gravity', activeRegions: ['R1', 'R2'], activeLoads: ['Q1'], resetDisplacements: true }];
  ed.deleteRegion(m, 'R1'); ed.deleteLoad(m, 'Q1');
  assert.deepEqual(m.stages[0].activeRegions, ['R2']); assert.deepEqual(m.stages[0].activeLoads, []);
  ed.deleteMaterial(m, 'M2');
  assert.equal(m.regions[0].materialId, null);
});

test('replaceInPlace keeps identity', () => {
  const a = { x: 1, y: 2 }; const b = { z: 3 };
  ed.replaceInPlace(a, b);
  assert.deepEqual(a, { z: 3 });
});

test('bc glyphs: auto fixity pins at bottom, rollers on sides pointing outward', () => {
  const m = createExampleSlope();
  const view = vm.makeView({ scale: 10, ox: 20, oy: 300 });
  const g = gl.bcGlyphs(m, view, 26);
  const pins = g.filter((x) => x.type === 'pin');
  const rollers = g.filter((x) => x.type === 'rollerX');
  assert.ok(pins.length >= 20 && rollers.length >= 4);
  for (const p of pins) { near(p.dx, 0); near(p.dy, 1); } // bottom: outward = down on screen
  assert.ok(rollers.some((r) => r.dx === -1) && rollers.some((r) => r.dx === 1));
  for (const r of rollers) near(r.dy, 0);
  // point fixity
  const m2 = createEmptyModel(); ed.addRectangleRegion(m2, [0, 0], [5, 5]);
  ed.addFixPoint(m2, [0, 5], true, false);
  const g2 = gl.bcGlyphs(m2, view);
  assert.equal(g2.length, 1); assert.equal(g2[0].type, 'rollerX'); assert.equal(g2[0].dx, -1);
});

test('bc segment: y-only on top edge points up; hit boundary', () => {
  const m = createEmptyModel(); ed.addRectangleRegion(m, [0, 0], [10, 5]);
  const b = ed.addFixSegment(m, [0, 5], [10, 5], false, true);
  const view = vm.makeView({ scale: 10, ox: 0, oy: 100 });
  const g = gl.bcGlyphs(m, view);
  assert.ok(g.every((x) => x.type === 'rollerY' && x.dy === -1)); // up on screen
  assert.equal(gl.hitBoundary(m, [5, 5.05], 0.2), b.id);
  assert.equal(gl.hitBoundary(m, [5, 2], 0.2), null);
});

test('load glyph direction and scaling', () => {
  const m = createEmptyModel();
  ed.addDistLoad(m, [0, 10], [10, 10], 0, -100, 0, -50);
  ed.addPointLoad(m, [5, 5], 30, 0);
  const view = vm.makeView({ scale: 10, ox: 0, oy: 200 });
  const g = gl.loadGlyphs(m, view);
  const dist = g.find((x) => x.kind === 'dist'), pt = g.find((x) => x.kind === 'point');
  // downward load: tail above tip on screen (smaller y)
  assert.ok(dist.arrows.every((a) => a.tail[1] < a.tip[1]));
  const lens = dist.arrows.map((a) => Math.hypot(a.tail[0] - a.tip[0], a.tail[1] - a.tip[1]));
  assert.ok(lens[0] > lens[lens.length - 1]); // |q| decreasing left to right
  near(Math.max(...lens), 56, 1e-9);
  // point load fx>0: arrow points right: tail left of tip
  assert.ok(pt.tail[0] < pt.tip[0]); near(pt.tail[1], pt.tip[1]);
  assert.equal(dist.labels.length, 2);
  // hit test
  const tip = view.toScreen([5, 5]);
  assert.equal(gl.hitLoad(m, view, tip[0] - 10, tip[1]), pt.id);
  assert.equal(gl.hitLoad(m, view, 500, 500), null);
});

test('water glyph', () => {
  const m = createExampleFooting();
  const w = gl.waterGlyph(m, vm.makeView({ scale: 10, ox: 0, oy: 200 }));
  assert.equal(w.pts.length, 2);
  near(w.symbol.y, -70 + 200); near(w.symbol.x, 200 - 28);
});

function gridMesh() {
  // 2x1 square split in T3: nodes 0..5 over [0,2]x[0,1]
  const nodes = new Float64Array([0, 0, 1, 0, 2, 0, 0, 1, 1, 1, 2, 1]);
  const elements = new Int32Array([0, 1, 4, 0, 4, 3, 1, 2, 5, 1, 5, 4]);
  return { type: 'T3', nodes, elements, nen: 3, elementRegion: new Int32Array(4), boundaryEdges: [], stats: {} };
}

test('interpolateAt on T3 mesh (linear field exact)', () => {
  const mesh = gridMesh();
  const vals = new Float64Array([0, 1, 2, 0, 1, 2].map((x, i) => x + (i >= 3 ? 10 : 0))); // f = x + 10 y
  near(vm.interpolateAt(mesh, vals, [0.3, 0.2]), 2.3, 1e-12);
  near(vm.interpolateAt(mesh, vals, [1.7, 0.9]), 10.7, 1e-12);
  assert.equal(vm.interpolateAt(mesh, vals, [2.5, 0.5]), null);
  assert.equal(vm.interpolateAt(mesh, vals, [1.7, 0.9], mesh.nodes, new Uint8Array([1, 1, 0, 0])), null); // inactive
});

test('interpolateAt on T6 element (via 4 sub-triangles)', () => {
  // single T6 triangle (0,0),(2,0),(0,2) with mid nodes
  const nodes = new Float64Array([0, 0, 2, 0, 0, 2, 1, 0, 1, 1, 0, 1]);
  const mesh = { type: 'T6', nodes, elements: new Int32Array([0, 1, 2, 3, 4, 5]), nen: 6, elementRegion: new Int32Array(1) };
  const vals = new Float64Array(6); for (let i = 0; i < 6; i++) vals[i] = 3 * nodes[2 * i] - nodes[2 * i + 1];
  near(vm.interpolateAt(mesh, vals, [0.4, 0.5]), 3 * 0.4 - 0.5, 1e-12);
  near(vm.interpolateAt(mesh, vals, [1.4, 0.3]), 3 * 1.4 - 0.3, 1e-12);
  assert.equal(vm.interpolateAt(mesh, vals, [1.5, 1.5]), null);
});

test('deformed nodes, auto scale, value range', () => {
  const mesh = gridMesh();
  const disp = new Float64Array(12); disp[2] = 0.01;
  const dn = vm.deformedNodes(mesh, disp, 100);
  near(dn[2], 2);
  const s = vm.autoDeformScale(mesh, disp, 0.1); // size 2, umax 0.01 -> raw 20
  assert.equal(s, 20);
  assert.equal(vm.autoDeformScale(mesh, new Float64Array(12)), 1);
  assert.deepEqual(vm.valueRange(new Float64Array([3, NaN, -1, 7])), { min: -1, max: 7 });
  const r = vm.valueRange(new Float64Array([5, 5])); assert.ok(r.max > r.min);
  assert.deepEqual(vm.valueRange(new Float64Array([1, 100, 2]), new Uint8Array([1, 0, 1])), { min: 1, max: 2 });
});

test('activeNodeMask', () => {
  const mesh = gridMesh();
  const mask = vm.activeNodeMask(mesh, new Uint8Array([1, 0, 0, 0]));
  assert.deepEqual(Array.from(mask), [1, 1, 0, 0, 1, 0]);
});

test('chartPath builds svg path with gaps for NaN', () => {
  const c = vm.chartPath([{ s: 0, v: 0 }, { s: 1, v: 1 }, { s: 2, v: NaN }, { s: 3, v: 2 }], 300, 200);
  assert.ok(c.d.startsWith('M')); assert.equal((c.d.match(/M/g) || []).length, 2);
  assert.ok(c.py(1) < c.py(0));
});

test('formatting helpers', () => {
  assert.equal(fm.fmtNum(0), '0');
  assert.equal(fm.fmtNum(1.23456789, 4), '1.235');
  assert.equal(fm.fmtNum(1500, 4), '1500');
  assert.equal(fm.fmtNum(0.00001234, 3), '1.23e-5');
  assert.equal(fm.fmtCoord(3.1000001), '3.1');
  assert.equal(fm.fmtCoord(-0.0001), '0');
  assert.equal(fm.decimalsForStep(0.2), 1); assert.equal(fm.decimalsForStep(5), 0); assert.equal(fm.decimalsForStep(0.05), 2);
  assert.equal(fm.fieldMeta('umag').label, 'Total displacement |u|');
  assert.equal(fm.fieldMeta('foo', { fieldInfo: () => ({ label: 'Foo!', unit: 'x' }) }).label, 'Foo!');
  assert.equal(fm.fieldMeta('zzz').label, 'zzz');
  assert.equal(fm.FIELD_ORDER.length, 18);
});

test('formatValue handles common console values', () => {
  assert.equal(fm.formatValue(undefined), 'undefined');
  assert.equal(fm.formatValue('hi'), 'hi');
  assert.equal(fm.formatValue([1, 2, 'a']), '[1, 2, "a"]');
  assert.equal(fm.formatValue({ a: 1, b: { c: 2 } }), '{ a: 1, b: { c: 2 } }');
  assert.equal(fm.formatValue(new Error('boom')), 'Error: boom');
  assert.match(fm.formatValue(new Float64Array([1, 2, 3])), /^Float64Array\(3\)/);
  const cyc = {}; cyc.self = cyc;
  assert.match(fm.formatValue(cyc), /Circular/);
  assert.equal(fm.esc('<a href="x">&'), '&lt;a href=&quot;x&quot;&gt;&amp;');
});

import { createState } from '../src/app/state.js';
import { createHistory } from '../src/ui/history.js';

test('history: undo/redo restores model in place, coalesces, holds groups', () => {
  const st = createState(createEmptyModel());
  let t = 0;
  const hist = createHistory(st, { now: () => t });
  const model = st.model;
  ed.addRectangleRegion(st.model, [0, 0], [10, 5]); t = 1000; st.modelChanged();
  ed.addAutoFixity(st.model); t = 2000; st.modelChanged();
  assert.equal(hist.canUndo(), true);
  assert.equal(st.model.boundaries.length, 1);
  hist.undo();
  assert.equal(st.model.boundaries.length, 0); assert.equal(st.model.regions.length, 1);
  assert.equal(st.model, model); // identity preserved
  hist.undo();
  assert.equal(st.model.regions.length, 0);
  assert.equal(hist.canUndo(), false);
  hist.redo(); hist.redo();
  assert.equal(st.model.boundaries.length, 1);
  assert.equal(hist.canRedo(), false);
  // burst within coalesce window = one step
  t = 10000;
  st.model.settings.meshSize = 3; st.modelChanged(); t = 10100;
  st.model.settings.meshSize = 4; st.modelChanged(); t = 10200;
  st.model.settings.meshSize = 5; st.modelChanged();
  hist.undo();
  assert.equal(st.model.settings.meshSize, 2);
  hist.redo();
  // hold groups arbitrary-length bursts
  t = 20000; hist.hold(true);
  for (let i = 0; i < 5; i++) { t += 2000; st.model.settings.meshSize = 10 + i; st.modelChanged(); }
  hist.hold(false);
  hist.undo();
  assert.equal(st.model.settings.meshSize, 5);
  // replacing the model object resets history
  st.set({ model: createEmptyModel() });
  assert.equal(hist.canUndo(), false);
  hist.destroy();
});

test('internal line crossing a shared region edge gets a vertex at the crossing in line and both regions', () => {
  const m = createEmptyModel();
  ed.addRectangleRegion(m, [0, 0], [20, 8]);
  ed.addRectangleRegion(m, [0, 8], [20, 14]);
  const line = ed.addLine(m, [[5, 0], [5, 14]]);
  const has = (pts, p) => pts.some((q) => q[0] === p[0] && q[1] === p[1]);
  assert.ok(has(m.regions[0].points, [5, 8]) && has(m.regions[1].points, [5, 8]));
  assert.ok(has(m.regions[0].points, [5, 0]) && has(m.regions[1].points, [5, 14]));
  assert.ok(has(line.points, [5, 8]));
  assert.equal(line.points.length, 3);
  assert.equal(ed.conformAll(m), 0);
});

// ---------------------------------------------------------------- regression tests (review fixes)
import { createIO } from '../src/app/io.js';
import { watchModelSwitch } from '../src/ui/modelswitch.js';
import { compileCommand, makeContext } from '../src/ui/cmdcompile.js';
import { EXAMPLE_NAMES } from '../src/app/examples.js';

test('model switch resets per-model plot settings, validation and caches; keeps display preferences', () => {
  const state = createState();
  const app = { validation: { ok: false, errors: ['x'] }, section: { p1: [0, 0], p2: [1, 1] }, plotCache: {} };
  const check = watchModelSwitch(state, app);
  Object.assign(state.plot, { min: -0.0068, max: 0.029, deformScale: 500, stageIndex: 2, nLevels: 5, colormap: 'viridis', field: 'syy' });
  assert.equal(check(), false, 'same model: nothing happens');
  assert.equal(app.validation.ok, false);
  createIO(state).loadExample('footing');
  assert.equal(check(), true);
  assert.ok(!Number.isFinite(state.plot.min) && !Number.isFinite(state.plot.max));
  assert.equal(state.plot.deformScale, null);
  assert.equal(state.plot.stageIndex, -1);
  assert.equal(state.plot.nLevels, 5);
  assert.equal(state.plot.colormap, 'viridis');
  assert.equal(state.plot.field, 'syy');
  assert.equal(app.validation, null);
  assert.equal(app.section, null);
  assert.equal(app.plotCache, null);
});

test('model switch is also detected for newModel and in-place edits do not reset', () => {
  const state = createState();
  const app = { validation: { ok: true, errors: [] }, section: null, plotCache: null };
  const check = watchModelSwitch(state, app);
  state.model.title = 'edited'; state.modelChanged();
  assert.equal(check(), false);
  assert.ok(app.validation);
  createIO(state).newModel();
  assert.equal(check(), true);
  assert.equal(app.validation, null);
});

test('command line: last statement value is returned', async () => {
  const state = createState();
  const ctx = makeContext({ geo: {}, state, services: {}, print() {}, help() {}, console });
  const run = (code) => compileCommand(code)(ctx);
  assert.equal(await run('const t = 5; t * 2'), 10);
  assert.equal(await run('const t = 5;\nt * 3;'), 15);
  assert.equal(await run('1 + 2'), 3);
  assert.equal(await run('const s = "a;b"; s.length'), 3);
  assert.equal(await run('const o = {\n a: 1,\n b: 2 };\no.a + o.b'), 3);
  assert.equal(await run('const f = `x;${1 + 1}`; f'), 'x;2');
  assert.equal(await run('let a = await Promise.resolve(4); a + 1'), 5);
  assert.equal(await run('let k = 0; for (let i = 0; i < 3; i++) { k += i; }'), undefined);
  assert.equal(await run('// note\n42'), 42);
  assert.throws(() => compileCommand('const = ;'), SyntaxError);
});

test('command line: `model` always refers to the current model', async () => {
  const state = createState();
  const io = createIO(state);
  const geo = { newModel: (t) => { io.newModel(); state.model.title = t; } };
  const ctx = makeContext({ geo, state, services: {}, print() {}, help() {}, console });
  assert.equal(await compileCommand('(geo.newModel("Fresh2"), model.title)')(ctx), 'Fresh2');
  assert.equal(await compileCommand('geo.newModel("Third"); model.title')(ctx), 'Third');
});

test('File > Load example lists every bundled example', async () => {
  const { buildMenus } = await import('../src/ui/menus.js');
  const loaded = [];
  const app = { state: createState(), actions: { loadExample: (n) => loaded.push(n) } };
  const file = buildMenus(app).find((m) => m.label === 'File');
  const sub = file.items().find((i) => i.label === 'Load example');
  assert.equal(sub.items.length, EXAMPLE_NAMES.length);
  sub.items.forEach((i) => i.run());
  assert.deepEqual(loaded, EXAMPLE_NAMES);
});
