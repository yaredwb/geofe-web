// Tools for the Mesh, Material, Boundary, Loads, Water and Plot modes.
import { hitRegion, interpolateAt } from '../viewmath.js';
import { hitBoundary, hitLoad } from '../glyphs.js';
import { addFixSegment, addFixPoint, addPointLoad, addDistLoad, samePt } from '../edit.js';
import { drawRubber, drawTag, plotData } from '../draw.js';
import { fixityDialog, pointLoadDialog, distLoadDialog } from '../modeldialogs.js';
import { fmtNum, fmtCoord } from '../format.js';

// ---------------------------------------------------------------- selection tools

/** Region-picking select tool (mesh / material / settings / solve modes). */
export function regionSelectTool() {
  return {
    id: 'select', label: 'Select', icon: 'select', hint: 'Click a region to select it.', snap: false,
    deactivate(app) { app.setHover(null); },
    onDown(app, e) { const r = hitRegion(app.state.model, e.raw); app.select(r ? { kind: 'region', id: r.id } : null); },
    onMove(app, e) { app.setHover(hitRegion(app.state.model, e.raw)?.id || null); },
  };
}

export function boundarySelectTool() {
  return {
    id: 'select', label: 'Select', icon: 'select', hint: 'Click a support symbol to select it, Delete removes it.', snap: false,
    onDown(app, e) {
      const id = hitBoundary(app.state.model, e.raw, 10 / app.state.view.scale);
      app.select(id ? { kind: 'boundary', id } : null);
    },
  };
}

export function loadSelectTool() {
  return {
    id: 'select', label: 'Select', icon: 'select', hint: 'Click a load to select it (double-click to edit), Delete removes it.', snap: false,
    onDown(app, e) { const id = hitLoad(app.state.model, e.view, e.sx, e.sy, 7); app.select(id ? { kind: 'load', id } : null); },
    onDouble(app, e) { const id = hitLoad(app.state.model, e.view, e.sx, e.sy, 7); if (id) app.editLoad(id); },
  };
}

export function waterSelectTool() {
  let drag = null;
  return {
    id: 'select', label: 'Select / move', icon: 'select', hint: 'Drag a phreatic-line vertex to move it.',
    cancel() { drag = null; },
    onDown(app, e) {
      const ph = app.state.model.water.phreatic, tol = 9 / app.state.view.scale;
      const i = ph.findIndex((p) => Math.hypot(p[0] - e.raw[0], p[1] - e.raw[1]) <= tol);
      if (i >= 0) { drag = { i, moved: false }; app.history.hold(true); app.select({ kind: 'water', index: i }); } else app.select(null);
    },
    onMove(app, e) {
      if (!drag) return;
      drag.moved = true;
      app.state.model.water.phreatic[drag.i] = [...e.p];
      app.commit({ quiet: true });
    },
    onUp(app) {
      app.history.hold(false);
      if (drag?.moved) { app.state.model.water.phreatic.sort((a, b) => a[0] - b[0]); app.commit(); }
      drag = null;
    },
  };
}

// ---------------------------------------------------------------- material

export function assignTool() {
  return {
    id: 'assign', label: 'Assign material', icon: 'assign', snap: false,
    hint: 'Click a region to assign the active material (selected in the list).',
    deactivate(app) { app.setHover(null); },
    onMove(app, e) { app.setHover(hitRegion(app.state.model, e.raw)?.id || null); },
    onDown(app, e) {
      const m = app.state.model;
      const r = hitRegion(m, e.raw);
      if (!r) return;
      const id = app.activeMaterialId();
      if (!id) { app.toast('Create a material first (Add).', 'warn'); return; }
      if (r.materialId === id) return;
      r.materialId = id;
      app.select({ kind: 'region', id: r.id });
      app.commit();
    },
  };
}

// ---------------------------------------------------------------- boundary

/** Two-click tool (segment fixity / distributed load). */
function twoClickTool({ id, label, icon, hint, second, done }) {
  let first = null, cur = null;
  return {
    id, label, icon, hint,
    snapExtra: () => (first ? [{ points: [first], closed: false }] : null),
    activate(app) { first = null; app.hint(hint); },
    deactivate() { first = null; },
    cancel(app) { first = null; cur = null; app.hint(hint); },
    onDown(app, e) {
      if (!first) { first = [...e.p]; app.hint(second); return; }
      if (samePt(first, e.p)) return;
      const p1 = first, p2 = [...e.p];
      first = null; cur = null; app.hint(hint);
      done(app, p1, p2);
    },
    onMove(app, e) { cur = e.p; },
    onContext(app) { this.cancel(app); },
    onKey(app, ev) { if (ev.key === 'Escape' && first) { this.cancel(app); return true; } return false; },
    drawOverlay(app, g, view) { if (first) drawRubber(g, view, [first], cur, { color: '#c62828' }); },
  };
}

export const fixSegmentTool = () => twoClickTool({
  id: 'fixseg', label: 'Fix segment', icon: 'boundary',
  hint: 'Click the first end point of the boundary segment to fix.', second: 'Click the second end point.',
  async done(app, p1, p2) {
    const r = await fixityDialog(`Segment (${fmtCoord(p1[0])}, ${fmtCoord(p1[1])}) → (${fmtCoord(p2[0])}, ${fmtCoord(p2[1])}). Mesh nodes lying on this segment are fixed.`);
    if (!r) return;
    const b = addFixSegment(app.state.model, p1, p2, r.fixX, r.fixY);
    app.select({ kind: 'boundary', id: b.id });
    app.commit();
  },
});

export function fixPointTool() {
  return {
    id: 'fixpoint', label: 'Fix point', icon: 'pin', hint: 'Click a point to fix (snaps to vertices / edges).',
    async onDown(app, e) {
      const r = await fixityDialog(`Point (${fmtCoord(e.p[0])}, ${fmtCoord(e.p[1])}). The nearest mesh node is fixed.`);
      if (!r) return;
      const b = addFixPoint(app.state.model, e.p, r.fixX, r.fixY);
      app.select({ kind: 'boundary', id: b.id });
      app.commit();
    },
  };
}

// ---------------------------------------------------------------- loads

export function pointLoadTool() {
  return {
    id: 'pointload', label: 'Point load', icon: 'pointload', hint: 'Click where the point load acts.',
    async onDown(app, e) {
      const r = await pointLoadDialog(e.p);
      if (!r) return;
      const l = addPointLoad(app.state.model, e.p, r.fx, r.fy);
      app.select({ kind: 'load', id: l.id });
      app.commit();
    },
  };
}

export const distLoadTool = () => twoClickTool({
  id: 'distload', label: 'Distributed load', icon: 'distload',
  hint: 'Click the start of the loaded segment.', second: 'Click the end of the loaded segment.',
  async done(app, p1, p2) {
    const r = await distLoadDialog(p1, p2);
    if (!r) return;
    const l = addDistLoad(app.state.model, p1, p2, r.qx1, r.qy1, r.qx2, r.qy2);
    app.select({ kind: 'load', id: l.id });
    app.commit();
  },
});

// ---------------------------------------------------------------- water

export function phreaticTool() {
  let pts = [], cur = null;
  const hint = 'Click points of the phreatic line from left to right; Enter / double-click finishes, Esc cancels.';
  function done(app) {
    if (pts.length < 2) { app.toast('A phreatic line needs at least 2 points', 'warn'); return; }
    const sorted = [...pts].sort((a, b) => a[0] - b[0]);
    const w = app.state.model.water;
    w.phreatic = sorted; w.enabled = true;
    pts = []; cur = null;
    app.commit();
    app.hint(hint);
  }
  const tool = {
    id: 'phreatic', label: 'Draw phreatic line', icon: 'phreatic', hint,
    snapExtra: () => (pts.length ? [{ points: pts, closed: false }] : null),
    activate(app) { pts = []; app.hint(hint); },
    deactivate() { pts = []; },
    cancel(app) { pts = []; cur = null; app.hint(hint); },
    onDown(app, e) { if (!pts.length || !samePt(e.p, pts[pts.length - 1])) pts.push([...e.p]); },
    onMove(app, e) { cur = e.p; },
    onDouble(app) { done(app); },
    onContext(app) { if (pts.length >= 2) done(app); else tool.cancel(app); },
    onKey(app, ev) {
      if (ev.key === 'Enter') { done(app); return true; }
      if (ev.key === 'Escape' && pts.length) { tool.cancel(app); return true; }
      if (ev.key === 'Backspace' && pts.length) { pts.pop(); return true; }
      return false;
    },
    drawOverlay(app, g, view) { if (pts.length) drawRubber(g, view, pts, cur, { color: '#1565c0' }); },
  };
  return tool;
}

// ---------------------------------------------------------------- plot

/** Hover probe: shows the interpolated value of the current field under the cursor. */
export function probeTool() {
  let info = null;
  return {
    id: 'probe', label: 'Value probe', icon: 'probe', snap: false,
    hint: 'Move the cursor over the model to read the interpolated value of the plotted field.',
    deactivate() { info = null; },
    onMove(app, e) {
      info = null;
      const d = plotData(app);
      if (!d || d.error || !app.state.mesh) return;
      const mesh = app.state.mesh;
      let v;
      if (d.coords || !app.services.postFields?.interpolateAt) v = interpolateAt(mesh, d.values, e.raw, d.coords || mesh.nodes, d.activeElements);
      else v = app.services.postFields.interpolateAt(mesh, d.values, e.raw[0], e.raw[1], d.activeElements);
      if (v !== null && Number.isFinite(v)) info = { x: e.sx, y: e.sy, p: e.raw, v, d };
    },
    drawOverlay(app, g, view, rect) {
      if (!info) return;
      g.save(); g.strokeStyle = '#000'; g.lineWidth = 1.5; g.beginPath(); g.arc(info.x, info.y, 4, 0, Math.PI * 2); g.stroke(); g.restore();
      const unit = info.d.info.unit && info.d.info.unit !== '-' ? ' ' + info.d.info.unit : '';
      drawTag(g, info.x, info.y, [`${info.d.info.label}`, `${fmtNum(info.v, 5)}${unit}`, `x = ${fmtCoord(info.p[0], 3)}, y = ${fmtCoord(info.p[1], 3)}`], { rect });
    },
  };
}

/** Section tool for line plots: two clicks (or press-drag-release) then a chart dialog opens. */
export function sectionTool() {
  let first = null, cur = null, down = null;
  const hint = 'Click the start and end of a section line to plot the field along it.';
  return {
    id: 'section', label: 'Line plot section', icon: 'section', hint, snap: false,
    activate(app) { first = null; app.hint(hint); },
    deactivate() { first = null; },
    cancel(app) { first = null; app.hint(hint); },
    onDown(app, e) {
      if (!first) { first = [...e.raw]; down = [e.sx, e.sy]; app.hint('Click the end of the section (Esc cancels).'); return; }
      finish(app, e.raw);
    },
    onMove(app, e) { cur = e.raw; },
    onUp(app, e) { if (first && down && Math.hypot(e.sx - down[0], e.sy - down[1]) > 6) finish(app, e.raw); down = null; },
    onContext(app) { this.cancel(app); },
    onKey(app, ev) { if (ev.key === 'Escape' && first) { this.cancel(app); return true; } return false; },
    drawOverlay(app, g, view) {
      if (first) drawRubber(g, view, [first], cur, { color: '#8e24aa' });
      else if (app.section) drawRubber(g, view, [app.section.p1], app.section.p2, { color: '#8e24aa' });
    },
  };
  function finish(app, p) {
    const p1 = first; first = null; app.hint(hint);
    if (Math.hypot(p[0] - p1[0], p[1] - p1[1]) < 1e-9) return;
    app.section = { p1, p2: [...p] };
    app.openLinePlot(p1, [...p]);
  }
}
