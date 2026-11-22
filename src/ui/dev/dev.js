// Dev harness: wires createUI with stub (or real, if present) services. Not part of the production app.
import { createState } from '../../app/state.js';
import { createExampleSlope, createExampleFooting, createEmptyModel } from '../../core/model.js';
import * as postFields from '../../post/fields.js';
import * as render from '../../post/render.js';
import { createUI } from '../ui.js';
import { stubMesh, stubSolve } from './stubs.js';

const state = createState(createExampleSlope());
let cancelFlag = false;

async function tryImport(p) { try { return await import(/* @vite-ignore */ p); } catch { return null; } }
const realMesher = await tryImport('../../mesh/mesher.js');
const realSolver = await tryImport('../../fem/solver.js');
const forceStub = new URLSearchParams(location.search).has('stub');

const services = {
  postFields, render,
  generateMesh() {
    const mesh = realMesher && !forceStub ? realMesher.generateMesh(state.model) : stubMesh(state.model);
    state.set({ mesh, results: null });
    return mesh;
  },
  async solve(opts = {}) {
    cancelFlag = false;
    const fn = realSolver && !forceStub ? realSolver.solve : stubSolve;
    const results = await fn(state.model, state.mesh, { onProgress: opts.onProgress, shouldCancel: () => cancelFlag || opts.shouldCancel?.() });
    state.set({ results });
    return results;
  },
  cancelSolve() { cancelFlag = true; },
  api: {
    get model() { return state.model; },
    example(name) { state.set({ model: name === 'footing' ? createExampleFooting() : createExampleSlope(), mesh: null, results: null }); return name; },
    mesh() { return services.generateMesh().stats; },
    solve: () => services.solve(),
    fos: () => state.results?.fos,
    set(path, value) { const parts = path.replace(/^model\./, '').split('.'); let o = state.model; for (const p of parts.slice(0, -1)) o = o[p]; o[parts.at(-1)] = value; state.modelChanged(); return value; },
    plot(field) { state.set({ mode: 'plot', plot: { ...state.plot, field } }); },
  },
  io: {
    save() { const blob = new Blob([JSON.stringify(state.model, null, 2)]); console.log('save', blob.size); },
    async load(file) { state.set({ model: JSON.parse(await file.text()), mesh: null, results: null }); },
    exportPNG(canvas) { console.log('exportPNG', canvas.width, canvas.height); },
    newModel() { state.set({ model: createEmptyModel(), mesh: null, results: null, selection: null }); },
    loadExample(name) { services.api.example(name); },
  },
};

const ui = createUI(document.getElementById('app'), state, services);
window.__ui = ui; window.__state = state; window.geo = services.api;
