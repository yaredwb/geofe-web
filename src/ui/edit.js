// DOM-free in-place model editing operations used by the UI tools. Callers must call state.modelChanged() afterwards.
import { newId, defaultMaterial, materialColor } from '../core/model.js';
import { polygonArea, projectOnSegment, bbox, segIntersect } from '../core/geom.js';
import { cleanNum } from './viewmath.js';

export const EPS = 1e-9;

export function samePt(a, b, eps = EPS) {
  return Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps;
}

/** Returns a copy of the ring in CCW order. */
export function ensureCCW(points) {
  const pts = points.map((p) => [p[0], p[1]]);
  return polygonArea(pts) < 0 ? pts.reverse() : pts;
}

/** Remove consecutive duplicate points (and a repeated closing point). */
export function dedupeRing(points) {
  const out = [];
  for (const p of points) if (!out.length || !samePt(out[out.length - 1], p)) out.push([p[0], p[1]]);
  while (out.length > 1 && samePt(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Validate a candidate polygon: >=3 distinct points, non-zero area, no self-intersection. Returns error string or null. */
export function polygonProblem(points) {
  const pts = dedupeRing(points);
  if (pts.length < 3) return 'A region needs at least 3 distinct points';
  if (Math.abs(polygonArea(pts)) < 1e-9) return 'Region has zero area';
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      if (properCross(pts[i], pts[(i + 1) % n], pts[j], pts[(j + 1) % n])) return 'Region outline intersects itself';
    }
  }
  return null;
}

function properCross(a, b, c, d) {
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
  const eps = 1e-12;
  return ((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps));
}

/** Create a new default material (does not add it). */
export function makeMaterial(model, overrides = {}) {
  const n = model.materials.length;
  const used = new Set(model.materials.map((m) => String(m.color).toLowerCase()));
  let color = null;
  for (let i = 0; i < 8 && !color; i++) if (!used.has(materialColor(i).toLowerCase())) color = materialColor(i);
  if (!color) color = hslHex((n * 47) % 360, 0.45, 0.68); // palette exhausted: golden-angle-ish hue walk
  return defaultMaterial({ id: newId('M', model.materials), name: `Material ${n + 1}`, color, ...overrides });
}

function hslHex(h, s, l) {
  const f = (n) => { const k = (n + h / 30) % 12, a = s * Math.min(l, 1 - l); return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)))); };
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/**
 * Add a region from a ring (re-oriented CCW). Material defaults to `materialId`, else the first material;
 * a default material is created when the model has none. Conformity with neighbours is enforced.
 */
export function addRegion(model, points, { materialId = null, name = null } = {}) {
  const ring = ensureCCW(dedupeRing(points));
  if (!model.materials.length) model.materials.push(makeMaterial(model, { name: 'Soil' }));
  const mid = materialId && model.materials.some((m) => m.id === materialId) ? materialId : model.materials[0].id;
  const id = newId('R', model.regions);
  const region = { id, name: name || `Region ${model.regions.length + 1}`, points: ring, materialId: mid };
  model.regions.push(region);
  conformAll(model);
  return region;
}

export function addRectangleRegion(model, p1, p2, opts) {
  const [x1, y1] = p1, [x2, y2] = p2;
  return addRegion(model, [[x1, y1], [x2, y1], [x2, y2], [x1, y2]], opts);
}

export function addLine(model, points) {
  const pts = dedupeOpen(points);
  const line = { id: newId('L', model.lines), points: pts };
  model.lines.push(line);
  conformAll(model);
  return line;
}

function dedupeOpen(points) {
  const out = [];
  for (const p of points) if (!out.length || !samePt(out[out.length - 1], p)) out.push([p[0], p[1]]);
  return out;
}

/**
 * Make all rings conform: any model vertex that lies in the interior of another ring's edge is inserted into
 * that ring, so neighbouring regions share identical vertices. Returns the number of vertices inserted.
 */
export function conformAll(model, eps = 1e-7) {
  let inserted = splitCrossings(model, eps);
  const rings = [];
  for (const r of model.regions) rings.push({ pts: r.points, closed: true });
  for (const l of model.lines) rings.push({ pts: l.points, closed: false });
  const all = [];
  for (const rg of rings) for (const p of rg.pts) all.push(p);
  for (const rg of rings) {
    for (let guard = 0; guard < 10000; guard++) {
      const pts = rg.pts, n = pts.length;
      let did = false;
      for (let i = 0; i < (rg.closed ? n : n - 1) && !did; i++) {
        const a = pts[i], b = pts[(i + 1) % n];
        const hits = [];
        for (const v of all) {
          if (samePt(v, a, eps) || samePt(v, b, eps)) continue;
          const pr = projectOnSegment(v, a, b);
          if (pr.dist <= eps && pr.t > 0 && pr.t < 1) hits.push({ t: pr.t, v });
        }
        if (hits.length) {
          hits.sort((p, q) => p.t - q.t);
          const uniq = [];
          for (const h of hits) if (!uniq.length || !samePt(uniq[uniq.length - 1].v, h.v, eps)) uniq.push(h);
          pts.splice(i + 1, 0, ...uniq.map((h) => [h.v[0], h.v[1]]));
          inserted += uniq.length;
          did = true;
        }
      }
      if (!did) break;
    }
  }
  return inserted;
}

/** Insert vertices where region edges / internal lines properly cross each other. Returns insertions. */
function splitCrossings(model, eps) {
  const segs = [];
  for (const r of model.regions) for (let i = 0; i < r.points.length; i++) segs.push([r.points[i], r.points[(i + 1) % r.points.length]]);
  for (const l of model.lines) for (let i = 0; i < l.points.length - 1; i++) segs.push([l.points[i], l.points[i + 1]]);
  const pts = [];
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const [a, b] = segs[i], [c, d] = segs[j];
      const p = segIntersect(a, b, c, d);
      if (!p) continue;
      const ends = [a, b, c, d];
      if (ends.every((e) => !samePt(e, p, eps))) pts.push(p); // crossing in the interior of both
      else if (!(samePt(a, p, eps) || samePt(b, p, eps)) || !(samePt(c, p, eps) || samePt(d, p, eps))) pts.push(p); // T-junction
    }
  }
  let n = 0;
  for (const p of pts) n += insertVertexAt(model, [cleanNum(p[0]), cleanNum(p[1])], eps);
  return n;
}

/** Insert point p into every ring edge that passes through it (within eps). Returns count of insertions. */
export function insertVertexAt(model, p, eps = 1e-7) {
  let count = 0;
  const doRing = (pts, closed) => {
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      if (samePt(p, a, eps) || samePt(p, b, eps)) continue;
      const pr = projectOnSegment(p, a, b);
      if (pr.dist <= eps && pr.t > 0 && pr.t < 1) { pts.splice(i + 1, 0, [p[0], p[1]]); count++; return; }
    }
  };
  for (const r of model.regions) doRing(r.points, true);
  for (const l of model.lines) doRing(l.points, false);
  return count;
}

function mapPoints(model, fn) {
  const mapArr = (arr) => { for (let i = 0; i < arr.length; i++) arr[i] = fn(arr[i]); };
  for (const r of model.regions) mapArr(r.points);
  for (const l of model.lines) mapArr(l.points);
  for (const ld of model.loads || []) { if (ld.p) ld.p = fn(ld.p); if (ld.p1) ld.p1 = fn(ld.p1); if (ld.p2) ld.p2 = fn(ld.p2); }
  for (const b of model.boundaries || []) {
    const t = b.target || {};
    if (t.p) t.p = fn(t.p);
    if (t.p1) t.p1 = fn(t.p1);
    if (t.p2) t.p2 = fn(t.p2);
  }
  if (model.water?.phreatic) mapArr(model.water.phreatic);
}

/** Move every vertex that coincides with `from` (regions, lines, loads, BCs, phreatic line) to `to`. */
export function moveVertexEverywhere(model, from, to, eps = 1e-7) {
  const f = [from[0], from[1]], t = [to[0], to[1]];
  mapPoints(model, (p) => (samePt(p, f, eps) ? [t[0], t[1]] : p));
}

/**
 * Delete the vertex at `pt` from every region/line containing it. Refuses (returns false) if a region would drop
 * below 3 vertices or a line below 2.
 */
export function deleteVertexEverywhere(model, pt, eps = 1e-7) {
  for (const r of model.regions) if (r.points.some((p) => samePt(p, pt, eps)) && r.points.filter((p) => !samePt(p, pt, eps)).length < 3) return false;
  for (const l of model.lines) if (l.points.some((p) => samePt(p, pt, eps)) && l.points.filter((p) => !samePt(p, pt, eps)).length < 2) return false;
  for (const r of model.regions) r.points = r.points.filter((p) => !samePt(p, pt, eps));
  for (const l of model.lines) l.points = l.points.filter((p) => !samePt(p, pt, eps));
  return true;
}

export function deleteRegion(model, id) {
  model.regions = model.regions.filter((r) => r.id !== id);
  for (const s of model.stages || []) s.activeRegions = (s.activeRegions || []).filter((x) => x !== id);
}
export function deleteLine(model, id) { model.lines = model.lines.filter((l) => l.id !== id); }
export function deleteLoad(model, id) {
  model.loads = model.loads.filter((l) => l.id !== id);
  for (const s of model.stages || []) s.activeLoads = (s.activeLoads || []).filter((x) => x !== id);
}
export function deleteBoundary(model, id) { model.boundaries = model.boundaries.filter((b) => b.id !== id); }
export function deleteMaterial(model, id) {
  model.materials = model.materials.filter((m) => m.id !== id);
  for (const r of model.regions) if (r.materialId === id) r.materialId = null;
}

/** Add an automatic-fixity boundary unless one exists. Returns the boundary or null if already present. */
export function addAutoFixity(model) {
  if (model.boundaries.some((b) => b.target?.kind === 'auto')) return null;
  const b = { id: newId('B', model.boundaries), type: 'fixity', target: { kind: 'auto' } };
  model.boundaries.push(b);
  return b;
}

export function addFixSegment(model, p1, p2, fixX, fixY) {
  const b = { id: newId('B', model.boundaries), type: 'fixity', target: { kind: 'segment', p1: [...p1], p2: [...p2] }, fixX: !!fixX, fixY: !!fixY };
  model.boundaries.push(b);
  return b;
}
export function addFixPoint(model, p, fixX, fixY) {
  const b = { id: newId('B', model.boundaries), type: 'fixity', target: { kind: 'point', p: [...p] }, fixX: !!fixX, fixY: !!fixY };
  model.boundaries.push(b);
  return b;
}
export function addPointLoad(model, p, fx, fy) {
  const l = { id: newId('P', model.loads), type: 'point', p: [...p], fx, fy };
  model.loads.push(l);
  return l;
}
export function addDistLoad(model, p1, p2, qx1, qy1, qx2, qy2) {
  const l = { id: newId('Q', model.loads), type: 'distributed', p1: [...p1], p2: [...p2], qx1, qy1, qx2, qy2 };
  model.loads.push(l);
  return l;
}

/** Horizontal phreatic line at height y spanning the model's x-extent. */
export function horizontalPhreatic(model, y) {
  const pts = [];
  for (const r of model.regions) pts.push(...r.points);
  if (!pts.length) return [[0, y], [10, y]];
  const b = bbox(pts);
  return [[cleanNum(b.xmin), y], [cleanNum(b.xmax), y]];
}

/** Remove references to unknown regions/loads from stages (e.g., after undo/delete). */
export function pruneStageRefs(model) {
  const rids = new Set(model.regions.map((r) => r.id)), lids = new Set(model.loads.map((l) => l.id));
  for (const s of model.stages || []) {
    s.activeRegions = (s.activeRegions || []).filter((x) => rids.has(x));
    s.activeLoads = (s.activeLoads || []).filter((x) => lids.has(x));
  }
}

/** Replace contents of `target` object with those of `source` in place (keeps object identity). */
export function replaceInPlace(target, source) {
  for (const k of Object.keys(target)) delete target[k];
  Object.assign(target, source);
}
