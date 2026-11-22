// End-to-end (Node) integration tests: model → mesh → solve → post fields, the scripting API and file round trips.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createExampleSlope, createExampleFooting, validateModel, effectiveStages } from '../src/core/model.js';
import { generateMesh, meshQuality } from '../src/mesh/mesher.js';
import { solve } from '../src/fem/solver.js';
import { FIELD_NAMES, nodalField, fieldRange } from '../src/post/fields.js';
import { createState } from '../src/app/state.js';
import { createServices, autoRefinement } from '../src/app/services.js';
import { createIO } from '../src/app/io.js';
import { createApi } from '../src/app/api.js';
import { EXAMPLE_NAMES, getExample } from '../src/app/examples.js';
import { normalizeModel } from '../src/app/model-utils.js';

const root = new URL('..', import.meta.url).pathname;
const readJSON = (f) => JSON.parse(fs.readFileSync(root + f, 'utf8'));

/** Mesh exactly as the application does (local refinement around loads). */
const appMesh = (model) => generateMesh(model, { refine: autoRefinement(model) });

const allFinite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

/** Structural checks on a mesh + results pair. */
function checkResults(model, mesh, res, { fos = false } = {}) {
  const nN = mesh.nodes.length / 2, nE = mesh.elements.length / mesh.nen;
  const stages = effectiveStages(model);
  assert.equal(res.analysis, fos ? 'fos' : 'static');
  assert.ok(res.ok, res.message);
  assert.equal(res.stages.length, stages.length + 0);
  const ngp = mesh.type === 'T6' ? 3 : 1;
  for (const s of res.stages) {
    assert.equal(s.displacement.length, 2 * nN);
    assert.equal(s.reactions.length, 2 * nN);
    assert.equal(s.activeElements.length, nE);
    assert.ok(allFinite(s.displacement), 'displacements finite');
    assert.ok(allFinite(s.reactions), 'reactions finite');
    const g = s.gp;
    for (const k of ['x', 'y', 'sxx', 'syy', 'sxy', 'szz', 'pore', 'eps_xx', 'eps_yy', 'gxy']) {
      assert.equal(g[k].length, nE * ngp, `gp.${k} length`);
      assert.ok(allFinite(g[k]), `gp.${k} finite`);
    }
    assert.equal(g.plastic.length, nE * ngp);
    assert.equal(g.elem.length, nE * ngp);
  }
}

/** Compute every post field of the last stage; finite wherever the node belongs to an active element. */
function checkFields(mesh, stage) {
  const nN = mesh.nodes.length / 2;
  const touched = new Uint8Array(nN);
  const nen = mesh.nen;
  for (let e = 0; e < mesh.elements.length / nen; e++) {
    if (!stage.activeElements[e]) continue;
    for (let k = 0; k < nen; k++) touched[mesh.elements[e * nen + k]] = 1;
  }
  const ranges = {};
  for (const name of FIELD_NAMES) {
    const v = nodalField(mesh, stage, name);
    assert.equal(v.length, nN, name);
    for (let i = 0; i < nN; i++) {
      if (touched[i]) assert.ok(Number.isFinite(v[i]), `${name}[${i}] must be finite on an active node`);
      else assert.ok(Number.isNaN(v[i]), `${name}[${i}] must be NaN on an inactive node`);
    }
    ranges[name] = fieldRange(v);
  }
  return ranges;
}

test('example JSON files are valid models and the two classic ones equal the factories', () => {
  assert.deepEqual(EXAMPLE_NAMES.sort(), ['embankment', 'excavation', 'footing', 'slope']);
  for (const n of EXAMPLE_NAMES) {
    const v = validateModel(readJSON(`examples/${n}.json`));
    assert.ok(v.ok, `${n}: ${v.errors.join('; ')}`);
    assert.deepEqual(getExample(n), readJSON(`examples/${n}.json`));
  }
  assert.deepEqual(readJSON('examples/slope.json'), createExampleSlope());
  // the bundled footing example differs from the factory only in the (safer) load level and title
  const f = createExampleFooting(); f.title = readJSON('examples/footing.json').title; f.loads[0].qy1 = f.loads[0].qy2 = -80;
  assert.deepEqual(readJSON('examples/footing.json'), f);
  // getExample returns independent copies
  const a = getExample('slope'); a.title = 'changed';
  assert.notEqual(getExample('slope').title, 'changed');
});

test('footing: static solve, equilibrium and all post fields', () => {
  const model = getExample('footing');
  const mesh = appMesh(model);
  const res = solve(model, mesh, {});
  checkResults(model, mesh, res);
  const st = res.stages[0];
  assert.equal(st.converged, true);
  // Settlement under the footing, downward, a few cm
  const r = checkFields(mesh, st);
  assert.ok(r.uy.min < -0.005 && r.uy.min > -0.5, `uy min ${r.uy.min}`);
  assert.ok(r.syy.min < -80, `syy min ${r.syy.min} must exceed the 80 kPa footing pressure`);
  // Vertical equilibrium: reactions = load (2 m x 80 kPa) + soil weight: sand 20*(3*18+1*20)=1480, clay 120*19=2280
  let Ry = 0;
  for (let i = 0; i < st.reactions.length / 2; i++) Ry += st.reactions[2 * i + 1];
  assert.ok(Math.abs(Ry - (160 + 1480 + 2280)) < 0.005 * 3920, `reaction sum ${Ry} vs 3920`);
  console.log(`footing: ${mesh.stats.nElements} el, uy_min=${r.uy.min.toFixed(4)} m, sum Ry=${Ry.toFixed(1)} kN/m`);
});

test('excavation: two stages (K0 then excavate), heave in the pit and inactive elements', () => {
  const model = getExample('excavation');
  const mesh = appMesh(model);
  const res = solve(model, mesh, {});
  checkResults(model, mesh, res);
  assert.equal(res.stages.length, 2);
  const [s0, s1] = res.stages;
  assert.ok(s0.converged && s1.converged);
  // K0 stage: no displacement
  assert.ok(Math.max(...s0.displacement.map(Math.abs)) < 1e-9);
  // the excavation region (index 1) is deactivated in stage 2
  const nE = mesh.elementRegion.length;
  let off = 0;
  for (let e = 0; e < nE; e++) if (mesh.elementRegion[e] === 1) { assert.equal(s1.activeElements[e], 0); off++; assert.equal(s0.activeElements[e], 1); }
  assert.ok(off > 20);
  const r = checkFields(mesh, s1);
  assert.ok(r.uy.max > 0.005, `heave ${r.uy.max}`); // excavation unloads the pit bottom: net upward movement
  console.log(`excavation: ${mesh.stats.nElements} el, heave=${r.uy.max.toFixed(4)} m, stage-2 max|u|=${Math.max(...s1.displacement.map(Math.abs)).toFixed(4)}`);
});

test('embankment on soft clay with water table: staged gravity loading', () => {
  const model = getExample('embankment');
  const mesh = appMesh(model);
  const res = solve(model, mesh, {});
  checkResults(model, mesh, res);
  const [s0, s1] = res.stages;
  assert.ok(s0.converged && s1.converged);
  const r = checkFields(mesh, s1);
  assert.ok(r.uy.min < -0.02, `embankment settlement ${r.uy.min}`);
  // stage 2 must show only the settlement caused by the embankment (displacements reset after the gravity stage)
  assert.equal(model.stages[1].resetDisplacements, true);
  let iN = 0, dN = Infinity;
  for (let n = 0; n < mesh.nodes.length / 2; n++) {
    const d = Math.hypot(mesh.nodes[2 * n] - 30, mesh.nodes[2 * n + 1] - 8);
    if (d < dN) { dN = d; iN = n; }
  }
  const uyc = s1.displacement[2 * iN + 1];
  assert.ok(uyc > -0.13 && uyc < -0.09, `embankment settlement at (30,8) = ${uyc}`);
  // pore pressure field: hydrostatic below y=7 → max at the bottom (y=0): 7*9.81
  const pw = r.pore;
  assert.ok(Math.abs(pw.max - 7 * 9.81) < 3, `pore max ${pw.max}`);
  console.log(`embankment: ${mesh.stats.nElements} el, settlement=${(-r.uy.min).toFixed(3)} m, pore max=${pw.max.toFixed(1)} kPa`);
});

test('slope: FOS by strength reduction (T6 default mesh)', () => {
  const model = getExample('slope');
  const t0 = performance.now();
  const mesh = appMesh(model);
  const res = solve(model, mesh, {});
  const ms = performance.now() - t0;
  checkResults(model, mesh, res, { fos: true });
  assert.ok(res.fos > 1.25 && res.fos < 1.5, `FOS ${res.fos}`);
  assert.ok(res.fosHistory.length >= 5 && res.fosHistory.some((h) => !h.converged) && res.fosHistory.some((h) => h.converged));
  const last = res.stages[res.stages.length - 1];
  const r = checkFields(mesh, last);
  assert.ok(r.eps_shear.max > r.eps_shear.min);
  console.log(`slope FOS = ${res.fos.toFixed(4)} (${res.fosHistory.length} trials, ${mesh.stats.nElements} T6 elements, ${ms.toFixed(0)} ms)`);
});

test('services + scripting API drive the whole workflow headlessly', async () => {
  const state = createState(getExample('slope'));
  const services = createServices(state, { useWorker: false });
  const io = createIO(state);
  const geo = createApi(state, services, io);
  services.api = geo; services.io = io;

  // build a model from scratch through the API
  geo.newModel('API model');
  const m = geo.material({ name: 'Sand', E: 30000, nu: 0.3, c: 1, phi: 33, gammaUnsat: 18 });
  const r1 = geo.rect(0, 0, 20, 10, m);
  geo.fixAuto();
  const q = geo.lineLoad([8, 10], [12, 10], 0, -100);
  assert.deepEqual([m, r1, q], ['M1', 'R1', 'Q1']);
  assert.deepEqual(geo.validate(), []);
  const stats = geo.mesh({ size: 2, type: 'T3' });
  assert.equal(stats.type, 'T3');
  assert.ok(stats.nElements > 50);
  const sum = await geo.solve();
  assert.ok(sum.results.ok);
  assert.equal(state.mode, 'plot');
  assert.equal(geo.fos(), null);
  const rg = geo.range('uy');
  assert.ok(rg.min < 0, 'settlement under load');
  geo.plot('syy', { deformed: true });
  assert.equal(state.plot.field, 'syy');
  assert.equal(state.plot.deformed, true);
  const sec = geo.section('uy', [0, 10], [20, 10], 11);
  assert.equal(sec.length, 11);
  assert.ok(sec[5].v < sec[0].v, 'larger settlement at the load');
  assert.throws(() => geo.plot('nonsense'), /Unknown field/);
  assert.throws(() => geo.assign('R9', 'M1'), /No region/);
  assert.throws(() => geo.region([[0, 0], [1, 1]], null), /at least 3|invalid|Invalid/i);

  // the command line scenario from the task
  geo.example('footing');
  geo.mesh({ size: 1 });
  await geo.solve();
  geo.plot('syy');
  assert.equal(state.model.settings.meshSize, 1);
  assert.ok(state.results.stages[0].converged);
  assert.equal(geo.get('settings.meshSize'), 1);
  geo.set('materials.M1.phi', 35);
  assert.equal(state.model.materials[0].phi, 35);
  assert.equal(state.results, null, 'editing invalidates results');
  assert.equal(state.mesh, null, 'editing invalidates the mesh');

  // staged model through the API
  geo.example('excavation');
  const id = geo.stage({ name: 'Extra stage', activeRegions: ['R1'], activeLoads: [] });
  assert.equal(id, 'S2');
  assert.equal(state.model.stages.length, 3);
});

test('save → load round trip and normalisation of sparse files', async () => {
  const state = createState(getExample('embankment'));
  const io = createIO(state);
  const json = JSON.stringify(state.model);
  await io.load({ name: 'x.json', text: async () => json });
  assert.deepEqual(state.model, getExample('embankment'));
  assert.equal(state.mesh, null);
  await assert.rejects(() => io.load({ text: async () => '{oops' }), /Invalid JSON/);
  await assert.rejects(() => io.load({ text: async () => '{"a":1}' }), /regions/);
  // sparse model gets defaults
  const m = normalizeModel({ regions: [{ id: 'R1', points: [[0, 0], [1, 0], [1, 1]], materialId: 'M1' }], materials: [{ id: 'M1' }], settings: { meshSize: 0.5 } });
  assert.equal(m.settings.meshSize, 0.5);
  assert.equal(m.settings.elementType, 'T6');
  assert.equal(m.settings.fos.tol, 0.005);
  assert.equal(m.materials[0].E, 20000);
  assert.deepEqual(m.loads, []);
  io.newModel();
  assert.equal(state.model.regions.length, 0);
  io.loadExample('footing');
  assert.equal(state.model.regions.length, 2);
  assert.throws(() => io.loadExample('nope'), /Unknown example/);
});

test('solver cancellation through services returns null', async () => {
  const state = createState(getExample('slope'));
  const services = createServices(state, { useWorker: false });
  const res = await services.solve({ shouldCancel: () => true });
  assert.equal(res, null);
  assert.equal(state.results, null);
});

test('mesh quality across all examples', () => {
  for (const n of EXAMPLE_NAMES) {
    const mesh = appMesh(getExample(n));
    const q = meshQuality(mesh);
    assert.equal(q.nInverted, 0, n);
    assert.ok(q.minAngle > 20, `${n}: min angle ${q.minAngle}`);
  }
});

test('geo.stage(): the first call defines the initial stage and honours initial:"k0"', () => {
  const state = createState(getExample('slope'));
  const services = createServices(state, { useWorker: false });
  const io = createIO(state);
  const geo = createApi(state, services, io);
  services.api = geo; services.io = io;
  geo.newModel('K0 staged');
  const m = geo.material({ name: 'Sand', E: 30000, nu: 0.3, c: 1, phi: 33, gammaUnsat: 18 });
  geo.rect(0, 0, 20, 10, m);
  geo.fixAuto();
  const q = geo.lineLoad([8, 10], [12, 10], 0, -100);
  geo.stage({ name: 'K0 init', initial: 'k0', activeLoads: [] });
  geo.stage({ name: 'Footing load', activeLoads: [q] });
  const st = state.model.stages;
  assert.equal(st.length, 2);
  assert.equal(st[0].initial, 'k0');
  assert.deepEqual(st[0].activeLoads, []);
  assert.equal(st[0].resetDisplacements, true);
  assert.deepEqual(st[1].activeLoads, [q]);
  assert.equal(st[1].initial, 'gravity');
  assert.deepEqual(st[1].activeRegions, st[0].activeRegions);
  assert.throws(() => geo.stage({ initial: 'k0' }), /first stage/);
  assert.equal(state.model.stages.length, 2);
});

test('validateModel rejects self-intersecting region outlines', () => {
  const m = createExampleSlope();
  m.regions[0].points = [[0, 0], [10, 10], [10, 0], [0, 10]];
  const v = validateModel(m);
  assert.ok(!v.ok);
  assert.ok(v.errors.some((e) => /intersects itself/.test(e)), v.errors.join('; '));
});

test('footing: distributed load hair off the boundary is projected by mesh.snaps; a far-off load produces a warning', () => {
  const base = readJSON('examples/footing.json');
  const run = (d) => {
    const m = JSON.parse(JSON.stringify(base));
    for (const L of m.loads) if (L.type === 'distributed') { L.p1[1] += d; L.p2[1] += d; }
    const mesh = appMesh(m);
    return solve(m, mesh);
  };
  const uy = (r) => Math.min(...r.stages.at(-1).displacement.filter((_, i) => i % 2 === 1));
  const ref = run(0), near = run(1e-3), far = run(0.05);
  assert.ok(Math.abs(uy(near) / uy(ref) - 1) < 5e-3, `${uy(near)} vs ${uy(ref)}`);
  assert.equal(ref.warnings.filter((w) => /Load/.test(w)).length, 0);
  assert.ok(far.warnings.some((w) => /Load Q1/.test(w)), 'warning for a load that is not on the mesh');
});
