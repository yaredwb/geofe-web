// Application services: mesh generation (main thread) and the FE analysis (Web Worker, with a main-thread
// fallback for Node / environments without module workers). The object returned by createServices() is what
// createUI() receives as `services` and what the scripting API (api.js) drives.
import { generateMesh as meshModel } from '../mesh/mesher.js';
import { solve as solveModel } from '../fem/solver.js';
import * as postFields from '../post/fields.js';
import * as render from '../post/render.js';
import { assertValid } from './model-utils.js';

/**
 * Local refinement around loads: the strip/footing edges and point loads are where stress gradients are
 * largest, so the mesh gets about twice the resolution there (the base mesh size is unchanged elsewhere).
 */
export function autoRefinement(model) {
  const h = Number(model.settings?.meshSize) || 2;
  const out = [];
  for (const l of model.loads || []) {
    if (l.type === 'point' && l.p) out.push({ p: l.p, size: h / 2.5, radius: 2 * h });
    else if (l.type === 'distributed' && l.p1 && l.p2) {
      out.push({ p: l.p1, size: h / 2, radius: 2 * h }, { p: l.p2, size: h / 2, radius: 2 * h });
    }
  }
  return out;
}

/** Sentinel for a cancelled run. */
export const CANCELLED = Symbol('cancelled');

/**
 * @param {object} state  store from state.js
 * @param {object} [opts]
 * @param {boolean} [opts.useWorker]  default: true when `Worker` exists (browser)
 * @param {() => Worker} [opts.createWorker]  factory for the solver worker (default: module worker for ../fem/worker.js)
 */
export function createServices(state, opts = {}) {
  const useWorker = opts.useWorker ?? (typeof Worker !== 'undefined');
  const createWorker = opts.createWorker || (() => new Worker(new URL('../fem/worker.js', import.meta.url), { type: 'module' }));
  let active = null;      // { cancel() } of the running solve
  let cancelRequested = false;

  const services = {
    postFields,
    render,

    /** Generate the mesh for the current model, store it in state (results become stale) and return it. */
    generateMesh(o = {}) {
      const model = state.model;
      assertValid(model);
      const t0 = performance.now();
      const mesh = meshModel(model, { refine: autoRefinement(model), ...o });
      mesh.stats.ms = performance.now() - t0;
      state.set({ mesh, results: null });
      for (const w of mesh.stats.warnings || []) state.logMsg(`Mesh: ${w}`, 'warn');
      state.logMsg(`Mesh generated: ${mesh.stats.nElements} ${mesh.type} elements, ${mesh.stats.nNodes} nodes, ` +
        `min angle ${mesh.stats.minAngle.toFixed(1)} deg (${mesh.stats.ms.toFixed(0)} ms)`);
      return mesh;
    },

    /**
     * Run the analysis. Generates the mesh first when it is stale. Resolves with the results (also stored in
     * state.results) or with null when cancelled; rejects on solver errors.
     */
    async solve({ onProgress, shouldCancel } = {}) {
      assertValid(state.model);
      if (!state.mesh) services.generateMesh();
      const model = state.model, mesh = state.mesh;
      cancelRequested = false;
      const isCancelled = () => cancelRequested || !!(shouldCancel && shouldCancel());
      const t0 = performance.now();
      let results;
      try {
        results = useWorker
          ? await runInWorker(model, mesh, onProgress, isCancelled)
          : await runDirect(model, mesh, onProgress, isCancelled);
      } finally { active = null; }
      if (results === CANCELLED || results?.cancelled) { state.logMsg('Analysis cancelled', 'warn'); return null; }
      results.elapsedMs = performance.now() - t0;
      state.set({ results });
      for (const w of results.warnings || []) state.logMsg(w, 'warn');
      state.logMsg(`${results.message || 'Analysis finished'} (${(results.elapsedMs / 1000).toFixed(1)} s)`, results.ok ? 'info' : 'warn');
      return results;
    },

    cancelSolve() { cancelRequested = true; active?.cancel(); },
  };

  /** Main-thread run (yields to the event loop first so the UI can paint the progress dialog). */
  async function runDirect(model, mesh, onProgress, isCancelled) {
    await new Promise((r) => setTimeout(r, 0));
    return solveModel(model, mesh, { onProgress, shouldCancel: isCancelled });
  }

  /** Run in a module Web Worker; cancelling terminates the worker (the solver is synchronous). */
  function runInWorker(model, mesh, onProgress, isCancelled) {
    return new Promise((resolve, reject) => {
      let worker;
      try { worker = createWorker(); } catch (e) { runDirect(model, mesh, onProgress, isCancelled).then(resolve, reject); return; }
      let finished = false;
      const finish = (fn, v) => { if (finished) return; finished = true; clearInterval(poll); worker.terminate(); fn(v); };
      const poll = setInterval(() => { if (isCancelled()) finish(resolve, CANCELLED); }, 100);
      active = { cancel: () => finish(resolve, CANCELLED) };
      worker.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'progress') { try { onProgress?.(m); } catch { /* UI callback errors must not kill the solve */ } }
        else if (m.type === 'done') finish(resolve, m.results);
        else if (m.type === 'error') finish(reject, new Error(m.message));
      };
      worker.onerror = (e) => finish(reject, new Error(e.message || 'Solver worker crashed'));
      worker.postMessage({ cmd: 'solve', model, mesh });
    });
  }

  return services;
}
