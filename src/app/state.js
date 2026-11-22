// Shared application store (contract between UI and integration).
import { createExampleSlope } from '../core/model.js';

export function createState(initialModel = createExampleSlope()) {
  const listeners = new Set();
  const state = {
    model: initialModel,
    mesh: null,          // output of generateMesh, null when stale
    results: null,       // output of solve, null when stale
    plot: { field: 'umag', stageIndex: -1 /* last */, deformed: false, deformScale: null /* auto */, showMesh: true, showPlastic: false, showVectors: false, colormap: 'rainbow' },
    selection: null,     // { kind: 'region'|'vertex'|'load'|'boundary'|'line', id, index? }
    mode: 'geometry',    // 'geometry'|'mesh'|'material'|'boundary'|'loads'|'water'|'settings'|'solve'|'plot'
    tool: 'select',      // active tool within mode
    view: { scale: 10, ox: 0, oy: 0 }, // screen = (x*scale+ox, -y*scale+oy)
    busy: false,
    log: [],             // [{level:'info'|'warn'|'error', text}]
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    set(patch) { Object.assign(state, patch); state.notify(); },
    // Call after mutating state.model in place. Geometry/material/BC edits invalidate mesh & results.
    modelChanged({ keepMesh = false } = {}) { if (!keepMesh) state.mesh = null; state.results = null; state.notify(); },
    logMsg(text, level = 'info') { state.log.push({ level, text }); state.notify(); },
    notify() { for (const fn of listeners) fn(state); },
  };
  return state;
}
