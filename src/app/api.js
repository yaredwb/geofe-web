// Scripting API exposed as `window.geo` and used by the command line. DOM-free: it works on the shared store
// (state.js) and the services object, so it can be driven from Node in tests as well.
//
// All editing methods modify state.model in place and call state.modelChanged() (=> mesh/results become stale and the
// edit is recorded for undo). Methods that create things return the new id, so calls can be chained through ids:
//   const m = geo.material({ name: 'Clay', c: 20, phi: 25 });
//   const r = geo.region([[0,0],[30,0],[30,10],[0,10]], m);
import { createEmptyModel, newId, defaultMaterial, cloneModel, validateModel, effectiveStages } from '../core/model.js';
import * as ed from '../ui/edit.js';
import { FIELD_NAMES, fieldInfo, fieldRange, nodalField, sampleAlongLine } from '../post/fields.js';
import { getExample, EXAMPLE_NAMES } from './examples.js';
import { normalizeModel, getPath, setPath } from './model-utils.js';
import { installModel } from './io.js';

const isPt = (p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
function pt(p, what = 'point') { if (!isPt(p)) throw new Error(`Invalid ${what}: expected [x, y], got ${JSON.stringify(p)}`); return [p[0], p[1]]; }
function num(v, what) { if (!Number.isFinite(v)) throw new Error(`Invalid ${what}: expected a number, got ${v}`); return v; }

/**
 * @param {object} state     shared store
 * @param {object} services  { generateMesh, solve, cancelSolve, ... } from services.js
 * @param {object} [io]      io object (for export download); optional
 */
export function createApi(state, services, io = null) {
  const M = () => state.model;
  const changed = (o) => state.modelChanged(o);

  /** Look up a material by id; throws when missing. */
  function mustMaterial(id) {
    if (!M().materials.some((m) => m.id === id)) throw new Error(`No material "${id}" (have: ${M().materials.map((m) => m.id).join(', ') || 'none'})`);
    return id;
  }
  function stageIndex(stage) {
    const st = state.results?.stages || [];
    if (stage == null) return -1;
    if (typeof stage === 'string') { const i = st.findIndex((s) => s.id === stage); if (i < 0) throw new Error(`No stage "${stage}"`); return i; }
    return stage;
  }
  function currentStage(stage) {
    if (!state.mesh) throw new Error('No mesh: run geo.mesh() first');
    if (!state.results) throw new Error('No results: run await geo.solve() first');
    const st = state.results.stages;
    const i = stageIndex(stage);
    const s = st[i < 0 ? st.length + i : i];
    if (!s) throw new Error('Stage index out of range');
    return s;
  }

  const geo = {
    // ------------------------------------------------------------------ model access
    /** The live model object. */
    get model() { return state.model; },
    get mesh() { return state.mesh; },
    get results() { return state.results; },
    /** JSON text of the model (pretty-printed). */
    export() { return JSON.stringify(state.model, null, 2); },
    /** Replace the model with JSON text or an object (the inverse of export()). */
    load(jsonOrObject) {
      const raw = typeof jsonOrObject === 'string' ? JSON.parse(jsonOrObject) : cloneModel(jsonOrObject);
      installModel(state, normalizeModel(raw));
      return M().title;
    },
    /** Download the model as a .json file (browser only). */
    save() { if (!io?.save) throw new Error('Saving is not available here'); return io.save(); },
    /** Start from an empty model (optionally titled). */
    newModel(title) { const m = createEmptyModel(); if (title) m.title = String(title); installModel(state, m); return m.title; },
    /** Load a bundled example: 'slope' | 'footing' | 'excavation' | 'embankment'. */
    example(name = 'slope') { installModel(state, getExample(name)); return name; },
    examples() { return [...EXAMPLE_NAMES]; },
    /** Validation problems of the current model ([] when valid). */
    validate() { return validateModel(M()).errors; },

    // ------------------------------------------------------------------ geometry
    /** Add a region from a ring of [x,y] points (any orientation). Returns the region id. */
    region(points, materialId = null, name = null) {
      if (!Array.isArray(points)) throw new Error('region(points): points must be an array of [x, y]');
      const pts = points.map((p) => pt(p));
      const problem = ed.polygonProblem(pts);
      if (problem) throw new Error(problem);
      if (materialId != null) mustMaterial(materialId);
      const r = ed.addRegion(M(), pts, { materialId, name });
      changed();
      return r.id;
    },
    /** Axis-aligned rectangular region. Returns the region id. */
    rect(x1, y1, x2, y2, materialId = null, name = null) {
      return geo.region([[x1, y1], [x2, y1], [x2, y2], [x1, y2]], materialId, name);
    },
    /** Internal line (polyline the mesh must conform to). Returns the line id. */
    line(points) {
      if (!Array.isArray(points) || points.length < 2) throw new Error('line(points): need at least 2 points');
      const l = ed.addLine(M(), points.map((p) => pt(p)));
      changed();
      return l.id;
    },
    /** Remove a region, line, material, load, boundary condition or stage by id. */
    remove(id) {
      const m = M();
      if (m.regions.some((r) => r.id === id)) ed.deleteRegion(m, id);
      else if (m.lines.some((l) => l.id === id)) ed.deleteLine(m, id);
      else if (m.loads.some((l) => l.id === id)) ed.deleteLoad(m, id);
      else if (m.boundaries.some((b) => b.id === id)) ed.deleteBoundary(m, id);
      else if (m.materials.some((x) => x.id === id)) ed.deleteMaterial(m, id);
      else if (m.stages.some((s) => s.id === id)) m.stages = m.stages.filter((s) => s.id !== id);
      else throw new Error(`Nothing with id "${id}"`);
      changed();
      return id;
    },

    // ------------------------------------------------------------------ materials
    /**
     * Create (or, when `props.id` already exists, update) a material. Returns its id.
     * e.g. geo.material({ name: 'Clay', E: 15000, nu: 0.35, c: 20, phi: 25, gammaUnsat: 17, gammaSat: 19 })
     */
    material(props = {}) {
      const m = M();
      const existing = props.id ? m.materials.find((x) => x.id === props.id) : null;
      if (existing) { Object.assign(existing, props); changed(); return existing.id; }
      const mat = ed.makeMaterial(m, props);
      m.materials.push(mat);
      changed();
      return mat.id;
    },
    /** Assign a material to a region. */
    assign(regionId, materialId) {
      const r = M().regions.find((x) => x.id === regionId);
      if (!r) throw new Error(`No region "${regionId}" (have: ${M().regions.map((x) => x.id).join(', ') || 'none'})`);
      r.materialId = mustMaterial(materialId);
      changed();
      return regionId;
    },

    // ------------------------------------------------------------------ boundary conditions, loads, water
    /** Standard fixities: bottom fixed in x and y, sides fixed in x. Returns the boundary id. */
    fixAuto() { const b = ed.addAutoFixity(M()); changed(); return b ? b.id : M().boundaries.find((x) => x.target?.kind === 'auto').id; },
    /** Fix the nodes along the segment p1-p2: geo.fix([0,0],[10,0],{x:true,y:true}). Returns the boundary id. */
    fix(p1, p2, { x = true, y = true } = {}) {
      const b = ed.addFixSegment(M(), pt(p1, 'p1'), pt(p2, 'p2'), x, y);
      changed();
      return b.id;
    },
    /** Fix a single point. */
    fixPoint(p, { x = true, y = true } = {}) { const b = ed.addFixPoint(M(), pt(p), x, y); changed(); return b.id; },
    /** Point load (kN per m out of plane); fy negative = downward. Returns the load id. */
    pointLoad(p, fx = 0, fy = 0) {
      const l = ed.addPointLoad(M(), pt(p), num(fx, 'fx'), num(fy, 'fy'));
      changed();
      return l.id;
    },
    /** Distributed (line) load in kPa along p1-p2, global axes; optional (qx2, qy2) at p2 for a linear variation. */
    lineLoad(p1, p2, qx = 0, qy = 0, qx2 = qx, qy2 = qy) {
      const l = ed.addDistLoad(M(), pt(p1, 'p1'), pt(p2, 'p2'), num(qx, 'qx'), num(qy, 'qy'), num(qx2, 'qx2'), num(qy2, 'qy2'));
      changed();
      return l.id;
    },
    /**
     * Phreatic line. geo.water([[0,5],[40,3]]) polyline; geo.water(4) horizontal at y=4; geo.water(false) disables.
     */
    water(line) {
      const m = M();
      if (line === false || line === null) m.water.enabled = false;
      else {
        const pl = typeof line === 'number' ? ed.horizontalPhreatic(m, line) : line.map((p) => pt(p));
        if (pl.length < 2) throw new Error('water(): the phreatic line needs at least 2 points');
        m.water = { ...m.water, enabled: true, phreatic: pl.sort((a, b) => a[0] - b[0]) };
      }
      changed();
      return m.water.enabled;
    },
    /**
     * Add a construction stage: geo.stage({ name, activeRegions:[ids], activeLoads:[ids], initial:'k0'|'gravity' }). Returns its id.
     * The first geo.stage() call on a model without explicit stages defines the initial stage (so `initial:'k0'` is honoured
     * there); later calls append stages that inherit regions and loads from the previous one. `initial` is only meaningful
     * for the first stage and is rejected otherwise.
     */
    stage(spec = {}) {
      const m = M();
      const first = m.stages.length === 0;
      if (spec.initial !== undefined && !['k0', 'gravity'].includes(spec.initial)) throw new Error('stage(): initial must be "k0" or "gravity"');
      if (!first && spec.initial && spec.initial !== 'gravity') throw new Error('stage(): "initial" only applies to the first stage');
      const prev = m.stages[m.stages.length - 1];
      const id = spec.id || newId('S', m.stages);
      m.stages.push({
        id, name: spec.name || (first ? 'Initial' : `Stage ${m.stages.length}`),
        initial: first ? (spec.initial || 'gravity') : 'gravity',
        activeRegions: spec.activeRegions || (prev ? [...prev.activeRegions] : m.regions.map((r) => r.id)),
        activeLoads: spec.activeLoads || (prev ? [...prev.activeLoads] : m.loads.map((l) => l.id)),
        resetDisplacements: spec.resetDisplacements ?? first,
      });
      changed();
      return id;
    },

    // ------------------------------------------------------------------ settings
    /** Set a value by path: geo.set('settings.meshSize', 1), geo.set('materials.M1.phi', 30), geo.set('plot.field','syy'). */
    set(path, value) {
      if (/^plot\./.test(path)) { setPath(state.plot, path.slice(5), value); state.set({ plot: { ...state.plot } }); return value; }
      setPath(M(), path, value);
      changed();
      return value;
    },
    get(path) { return /^plot\./.test(path) ? getPath(state.plot, path.slice(5)) : getPath(M(), path); },

    // ------------------------------------------------------------------ analysis
    /** Generate the mesh. Options {size, type:'T3'|'T6'} are stored in settings. Returns the mesh statistics. */
    mesh({ size, type, ...rest } = {}) {
      const s = M().settings;
      if (size !== undefined) s.meshSize = num(size, 'size');
      if (type !== undefined) { if (!['T3', 'T6'].includes(type)) throw new Error('type must be "T3" or "T6"'); s.elementType = type; }
      if (size !== undefined || type !== undefined) changed({ keepMesh: true });
      const mesh = services.generateMesh(rest);
      return { ...mesh.stats, type: mesh.type };
    },
    /** Run the analysis (meshes first if needed). Resolves with a summary; full results are in geo.results. */
    async solve({ analysis } = {}) {
      if (analysis !== undefined) { if (!['static', 'fos'].includes(analysis)) throw new Error('analysis must be "static" or "fos"'); M().settings.analysis = analysis; changed({ keepMesh: true }); }
      if (state.busy) throw new Error('Another operation is running');
      state.set({ busy: true });
      let results;
      try {
        let last = 0;
        results = await services.solve({
          onProgress: (p) => { const t = performance.now(); if (p?.text && t - last > 400) { last = t; state.logMsg(p.text); } },
        });
      } finally { state.set({ busy: false }); }
      if (!results) throw new Error('Analysis cancelled');
      if (state.mode !== 'plot') state.set({ mode: 'plot' });
      return geo.summary();
    },
    cancel() { services.cancelSolve?.(); },
    /** Safety factor of the last strength-reduction analysis (null for static analyses). */
    fos() {
      if (!state.results) throw new Error('No results: run await geo.solve() first');
      return state.results.fos ?? null;
    },
    /** Compact summary of the current mesh/results. */
    summary() {
      const r = state.results;
      return {
        mesh: state.mesh ? { type: state.mesh.type, nodes: state.mesh.stats.nNodes, elements: state.mesh.stats.nElements } : null,
        results: r ? {
          ok: r.ok, message: r.message, analysis: r.analysis, fos: r.fos ?? null,
          stages: r.stages.map((s) => ({ id: s.id, name: s.name, converged: s.converged })),
        } : null,
      };
    },

    // ------------------------------------------------------------------ plotting & post-processing
    /**
     * Show a result field in Plot mode. geo.plot('syy'), geo.plot('eps_shear', { deformed: true, stage: 0 }).
     * Options: stage (index or id), deformed, scale, mesh, plastic, vectors, colormap ('rainbow'|'viridis'|'jet'), levels.
     */
    plot(field = state.plot.field, o = {}) {
      if (!FIELD_NAMES.includes(field)) throw new Error(`Unknown field "${field}". Available: ${FIELD_NAMES.join(', ')}`);
      const plot = { ...state.plot, field };
      if (o.stage !== undefined) plot.stageIndex = stageIndex(o.stage);
      if (o.deformed !== undefined) plot.deformed = !!o.deformed;
      if (o.scale !== undefined) plot.deformScale = o.scale;
      if (o.mesh !== undefined) plot.showMesh = !!o.mesh;
      if (o.plastic !== undefined) plot.showPlastic = !!o.plastic;
      if (o.vectors !== undefined) plot.showVectors = !!o.vectors;
      if (o.colormap !== undefined) plot.colormap = o.colormap;
      if (o.levels !== undefined) plot.nLevels = o.levels;
      state.set({ mode: 'plot', plot });
      return field;
    },
    /** {min, max, unit, label} of a nodal field for a stage (default: last). */
    range(field = state.plot.field, stage) {
      const s = currentStage(stage);
      return { ...fieldRange(nodalField(state.mesh, s, field)), ...fieldInfo(field) };
    },
    /** Nodal values (Float64Array) of a field. */
    field(field = state.plot.field, stage) { return nodalField(state.mesh, currentStage(stage), field); },
    /** Sample a field along p1-p2: [{s, x, y, v}]. */
    section(field, p1, p2, n = 50, stage) {
      const st = currentStage(stage);
      return sampleAlongLine(state.mesh, nodalField(state.mesh, st, field), pt(p1, 'p1'), pt(p2, 'p2'), n, st.activeElements);
    },
    /** Names of available result fields. */
    fields() { return [...FIELD_NAMES]; },
    help() {
      return [
        'geo.example(name) · geo.newModel() · geo.material({...}) · geo.region(pts, mat) · geo.rect(x1,y1,x2,y2, mat) · geo.line(pts)',
        'geo.assign(region, mat) · geo.fixAuto() · geo.fix(p1,p2,{x,y}) · geo.pointLoad(p,fx,fy) · geo.lineLoad(p1,p2,qx,qy) · geo.water(line|y|false)',
        'geo.stage({...}) · geo.set(path, v) · geo.get(path) · geo.mesh({size,type}) · await geo.solve({analysis}) · geo.fos()',
        'geo.plot(field, opts) · geo.range(field) · geo.section(field,p1,p2,n) · geo.export() · geo.load(json) · geo.model · geo.results',
      ].join('\n');
    },
  };
  return geo;
}
