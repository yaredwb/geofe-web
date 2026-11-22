// Planar straight-line graph (PSLG) construction for the mesher (DOM-free).
//
// Input: region polygons + internal lines + "feature points" (load end points, fixity points...).
// Output: merged vertex list and a set of atomic segments such that no two segments cross, no vertex lies
// in the interior of a segment, and coincident edges of neighbouring regions appear exactly once.
import { pointInPolygon, distPointSegment } from '../core/geom.js';

/** Spatial hash that merges points closer than tol. */
export class PointIndex {
  constructor(tol) {
    this.tol = tol;
    this.cell = Math.max(tol * 2, 1e-300);
    this.map = new Map();
    this.x = [];
    this.y = [];
  }

  _key(ix, iy) { return ix + ',' + iy; }

  find(x, y) {
    const c = this.cell;
    const ix = Math.floor(x / c), iy = Math.floor(y / c);
    let best = -1, bestD = this.tol * this.tol;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.map.get(this._key(ix + dx, iy + dy));
        if (!list) continue;
        for (const i of list) {
          const ddx = this.x[i] - x, ddy = this.y[i] - y;
          const d = ddx * ddx + ddy * ddy;
          if (d <= bestD) { bestD = d; best = i; }
        }
      }
    }
    return best;
  }

  /** Index of an existing point within tol, else a new point. */
  add(x, y) {
    const f = this.find(x, y);
    if (f >= 0) return f;
    const i = this.x.length;
    this.x.push(x);
    this.y.push(y);
    const k = this._key(Math.floor(x / this.cell), Math.floor(y / this.cell));
    const list = this.map.get(k);
    if (list) list.push(i); else this.map.set(k, [i]);
    return i;
  }
}

function segKey(a, b) { return a < b ? a * 67108864 + b : b * 67108864 + a; }

/**
 * Build the PSLG.
 * @param {object} model
 * @param {Array<[number,number]>} features points that must become mesh vertices (only kept if on/in the domain)
 * @param {number} tol geometric merge tolerance (absolute): floating-point noise level
 * @param {number} [snapTol] snap tolerance (absolute, >= tol). Vertices closer than 1.5*snapTol are merged, and a vertex
 *   within snapTol of another segment splits that segment (T-junction), so near-coincident geometry typed with
 *   rounding (3.333333 vs 3.33333333, a load 1e-4 below the surface, a line ending 1e-5 short of a boundary) is
 *   connected instead of leaving cracks or sliver triangles. Default: tol (exact legacy behaviour).
 * @param {object} [opts]
 * @param {number} [opts.gapWarn] report vertices/edges that are closer than this but NOT connected (0 = off)
 * @returns {{x:number[], y:number[], segs:Array<[number,number]>, featureVerts:Set<number>, onSegment:Uint8Array, warnings:string[], snaps:Array<{from,to}>}}
 */
export function buildPSLG(model, features, tol, snapTol = tol, opts = {}) {
  const st = Math.max(snapTol, tol);
  const idx = new PointIndex(st > tol ? 1.5 * st : tol);
  const raw = []; // raw segments [i,j]

  const addPolyline = (pts, closed) => {
    const ids = [];
    for (const p of pts) {
      const i = idx.add(p[0], p[1]);
      if (ids.length === 0 || ids[ids.length - 1] !== i) ids.push(i);
    }
    if (closed && ids.length > 1 && ids[0] === ids[ids.length - 1]) ids.pop();
    const n = ids.length;
    if (n < 2) return;
    const last = closed ? n : n - 1;
    if (closed && n < 3) return;
    for (let k = 0; k < last; k++) {
      const a = ids[k], b = ids[(k + 1) % n];
      if (a !== b) raw.push([a, b]);
    }
  };

  const regionPolys = [];
  for (const r of model.regions || []) {
    if (Array.isArray(r.points) && r.points.length >= 3) {
      addPolyline(r.points, true);
      regionPolys.push(r.points);
    }
  }

  // Snap a free point (internal-line vertex or feature point) to the existing geometry: onto a vertex within the merge
  // radius (done by idx), else orthogonally onto the nearest raw segment within snapTol. Projecting (rather than
  // inserting the point as is) keeps the region outline exact and leaves no sliver between the point and the edge.
  const snaps = [];
  const snapPoint = (p) => {
    if (!(st > tol) || idx.find(p[0], p[1]) >= 0) return p;
    let best = null, bd = st;
    for (const [a, b] of raw) {
      const ax = idx.x[a], ay = idx.y[a], dx = idx.x[b] - ax, dy = idx.y[b] - ay;
      const L2 = dx * dx + dy * dy;
      if (!(L2 > 0)) continue;
      const t = ((p[0] - ax) * dx + (p[1] - ay) * dy) / L2;
      if (t <= 0 || t >= 1) continue;
      const d = Math.hypot(p[0] - ax - t * dx, p[1] - ay - t * dy);
      if (d <= bd) { bd = d; best = [ax + t * dx, ay + t * dy]; }
    }
    if (best) { if (bd > tol) snaps.push({ from: [p[0], p[1]], to: best }); return best; }
    return p;
  };

  for (const l of model.lines || []) {
    if (Array.isArray(l.points) && l.points.length >= 2) addPolyline(l.points.map(snapPoint), false);
  }

  // Feature points: kept only if on a raw segment or inside a region.
  const featureVerts = new Set();
  for (const p0 of features || []) {
    if (!p0 || !Number.isFinite(p0[0]) || !Number.isFinite(p0[1])) continue;
    const p = snapPoint(p0);
    const existing = idx.find(p[0], p[1]);
    if (existing >= 0) { featureVerts.add(existing); continue; }
    let ok = p !== p0; // snapped onto an edge
    if (!ok) for (const [a, b] of raw) {
      if (distPointSegment(p, [idx.x[a], idx.y[a]], [idx.x[b], idx.y[b]]) <= st) { ok = true; break; }
    }
    if (!ok) for (const poly of regionPolys) if (pointInPolygon(p, poly)) { ok = true; break; }
    if (ok) featureVerts.add(idx.add(p[0], p[1]));
  }

  // 1. Proper crossings between raw segments -> new vertices.
  const nRaw = raw.length;
  const bb = raw.map(([a, b]) => [
    Math.min(idx.x[a], idx.x[b]) - st, Math.min(idx.y[a], idx.y[b]) - st,
    Math.max(idx.x[a], idx.x[b]) + st, Math.max(idx.y[a], idx.y[b]) + st,
  ]);
  for (let i = 0; i < nRaw; i++) {
    for (let j = i + 1; j < nRaw; j++) {
      const A = bb[i], B = bb[j];
      if (A[2] < B[0] || B[2] < A[0] || A[3] < B[1] || B[3] < A[1]) continue;
      const [a, b] = raw[i], [c, d] = raw[j];
      if (a === c || a === d || b === c || b === d) continue;
      const rx = idx.x[b] - idx.x[a], ry = idx.y[b] - idx.y[a];
      const sx = idx.x[d] - idx.x[c], sy = idx.y[d] - idx.y[c];
      const den = rx * sy - ry * sx;
      const L1 = Math.hypot(rx, ry), L2 = Math.hypot(sx, sy);
      if (Math.abs(den) <= 1e-12 * L1 * L2) continue; // parallel
      const qx = idx.x[c] - idx.x[a], qy = idx.y[c] - idx.y[a];
      const t = (qx * sy - qy * sx) / den;
      const u = (qx * ry - qy * rx) / den;
      const e1 = st / L1, e2 = st / L2;
      if (t <= e1 || t >= 1 - e1 || u <= e2 || u >= 1 - e2) continue; // endpoint contacts handled below
      idx.add(idx.x[a] + t * rx, idx.y[a] + t * ry);
    }
  }

  // 2. Split every raw segment at all vertices lying on its interior.
  const nV = idx.x.length;
  const order = Array.from({ length: nV }, (_, i) => i).sort((p, q) => idx.x[p] - idx.x[q] || p - q);
  const xsorted = order.map((i) => idx.x[i]);
  const lowerBound = (v) => {
    let lo = 0, hi = xsorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (xsorted[m] < v) lo = m + 1; else hi = m; }
    return lo;
  };
  const segs = [];
  const seen = new Set();
  for (const [a, b] of raw) {
    const ax = idx.x[a], ay = idx.y[a], bx = idx.x[b], by = idx.y[b];
    const dx = bx - ax, dy = by - ay;
    const L = Math.hypot(dx, dy);
    const onSeg = [];
    const xlo = Math.min(ax, bx) - st, xhi = Math.max(ax, bx) + st;
    const ylo = Math.min(ay, by) - st, yhi = Math.max(ay, by) + st;
    for (let q = lowerBound(xlo); q < order.length && xsorted[q] <= xhi; q++) {
      const v = order[q];
      if (v === a || v === b) continue;
      const y = idx.y[v];
      if (y < ylo || y > yhi) continue;
      const px = idx.x[v] - ax, py = idx.y[v] - ay;
      const t = (px * dx + py * dy) / (L * L);
      if (t <= 0 || t >= 1) continue;
      const dist = Math.abs(px * dy - py * dx) / L;
      if (dist > st) continue;
      if (t * L <= st || (1 - t) * L <= st) continue;
      onSeg.push([t, v]);
    }
    onSeg.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
    let prev = a;
    for (const [, v] of onSeg) {
      if (v !== prev) { const k = segKey(prev, v); if (!seen.has(k)) { seen.add(k); segs.push([prev, v]); } prev = v; }
    }
    if (prev !== b) { const k = segKey(prev, b); if (!seen.has(k)) { seen.add(k); segs.push([prev, b]); } }
  }

  const onSegment = new Uint8Array(idx.x.length);
  for (const [a, b] of segs) { onSegment[a] = 1; onSegment[b] = 1; }
  const warnings = opts.gapWarn > 0 ? nearMissWarnings(idx.x, idx.y, segs, st, opts.gapWarn) : [];
  return { x: idx.x, y: idx.y, segs, featureVerts, onSegment, warnings, snaps };
}

/**
 * Detect geometry that nearly touches but was NOT connected by the snapping: a vertex that lies just beside a
 * non-incident edge (thin gap, or a vertex not lying on the neighbouring region's edge) or two unconnected vertices
 * that almost coincide. Such a gap behaves as a crack (nodes are not shared), so the user should merge or move them.
 */
function nearMissWarnings(x, y, segs, snapTol, gapWarn) {
  const nV = x.length;
  const out = [];
  let more = 0;
  const push = (msg) => { if (out.length < 5) out.push(msg); else more++; };
  const fmt = (v) => (+v.toPrecision(6)).toString();
  const conn = new Set();
  for (const [a, b] of segs) conn.add(segKey(a, b));
  // vertex - vertex
  const order = Array.from({ length: nV }, (_, i) => i).sort((p, q) => x[p] - x[q] || p - q);
  for (let i = 0; i < nV; i++) {
    const u = order[i];
    for (let j = i + 1; j < nV && x[order[j]] - x[u] <= gapWarn; j++) {
      const v = order[j];
      const d = Math.hypot(x[u] - x[v], y[u] - y[v]);
      if (d > gapWarn || conn.has(segKey(u, v))) continue;
      push(`vertices (${fmt(x[u])}, ${fmt(y[u])}) and (${fmt(x[v])}, ${fmt(y[v])}) are ${fmt(d)} m apart but not connected; ` +
        'the gap acts as a crack. Merge them or move them apart.');
    }
  }
  // vertex - edge (thin sliver: the gap is much smaller than the distance to the edge ends)
  if (nV * segs.length <= 4e6) {
    for (const [a, b] of segs) {
      const ax = x[a], ay = y[a], dx = x[b] - ax, dy = y[b] - ay;
      const L = Math.hypot(dx, dy);
      if (!(L > 0)) continue;
      const xlo = Math.min(ax, x[b]) - gapWarn, xhi = Math.max(ax, x[b]) + gapWarn;
      const ylo = Math.min(ay, y[b]) - gapWarn, yhi = Math.max(ay, y[b]) + gapWarn;
      for (let v = 0; v < nV; v++) {
        if (v === a || v === b) continue;
        if (x[v] < xlo || x[v] > xhi || y[v] < ylo || y[v] > yhi) continue;
        const px = x[v] - ax, py = y[v] - ay;
        const t = (px * dx + py * dy) / (L * L);
        if (t <= 0 || t >= 1) continue;
        const d = Math.abs(px * dy - py * dx) / L;
        if (d > gapWarn || d <= snapTol) continue;
        if (d > 0.035 * Math.min(t, 1 - t) * L) continue; // genuine acute corner, not a sliver gap
        push(`vertex (${fmt(x[v])}, ${fmt(y[v])}) lies ${fmt(d)} m from the edge (${fmt(ax)}, ${fmt(ay)})-(${fmt(x[b])}, ${fmt(y[b])}) ` +
          'but is not connected to it; the interface acts as a crack. Move the vertex onto the edge.');
      }
    }
  }
  if (more) out.push(`... and ${more} more near-coincident geometry location(s)`);
  return out;
}

/** Mark vertices where two incident segments meet at an angle smaller than ~60 degrees (small-angle apexes). */
export function findAcuteApexes(x, y, segs) {
  const nV = x.length;
  const dirs = new Array(nV);
  const add = (v, w) => {
    (dirs[v] || (dirs[v] = [])).push(Math.atan2(y[w] - y[v], x[w] - x[v]));
  };
  for (const [a, b] of segs) { add(a, b); add(b, a); }
  const apex = new Uint8Array(nV);
  const lim = Math.PI / 3 - 1e-9;
  for (let v = 0; v < nV; v++) {
    const d = dirs[v];
    if (!d || d.length < 2) continue;
    d.sort((p, q) => p - q);
    for (let i = 0; i < d.length; i++) {
      const gap = i + 1 < d.length ? d[i + 1] - d[i] : d[0] + 2 * Math.PI - d[i];
      if (gap < lim) { apex[v] = 1; break; }
    }
  }
  return apex;
}
