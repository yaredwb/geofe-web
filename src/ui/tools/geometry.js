// Geometry-mode tools: select/move vertex, draw polygon, rectangle, internal line.
import { hitVertex, hitRegion, hitLine, hitEdge } from '../viewmath.js';
import { addRegion, addRectangleRegion, addLine, moveVertexEverywhere, conformAll, insertVertexAt, polygonProblem, dedupeRing, samePt } from '../edit.js';
import { drawRubber } from '../draw.js';

const PX_VERTEX = 9, PX_LINE = 6;

/** Selection descriptor for a vertex hit. */
function vertexSel(h) { return { kind: 'vertex', owner: h.owner, id: h.id, index: h.index }; }

export function makeSelectTool() {
  let drag = null;
  return {
    id: 'select', label: 'Select / move', icon: 'select', hint: 'Click to select; drag a vertex to move it (shared by neighbours); double-click an edge to add a vertex, a region to edit coordinates.',
    cancel() { drag = null; },
    deactivate(app) { drag = null; app.setHover(null); },
    snapFilter(app, geom) {
      if (!drag) return geom;
      const c = drag.cur;
      return {
        vertices: geom.vertices.filter((v) => !samePt(v, c)),
        segments: geom.segments.filter(([a, b]) => !samePt(a, c) && !samePt(b, c)),
      };
    },
    onDown(app, e) {
      const { model } = app.state, s = app.state.view.scale;
      const v = hitVertex(model, e.raw, PX_VERTEX / s);
      if (v) {
        app.select(vertexSel(v));
        drag = { cur: [...v.point], start: [...v.point], moved: false, sx: e.sx, sy: e.sy };
        app.history.hold(true);
        return;
      }
      const l = hitLine(model, e.raw, PX_LINE / s);
      if (l) { app.select({ kind: 'line', id: l.id }); return; }
      const r = hitRegion(model, e.raw);
      app.select(r ? { kind: 'region', id: r.id } : null);
    },
    onMove(app, e) {
      if (drag) {
        if (!drag.moved && Math.hypot(e.sx - drag.sx, e.sy - drag.sy) < 3) return;
        drag.moved = true;
        if (!samePt(e.p, drag.cur)) {
          moveVertexEverywhere(app.state.model, drag.cur, e.p);
          drag.cur = [...e.p];
          app.commit({ quiet: true });
        }
        return;
      }
      const { model } = app.state, s = app.state.view.scale;
      const v = hitVertex(model, e.raw, PX_VERTEX / s);
      app.setHover(v || hitLine(model, e.raw, PX_LINE / s) ? null : hitRegion(model, e.raw)?.id || null);
    },
    onUp(app) {
      if (!drag) return;
      const d = drag; drag = null;
      app.history.hold(false);
      if (!d.moved) return;
      const model = app.state.model;
      // clean rings (a vertex dropped on a neighbour merges) and ensure they are still valid polygons
      let bad = null;
      for (const r of model.regions) {
        const clean = dedupeRing(r.points);
        if (clean.length !== r.points.length) r.points = clean;
        const prob = polygonProblem(r.points);
        if (prob) { bad = `${r.name || r.id}: ${prob}`; break; }
      }
      if (bad) {
        // revert the move
        moveVertexEverywhere(model, d.cur, d.start);
        app.toast(`Move rejected - ${bad}`, 'warn');
      } else {
        conformAll(model);
        const sel = app.state.selection;
        if (sel?.kind === 'vertex') {
          const owner = (sel.owner === 'line' ? model.lines : model.regions).find((x) => x.id === sel.id);
          const idx = owner ? owner.points.findIndex((p) => samePt(p, d.cur)) : -1;
          app.select(idx >= 0 ? { ...sel, index: idx } : null);
        }
      }
      app.commit();
    },
    onDouble(app, e) {
      const { model } = app.state, s = app.state.view.scale;
      if (hitVertex(model, e.raw, PX_VERTEX / s)) return;
      const edge = hitEdge(model, e.raw, PX_LINE / s);
      if (edge) {
        const n = insertVertexAt(model, edge.point);
        if (n) { app.commit(); app.toast('Vertex inserted', 'info'); app.select({ kind: 'vertex', owner: edge.owner, id: edge.id, index: edge.edgeIndex + 1 }); }
        return;
      }
      const r = hitRegion(model, e.raw);
      if (r) app.editRegion(r.id);
    },
    onKey(app, ev) {
      if (ev.key === 'Escape' && drag) { moveVertexEverywhere(app.state.model, drag.cur, drag.start); drag = null; app.history.hold(false); app.commit(); return true; }
      return false;
    },
  };
}

/** Polyline-collecting helper used by the polygon and line tools. */
function makePolyTool({ id, label, icon, hint, closed, minPts, finish }) {
  let pts = [];
  let cur = null;
  const tool = {
    id, label, icon, hint,
    snapExtra: () => (pts.length ? [{ points: pts, closed: false }] : null),
    activate(app) { pts = []; cur = null; app.hint(hint); },
    deactivate() { pts = []; cur = null; },
    cancel(app) { pts = []; cur = null; app.hint(hint); },
    onDown(app, e) {
      if (closed && pts.length >= 3 && samePt(e.p, pts[0])) { done(app); return; }
      if (pts.length && samePt(e.p, pts[pts.length - 1])) return;
      pts.push([...e.p]);
      app.hint(closed ? `${pts.length} point(s). Click the first point or press Enter to close; Backspace removes the last; Esc cancels.` : `${pts.length} point(s). Enter / double-click / right-click to finish; Esc cancels.`);
    },
    onMove(app, e) { cur = e.p; },
    onDouble(app) { if (pts.length >= minPts) done(app); },
    onContext(app) { if (pts.length >= minPts) done(app); else tool.cancel(app); app.canvas?.redrawOverlay(); },
    onKey(app, ev) {
      if (ev.key === 'Enter') { if (pts.length >= minPts) done(app); else app.toast(`Need at least ${minPts} points`, 'warn'); return true; }
      if (ev.key === 'Escape') { if (pts.length) { tool.cancel(app); return true; } return false; }
      if (ev.key === 'Backspace') { if (pts.length) { pts.pop(); return true; } return false; }
      return false;
    },
    drawOverlay(app, g, view) { if (pts.length) drawRubber(g, view, pts, cur, { closed: false, fill: closed && pts.length >= 2 }); },
  };
  function done(app) {
    const ring = closed ? dedupeRing(pts) : pts;
    if (closed) {
      const prob = polygonProblem(ring);
      if (prob) { app.toast(prob, 'warn'); return; }
    }
    finish(app, ring);
    pts = []; cur = null; app.hint(hint);
  }
  return tool;
}

export const polygonTool = () => makePolyTool({
  id: 'polygon', label: 'Draw polygon region', icon: 'polygon', closed: true, minPts: 3,
  hint: 'Click vertices of the region outline. Close by clicking the first point or pressing Enter. Snaps to vertices, edges and grid (hold Shift to disable).',
  finish(app, ring) {
    const r = addRegion(app.state.model, ring, { materialId: app.activeMaterialId() });
    app.select({ kind: 'region', id: r.id });
    app.commit();
    app.toast(`Created ${r.name}`, 'info');
  },
});

export const lineTool = () => makePolyTool({
  id: 'line', label: 'Add internal line', icon: 'line', closed: false, minPts: 2,
  hint: 'Click the points of an internal line the mesh must conform to. Enter or double-click to finish.',
  finish(app, pts) {
    const l = addLine(app.state.model, pts);
    app.select({ kind: 'line', id: l.id });
    app.commit();
  },
});

export function rectTool() {
  let start = null, cur = null, down = null;
  const hint = 'Click two opposite corners (or drag) to create a rectangular region.';
  function finish(app, p) {
    if (Math.abs(p[0] - start[0]) < 1e-9 || Math.abs(p[1] - start[1]) < 1e-9) { app.toast('Rectangle has zero width or height', 'warn'); return; }
    const r = addRectangleRegion(app.state.model, start, p, { materialId: app.activeMaterialId() });
    app.select({ kind: 'region', id: r.id });
    app.commit();
    start = null; cur = null;
    app.hint(hint);
  }
  return {
    id: 'rect', label: 'Draw rectangle region', icon: 'rect', hint,
    snapExtra: () => (start ? [{ points: [start], closed: false }] : null),
    activate(app) { start = null; app.hint(hint); },
    deactivate() { start = null; },
    cancel(app) { start = null; cur = null; app.hint(hint); },
    onDown(app, e) {
      if (!start) { start = [...e.p]; down = [e.sx, e.sy]; app.hint('Click the opposite corner (Esc cancels).'); } else finish(app, e.p);
    },
    onMove(app, e) { cur = e.p; },
    onUp(app, e) { if (start && down && Math.hypot(e.sx - down[0], e.sy - down[1]) > 6) finish(app, e.p); down = null; },
    onContext(app) { this.cancel(app); },
    onKey(app, ev) { if (ev.key === 'Escape' && start) { this.cancel(app); return true; } return false; },
    drawOverlay(app, g, view) {
      if (!start || !cur) return;
      drawRubber(g, view, [start, [cur[0], start[1]], cur, [start[0], cur[1]]], null, { closed: true, fill: true });
    },
  };
}

export const geometryTools = () => [makeSelectTool(), polygonTool(), rectTool(), lineTool()];
