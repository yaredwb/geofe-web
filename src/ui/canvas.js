// The central model canvas: DPR-aware, two layers (cached base + cheap overlay), pointer/wheel handling, snapping.
import { h } from './dom.js';
import { makeView, zoomAbout, panBy, zoomExtents, snapPoint, collectSnapGeometry, gridSteps, modelBBox } from './viewmath.js';
import * as D from './draw.js';

/**
 * createModelCanvas(app, host) → { el, invalidate(), redrawOverlay(), resize(), zoomExtents(), zoomBy(f), toDataURL(), getView() }
 * `app` supplies: state, services, opts, cursor, currentTool(), setStatus(), toast().
 */
export function createModelCanvas(app, host) {
  const { state } = app;
  const canvas = h('canvas.gf-canvas', { tabIndex: 0 });
  const base = document.createElement('canvas');
  host.appendChild(canvas);
  let W = 0, H = 0, dpr = 1;
  let baseDirty = true, rafId = 0, overlayOnly = true;
  let snapGeom = null, snapDirty = true;
  let panning = null;
  let spaceDown = false;
  let lastModelRef = null;
  let didInitialFit = false;

  const getView = () => makeView(state.view);
  const rect = () => D.plotRect(W, H);

  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(50, Math.floor(r.width)), hh = Math.max(50, Math.floor(r.height));
    dpr = window.devicePixelRatio || 1;
    if (w === W && hh === H && canvas.width === Math.round(w * dpr)) return;
    W = w; H = hh;
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    base.width = canvas.width; base.height = canvas.height;
    if (!didInitialFit && modelBBox(state.model)) { fitExtents(false); didInitialFit = true; }
    invalidate();
  }

  function fitExtents(notify = true) {
    const bb = modelBBox(state.model) || (state.mesh && meshBox(state.mesh));
    // In plot mode with results, keep the colour legend (drawn at the right edge) clear of the model.
    const r = rect();
    const legendGutter = state.mode === 'plot' && state.results ? 170 : 0;
    const v = zoomExtents(bb, legendGutter ? { ...r, w: Math.max(100, r.w - legendGutter) } : r, 0.08);
    if (notify) state.set({ view: v }); else state.view = v;
  }
  function meshBox(mesh) {
    let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
    for (let i = 0; i < mesh.nodes.length; i += 2) { xmin = Math.min(xmin, mesh.nodes[i]); xmax = Math.max(xmax, mesh.nodes[i]); ymin = Math.min(ymin, mesh.nodes[i + 1]); ymax = Math.max(ymax, mesh.nodes[i + 1]); }
    return { xmin, ymin, xmax, ymax };
  }

  function zoomBy(f) {
    const r = rect();
    state.set({ view: zoomAbout(state.view, r.x + r.w / 2, r.y + r.h / 2, f) });
  }

  function invalidate(overlayOnlyFlag = false) {
    if (!overlayOnlyFlag) baseDirty = true;
    if (!rafId) rafId = requestAnimationFrame(frame);
  }

  function frame() {
    rafId = 0;
    if (!W) return;
    if (baseDirty) { renderBase(); baseDirty = false; }
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.drawImage(base, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderOverlay(g);
  }

  function renderBase() {
    const g = base.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = D.COLORS.bg; g.fillRect(0, 0, W, H);
    const view = getView(), r = rect(), { model, mode, mesh, results } = state, o = app.opts;
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    if (o.grid) D.drawGrid(g, view, r);
    let plotted = false, msg = null;
    if (mode === 'plot') {
      if (results && mesh) {
        const res = D.drawResults(g, view, r, app);
        plotted = res === true;
        if (typeof res === 'string') msg = res;
      } else msg = mesh ? 'No results yet. Switch to Solve mode and run the analysis.' : 'No results yet. Generate a mesh and run the analysis (Solve).';
    }
    if (!plotted) {
      const showMesh = !!mesh && o.showMesh;
      if (showMesh) D.drawMeshLayer(g, view, model, mesh, app.services.render);
      D.drawGeometry(g, view, r, model, { labels: o.labels, fillAlpha: showMesh ? 0 : 0.9, selection: mode === 'plot' ? null : state.selection, hoverRegion: app.hoverRegion });
    }
    const sel = mode === 'plot' ? null : state.selection;
    if (!plotted || !state.plot.deformed) {
      if (o.showWater) D.drawWater(g, view, model, { selected: sel?.kind === 'water' });
      if (o.showBC) D.drawBoundaryConditions(g, view, model, { selectedId: sel?.kind === 'boundary' ? sel.id : null });
      if (o.showLoads && !plotted) D.drawLoads(g, view, model, { selectedId: sel?.kind === 'load' ? sel.id : null });
    }
    if (!model.regions.length && !plotted) {
      g.fillStyle = '#7b8494'; g.font = '14px system-ui, sans-serif'; g.textAlign = 'center';
      g.fillText('Empty model. Use the Geometry tools (polygon / rectangle) or File → Load example.', r.x + r.w / 2, r.y + r.h / 2);
    }
    if (msg) {
      g.font = '13px system-ui, sans-serif'; g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.85)';
      const w = g.measureText(msg).width + 24;
      g.fillRect(r.x + r.w / 2 - w / 2, r.y + 14, w, 28);
      g.fillStyle = '#6a4a00'; g.fillText(msg, r.x + r.w / 2, r.y + 33);
    }
    g.restore();
    D.drawRulers(g, view, r, W, H, model.units?.length || 'm');
  }

  function renderOverlay(g) {
    const view = getView(), r = rect();
    const tool = app.currentTool();
    g.save();
    g.beginPath(); g.rect(r.x, r.y, r.w, r.h); g.clip();
    if (tool?.drawOverlay) tool.drawOverlay(app, g, view, r);
    const c = app.cursor;
    if (c.model && tool?.snap !== false && !panning && c.inside) D.drawSnapMarker(g, view, c.model, c.snapKind);
    g.restore();
    if (c.screen && c.inside) D.drawRulerCursor(g, r, c.screen[0], c.screen[1]);
  }

  // ---------------------------------------------------------------- pointer handling

  function localXY(ev) {
    const b = canvas.getBoundingClientRect();
    return [ev.clientX - b.left, ev.clientY - b.top];
  }

  function snapGeometry(tool) {
    if (snapDirty || !snapGeom) { snapGeom = collectSnapGeometry(state.model); snapDirty = false; }
    const extra = tool?.snapExtra ? tool.snapExtra(app) : null;
    let geom = snapGeom;
    if (tool?.snapFilter) geom = tool.snapFilter(app, geom);
    if (extra && extra.length) {
      const e = collectSnapGeometry({ regions: [], lines: [] }, extra);
      geom = { vertices: geom.vertices.concat(e.vertices), segments: geom.segments.concat(e.segments) };
    }
    return geom;
  }

  /** Build the event object passed to tools. */
  function makeEvent(ev, sx, sy) {
    const view = getView();
    const raw = view.toModel([sx, sy]);
    const tool = app.currentTool();
    let p = raw, kind = 'none';
    if (tool?.snap !== false && !ev.shiftKey) {
      const { major, minor } = gridSteps(view.scale);
      const step = minor * view.scale >= 8 ? minor : major;
      const res = snapPoint(raw, { scale: view.scale, gridStep: step, snapGrid: app.opts.snapGrid, snapGeom: app.opts.snapGeom, geom: snapGeometry(tool) });
      p = res.p; kind = res.kind;
    }
    return { raw, p, snap: kind, sx, sy, shift: ev.shiftKey, ctrl: ev.ctrlKey || ev.metaKey, alt: ev.altKey, button: ev.button, ev, view };
  }

  function updateCursor(e) {
    const r = rect();
    app.cursor = { model: e.p, raw: e.raw, screen: [e.sx, e.sy], snapKind: e.snap, inside: e.sx >= r.x && e.sx <= r.x + r.w && e.sy >= r.y && e.sy <= r.y + r.h };
    app.updateStatusCursor();
  }

  canvas.addEventListener('pointerdown', (ev) => {
    canvas.focus({ preventScroll: true });
    const [sx, sy] = localXY(ev);
    const r = rect();
    const tool = app.currentTool();
    const wantPan = ev.button === 1 || (ev.button === 0 && (tool?.id === 'pan' || spaceDown));
    if (wantPan) {
      panning = { x: ev.clientX, y: ev.clientY, view: { ...state.view } };
      canvas.setPointerCapture(ev.pointerId);
      canvas.classList.add('panning');
      ev.preventDefault();
      return;
    }
    if (ev.button === 2) { ev.preventDefault(); tool?.onContext?.(app, makeEvent(ev, sx, sy)); return; }
    if (ev.button !== 0) return;
    if (sx < r.x || sx > r.x + r.w || sy < r.y || sy > r.y + r.h) return;
    canvas.setPointerCapture(ev.pointerId);
    const e = makeEvent(ev, sx, sy);
    updateCursor(e);
    app.dragging = true;
    tool?.onDown?.(app, e);
    invalidate(true);
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (panning) {
      const v = panBy(panning.view, ev.clientX - panning.x, ev.clientY - panning.y);
      state.set({ view: v });
      return;
    }
    const [sx, sy] = localXY(ev);
    const e = makeEvent(ev, sx, sy);
    updateCursor(e);
    const tool = app.currentTool();
    tool?.onMove?.(app, e);
    invalidate(true);
  });

  const endPointer = (ev) => {
    if (panning) { panning = null; canvas.classList.remove('panning'); return; }
    if (!app.dragging) return;
    app.dragging = false;
    const [sx, sy] = localXY(ev);
    app.currentTool()?.onUp?.(app, makeEvent(ev, sx, sy));
    invalidate(true);
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  canvas.addEventListener('pointerleave', () => { if (!app.dragging) { app.cursor = { ...app.cursor, inside: false }; app.updateStatusCursor(); invalidate(true); } });
  canvas.addEventListener('dblclick', (ev) => {
    const [sx, sy] = localXY(ev);
    const r = rect();
    if (sx < r.x || sx > r.x + r.w || sy < r.y || sy > r.y + r.h) return;
    app.currentTool()?.onDouble?.(app, makeEvent(ev, sx, sy));
    invalidate(true);
  });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
  canvas.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const [sx, sy] = localXY(ev);
    const f = Math.pow(1.0018, -Math.max(-300, Math.min(300, ev.deltaY * (ev.deltaMode === 1 ? 16 : 1))));
    state.set({ view: zoomAbout(state.view, sx, sy, f) });
  }, { passive: false });

  // Space = temporary hand tool
  const onKeyDown = (ev) => {
    if (ev.code === 'Space' && !ev.repeat && !isFormTarget(ev.target)) { spaceDown = true; canvas.classList.add('panmode'); if (document.activeElement === canvas || document.activeElement === document.body) ev.preventDefault(); }
  };
  const onKeyUp = (ev) => { if (ev.code === 'Space') { spaceDown = false; canvas.classList.remove('panmode'); } };
  const isFormTarget = (t) => t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.tagName === 'BUTTON' || t.isContentEditable);
  document.addEventListener('keydown', onKeyDown);
  document.addEventListener('keyup', onKeyUp);

  const ro = new ResizeObserver(() => resize());
  ro.observe(host);
  const onWinResize = () => resize();
  window.addEventListener('resize', onWinResize);

  // State changes: model replaced -> refit; anything else -> redraw base
  const unsub = state.subscribe(() => {
    snapDirty = true;
    if (state.model !== lastModelRef) {
      const first = lastModelRef === null;
      lastModelRef = state.model;
      if (!first && W) { fitExtents(false); }
    }
    invalidate();
  });
  lastModelRef = state.model;

  resize();

  return {
    el: canvas,
    invalidate,
    redrawOverlay: () => invalidate(true),
    resize,
    zoomExtents: () => fitExtents(true),
    zoomBy,
    getView,
    plotRect: rect,
    markSnapDirty() { snapDirty = true; },
    baseCanvas() { if (baseDirty) { renderBase(); baseDirty = false; } return base; },
    toDataURL(type = 'image/png') {
      // Compose base + overlay-less image
      const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
      if (baseDirty) renderBase();
      c.getContext('2d').drawImage(base, 0, 0);
      return c.toDataURL(type);
    },
    destroy() { ro.disconnect(); unsub(); window.removeEventListener('resize', onWinResize); document.removeEventListener('keydown', onKeyDown); document.removeEventListener('keyup', onKeyUp); canvas.remove(); },
  };
}
