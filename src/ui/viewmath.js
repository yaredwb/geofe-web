// DOM-free view transform, grid, snapping, hit-testing and mesh-sampling helpers for the editor canvas.
// Screen coordinates are CSS pixels relative to the canvas element: sx = x*scale + ox, sy = -y*scale + oy.
import { projectOnSegment, pointInPolygon, distPointSegment, bbox } from '../core/geom.js';

export const MIN_SCALE = 1e-4;
export const MAX_SCALE = 1e6;

/** Clean floating point noise: 0.30000000000000004 -> 0.3 */
export function cleanNum(x) {
  return Math.round(x * 1e9) / 1e9 + 0;
}

/** Build the transform object used by the canvas and by services.render.* (scale, ox, oy, toScreen, toModel). */
export function makeView({ scale, ox, oy }) {
  return {
    scale, ox, oy,
    toScreen(p) { return [p[0] * scale + ox, -p[1] * scale + oy]; },
    toModel(s) { return [(s[0] - ox) / scale, (oy - s[1]) / scale]; },
  };
}

/** New {scale,ox,oy} after zooming by `factor` keeping the model point under screen (sx,sy) fixed. */
export function zoomAbout(view, sx, sy, factor) {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
  const k = scale / view.scale;
  return { scale, ox: sx - (sx - view.ox) * k, oy: sy + (view.oy - sy) * k };
}

export function panBy(view, dx, dy) {
  return { scale: view.scale, ox: view.ox + dx, oy: view.oy + dy };
}

/** View fitting bbox {xmin,ymin,xmax,ymax} into screen rect {x,y,w,h} with fractional margin. */
export function zoomExtents(bb, rect, margin = 0.06) {
  if (!bb || !Number.isFinite(bb.xmin)) return { scale: 10, ox: rect.x + 20, oy: rect.y + rect.h - 20 };
  let dx = bb.xmax - bb.xmin, dy = bb.ymax - bb.ymin;
  const ext = Math.max(dx, dy, 1e-9);
  if (dx < ext * 1e-6) dx = ext; // degenerate (a vertical/horizontal line or point)
  if (dy < ext * 1e-6) dy = ext;
  const w = Math.max(rect.w, 10), h = Math.max(rect.h, 10);
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min((w * (1 - 2 * margin)) / dx, (h * (1 - 2 * margin)) / dy)));
  const cx = (bb.xmin + bb.xmax) / 2, cy = (bb.ymin + bb.ymax) / 2;
  return { scale, ox: rect.x + w / 2 - cx * scale, oy: rect.y + h / 2 + cy * scale };
}

/** Smallest "nice" number (1, 2, 5 × 10^k) that is >= raw. */
export function niceStep(raw) {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const e = Math.floor(Math.log10(raw));
  const f = raw / Math.pow(10, e);
  const m = f <= 1 + 1e-9 ? 1 : f <= 2 + 1e-9 ? 2 : f <= 5 + 1e-9 ? 5 : 10;
  return cleanNum(m * Math.pow(10, e)) || m * Math.pow(10, e);
}

/** Major / minor grid spacing (model units) for the current scale. Major lines are >= minMajorPx apart. */
export function gridSteps(scale, minMajorPx = 70) {
  const major = niceStep(minMajorPx / scale);
  const e = Math.floor(Math.log10(major));
  const mant = Math.round(major / Math.pow(10, e));
  const div = mant === 2 ? 4 : 5; // 1->0.2, 2->0.5, 5->1
  return { major, minor: major / div };
}

/** Multiples of `step` in [min,max] (cleaned of FP noise). */
export function ticks(min, max, step) {
  const out = [];
  if (!(step > 0) || !(max >= min)) return out;
  const i0 = Math.ceil(min / step - 1e-9), i1 = Math.floor(max / step + 1e-9);
  if (i1 - i0 > 2000) return out;
  for (let i = i0; i <= i1; i++) out.push(cleanNum(i * step));
  return out;
}

export function snapToGrid(p, step) {
  return [cleanNum(Math.round(p[0] / step) * step), cleanNum(Math.round(p[1] / step) * step)];
}

/**
 * Gather unique snap vertices and segments from the model (regions, internal lines) plus optional extra
 * in-progress polylines [{points, closed}].
 */
export function collectSnapGeometry(model, extra = []) {
  const vertices = [];
  const segments = [];
  const seen = new Set();
  const addV = (p) => {
    const k = p[0].toFixed(9) + ',' + p[1].toFixed(9);
    if (!seen.has(k)) { seen.add(k); vertices.push(p); }
  };
  const addRing = (pts, closed) => {
    for (const p of pts) addV(p);
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) segments.push([pts[i], pts[(i + 1) % n]]);
  };
  for (const r of model?.regions || []) addRing(r.points, true);
  for (const l of model?.lines || []) addRing(l.points, false);
  for (const e of extra) addRing(e.points, !!e.closed);
  return { vertices, segments };
}

// Keep exact edge coordinate on the constant axis; clean noise on the sliding axis.
function cleanNum2(v, keepExact) { return keepExact ? v : cleanNum(v); }

/**
 * Snap a raw model point. Priority: existing vertex > point on existing edge > grid.
 * opts: { scale, gridStep, snapGrid, snapGeom, geom:{vertices,segments}, vertexTolPx, edgeTolPx }
 * Returns { p, kind: 'vertex'|'edge'|'grid'|'none' }. Vertex snaps return the EXACT existing coordinates.
 */
export function snapPoint(raw, opts) {
  const { scale, gridStep, snapGrid = true, snapGeom = true, geom, vertexTolPx = 10, edgeTolPx = 8 } = opts;
  if (snapGeom && geom) {
    const vt = vertexTolPx / scale;
    let best = null, bd = vt;
    for (const v of geom.vertices) {
      const d = Math.hypot(v[0] - raw[0], v[1] - raw[1]);
      if (d <= bd) { bd = d; best = v; }
    }
    if (best) return { p: [best[0], best[1]], kind: 'vertex' };
    const et = edgeTolPx / scale;
    let bestE = null, bestSeg = null, ed = et;
    for (const seg of geom.segments) {
      const pr = projectOnSegment(raw, seg[0], seg[1]);
      if (pr.dist <= ed) { ed = pr.dist; bestE = pr.point; bestSeg = seg; }
    }
    if (bestE) {
      // On axis-aligned edges slide to the nearest round grid position along the edge (keeps coordinates tidy).
      if (snapGrid && gridStep > 0 && (bestSeg[0][0] === bestSeg[1][0] || bestSeg[0][1] === bestSeg[1][1])) {
        const along = projectOnSegment(snapToGrid(bestE, gridStep), bestSeg[0], bestSeg[1]).point;
        if (Math.hypot(along[0] - bestE[0], along[1] - bestE[1]) <= edgeTolPx / scale) return { p: [cleanNum2(along[0], bestSeg[0][0] === bestSeg[1][0]), cleanNum2(along[1], bestSeg[0][1] === bestSeg[1][1])], kind: 'edge' };
      }
      return { p: [bestE[0], bestE[1]], kind: 'edge' };
    }
  }
  if (snapGrid && gridStep > 0) return { p: snapToGrid(raw, gridStep), kind: 'grid' };
  return { p: [raw[0], raw[1]], kind: 'none' };
}

// ---------------------------------------------------------------- hit testing (model space, tolerance in model units)

/** Nearest region/line vertex within tol. Returns {owner:'region'|'line', id, index, point, dist} or null. */
export function hitVertex(model, p, tol) {
  let best = null, bd = tol;
  const test = (owner, id, pts) => {
    pts.forEach((q, index) => {
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d <= bd) { bd = d; best = { owner, id, index, point: q, dist: d }; }
    });
  };
  for (const r of model.regions || []) test('region', r.id, r.points);
  for (const l of model.lines || []) test('line', l.id, l.points);
  return best;
}

/** Topmost region containing p (later regions win), or null. */
export function hitRegion(model, p) {
  const rs = model.regions || [];
  for (let i = rs.length - 1; i >= 0; i--) if (pointInPolygon(p, rs[i].points)) return rs[i];
  return null;
}

/** Nearest internal line within tol: {id, dist} or null. */
export function hitLine(model, p, tol) {
  let best = null, bd = tol;
  for (const l of model.lines || []) {
    for (let i = 0; i < l.points.length - 1; i++) {
      const d = distPointSegment(p, l.points[i], l.points[i + 1]);
      if (d <= bd) { bd = d; best = { id: l.id, dist: d }; }
    }
  }
  return best;
}

/** Nearest region edge/line segment: {owner,id,edgeIndex,point,dist} (used to insert a vertex). */
export function hitEdge(model, p, tol) {
  let best = null, bd = tol;
  const test = (owner, id, pts, closed) => {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const pr = projectOnSegment(p, pts[i], pts[(i + 1) % n]);
      if (pr.dist <= bd) { bd = pr.dist; best = { owner, id, edgeIndex: i, point: pr.point, dist: pr.dist }; }
    }
  };
  for (const r of model.regions || []) test('region', r.id, r.points, true);
  for (const l of model.lines || []) test('line', l.id, l.points, false);
  return best;
}

/** Bounding box of everything geometric in the model (regions, lines, loads, water). null if empty. */
export function modelBBox(model) {
  const pts = [];
  for (const r of model.regions || []) pts.push(...r.points);
  for (const l of model.lines || []) pts.push(...l.points);
  if (!pts.length) {
    for (const l of model.loads || []) { if (l.p) pts.push(l.p); if (l.p1) pts.push(l.p1, l.p2); }
    if (model.water?.phreatic?.length) pts.push(...model.water.phreatic);
  }
  return pts.length ? bbox(pts) : null;
}

export function polygonCentroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % n];
    const f = x1 * y2 - x2 * y1;
    a += f; cx += (x1 + x2) * f; cy += (y1 + y2) * f;
  }
  if (Math.abs(a) < 1e-12) {
    const b = bbox(pts);
    return [(b.xmin + b.xmax) / 2, (b.ymin + b.ymax) / 2];
  }
  return [cx / (3 * a), cy / (3 * a)];
}

// ---------------------------------------------------------------- mesh sampling (probe, line plots)

const triCache = new WeakMap(); // nodes array -> { elemBox: Float64Array, mesh }

/** Sub-triangles (as node index triples) of element e: 1 for T3, 4 for T6. */
export function elementTriangles(mesh, e) {
  const nen = mesh.nen, el = mesh.elements, o = e * nen;
  if (nen === 3) return [[el[o], el[o + 1], el[o + 2]]];
  const n0 = el[o], n1 = el[o + 1], n2 = el[o + 2], n3 = el[o + 3], n4 = el[o + 4], n5 = el[o + 5];
  return [[n0, n3, n5], [n3, n1, n4], [n5, n4, n2], [n3, n4, n5]];
}

function elemBoxes(mesh, nodes) {
  let c = triCache.get(nodes);
  if (c && c.mesh === mesh) return c.boxes;
  const nEl = mesh.elements.length / mesh.nen, nen = mesh.nen;
  const boxes = new Float64Array(nEl * 4);
  for (let e = 0; e < nEl; e++) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = 0; k < Math.min(nen, 3); k++) {
      const n = mesh.elements[e * nen + k];
      const x = nodes[2 * n], y = nodes[2 * n + 1];
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    boxes[4 * e] = x0; boxes[4 * e + 1] = y0; boxes[4 * e + 2] = x1; boxes[4 * e + 3] = y1;
  }
  triCache.set(nodes, { mesh, boxes });
  return boxes;
}

/**
 * Interpolate a nodal field at model point p. `nodes` defaults to mesh.nodes (pass a deformed coordinate array
 * to probe a deformed plot). `active` (optional Uint8Array per element) skips inactive elements.
 * Returns the value or null if p is outside the mesh. Triangles use linear (barycentric) interpolation of the
 * corner / sub-triangle node values.
 */
export function interpolateAt(mesh, values, p, nodes = mesh.nodes, active = null) {
  if (!mesh || !values) return null;
  const boxes = elemBoxes(mesh, nodes);
  const nEl = mesh.elements.length / mesh.nen;
  const [px, py] = p;
  for (let e = 0; e < nEl; e++) {
    const o = 4 * e;
    // bbox from corners only: T6 mid-nodes of straight-sided elements lie on the edges, fine (small pad for curved)
    const pad = 1e-9 + 0.0 * boxes[o];
    if (px < boxes[o] - pad || px > boxes[o + 2] + pad || py < boxes[o + 1] - pad || py > boxes[o + 3] + pad) continue;
    if (active && !active[e]) continue;
    for (const [a, b, c] of elementTriangles(mesh, e)) {
      const ax = nodes[2 * a], ay = nodes[2 * a + 1], bx = nodes[2 * b], by = nodes[2 * b + 1], cx = nodes[2 * c], cy = nodes[2 * c + 1];
      const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(det) < 1e-300) continue;
      const l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / det;
      const l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / det;
      const l3 = 1 - l1 - l2;
      const eps = -1e-9;
      if (l1 >= eps && l2 >= eps && l3 >= eps) return l1 * values[a] + l2 * values[b] + l3 * values[c];
    }
  }
  return null;
}

/** Deformed node coordinates: nodes + scale * disp (new Float64Array). */
export function deformedNodes(mesh, disp, scale) {
  const out = new Float64Array(mesh.nodes.length);
  for (let i = 0; i < out.length; i++) out[i] = mesh.nodes[i] + scale * (disp[i] || 0);
  return out;
}

/** A "nice" deformation magnification so the largest displacement is ~fraction of the model size. */
export function autoDeformScale(mesh, disp, fraction = 0.1) {
  if (!mesh || !disp) return 1;
  let umax = 0;
  for (let i = 0; i < disp.length; i += 2) umax = Math.max(umax, Math.hypot(disp[i], disp[i + 1]));
  if (!(umax > 0)) return 1;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < mesh.nodes.length; i += 2) {
    const x = mesh.nodes[i], y = mesh.nodes[i + 1];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  const size = Math.max(x1 - x0, y1 - y0);
  const raw = (fraction * size) / umax;
  if (raw <= 1) return Math.max(1, Math.round(raw * 10) / 10 || 1);
  // round to 1 significant digit (1,2,5 progression)
  const e = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / e;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * e;
}

/** min/max of finite values; widened slightly if degenerate. */
export function valueRange(values, mask = null) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    if (mask && !mask[i]) continue;
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!Number.isFinite(min)) return { min: 0, max: 1 };
  if (max - min < 1e-14 * Math.max(1, Math.abs(max))) { const d = Math.max(Math.abs(max) * 0.01, 1e-12); return { min: min - d, max: max + d }; }
  return { min, max };
}

/** Mask of nodes belonging to at least one active element. */
export function activeNodeMask(mesh, activeElements) {
  if (!activeElements) return null;
  const mask = new Uint8Array(mesh.nodes.length / 2);
  const nen = mesh.nen, nEl = mesh.elements.length / nen;
  for (let e = 0; e < nEl; e++) if (activeElements[e]) for (let k = 0; k < nen; k++) mask[mesh.elements[e * nen + k]] = 1;
  return mask;
}

/** Distance (model units) along a section; helper for line-plot axes. */
export function chartPath(points, w, h, pad = { l: 56, r: 12, t: 10, b: 30 }) {
  // points: [{s,v}] -> {d: svg path, xs:[min,max], ys:[min,max], px(s), py(v)}
  const valid = points.filter((q) => Number.isFinite(q.v));
  const xs = [Math.min(...points.map((q) => q.s)), Math.max(...points.map((q) => q.s))];
  let y0 = valid.length ? Math.min(...valid.map((q) => q.v)) : 0, y1 = valid.length ? Math.max(...valid.map((q) => q.v)) : 1;
  if (y1 - y0 < 1e-14) { y0 -= 0.5; y1 += 0.5; }
  const padY = (y1 - y0) * 0.05; y0 -= padY; y1 += padY;
  const px = (s) => pad.l + ((s - xs[0]) / Math.max(xs[1] - xs[0], 1e-12)) * (w - pad.l - pad.r);
  const py = (v) => h - pad.b - ((v - y0) / (y1 - y0)) * (h - pad.t - pad.b);
  let d = '', pen = false;
  for (const q of points) {
    if (!Number.isFinite(q.v)) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + px(q.s).toFixed(2) + ' ' + py(q.v).toFixed(2);
    pen = true;
  }
  return { d, xs, ys: [y0, y1], px, py, pad };
}
