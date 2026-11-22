// Canvas drawing routines for the editor (grid, rulers, geometry, BC/load/water glyphs, selection, plot results).
// All functions take a 2D context already scaled to CSS pixels and a `view` from viewmath.makeView().
import { gridSteps, ticks, polygonCentroid, valueRange, deformedNodes, autoDeformScale, activeNodeMask } from './viewmath.js';
import { bcGlyphs, loadGlyphs, waterGlyph } from './glyphs.js';
import { fmtCoord, decimalsForStep, fmtNum, fieldMeta } from './format.js';
import { effectiveStages } from '../core/model.js';

export const MARGIN = { l: 52, t: 8, r: 10, b: 30 };
export const COLORS = {
  bg: '#ffffff', gridMinor: '#f0f2f5', gridMajor: '#dde1e8', axis: '#9aa3b2', ruler: '#f1f2f5', rulerLine: '#b9bfca', rulerText: '#4a5262',
  edge: '#2b303a', vertexFill: '#ffffff', sel: '#ff7f0e', selFill: 'rgba(255,127,14,0.18)', bc: '#1f4f9e', load: '#c62828', water: '#1565c0',
  hover: 'rgba(31,111,208,0.18)',
};

/** Plot (clip) rectangle inside the canvas, leaving room for the rulers. */
export function plotRect(w, h) {
  return { x: MARGIN.l, y: MARGIN.t, w: Math.max(10, w - MARGIN.l - MARGIN.r), h: Math.max(10, h - MARGIN.t - MARGIN.b) };
}

export function drawGrid(g, view, rect) {
  const { major, minor } = gridSteps(view.scale);
  const [xmin, ymax] = view.toModel([rect.x, rect.y]);
  const [xmax, ymin] = view.toModel([rect.x + rect.w, rect.y + rect.h]);
  g.save();
  g.lineWidth = 1;
  const line = (xs, color) => {
    g.strokeStyle = color; g.beginPath();
    for (const x of xs[0]) { const sx = Math.round(view.toScreen([x, 0])[0]) + 0.5; g.moveTo(sx, rect.y); g.lineTo(sx, rect.y + rect.h); }
    for (const y of xs[1]) { const sy = Math.round(view.toScreen([0, y])[1]) + 0.5; g.moveTo(rect.x, sy); g.lineTo(rect.x + rect.w, sy); }
    g.stroke();
  };
  if (minor * view.scale >= 7) line([ticks(xmin, xmax, minor), ticks(ymin, ymax, minor)], COLORS.gridMinor);
  line([ticks(xmin, xmax, major), ticks(ymin, ymax, major)], COLORS.gridMajor);
  // axes through the origin
  g.strokeStyle = COLORS.axis;
  g.beginPath();
  const o = view.toScreen([0, 0]);
  if (o[0] >= rect.x && o[0] <= rect.x + rect.w) { g.moveTo(Math.round(o[0]) + 0.5, rect.y); g.lineTo(Math.round(o[0]) + 0.5, rect.y + rect.h); }
  if (o[1] >= rect.y && o[1] <= rect.y + rect.h) { g.moveTo(rect.x, Math.round(o[1]) + 0.5); g.lineTo(rect.x + rect.w, Math.round(o[1]) + 0.5); }
  g.stroke();
  g.restore();
}

export function drawRulers(g, view, rect, w, h, units = 'm') {
  const { major, minor } = gridSteps(view.scale);
  const dec = decimalsForStep(major);
  const [xmin, ymax] = view.toModel([rect.x, rect.y]);
  const [xmax, ymin] = view.toModel([rect.x + rect.w, rect.y + rect.h]);
  g.save();
  g.fillStyle = COLORS.ruler;
  g.fillRect(0, 0, MARGIN.l, h); g.fillRect(0, rect.y + rect.h, w, h - rect.y - rect.h);
  g.fillRect(0, 0, w, rect.y); g.fillRect(rect.x + rect.w, 0, w - rect.x - rect.w, h);
  g.strokeStyle = COLORS.rulerLine; g.lineWidth = 1;
  g.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.w - 1, rect.h - 1);
  g.fillStyle = COLORS.rulerText; g.font = '11px system-ui, sans-serif';
  g.beginPath();
  // x ruler (bottom)
  g.textAlign = 'center'; g.textBaseline = 'top';
  if (minor * view.scale >= 6) for (const x of ticks(xmin, xmax, minor)) { const sx = Math.round(view.toScreen([x, 0])[0]) + 0.5; g.moveTo(sx, rect.y + rect.h); g.lineTo(sx, rect.y + rect.h + 3); }
  for (const x of ticks(xmin, xmax, major)) {
    const sx = Math.round(view.toScreen([x, 0])[0]) + 0.5;
    g.moveTo(sx, rect.y + rect.h); g.lineTo(sx, rect.y + rect.h + 6);
    g.fillText(fmtCoord(x, dec), sx, rect.y + rect.h + 8);
  }
  // y ruler (left)
  g.textAlign = 'right'; g.textBaseline = 'middle';
  if (minor * view.scale >= 6) for (const y of ticks(ymin, ymax, minor)) { const sy = Math.round(view.toScreen([0, y])[1]) + 0.5; g.moveTo(rect.x, sy); g.lineTo(rect.x - 3, sy); }
  for (const y of ticks(ymin, ymax, major)) {
    const sy = Math.round(view.toScreen([0, y])[1]) + 0.5;
    g.moveTo(rect.x, sy); g.lineTo(rect.x - 6, sy);
    g.fillText(fmtCoord(y, dec), rect.x - 8, sy);
  }
  g.stroke();
  g.fillStyle = '#6b7385'; g.font = 'italic 10px system-ui, sans-serif';
  g.textAlign = 'right'; g.textBaseline = 'bottom';
  g.fillText(`x [${units}]`, rect.x + rect.w - 4, h - 1);
  g.save(); g.translate(11, rect.y + 4); g.rotate(-Math.PI / 2); g.textAlign = 'right'; g.textBaseline = 'top'; g.fillText(`y [${units}]`, 0, -2); g.restore();
  g.restore();
}

/** Cursor position markers on the rulers. */
export function drawRulerCursor(g, rect, sx, sy) {
  g.save();
  g.strokeStyle = '#e53935'; g.lineWidth = 1; g.beginPath();
  if (sx >= rect.x && sx <= rect.x + rect.w) { g.moveTo(Math.round(sx) + 0.5, rect.y + rect.h); g.lineTo(Math.round(sx) + 0.5, rect.y + rect.h + 7); }
  if (sy >= rect.y && sy <= rect.y + rect.h) { g.moveTo(rect.x, Math.round(sy) + 0.5); g.lineTo(rect.x - 7, Math.round(sy) + 0.5); }
  g.stroke();
  g.restore();
}

function materialOf(model, id) { return model.materials.find((m) => m.id === id); }

function ringPath(g, view, pts) {
  pts.forEach((p, i) => { const s = view.toScreen(p); if (i === 0) g.moveTo(s[0], s[1]); else g.lineTo(s[0], s[1]); });
  g.closePath();
}

function hatch(g, rect, view, pts) {
  // diagonal hatch for regions without material
  g.save();
  g.beginPath(); ringPath(g, view, pts); g.clip();
  g.strokeStyle = 'rgba(120,120,120,0.5)'; g.lineWidth = 1; g.beginPath();
  for (let d = -rect.h; d < rect.w + rect.h; d += 8) { g.moveTo(rect.x + d, rect.y); g.lineTo(rect.x + d - rect.h, rect.y + rect.h); }
  g.stroke(); g.restore();
}

/** Regions with material fill, outlines, internal lines, vertices and optional labels. */
export function drawGeometry(g, view, rect, model, { labels = true, fillAlpha = 0.9, vertices = true, selection = null, hoverRegion = null } = {}) {
  g.save();
  g.lineJoin = 'round';
  for (const r of model.regions) {
    const mat = materialOf(model, r.materialId);
    g.beginPath(); ringPath(g, view, r.points);
    g.globalAlpha = fillAlpha;
    g.fillStyle = mat ? mat.color : '#f4f4f4';
    g.fill();
    g.globalAlpha = 1;
    if (!mat) hatch(g, rect, view, r.points);
  }
  if (hoverRegion) {
    const r = model.regions.find((x) => x.id === hoverRegion);
    if (r) { g.beginPath(); ringPath(g, view, r.points); g.fillStyle = COLORS.hover; g.fill(); }
  }
  g.strokeStyle = COLORS.edge; g.lineWidth = 1.4;
  for (const r of model.regions) { g.beginPath(); ringPath(g, view, r.points); g.stroke(); }
  // internal lines
  g.strokeStyle = '#6a1b9a'; g.lineWidth = 1.6; g.setLineDash([6, 3]);
  for (const l of model.lines) {
    g.beginPath(); l.points.forEach((p, i) => { const s = view.toScreen(p); if (i === 0) g.moveTo(s[0], s[1]); else g.lineTo(s[0], s[1]); }); g.stroke();
  }
  g.setLineDash([]);
  // selection highlight
  if (selection) {
    g.strokeStyle = COLORS.sel; g.lineWidth = 3;
    if (selection.kind === 'region') {
      const r = model.regions.find((x) => x.id === selection.id);
      if (r) { g.beginPath(); ringPath(g, view, r.points); g.fillStyle = COLORS.selFill; g.fill(); g.stroke(); }
    } else if (selection.kind === 'line') {
      const l = model.lines.find((x) => x.id === selection.id);
      if (l) { g.beginPath(); l.points.forEach((p, i) => { const s = view.toScreen(p); if (i === 0) g.moveTo(s[0], s[1]); else g.lineTo(s[0], s[1]); }); g.stroke(); }
    }
  }
  if (vertices) {
    const seen = new Set();
    const sq = (p, big) => {
      const k = p[0].toFixed(7) + ',' + p[1].toFixed(7);
      if (seen.has(k) && !big) return;
      seen.add(k);
      const s = view.toScreen(p), z = big ? 4.5 : 3;
      if (s[0] < rect.x - 8 || s[0] > rect.x + rect.w + 8 || s[1] < rect.y - 8 || s[1] > rect.y + rect.h + 8) return;
      g.fillStyle = big ? COLORS.sel : COLORS.vertexFill; g.strokeStyle = big ? '#8a3c00' : COLORS.edge; g.lineWidth = 1;
      g.fillRect(s[0] - z, s[1] - z, 2 * z, 2 * z); g.strokeRect(s[0] - z + 0.5, s[1] - z + 0.5, 2 * z - 1, 2 * z - 1);
    };
    for (const r of model.regions) for (const p of r.points) sq(p, false);
    for (const l of model.lines) for (const p of l.points) sq(p, false);
    if (selection?.kind === 'vertex') {
      const owner = selection.owner === 'line' ? model.lines : model.regions;
      const o = owner.find((x) => x.id === selection.id);
      const p = o?.points[selection.index];
      if (p) sq(p, true);
    }
  }
  if (labels) {
    g.textAlign = 'center'; g.textBaseline = 'middle';
    for (const r of model.regions) {
      const c = view.toScreen(polygonCentroid(r.points));
      if (c[0] < rect.x || c[0] > rect.x + rect.w || c[1] < rect.y || c[1] > rect.y + rect.h) continue;
      const mat = materialOf(model, r.materialId);
      g.font = '600 12px system-ui, sans-serif'; g.fillStyle = 'rgba(20,25,35,0.85)';
      g.fillText(r.name || r.id, c[0], c[1] - 7);
      g.font = '11px system-ui, sans-serif'; g.fillStyle = mat ? 'rgba(20,25,35,0.6)' : '#b71c1c';
      g.fillText(mat ? mat.name : 'no material', c[0], c[1] + 8);
    }
  }
  g.restore();
}

/** Mesh coloured by region (uses services.render.drawMesh when available). */
export function drawMeshLayer(g, view, model, mesh, render, { fillAlpha = 0.7 } = {}) {
  const regionColors = model.regions.map((r) => materialOf(model, r.materialId)?.color || '#dddddd');
  if (render?.drawMesh) {
    render.drawMesh(g, view, mesh, { regionColors, fillAlpha, edgeColor: 'rgba(30,40,60,0.5)', lineWidth: 0.6, showBoundary: true });
    return;
  }
  const nen = mesh.nen, nEl = mesh.elements.length / nen, el = mesh.elements, X = mesh.nodes;
  g.save(); g.lineWidth = 0.6; g.strokeStyle = 'rgba(30,40,60,0.5)'; g.beginPath();
  for (let e = 0; e < nEl; e++) {
    for (let k = 0; k < 3; k++) {
      const n = el[e * nen + k] * 2; const s = view.toScreen([X[n], X[n + 1]]);
      if (k === 0) g.moveTo(s[0], s[1]); else g.lineTo(s[0], s[1]);
    }
    g.closePath();
  }
  g.stroke(); g.restore();
}

function arrow(g, tail, tip, head = 7) {
  const dx = tip[0] - tail[0], dy = tip[1] - tail[1], L = Math.hypot(dx, dy);
  if (L < 1) return;
  const ux = dx / L, uy = dy / L;
  g.beginPath(); g.moveTo(tail[0], tail[1]); g.lineTo(tip[0] - ux * head * 0.6, tip[1] - uy * head * 0.6); g.stroke();
  g.beginPath(); g.moveTo(tip[0], tip[1]);
  g.lineTo(tip[0] - ux * head - uy * head * 0.42, tip[1] - uy * head + ux * head * 0.42);
  g.lineTo(tip[0] - ux * head + uy * head * 0.42, tip[1] - uy * head - ux * head * 0.42);
  g.closePath(); g.fill();
}

/** Classic support symbols: pins (triangle + hatched ground) and rollers (triangle + wheels + ground line). */
export function drawBoundaryConditions(g, view, model, { selectedId = null } = {}) {
  const glyphs = bcGlyphs(model, view);
  g.save();
  g.lineWidth = 1.3; g.lineJoin = 'round';
  for (const gl of glyphs) {
    const sel = gl.id === selectedId;
    const col = sel ? COLORS.sel : COLORS.bc;
    g.strokeStyle = col; g.fillStyle = 'rgba(255,255,255,0.9)'; g.lineWidth = sel ? 2 : 1.3;
    const { x, y, dx, dy } = gl, nx = -dy, ny = dx;
    const P = (a, b) => [x + dx * a + nx * b, y + dy * a + ny * b];
    if (gl.type === 'pin') {
      const t = [P(0, 0), P(10, -6), P(10, 6)];
      g.beginPath(); g.moveTo(...t[0]); g.lineTo(...t[1]); g.lineTo(...t[2]); g.closePath(); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(...P(10, -9)); g.lineTo(...P(10, 9));
      for (let k = -9; k <= 6; k += 5) { g.moveTo(...P(10, k + 3)); g.lineTo(...P(15, k)); }
      g.stroke();
    } else {
      const t = [P(0, 0), P(8, -6), P(8, 6)];
      g.beginPath(); g.moveTo(...t[0]); g.lineTo(...t[1]); g.lineTo(...t[2]); g.closePath(); g.fill(); g.stroke();
      for (const off of [-3.2, 3.2]) { const c = P(11, off); g.beginPath(); g.arc(c[0], c[1], 2.6, 0, Math.PI * 2); g.fill(); g.stroke(); }
      g.beginPath(); g.moveTo(...P(14.2, -9)); g.lineTo(...P(14.2, 9)); g.stroke();
    }
  }
  g.restore();
}

export function drawLoads(g, view, model, { selectedId = null } = {}) {
  const glyphs = loadGlyphs(model, view, { fmt: (v) => fmtNum(v, 4) });
  g.save();
  g.font = '11px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'bottom';
  for (const gl of glyphs) {
    const sel = gl.id === selectedId;
    const col = sel ? COLORS.sel : COLORS.load;
    g.strokeStyle = col; g.fillStyle = col; g.lineWidth = sel ? 2.4 : 1.6;
    if (gl.kind === 'point') {
      arrow(g, gl.tail, gl.tip, 9);
      g.fillStyle = sel ? '#8a3c00' : '#8e1b1b'; g.textAlign = 'center';
      g.fillText(gl.label, gl.tail[0], gl.tail[1] - 4);
    } else {
      for (const a of gl.arrows) arrow(g, a.tail, a.tip, 7);
      if (gl.tailLine.length > 1) { g.beginPath(); gl.tailLine.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke(); }
      g.fillStyle = sel ? '#8a3c00' : '#8e1b1b';
      for (const l of gl.labels) g.fillText(l.text, l.x, l.y - 4);
    }
  }
  g.restore();
}

export function drawWater(g, view, model, { selected = false } = {}) {
  const w = model.water;
  if (!w || !w.phreatic || w.phreatic.length === 0) return;
  const { pts, symbol } = waterGlyph(model, view);
  g.save();
  const on = !!w.enabled;
  g.strokeStyle = selected ? COLORS.sel : on ? COLORS.water : '#8a94a6'; g.lineWidth = on ? 2.2 : 1.6;
  if (!on) g.setLineDash([6, 4]);
  g.beginPath(); pts.forEach((p, i) => (i ? g.lineTo(p[0], p[1]) : g.moveTo(p[0], p[1]))); g.stroke();
  g.setLineDash([]);
  for (const p of pts) { g.fillStyle = on ? '#fff' : '#eee'; g.fillRect(p[0] - 3, p[1] - 3, 6, 6); g.strokeRect(p[0] - 3 + 0.5, p[1] - 3 + 0.5, 5, 5); }
  if (symbol) {
    const { x, y } = symbol;
    g.fillStyle = on ? COLORS.water : '#8a94a6';
    g.beginPath(); g.moveTo(x, y); g.lineTo(x - 7, y - 11); g.lineTo(x + 7, y - 11); g.closePath(); g.fill();
    g.lineWidth = 1.6; g.beginPath();
    g.moveTo(x - 9, y + 3); g.lineTo(x + 9, y + 3); g.moveTo(x - 6, y + 7); g.lineTo(x + 6, y + 7); g.moveTo(x - 3, y + 11); g.lineTo(x + 3, y + 11); g.stroke();
    if (!on) { g.font = '10px system-ui, sans-serif'; g.fillStyle = '#6b7385'; g.textAlign = 'left'; g.fillText('(off)', x + 12, y + 3); }
  }
  g.restore();
}

/** Small marker showing the snap result under the cursor. */
export function drawSnapMarker(g, view, p, kind) {
  if (!p || kind === 'none') return;
  const s = view.toScreen(p);
  g.save(); g.lineWidth = 1.5;
  if (kind === 'vertex') { g.strokeStyle = '#d81b60'; g.strokeRect(s[0] - 6.5, s[1] - 6.5, 13, 13); }
  else if (kind === 'edge') { g.strokeStyle = '#2e7d32'; g.beginPath(); g.moveTo(s[0], s[1] - 7); g.lineTo(s[0] + 7, s[1]); g.lineTo(s[0], s[1] + 7); g.lineTo(s[0] - 7, s[1]); g.closePath(); g.stroke(); }
  else { g.strokeStyle = 'rgba(30,60,120,0.7)'; g.beginPath(); g.moveTo(s[0] - 5, s[1]); g.lineTo(s[0] + 5, s[1]); g.moveTo(s[0], s[1] - 5); g.lineTo(s[0], s[1] + 5); g.stroke(); }
  g.restore();
}

/** Draw a polyline/polygon rubber band (model-space points) plus a live segment to `cursor`. */
export function drawRubber(g, view, pts, cursor, { closed = false, color = '#1565c0', fill = false } = {}) {
  if (!pts.length) return;
  g.save();
  g.strokeStyle = color; g.fillStyle = 'rgba(21,101,192,0.12)'; g.lineWidth = 1.6; g.setLineDash([5, 3]);
  g.beginPath();
  pts.forEach((p, i) => { const s = view.toScreen(p); if (i === 0) g.moveTo(s[0], s[1]); else g.lineTo(s[0], s[1]); });
  if (cursor) { const c = view.toScreen(cursor); g.lineTo(c[0], c[1]); }
  if (closed) g.closePath();
  if (fill) g.fill();
  g.stroke(); g.setLineDash([]);
  g.fillStyle = color;
  for (const p of pts) { const s = view.toScreen(p); g.fillRect(s[0] - 3, s[1] - 3, 6, 6); }
  g.restore();
}

/** Floating text box at screen coords (tooltips, probe). */
export function drawTag(g, x, y, lines, { rect = null, bg = 'rgba(255,255,225,0.96)' } = {}) {
  g.save();
  g.font = '11.5px system-ui, sans-serif';
  const w = Math.max(...lines.map((l) => g.measureText(l).width)) + 12, h = lines.length * 15 + 8;
  let bx = x + 14, by = y + 14;
  if (rect) { if (bx + w > rect.x + rect.w) bx = x - w - 10; if (by + h > rect.y + rect.h) by = y - h - 10; }
  g.fillStyle = bg; g.strokeStyle = '#888'; g.lineWidth = 1;
  g.fillRect(bx, by, w, h); g.strokeRect(bx + 0.5, by + 0.5, w - 1, h - 1);
  g.fillStyle = '#1b1f27'; g.textAlign = 'left'; g.textBaseline = 'top';
  lines.forEach((l, i) => g.fillText(l, bx + 6, by + 5 + i * 15));
  g.restore();
}

// ------------------------------------------------------------------ results plot

/** Stage index resolved from plot.stageIndex (-1 = last). */
export function resolveStageIndex(results, plot) {
  const n = results?.stages?.length || 0;
  if (!n) return -1;
  const i = plot.stageIndex ?? -1;
  return i < 0 ? n - 1 : Math.min(i, n - 1);
}

/**
 * Compute (and cache) everything the results plot needs for the current settings.
 * Returns { stage, stageIdx, values, min, max, deformScale, coords, activeElements, info } or null.
 */
export function plotData(app) {
  const { state, services } = app;
  const { mesh, results, plot } = state;
  if (!mesh || !results || !results.stages?.length) return null;
  const idx = resolveStageIndex(results, plot);
  const stage = results.stages[idx];
  if (!stage || !stage.displacement) return null;
  const key = [plot.field, idx, plot.deformed, plot.deformScale, plot.min, plot.max].join('|');
  const c = app.plotCache;
  if (c && c.results === results && c.mesh === mesh && c.key === key) return c.data;
  let values;
  try { values = services.postFields.nodalField(mesh, stage, plot.field); } catch (e) { return { error: `Cannot compute field "${plot.field}": ${e.message}`, stage, stageIdx: idx }; }
  const act = stage.activeElements || null;
  const mask = activeNodeMask(mesh, act);
  const auto = valueRange(values, mask);
  let min = Number.isFinite(plot.min) ? plot.min : auto.min;
  let max = Number.isFinite(plot.max) ? plot.max : auto.max;
  if (min > max) [min, max] = [max, min]; // a reversed manual range still plots sensibly
  if (min === max) { const d = Math.abs(min) * 1e-3 || 1e-6; min -= d; max += d; } // a zero-width range would make a degenerate legend
  const deformScale = plot.deformScale && plot.deformScale > 0 ? plot.deformScale : autoDeformScale(mesh, stage.displacement, 0.1);
  const coords = plot.deformed ? deformedNodes(mesh, stage.displacement, deformScale) : null;
  const data = { stage, stageIdx: idx, values, min, max, autoMin: auto.min, autoMax: auto.max, deformScale, coords, activeElements: act, info: fieldMeta(plot.field, services.postFields) };
  app.plotCache = { results, mesh, key, data };
  return data;
}

/** Draw contour plot + overlays. Returns false if there is nothing to draw. */
export function drawResults(g, view, rect, app) {
  const { state, services } = app;
  const { mesh, plot, results } = state;
  const R = services.render;
  const data = plotData(app);
  if (!data || data.error || !R) return data?.error || false;
  const { stage, values, min, max, deformScale, coords, activeElements } = data;
  g.save();
  g.beginPath(); g.rect(rect.x, rect.y, rect.w, rect.h); g.clip();
  const common = { coords: coords || undefined, activeElements: activeElements || undefined };
  let drawn = null;
  try {
    if (plot.deformed) {
      // ghost of the undeformed boundary
      g.save(); g.strokeStyle = 'rgba(0,0,0,0.35)'; g.setLineDash([4, 3]); g.lineWidth = 1; g.beginPath();
      for (const [a, b] of mesh.boundaryEdges || []) { const pa = view.toScreen([mesh.nodes[2 * a], mesh.nodes[2 * a + 1]]), pb = view.toScreen([mesh.nodes[2 * b], mesh.nodes[2 * b + 1]]); g.moveTo(pa[0], pa[1]); g.lineTo(pb[0], pb[1]); }
      g.stroke(); g.restore();
    }
    drawn = R.drawContours(g, view, mesh, values, { ...common, min, max, nLevels: plot.nLevels || 12, colormap: plot.colormap });
    if (plot.showMesh) R.drawMesh(g, view, mesh, { ...common, edgeColor: 'rgba(0,0,0,0.28)', lineWidth: 0.5, showBoundary: true });
    else R.drawMesh(g, view, mesh, { ...common, showEdges: false, showBoundary: true });
    if (plot.showVectors) R.drawVectors(g, view, mesh, stage.displacement, { ...common });
    if (plot.showPlastic) R.drawPlasticPoints(g, view, stage, plot.deformed ? { mesh, disp: stage.displacement, deformScale } : {});
  } catch (e) {
    g.restore();
    return `Plot error: ${e.message}`;
  }
  g.restore();
  // legend
  const lh = Math.min(320, Math.max(120, rect.h - 60));
  try {
    g.save(); g.fillStyle = 'rgba(255,255,255,0.82)'; g.fillRect(rect.x + rect.w - 158, rect.y + 6, 152, lh + 12); g.restore();
    R.drawLegend(g, rect.x + rect.w - 150, rect.y + 12, 18, lh, min, max, plot.colormap, data.info.label, data.info.unit && data.info.unit !== '-' ? data.info.unit : '', { levels: drawn?.levels, nLevels: plot.nLevels || 12 });
  } catch { /* legend is optional */ }
  // title / FOS label
  g.save();
  g.textAlign = 'left'; g.textBaseline = 'top';
  const st = effectiveStages(state.model)[data.stageIdx];
  g.font = '12px system-ui, sans-serif'; g.fillStyle = '#394150';
  let ty = rect.y + 10;
  g.fillText(`${data.info.label}${data.info.unit ? ' [' + data.info.unit + ']' : ''} · ${stage.name || st?.name || 'Stage ' + (data.stageIdx + 1)}${plot.deformed ? ` · deformed ×${fmtNum(deformScale, 3)}` : ''}`, rect.x + 12, ty);
  ty += 20;
  if (results.analysis === 'fos' && results.fos != null) {
    const txt = `FOS = ${Number(results.fos).toFixed(2)}`;
    g.font = '700 30px system-ui, sans-serif';
    const w = g.measureText(txt).width + 24;
    g.fillStyle = 'rgba(255,255,255,0.88)'; g.strokeStyle = results.ok === false ? '#b71c1c' : '#1b5e20'; g.lineWidth = 2;
    g.fillRect(rect.x + 10, ty, w, 46); g.strokeRect(rect.x + 10, ty, w, 46);
    g.fillStyle = results.fos < 1 ? '#b71c1c' : results.fos < 1.3 ? '#e65100' : '#1b5e20';
    g.fillText(txt, rect.x + 22, ty + 7);
  }
  g.restore();
  return true;
}
