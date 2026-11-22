// Menu bar (File, Geometry, Mesh, Material, Boundary, Loads, Water, Stages, Solve, Plot, View, Help).
import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { listExamples } from '../app/examples.js';
import { FIELD_ORDER, fieldMeta } from './format.js';

/** Menu structure. Each menu: {label, items: () => [item]}; item: {label, run, shortcut, checked, disabled, items, sep, icon}. */
export function buildMenus(app) {
  const { state, actions: A } = app;
  const mode = (id, tool) => () => { app.setMode(id); if (tool) app.setTool(tool); };
  const has = () => state.model.regions.length > 0;
  return [
    { label: 'File', items: () => [
      { label: 'New model', run: A.newModel, icon: 'new' },
      { label: 'Open…', run: A.open, shortcut: 'Ctrl+O', icon: 'open' },
      { label: 'Save', run: A.save, shortcut: 'Ctrl+S', icon: 'save' },
      { sep: true },
      { label: 'Load example', icon: 'stage', items: listExamples().map(({ name, title }) => ({ label: title, run: () => A.loadExample(name) })) },
      { sep: true },
      { label: 'Export image (PNG)…', run: A.exportPNG, icon: 'png' },
    ] },
    { label: 'Geometry', items: () => [
      { label: 'Select / move vertex', run: mode('geometry', 'select'), shortcut: 'V', icon: 'select' },
      { label: 'Draw polygon region', run: mode('geometry', 'polygon'), shortcut: 'P', icon: 'polygon' },
      { label: 'Draw rectangle region', run: mode('geometry', 'rect'), shortcut: 'R', icon: 'rect' },
      { label: 'Add internal line', run: mode('geometry', 'line'), shortcut: 'L', icon: 'line' },
      { sep: true },
      { label: 'Edit region coordinates…', run: () => A.editRegion(), disabled: !has(), icon: 'table' },
      { label: 'Delete selected', run: A.deleteSelection, shortcut: 'Del', disabled: !state.selection, icon: 'delete' },
      { sep: true },
      { label: 'Clear all geometry', run: A.clearGeometry, disabled: !has() },
    ] },
    { label: 'Mesh', items: () => [
      { label: 'Generate mesh', run: A.generateMesh, shortcut: 'F9', icon: 'generate' },
      { label: 'Element type', items: [
        { label: 'T3 (linear triangle)', checked: state.model.settings.elementType === 'T3', run: () => { state.model.settings.elementType = 'T3'; app.commit(); } },
        { label: 'T6 (quadratic triangle)', checked: state.model.settings.elementType === 'T6', run: () => { state.model.settings.elementType = 'T6'; app.commit(); } },
      ] },
      { label: 'Mesh size…', run: A.meshSize },
      { label: 'Discard mesh', run: () => { state.mesh = null; state.results = null; state.notify(); }, disabled: !state.mesh },
      { sep: true },
      { label: 'Show mesh on model', checked: app.opts.showMesh, run: () => app.toggleOpt('showMesh') },
      { label: 'Mesh mode', run: mode('mesh') },
    ] },
    { label: 'Material', items: () => [
      { label: 'Add material…', run: A.addMaterial, icon: 'plus' },
      { label: 'Edit active material…', run: () => A.editMaterial(), disabled: !state.model.materials.length, icon: 'edit' },
      { label: 'Delete active material', run: () => A.deleteMaterial(), disabled: !state.model.materials.length },
      { sep: true },
      { label: 'Assign to region (click)', run: mode('material', 'assign'), icon: 'assign' },
      ...state.model.materials.map((m) => ({ label: m.name, checked: app.activeMaterialId() === m.id, run: () => { app.setActiveMaterial(m.id); app.setMode('material'); } })),
    ] },
    { label: 'Boundary', items: () => [
      { label: 'Auto fixity', run: A.autoFixity, icon: 'auto' },
      { label: 'Fix segment (2 clicks)', run: mode('boundary', 'fixseg'), icon: 'boundary' },
      { label: 'Fix point', run: mode('boundary', 'fixpoint'), icon: 'pin' },
      { sep: true },
      { label: 'Clear all fixities', run: A.clearBoundaries, disabled: !state.model.boundaries.length },
    ] },
    { label: 'Loads', items: () => [
      { label: 'Point load', run: mode('loads', 'pointload'), icon: 'pointload' },
      { label: 'Distributed load', run: mode('loads', 'distload'), icon: 'distload' },
      { sep: true },
      { label: 'Clear all loads', run: A.clearLoads, disabled: !state.model.loads.length },
    ] },
    { label: 'Water', items: () => [
      { label: 'Draw phreatic line', run: mode('water', 'phreatic'), icon: 'phreatic' },
      { label: 'Horizontal water level…', run: A.waterLevel, icon: 'water' },
      { label: 'Water table active', checked: state.model.water.enabled, run: () => { state.model.water.enabled = !state.model.water.enabled; app.commit(); } },
      { label: 'Clear water table', run: A.clearWater, disabled: !state.model.water.phreatic.length },
    ] },
    { label: 'Stages', items: () => [
      { label: 'Edit stages…', run: A.openStages, icon: 'stage' },
      { label: 'Remove all stages (single default stage)', run: () => { state.model.stages = []; app.commit(); }, disabled: !(state.model.stages || []).length },
    ] },
    { label: 'Solve', items: () => [
      { label: 'Analysis settings…', run: A.openSettings, icon: 'settings' },
      { label: 'Validate model', run: A.validate, icon: 'check' },
      { sep: true },
      { label: 'Run analysis', run: A.runSolve, shortcut: 'Ctrl+Enter', disabled: state.busy, icon: 'solve' },
      { label: 'Cancel analysis', run: A.cancelSolve, disabled: !state.busy, icon: 'stop' },
    ] },
    { label: 'Plot', items: () => [
      { label: 'Plot mode', run: mode('plot', 'probe'), icon: 'plot' },
      { label: 'Quantity', items: FIELD_ORDER.map((n) => ({ label: fieldMeta(n, app.services.postFields).label, checked: state.plot.field === n, run: () => { state.set({ plot: { ...state.plot, field: n } }); app.setMode('plot'); } })) },
      { label: 'Deformed mesh', checked: state.plot.deformed, run: () => state.set({ plot: { ...state.plot, deformed: !state.plot.deformed } }) },
      { label: 'Show mesh', checked: state.plot.showMesh, run: () => state.set({ plot: { ...state.plot, showMesh: !state.plot.showMesh } }) },
      { label: 'Plastic points', checked: state.plot.showPlastic, run: () => state.set({ plot: { ...state.plot, showPlastic: !state.plot.showPlastic } }) },
      { label: 'Displacement vectors', checked: state.plot.showVectors, run: () => state.set({ plot: { ...state.plot, showVectors: !state.plot.showVectors } }) },
      { sep: true },
      { label: 'Line plot (section)…', run: mode('plot', 'section'), icon: 'section' },
      { label: 'Export image (PNG)…', run: A.exportPNG, icon: 'png' },
    ] },
    { label: 'View', items: () => [
      { label: 'Zoom extents', run: A.zoomExtents, shortcut: 'F / Home', icon: 'extents' },
      { label: 'Zoom in', run: () => app.canvas.zoomBy(1.25), shortcut: '+', icon: 'zoomin' },
      { label: 'Zoom out', run: () => app.canvas.zoomBy(0.8), shortcut: '-', icon: 'zoomout' },
      { sep: true },
      { label: 'Grid', checked: app.opts.grid, run: () => app.toggleOpt('grid'), shortcut: 'G' },
      { label: 'Snap to grid', checked: app.opts.snapGrid, run: () => app.toggleOpt('snapGrid') },
      { label: 'Snap to vertices / edges', checked: app.opts.snapGeom, run: () => app.toggleOpt('snapGeom') },
      { label: 'Region labels', checked: app.opts.labels, run: () => app.toggleOpt('labels') },
      { label: 'Show supports', checked: app.opts.showBC, run: () => app.toggleOpt('showBC') },
      { label: 'Show loads', checked: app.opts.showLoads, run: () => app.toggleOpt('showLoads') },
      { label: 'Show water table', checked: app.opts.showWater, run: () => app.toggleOpt('showWater') },
      { sep: true },
      { label: 'Info panel', checked: app.opts.showInfo, run: () => app.toggleOpt('showInfo') },
      { label: 'Command panel', checked: app.opts.showPanel, run: () => app.toggleOpt('showPanel') },
      { label: 'Command line', checked: app.opts.showConsole, run: () => app.toggleOpt('showConsole'), shortcut: 'Ctrl+`' },
    ] },
    { label: 'Help', items: () => [
      { label: 'Keyboard shortcuts', run: A.showShortcuts, icon: 'help' },
      { label: 'Scripting help (command line)', run: () => { app.opts.showConsole = true; app.applyLayout(); app.console.print('Type help() for the guide. Try: geo.example("slope"); await geo.solve()', 'sys'); app.console.focus(); } },
      { sep: true },
      { label: 'About GeoFE', run: A.about },
    ] },
  ];
}

export function createMenuBar(app, host) {
  const menus = buildMenus(app);
  const bar = h('div.gf-menubar', { role: 'menubar' });
  host.appendChild(bar);
  let openIdx = -1;
  let popups = [];
  const heads = menus.map((m, i) => {
    const b = h('button.gf-menuhead', { type: 'button', role: 'menuitem', onmousedown: (e) => { e.preventDefault(); toggle(i); }, onmouseenter: () => { if (openIdx >= 0 && openIdx !== i) open(i); } }, m.label);
    bar.appendChild(b);
    return b;
  });

  function closeAll() {
    for (const p of popups) p.remove();
    popups = [];
    heads.forEach((b) => b.classList.remove('open'));
    openIdx = -1;
    document.removeEventListener('mousedown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function outside(e) { if (!e.target.closest('.gf-menupop') && !e.target.closest('.gf-menuhead')) closeAll(); }
  function onKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeAll(); }
    else if (e.key === 'ArrowRight' && openIdx >= 0) { e.preventDefault(); open((openIdx + 1) % menus.length); }
    else if (e.key === 'ArrowLeft' && openIdx >= 0) { e.preventDefault(); open((openIdx + menus.length - 1) % menus.length); }
  }
  function toggle(i) { if (openIdx === i) closeAll(); else open(i); }
  function open(i) {
    closeAll();
    openIdx = i;
    heads[i].classList.add('open');
    const r = heads[i].getBoundingClientRect();
    showPopup(menus[i].items(), r.left, r.bottom, 0);
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('keydown', onKey, true);
  }
  function showPopup(items, x, y, depth) {
    // remove deeper popups
    while (popups.length > depth) popups.pop().remove();
    const pop = h('div.gf-menupop', { role: 'menu' });
    for (const it of items) {
      if (it.sep) { pop.appendChild(h('div.gf-menusep')); continue; }
      const row = h('div.gf-menuitem' + (it.disabled ? '.disabled' : ''), { role: 'menuitem' },
        h('span.chk', it.checked ? { html: icon('check', 13) } : null),
        h('span.ic', it.icon ? { html: icon(it.icon, 15) } : null),
        h('span.lb', it.label),
        h('span.sc', it.items ? '▸' : it.shortcut || ''));
      if (it.items) {
        row.addEventListener('mouseenter', () => { const rr = row.getBoundingClientRect(); showPopup(it.items, rr.right - 2, rr.top - 4, depth + 1); });
        row.addEventListener('click', (e) => e.stopPropagation());
      } else {
        row.addEventListener('mouseenter', () => { while (popups.length > depth + 1) popups.pop().remove(); });
        row.addEventListener('click', () => {
          if (it.disabled) return;
          closeAll();
          try { const r = it.run?.(); if (r && r.catch) r.catch((e) => app.toast(String(e?.message || e), 'error')); } catch (e) { app.toast(String(e?.message || e), 'error'); console.error(e); }
        });
      }
      pop.appendChild(row);
    }
    document.body.appendChild(pop);
    popups.push(pop);
    const pr = pop.getBoundingClientRect();
    let left = x, top = y;
    if (left + pr.width > window.innerWidth - 4) left = depth === 0 ? window.innerWidth - pr.width - 4 : x - pr.width - (depth ? 160 : 0);
    if (top + pr.height > window.innerHeight - 4) top = Math.max(4, window.innerHeight - pr.height - 4);
    pop.style.left = left + 'px'; pop.style.top = top + 'px';
  }
  return { close: closeAll, destroy: () => { closeAll(); bar.remove(); } };
}

export function createToolbar(app, host) {
  const { state, actions: A } = app;
  const bar = h('div.gf-toolbar');
  host.appendChild(bar);
  const items = [];
  const add = (name, title, run, opts = {}) => {
    const b = h('button.gf-tbtn', { type: 'button', title, onclick: run, html: icon(name, 20) });
    if (opts.id) b.dataset.id = opts.id;
    bar.appendChild(b);
    items.push({ b, opts });
    return b;
  };
  const sep = () => bar.appendChild(h('span.gf-tsep'));
  add('new', 'New model', A.newModel); add('open', 'Open model… (Ctrl+O)', A.open); add('save', 'Save model (Ctrl+S)', A.save); add('png', 'Export image', A.exportPNG);
  sep();
  add('undo', 'Undo (Ctrl+Z)', A.undo, { enabled: () => app.history.canUndo() }); add('redo', 'Redo (Ctrl+Y)', A.redo, { enabled: () => app.history.canRedo() });
  sep();
  add('select', 'Select tool (V)', () => { if (state.mode === 'geometry' || app.toolsFor(state.mode).some((t) => t.id === 'select')) app.setTool('select'); else app.setMode('geometry'); }, { active: () => state.tool === 'select' });
  add('hand', 'Pan (H) · or middle mouse / Space', () => app.setTool('pan'), { active: () => state.tool === 'pan' });
  add('zoomin', 'Zoom in (+)', () => app.canvas.zoomBy(1.25)); add('zoomout', 'Zoom out (-)', () => app.canvas.zoomBy(0.8)); add('extents', 'Zoom extents (F)', A.zoomExtents);
  sep();
  add('delete', 'Delete selected (Del)', A.deleteSelection, { enabled: () => !!state.selection });
  add('grid', 'Toggle grid (G)', () => app.toggleOpt('grid'), { active: () => app.opts.grid });
  add('snap', 'Toggle snapping', () => { const on = !(app.opts.snapGrid || app.opts.snapGeom); app.opts.snapGrid = on; app.opts.snapGeom = on; app.updateChrome(); }, { active: () => app.opts.snapGrid || app.opts.snapGeom });
  sep();
  add('generate', 'Generate mesh (F9)', A.generateMesh);
  add('solve', 'Run analysis (Ctrl+Enter)', A.runSolve, { enabled: () => !state.busy });
  add('stop', 'Cancel analysis', A.cancelSolve, { enabled: () => state.busy });
  add('plot', 'Plot results', () => app.setMode('plot'));
  bar.appendChild(h('span.gf-tspacer'));
  add('console', 'Toggle command line (Ctrl+`)', () => app.toggleOpt('showConsole'), { active: () => app.opts.showConsole });
  add('info', 'Toggle info panel', () => app.toggleOpt('showInfo'), { active: () => app.opts.showInfo });
  function update() {
    for (const { b, opts } of items) {
      if (opts.enabled) b.disabled = !opts.enabled();
      if (opts.active) b.classList.toggle('active', !!opts.active());
    }
  }
  update();
  return { update };
}
