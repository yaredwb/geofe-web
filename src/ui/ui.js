// GeoFE user interface: createUI(rootEl, state, services) assembles menus, toolbar, panels, canvas, console.
import { createEmptyModel, validateModel } from '../core/model.js';
import { h } from './dom.js';
import { isTyping, downloadBlob } from './dom.js';
import { createModelCanvas } from './canvas.js';
import { createConsole, consoleHeader } from './console.js';
import { createMenuBar, createToolbar } from './menus.js';
import { createInfoPanel } from './panels/info.js';
import { createCommandPanel, MODES } from './panels/command.js';
import { buildTools, panTool } from './tools/index.js';
import { alertDialog, confirmDialog, formDialog, openModal } from './dialogs.js';
import { materialDialog, settingsDialog, regionDialog, stagesDialog, pointLoadDialog, distLoadDialog, waterLevelDialog } from './modeldialogs.js';
import { openLinePlotDialog } from './plotdialogs.js';
import { runSolve } from './solve.js';
import { createHistory } from './history.js';
import { watchModelSwitch } from './modelswitch.js';
import * as ed from './edit.js';
import { fmtCoord } from './format.js';

export const SHORTCUTS = [
  ['General', [
    ['Ctrl+Z / Ctrl+Y (Ctrl+Shift+Z)', 'Undo / redo'], ['Ctrl+S', 'Save model'], ['Ctrl+O', 'Open model'], ['Ctrl+Enter', 'Run analysis'], ['F9', 'Generate mesh'],
    ['1 … 9', 'Mode: Geometry, Mesh, Material, Boundary, Loads, Water, Settings, Solve, Plot'], ['Ctrl+`', 'Show / hide command line'], ['F1 or ?', 'This list'],
  ]],
  ['View', [
    ['Mouse wheel', 'Zoom about the cursor'], ['Middle drag / Space + drag / H', 'Pan'], ['F or Home', 'Zoom extents'], ['+ / -', 'Zoom in / out'], ['G', 'Toggle grid'], ['Shift (held)', 'Temporarily disable snapping'],
  ]],
  ['Geometry', [
    ['V', 'Select / move vertex'], ['P', 'Draw polygon region'], ['R', 'Draw rectangle region'], ['L', 'Add internal line'],
    ['Enter / double-click / right-click', 'Finish polygon, line or phreatic line'], ['Backspace', 'Remove last point while drawing'], ['Esc', 'Cancel the current operation / clear selection'], ['Delete', 'Delete selected item'],
  ]],
  ['Command line', [['Enter', 'Run'], ['Shift+Enter', 'New line'], ['↑ / ↓', 'History'], ['Tab', 'Complete geo.xxx'], ['Ctrl+L', 'Clear']]],
];

/**
 * Build the application UI inside `rootEl`.
 * @param {HTMLElement} rootEl
 * @param {object} state  store from src/app/state.js
 * @param {object} services { generateMesh, solve, cancelSolve, postFields, render, api, io }
 * @returns {{ app, destroy, redraw, getCanvas, snapshotCanvas, toast, setMode }}
 */
export function createUI(rootEl, state, services = {}) {
  services = { io: {}, api: {}, ...services };
  rootEl.classList.add('gf-app');
  rootEl.textContent = '';

  // ------------------------------------------------------------ app context shared by all UI modules
  const app = {
    state, services,
    opts: { grid: true, snapGrid: true, snapGeom: true, labels: true, showMesh: true, showBC: true, showLoads: true, showWater: true, showInfo: true, showPanel: true, showConsole: true },
    cursor: { model: null, raw: null, screen: null, snapKind: 'none', inside: false },
    infoOpen: {},
    hoverRegion: null,
    plotCache: null,
    validation: null,
    section: null,
    dragging: false,
    suppressPanel: false,
    _activeMaterial: null,
    _hint: null,
  };
  if (state.plot.nLevels === undefined) state.plot.nLevels = 12;
  const toolsByMode = buildTools();
  app.toolsFor = (mode) => toolsByMode[mode] || [];
  app.panTool = panTool;
  app.history = createHistory(state);

  // ------------------------------------------------------------ DOM skeleton
  const menuHost = h('div.gf-menuhost');
  const toolbarHost = h('div.gf-toolbarhost');
  const infoHost = h('aside.gf-info');
  const canvasHost = h('div.gf-canvashost');
  const toastHost = h('div.gf-toasts');
  const splitter = h('div.gf-splitter', { title: 'Drag to resize' });
  const consoleHost = h('div.gf-console');
  const centerCol = h('div.gf-center', h('div.gf-canvaswrap', canvasHost, toastHost), splitter, consoleHost);
  const panelHost = h('aside.gf-panel');
  const main = h('div.gf-main', infoHost, centerCol, panelHost);
  const statusLeft = h('span.gf-st-coords', 'x: –  y: –');
  const statusSnap = h('span.gf-st-snap');
  const statusMode = h('span.gf-st-mode');
  const statusHint = h('span.gf-st-hint');
  const statusRight = h('span.gf-st-right');
  const status = h('div.gf-status', statusLeft, statusSnap, statusMode, statusHint, statusRight);
  rootEl.append(menuHost, toolbarHost, main, status);

  // ------------------------------------------------------------ small services
  // opts: { ms: display time, quiet: do not echo to the command line (the caller already logged the text) }
  app.toast = (text, kind = 'info', { ms = kind === 'error' ? 6000 : 3200, quiet = false } = {}) => {
    const t = h('div.gf-toast.' + kind, text);
    toastHost.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, ms);
    while (toastHost.childElementCount > 4) toastHost.firstChild.remove();
    if (kind !== 'info' && !quiet) app.console?.print(text, kind === 'error' ? 'err' : 'warn');
  };
  app.hint = (text) => { app._hint = text; updateStatus(); };
  app.quiet = (fn) => { app.suppressPanel = true; try { fn(); } finally { app.suppressPanel = false; } };
  app.select = (sel) => state.set({ selection: sel });
  app.setHover = (id) => { if (app.hoverRegion !== id) { app.hoverRegion = id; app.canvas?.invalidate(); } };
  app.commit = ({ quiet = false } = {}) => { state.modelChanged(); return quiet; };
  app.currentTool = () => (state.tool === 'pan' ? panTool : app.toolsFor(state.mode).find((t) => t.id === state.tool) || app.toolsFor(state.mode)[0]);
  app.activeMaterialId = () => {
    const mats = state.model.materials;
    if (app._activeMaterial && mats.some((m) => m.id === app._activeMaterial)) return app._activeMaterial;
    return mats.length ? mats[0].id : null;
  };
  app.setActiveMaterial = (id) => { app._activeMaterial = id; state.notify(); };
  app.toggleOpt = (k) => { app.opts[k] = !app.opts[k]; applyLayout(); app.canvas?.invalidate(); updateChrome(); };
  app.applyLayout = () => applyLayout();
  app.updateChrome = () => updateChrome();
  app.updateStatusCursor = () => updateStatusCursor();
  app.openLinePlot = (p1, p2) => openLinePlotDialog(app, p1, p2);

  app.setTool = (id) => {
    const old = app.currentTool();
    if (old && old.id === id) return;
    old?.cancel?.(app); old?.deactivate?.(app);
    state.set({ tool: id });
    const t = app.currentTool();
    t?.activate?.(app);
    app._hint = t?.hint || null;
    updateStatus();
    app.canvas?.redrawOverlay();
  };
  app.setMode = (mode) => {
    if (!MODES.some((m) => m.id === mode)) return;
    const changed = mode !== state.mode;
    const old = app.currentTool();
    old?.cancel?.(app); old?.deactivate?.(app);
    const def = app.toolsFor(mode)[0];
    const keepPan = state.tool === 'pan';
    const selKeep = mode === state.mode;
    state.set({ mode, tool: keepPan ? 'pan' : def?.id || 'select', selection: selKeep ? state.selection : null });
    app.setHover(null);
    const t = app.currentTool();
    t?.activate?.(app);
    app._hint = t?.hint || null;
    updateStatus();
    if (changed && mode === 'settings') setTimeout(() => actions.openSettings(), 30);
  };

  // ------------------------------------------------------------ actions (menus, toolbar, panels, shortcuts)
  const guard = (fn) => async (...a) => {
    try { return await fn(...a); } catch (e) { console.error(e); app.toast(String(e?.message || e), 'error'); return undefined; }
  };

  const actions = {
    newModel: guard(async () => {
      if (state.model.regions.length && !(await confirmDialog('New model', 'Discard the current model and start a new one?', { okLabel: 'New model' }))) return;
      if (services.io?.newModel) await services.io.newModel();
      else state.set({ model: createEmptyModel(), mesh: null, results: null, selection: null });
      app.setMode('geometry');
    }),
    open: guard(async () => {
      const input = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
      document.body.appendChild(input);
      input.addEventListener('change', async () => {
        const f = input.files[0]; input.remove();
        if (!f) return;
        try { await services.io.load(f); app.toast(`Loaded ${f.name}`); } catch (e) { app.toast(`Cannot open file: ${e.message || e}`, 'error'); }
      });
      input.click();
    }),
    save: guard(async () => { if (services.io?.save) await services.io.save(); else downloadBlob('model.json', JSON.stringify(state.model, null, 2), 'application/json'); }),
    exportPNG: guard(async () => {
      const c = app.snapshotCanvas();
      if (services.io?.exportPNG) await services.io.exportPNG(c);
      else downloadBlob('model.png', await new Promise((r) => c.toBlob(r, 'image/png')));
    }),
    loadExample: guard(async (name) => { await services.io.loadExample(name); app.setMode('geometry'); app.canvas.zoomExtents(); }),
    undo() { if (app.history.undo()) app.toast('Undo', 'info'); },
    redo() { if (app.history.redo()) app.toast('Redo', 'info'); },
    zoomExtents() { app.canvas.zoomExtents(); },

    deleteSelection() {
      const sel = state.selection, m = state.model;
      if (!sel) return;
      if (sel.kind === 'region') ed.deleteRegion(m, sel.id);
      else if (sel.kind === 'line') ed.deleteLine(m, sel.id);
      else if (sel.kind === 'load') ed.deleteLoad(m, sel.id);
      else if (sel.kind === 'boundary') ed.deleteBoundary(m, sel.id);
      else if (sel.kind === 'water') { m.water.phreatic.splice(sel.index, 1); }
      else if (sel.kind === 'vertex') {
        const o = (sel.owner === 'line' ? m.lines : m.regions).find((x) => x.id === sel.id);
        const p = o?.points[sel.index];
        if (!p || !ed.deleteVertexEverywhere(m, p)) { app.toast('Cannot delete: a region needs at least 3 vertices', 'warn'); return; }
      } else return;
      state.selection = null;
      app.commit();
    },
    clearGeometry: guard(async () => {
      if (!(await confirmDialog('Clear geometry', 'Remove all regions and internal lines?', { okLabel: 'Clear' }))) return;
      state.model.regions = []; state.model.lines = []; state.model.stages = []; state.selection = null; app.commit();
    }),

    generateMesh: guard(async ({ silent = false } = {}) => {
      const m = state.model;
      if (!m.regions.length) { app.toast('Nothing to mesh: draw a region first', 'warn'); return null; }
      if (!services.generateMesh) throw new Error('No mesher available');
      const t0 = performance.now();
      const wasBusy = state.busy; // runSolve sets busy before meshing; do not drop it when the mesh is done
      state.set({ busy: true });
      try {
        await new Promise((r) => setTimeout(r, 10)); // let the busy state paint
        const mesh = await services.generateMesh();
        if (mesh && state.mesh !== mesh) state.set({ mesh });
        const ms = performance.now() - t0;
        const mm = state.mesh;
        if (!silent && mm) app.toast(`Mesh: ${mm.stats?.nElements ?? mm.elements.length / mm.nen} elements, ${mm.stats?.nNodes ?? mm.nodes.length / 2} nodes (${ms.toFixed(0)} ms)`);
        return mm;
      } catch (e) {
        await alertDialog('Mesh generation failed', String(e.message || e), { kind: 'error' });
        return null;
      } finally { state.set({ busy: wasBusy }); }
    }),
    runSolve: guard(() => runSolve(app)),
    cancelSolve() { try { services.cancelSolve?.(); } catch (e) { app.toast(String(e.message || e), 'error'); } },
    validate() {
      const v = validateModel(state.model);
      app.validation = v;
      app.setMode('solve');
      state.notify();
      app.toast(v.ok ? 'Model is valid' : `${v.errors.length} problem(s) found`, v.ok ? 'info' : 'warn');
    },

    openSettings: guard(async () => { if (await settingsDialog(state.model)) app.commit(); }),
    openStages: guard(async () => { if (await stagesDialog(state.model)) app.commit(); }),
    meshSize: guard(async () => {
      const r = await formDialog({ title: 'Mesh size', width: 320, fields: [{ key: 'size', label: 'Target element size', type: 'number', value: state.model.settings.meshSize, unit: 'm', minExclusive: 0 }] });
      if (r) { state.model.settings.meshSize = r.size; app.commit(); }
    }),

    addMaterial: guard(async () => {
      const m = state.model;
      const mat = await materialDialog(ed.makeMaterial(m), { isNew: true });
      if (!mat) return;
      m.materials.push(mat); app._activeMaterial = mat.id; app.commit();
    }),
    editMaterial: guard(async (id = app.activeMaterialId()) => {
      const mat = state.model.materials.find((x) => x.id === id);
      if (!mat) return;
      const r = await materialDialog(mat);
      if (r) { Object.assign(mat, r); app.commit(); }
    }),
    deleteMaterial: guard(async (id = app.activeMaterialId()) => {
      const m = state.model, mat = m.materials.find((x) => x.id === id);
      if (!mat) return;
      const used = m.regions.filter((r) => r.materialId === id).length;
      if (!(await confirmDialog('Delete material', `Delete "${mat.name}"?${used ? ` ${used} region(s) will have no material.` : ''}`, { okLabel: 'Delete' }))) return;
      ed.deleteMaterial(m, id); app._activeMaterial = null; app.commit();
    }),
    editRegion(id) {
      const m = state.model;
      const rid = id || (state.selection?.kind === 'region' ? state.selection.id : state.selection?.kind === 'vertex' && state.selection.owner === 'region' ? state.selection.id : m.regions[0]?.id);
      const r = m.regions.find((x) => x.id === rid);
      if (!r) { app.toast('Select a region first', 'warn'); return; }
      regionDialog(m, r).then((ok) => { if (ok) { state.selection = { kind: 'region', id: r.id }; app.commit(); } });
    },
    editLoad: guard(async (id) => {
      const l = state.model.loads.find((x) => x.id === id);
      if (!l) return;
      if (l.type === 'point') {
        const r = await pointLoadDialog(l.p, l);
        if (r) { l.fx = r.fx; l.fy = r.fy; app.commit(); }
      } else {
        const r = await distLoadDialog(l.p1, l.p2, l);
        if (r) { Object.assign(l, r); app.commit(); }
      }
    }),
    autoFixity() {
      if (ed.addAutoFixity(state.model)) { app.commit(); app.toast('Automatic fixity added: base fixed, sides rollers'); } else app.toast('Automatic fixity is already defined', 'warn');
    },
    clearBoundaries() { state.model.boundaries = []; state.selection = null; app.commit(); },
    deleteBoundary(id) { ed.deleteBoundary(state.model, id); state.selection = null; app.commit(); },
    clearLoads() { state.model.loads = []; ed.pruneStageRefs(state.model); state.selection = null; app.commit(); },
    deleteLoad(id) { ed.deleteLoad(state.model, id); state.selection = null; app.commit(); },
    clearWater() { state.model.water.phreatic = []; state.model.water.enabled = false; state.selection = null; app.commit(); },
    waterLevel: guard(async () => {
      const m = state.model;
      const y0 = m.water.phreatic.length ? m.water.phreatic[0][1] : 0;
      const r = await waterLevelDialog(y0);
      if (!r) return;
      m.water.phreatic = ed.horizontalPhreatic(m, r.y); m.water.enabled = true; app.commit();
    }),

    showShortcuts() {
      const body = h('div.gf-shortcuts', SHORTCUTS.map(([title, rows]) => h('div', h('h4', title), h('table.gf-kv', h('tbody', rows.map(([k, d]) => h('tr', h('th', h('kbd', k)), h('td', d))))))));
      openModal({ title: 'Keyboard shortcuts', body, width: 600, buttons: [{ label: 'Close', primary: true }] });
    },
    about() {
      alertDialog('About GeoFE', h('div', h('p', h('b', 'GeoFE Web'), ' - a 2D geotechnical finite element program for the browser.'), h('p', 'Workflow: Geometry → Mesh → Material → Boundary & Loads → Solve (static or strength-reduction FOS) → Plot.'), h('p', 'Units: m, kN, kPa. x right, y up; gravity acts in −y.')));
    },
  };
  app.actions = actions;
  app.editRegion = actions.editRegion;
  app.editLoad = actions.editLoad;

  // ------------------------------------------------------------ build components
  const menubar = createMenuBar(app, menuHost);
  const toolbar = createToolbar(app, toolbarHost);
  const info = createInfoPanel(app, infoHost);
  const cmd = createCommandPanel(app, panelHost);
  app.canvas = createModelCanvas(app, canvasHost);
  app.snapshotCanvas = () => {
    const src = app.canvas.baseCanvas();
    const c = document.createElement('canvas');
    c.width = src.width; c.height = src.height;
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  };
  const dockHead = consoleHeader(app, { onToggle: () => app.toggleOpt('showConsole'), onClear: () => app.console.clear() });
  const consoleBody = h('div.gf-console-body');
  consoleHost.append(dockHead, consoleBody);
  app.console = createConsole(app, consoleBody);

  // dock splitter
  let splitDrag = null;
  splitter.addEventListener('pointerdown', (e) => { splitDrag = { y: e.clientY, h: consoleHost.getBoundingClientRect().height }; splitter.setPointerCapture(e.pointerId); });
  splitter.addEventListener('pointermove', (e) => {
    if (!splitDrag) return;
    const hh = Math.max(70, Math.min(window.innerHeight * 0.7, splitDrag.h - (e.clientY - splitDrag.y)));
    consoleHost.style.height = hh + 'px';
  });
  splitter.addEventListener('pointerup', () => { splitDrag = null; app.canvas.resize(); });

  function applyLayout() {
    rootEl.classList.toggle('no-info', !app.opts.showInfo);
    rootEl.classList.toggle('no-panel', !app.opts.showPanel);
    rootEl.classList.toggle('no-console', !app.opts.showConsole);
    queueMicrotask(() => app.canvas?.resize());
  }

  // ------------------------------------------------------------ status bar
  function updateStatusCursor() {
    const c = app.cursor;
    if (c.model && c.inside) {
      const u = state.model.units?.length || 'm';
      statusLeft.textContent = `x: ${fmtCoord(c.model[0], 3)}  y: ${fmtCoord(c.model[1], 3)} ${u}`;
      statusSnap.textContent = c.snapKind && c.snapKind !== 'none' ? `snap: ${c.snapKind}` : '';
    } else { statusLeft.textContent = 'x: –  y: –'; statusSnap.textContent = ''; }
  }
  function updateStatus() {
    const mode = MODES.find((m) => m.id === state.mode);
    const tool = app.currentTool();
    statusMode.textContent = `${mode?.label || state.mode}${tool ? ' · ' + tool.label : ''}`;
    statusHint.textContent = app._hint || tool?.hint || '';
    const mesh = state.mesh;
    statusRight.textContent = state.busy ? 'Working…' : [`${state.model.regions.length} region(s)`, mesh ? `${mesh.stats?.nElements ?? mesh.elements.length / mesh.nen} elements` : 'no mesh', state.results ? (state.results.analysis === 'fos' && state.results.fos != null ? `FOS ${Number(state.results.fos).toFixed(2)}` : 'solved') : 'unsolved'].join('  |  ');
    statusRight.classList.toggle('busy', !!state.busy);
  }
  function updateChrome() {
    toolbar.update(); updateStatus();
  }

  // ------------------------------------------------------------ store subscription
  let lastMode = state.mode;
  let lastResults = state.results;
  const checkModelSwitch = watchModelSwitch(state, app);
  const unsub = state.subscribe(() => {
    if (checkModelSwitch()) toastHost.replaceChildren(); // toasts about the previous model are stale
    // Results that appear from outside the Solve button (e.g. `await geo.solve()` in the console) -> show them.
    if (state.results !== lastResults) {
      const fresh = state.results && !state.busy && state.mode !== 'plot' && state.results.stages?.length;
      lastResults = state.results;
      if (fresh) queueMicrotask(() => app.setMode('plot'));
      // Solver warnings (already in the log / command line) must not go unnoticed: toast + persistent notes in the panels.
      const nw = state.results?.warnings?.length || 0;
      if (nw) app.toast(`Solver warning${nw > 1 ? `s (${nw})` : ''}: ${state.results.warnings[0]}${nw > 1 ? ' (more in the Solve panel)' : ''}`, 'warn', { ms: 9000, quiet: true });
    }
    if (state.mode !== lastMode) { lastMode = state.mode; app._hint = null; }
    // first time Plot mode shows a given result set: refit so the legend does not cover the model
    if (state.mode === 'plot' && state.results && app._fittedFor !== state.results) {
      app._fittedFor = state.results;
      queueMicrotask(() => app.canvas?.zoomExtents());
    }
    // keep tool valid for mode (e.g. when mode changed from outside via geo.plot())
    if (state.tool !== 'pan' && !app.toolsFor(state.mode).some((t) => t.id === state.tool)) {
      state.tool = app.toolsFor(state.mode)[0]?.id || 'select';
    }
    info.update();
    cmd.update();
    updateChrome();
    updateStatusCursor();
  });

  // ------------------------------------------------------------ keyboard
  const onKey = (ev) => {
    if (document.querySelector('.gf-modal-overlay:not(.gf-nonmodal)')) return;
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (ctrl && ev.key === '`') { ev.preventDefault(); app.toggleOpt('showConsole'); if (app.opts.showConsole) app.console.focus(); return; }
    if (isTyping()) return;
    if (ctrl) {
      const k = ev.key.toLowerCase();
      if (k === 'z') { ev.preventDefault(); ev.shiftKey ? actions.redo() : actions.undo(); }
      else if (k === 'y') { ev.preventDefault(); actions.redo(); }
      else if (k === 's') { ev.preventDefault(); actions.save(); }
      else if (k === 'o') { ev.preventDefault(); actions.open(); }
      else if (ev.key === 'Enter') { ev.preventDefault(); actions.runSolve(); }
      return;
    }
    if (ev.altKey) return;
    const tool = app.currentTool();
    if (tool?.onKey?.(app, ev)) { ev.preventDefault(); app.canvas.redrawOverlay(); updateStatus(); return; }
    const k = ev.key;
    if (k === 'Escape') {
      if (state.selection) app.select(null);
      else if (state.tool !== (app.toolsFor(state.mode)[0]?.id)) app.setTool(app.toolsFor(state.mode)[0]?.id || 'select');
      return;
    }
    if (k === 'Delete' || k === 'Backspace') { if (state.selection) { ev.preventDefault(); actions.deleteSelection(); } return; }
    if (k === 'F9') { ev.preventDefault(); actions.generateMesh(); return; }
    if (k === 'F1' || k === '?') { ev.preventDefault(); actions.showShortcuts(); return; }
    if (/^[1-9]$/.test(k)) { ev.preventDefault(); app.setMode(MODES[Number(k) - 1].id); return; }
    switch (k.toLowerCase()) {
      case 'v': app.setMode('geometry'); app.setTool('select'); break;
      case 'p': app.setMode('geometry'); app.setTool('polygon'); break;
      case 'r': app.setMode('geometry'); app.setTool('rect'); break;
      case 'l': app.setMode('geometry'); app.setTool('line'); break;
      case 'h': app.setTool('pan'); break;
      case 'g': app.toggleOpt('grid'); break;
      case 'f': case 'home': app.canvas.zoomExtents(); break;
      case '+': case '=': app.canvas.zoomBy(1.25); break;
      case '-': case '_': app.canvas.zoomBy(0.8); break;
      default: return;
    }
    ev.preventDefault();
  };
  document.addEventListener('keydown', onKey);

  // ------------------------------------------------------------ initial layout
  applyLayout();
  const t0 = app.currentTool(); t0?.activate?.(app);
  updateChrome(); updateStatusCursor(); info.update(); cmd.update();

  return {
    app,
    redraw: () => app.canvas.invalidate(),
    getCanvas: () => app.canvas.el,
    snapshotCanvas: () => app.snapshotCanvas(),
    toast: app.toast,
    setMode: app.setMode,
    print: (t, k) => app.console.print(t, k),
    destroy() {
      document.removeEventListener('keydown', onKey);
      unsub(); menubar.destroy(); app.canvas.destroy(); app.console.destroy(); app.history.destroy();
      rootEl.textContent = ''; rootEl.classList.remove('gf-app');
    },
  };
}

