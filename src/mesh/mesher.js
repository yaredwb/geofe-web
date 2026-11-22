// Mesher: model -> finite element mesh (T3 / T6). DOM-free; see ARCHITECTURE.md ("Mesh format").
//
// generateMesh(model, opts) builds a planar straight-line graph from the region polygons and internal
// lines, discretises it, and runs a constrained Delaunay refinement (Ruppert/Ungor) with a size field.
// Triangles are classified by region, optionally smoothed, converted to T6 and renumbered with RCM.
import { polygonArea, pointInPolygon, bbox } from '../core/geom.js';
import { buildPSLG, findAcuteApexes } from './pslg.js';
import { makeSizeField } from './sizefield.js';
import { buildTriangulation } from './refine.js';
import { extractTriangles, smoothMesh, toQuadratic, rcmOrdering, triangleMetrics } from './postprocess.js';

export { bandwidth } from './postprocess.js';

export const MESH_DEFAULTS = {
  minAngle: 25,        // degrees, target minimum angle of the Delaunay refinement
  sizeFactor: 0.76,    // triangle is "too big" when circumradius > sizeFactor * h  (calibrated: mean edge ~ h)
  grading: 0.4,        // size-field growth rate away from refinement features
  smoothPasses: 4,     // smart-Laplacian passes (0 disables)
  maxElements: 600000, // refuse to generate meshes estimated to be larger than this
};

/** Collect points that must be mesh vertices so loads and fixities land on nodes. */
function collectFeaturePoints(model) {
  const pts = [];
  for (const l of model.loads || []) {
    if (l.type === 'point' && l.p) pts.push(l.p);
    else if (l.type === 'distributed') { if (l.p1) pts.push(l.p1); if (l.p2) pts.push(l.p2); }
  }
  for (const b of model.boundaries || []) {
    const t = b.target;
    if (!t) continue;
    if (t.kind === 'point' && t.p) pts.push(t.p);
    else if (t.kind === 'segment') { if (t.p1) pts.push(t.p1); if (t.p2) pts.push(t.p2); }
  }
  return pts;
}

/** Problem with a region outline that makes it unmeshable (self-intersection), or null. */
function outlineProblem(points) {
  const pts = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
  }
  while (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const n = pts.length;
  if (n < 4) return null;
  const bb = bbox(pts);
  const scale = Math.max(bb.xmax - bb.xmin, bb.ymax - bb.ymin, 1e-300);
  const eps = 1e-12 * scale * scale;
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j], d = pts[(j + 1) % n];
      if (Math.max(a[0], b[0]) < Math.min(c[0], d[0]) || Math.max(c[0], d[0]) < Math.min(a[0], b[0])) continue;
      if (Math.max(a[1], b[1]) < Math.min(c[1], d[1]) || Math.max(c[1], d[1]) < Math.min(a[1], b[1])) continue;
      const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
      if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) {
        return 'Region outline intersects itself';
      }
    }
  }
  return null;
}

/**
 * Local feature size: for every PSLG segment, the distance to the nearest segment it does not share a vertex with
 * (sampled at its end points and midpoint). Where that is below 0.7*meshSize the size field is limited to it.
 */
function addFeatureSizes(pslg, sizeField, meshSize, minGap) {
  const { x, y, segs } = pslg;
  const S = segs.length;
  if (S < 2 || S > 3000) return;
  const lim = 0.7 * meshSize;
  const pd = (px, py, a, b) => {
    const ax = x[a], ay = y[a], dx = x[b] - ax, dy = y[b] - ay;
    const L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const bxl = new Float64Array(S), bxh = new Float64Array(S), byl = new Float64Array(S), byh = new Float64Array(S);
  for (let s = 0; s < S; s++) {
    const [a, b] = segs[s];
    bxl[s] = Math.min(x[a], x[b]); bxh[s] = Math.max(x[a], x[b]);
    byl[s] = Math.min(y[a], y[b]); byh[s] = Math.max(y[a], y[b]);
  }
  for (let s = 0; s < S; s++) {
    const [a, b] = segs[s];
    const pts = [x[a], y[a], x[b], y[b], 0.5 * (x[a] + x[b]), 0.5 * (y[a] + y[b])];
    let dmin = lim;
    for (let t = 0; t < S; t++) {
      if (t === s) continue;
      const [c, d] = segs[t];
      if (c === a || c === b || d === a || d === b) continue;
      if (bxl[t] - dmin > bxh[s] || bxh[t] + dmin < bxl[s] || byl[t] - dmin > byh[s] || byh[t] + dmin < byl[s]) continue;
      for (let k = 0; k < 6; k += 2) {
        const dd = pd(pts[k], pts[k + 1], c, d);
        if (dd < dmin) dmin = dd;
      }
    }
    if (dmin < lim && dmin > minGap) sizeField.addSegment(x[a], y[a], x[b], y[b], dmin, 0);
  }
}

/**
 * Generate a mesh for the model.
 * @param {object} model
 * @param {object} [opts]
 * @param {number} [opts.meshSize]     overrides model.settings.meshSize (alias: size)
 * @param {'T3'|'T6'} [opts.type]      overrides model.settings.elementType (alias: elementType)
 * @param {Array}  [opts.refine]       [{p:[x,y], size, radius}] or [{p1,p2,size,radius}] local size features
 * @param {number} [opts.minAngle]     target minimum angle in degrees (default 25)
 * @param {number} [opts.smoothPasses] Laplacian smoothing passes (default 4)
 * @param {number} [opts.grading]      size-field gradient (default 0.4)
 * @returns {{type, nodes, elements, nen, elementRegion, boundaryEdges, stats}}
 */
export function generateMesh(model, opts = {}) {
  const o = { ...MESH_DEFAULTS, ...opts };
  const settings = model.settings || {};
  const meshSize = Number(o.meshSize ?? o.size ?? settings.meshSize ?? 2);
  const type = o.type ?? o.elementType ?? settings.elementType ?? 'T6';
  if (!(meshSize > 0) || !Number.isFinite(meshSize)) throw new Error('Mesh generation failed: meshSize must be a positive number');
  if (type !== 'T3' && type !== 'T6') throw new Error(`Mesh generation failed: unknown element type "${type}"`);
  const regions = model.regions || [];
  // self-intersecting outlines have no well-defined interior: report them instead of meshing them by even-odd luck
  for (const r of regions) {
    const problem = Array.isArray(r.points) ? outlineProblem(r.points) : null;
    if (problem) throw new Error(`Mesh generation failed: region ${r.id ?? '?'}: ${problem}`);
  }
  const valid = regions.map((r) => Array.isArray(r.points) && r.points.length >= 3 && Math.abs(polygonArea(r.points)) > 0);
  if (!valid.some(Boolean)) throw new Error('Mesh generation failed: the model has no valid regions');

  // geometry extent and tolerance
  const allPts = [];
  regions.forEach((r, i) => { if (valid[i]) allPts.push(...r.points); });
  for (const l of model.lines || []) if (Array.isArray(l.points)) allPts.push(...l.points);
  const bb = bbox(allPts);
  const diag = Math.hypot(bb.xmax - bb.xmin, bb.ymax - bb.ymin);
  const tol = o.geomTol ?? 1e-8 * diag; // floating-point noise level (vertex identity)

  // Size field (user refinement first, so that the snap tolerance can stay well below the smallest requested size).
  const sizeField = makeSizeField(meshSize, o.refine, o.grading);
  const hminUser = sizeField.hmin;
  // Snap tolerance: vertices closer than 1.5*snapTol are merged and a vertex within snapTol of an edge splits it, so
  // coordinates typed with rounding (3.333333 vs 3.33333333) or loads/lines a hair off an edge give a conforming mesh
  // rather than a crack or slivers. Kept far below the element size so the geometry change is invisible.
  const snapTol = o.snapTol ?? Math.max(tol, Math.min(Math.max(1e-6 * diag, 2e-3 * meshSize), 0.02 * hminUser, 1e-3 * diag));

  // region lookup: smallest containing polygon wins (handles nested/overlapping regions deterministically)
  const polys = [];
  regions.forEach((r, i) => {
    if (!valid[i]) return;
    polys.push({ i, pts: r.points, area: Math.abs(polygonArea(r.points)), bb: bbox(r.points) });
  });
  const regionOf = (x, y) => {
    let best = -1, bestArea = Infinity;
    for (const p of polys) {
      if (x < p.bb.xmin || x > p.bb.xmax || y < p.bb.ymin || y > p.bb.ymax) continue;
      if (p.area < bestArea && pointInPolygon([x, y], p.pts)) { best = p.i; bestArea = p.area; }
    }
    return best;
  };

  // PSLG
  const pslg = buildPSLG(model, collectFeaturePoints(model), tol, snapTol, { gapWarn: 0.05 * meshSize });
  const apex = findAcuteApexes(pslg.x, pslg.y, pslg.segs);

  // size field: grading away from segments much shorter than meshSize ...
  for (const [a, b] of pslg.segs) {
    const L = Math.hypot(pslg.x[b] - pslg.x[a], pslg.y[b] - pslg.y[a]);
    if (L < 0.7 * meshSize && L > 1e-6 * diag) sizeField.addSegment(pslg.x[a], pslg.y[a], pslg.x[b], pslg.y[b], L, 0);
  }
  // ... and away from places where two non-adjacent segments are close (thin layers, narrow necks): the local
  // feature size limits the element size there, otherwise the layer is filled with slivers.
  addFeatureSizes(pslg, sizeField, meshSize, Math.max(snapTol, 1e-6 * diag));

  // element count estimate (guard against absurd requests, set the insertion cap)
  const totalArea = polys.reduce((s, p) => s + p.area, 0);
  let est = totalArea / (0.433 * meshSize * meshSize);
  if (!sizeField.constant) {
    const N = 40;
    const dx = (bb.xmax - bb.xmin) / N, dy = (bb.ymax - bb.ymin) / N;
    let s = 0, inside = 0;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = bb.xmin + (i + 0.5) * dx, y = bb.ymin + (j + 0.5) * dy;
        if (regionOf(x, y) < 0) continue;
        inside++;
        const h = sizeField.at(x, y);
        s += (dx * dy) / (0.433 * h * h);
      }
    }
    if (inside) est = Math.max(est, s);
  }
  if (est > o.maxElements) {
    throw new Error(`Mesh generation refused: about ${Math.round(est)} elements would be needed; increase the mesh size (limit ${o.maxElements}).`);
  }

  const built = buildTriangulation(pslg, apex, sizeField, {
    minAngle: o.minAngle,
    sizeFactor: o.sizeFactor,
    maxInsertions: o.maxInsertions ?? Math.round(4 * est + 20000),
    regionOf,
    meshSize,
    diag,
    shellUnit: meshSize,
  });

  const ex = extractTriangles(built.tri, built.vfixed);
  if (ex.T.length === 0) throw new Error('Mesh generation failed: no elements were created');
  if (o.smoothPasses > 0) smoothMesh(ex.X, ex.Y, ex.T, ex.fixed, o.smoothPasses);

  // element connectivity and node numbering
  let X = ex.X, Y = ex.Y, E = ex.T, nen = 3;
  const nCorner = ex.X.length;
  if (type === 'T6') {
    const q = toQuadratic(ex.X, ex.Y, ex.T);
    X = q.X; Y = q.Y; E = q.E; nen = 6;
  }
  const nN = X.length;
  const nEl = ex.T.length / 3;
  const perm = rcmOrdering(nN, E, nen);

  // element order follows the smallest new node index (locality for assembly), ties by creation order
  const keyMin = new Int32Array(nEl);
  for (let e = 0; e < nEl; e++) {
    let m = nN;
    for (let i = 0; i < 3; i++) { const v = perm[E[e * nen + i]]; if (v < m) m = v; }
    keyMin[e] = m;
  }
  const eorder = Array.from({ length: nEl }, (_, i) => i).sort((p, q) => keyMin[p] - keyMin[q] || p - q);

  const nodes = new Float64Array(2 * nN);
  for (let v = 0; v < nN; v++) { nodes[2 * perm[v]] = X[v]; nodes[2 * perm[v] + 1] = Y[v]; }
  const elements = new Int32Array(nen * nEl);
  const elementRegion = new Int32Array(nEl);
  for (let k = 0; k < nEl; k++) {
    const e = eorder[k];
    for (let i = 0; i < nen; i++) elements[k * nen + i] = perm[E[e * nen + i]];
    elementRegion[k] = ex.R[e];
  }

  // outer boundary: directed corner edges whose reverse edge does not exist
  const dirSet = new Set();
  for (let k = 0; k < nEl; k++) {
    for (let i = 0; i < 3; i++) {
      const a = elements[k * nen + i], b = elements[k * nen + (i + 1) % 3];
      dirSet.add(a * nN + b);
    }
  }
  const boundaryEdges = [];
  for (let k = 0; k < nEl; k++) {
    for (let i = 0; i < 3; i++) {
      const a = elements[k * nen + i], b = elements[k * nen + (i + 1) % 3];
      if (!dirSet.has(b * nN + a)) boundaryEdges.push([a, b]);
    }
  }

  const mesh = { type, nodes, elements, nen, elementRegion, boundaryEdges, stats: null };
  const q = meshQuality(mesh);
  mesh.stats = {
    nNodes: nN,
    nElements: nEl,
    minAngle: q.minAngle,
    maxAspect: q.maxAspect,
    maxAngle: q.maxAngle,
    nCornerNodes: nCorner,
    capped: built.capped,
    skippedTriangles: built.nSkipped,
    warnings: [...pslg.warnings],
  };
  mesh.snaps = pslg.snaps; // feature/line points moved onto a nearby edge: [{from:[x,y], to:[x,y]}]
  if (built.capped) mesh.stats.warnings.push('Refinement stopped at the insertion limit; some elements may be larger or of lower quality than requested.');
  if (q.minAngle < 5) {
    mesh.stats.warnings.push(`Mesh contains poorly shaped elements (min angle ${q.minAngle.toFixed(2)} deg); a region may be thinner than the ` +
      'target element size or two geometry features nearly coincide - reduce the mesh size locally, add a refinement feature or clean up the geometry.');
  }
  return mesh;
}

/**
 * Quality metrics of a mesh (corner nodes only). Angles in degrees; aspect = longest edge * perimeter /
 * (4 sqrt(3) * area), which is 1 for an equilateral triangle.
 */
export function meshQuality(mesh) {
  const { nodes, elements, nen } = mesh;
  const nEl = elements.length / nen;
  let minAngle = Infinity, maxAngle = 0, maxAspect = 0, minArea = Infinity, maxArea = 0, totalArea = 0, nInverted = 0, sumMin = 0;
  for (let e = 0; e < nEl; e++) {
    const a = elements[e * nen], b = elements[e * nen + 1], c = elements[e * nen + 2];
    const m = triangleMetrics(nodes[2 * a], nodes[2 * a + 1], nodes[2 * b], nodes[2 * b + 1], nodes[2 * c], nodes[2 * c + 1]);
    if (m.area <= 0) nInverted++;
    if (m.minAngle < minAngle) minAngle = m.minAngle;
    if (m.maxAngle > maxAngle) maxAngle = m.maxAngle;
    if (m.aspect > maxAspect) maxAspect = m.aspect;
    if (m.area < minArea) minArea = m.area;
    if (m.area > maxArea) maxArea = m.area;
    totalArea += m.area;
    sumMin += m.minAngle;
  }
  return {
    nElements: nEl,
    minAngle: nEl ? minAngle : 0,
    maxAngle,
    meanMinAngle: nEl ? sumMin / nEl : 0,
    maxAspect,
    minArea: nEl ? minArea : 0,
    maxArea,
    totalArea,
    nInverted,
  };
}

/**
 * Nodes (including T6 mid-side nodes) within `tol` of segment p1-p2, ordered along the segment.
 * Default tol = 1e-6 * max(1, segment length).
 * @returns {number[]} node indices
 */
export function findNodesOnSegment(mesh, p1, p2, tol) {
  const { nodes } = mesh;
  const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
  const L2 = dx * dx + dy * dy;
  const L = Math.sqrt(L2);
  const tl = tol ?? 1e-6 * Math.max(1, L);
  const hits = [];
  const n = nodes.length / 2;
  for (let i = 0; i < n; i++) {
    const px = nodes[2 * i] - p1[0], py = nodes[2 * i + 1] - p1[1];
    let t = L2 > 0 ? (px * dx + py * dy) / L2 : 0;
    const tc = t < 0 ? 0 : t > 1 ? 1 : t;
    const ex = px - tc * dx, ey = py - tc * dy;
    if (ex * ex + ey * ey <= tl * tl) hits.push([t, i]);
  }
  hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return hits.map((h) => h[1]);
}

/** Index of the node nearest to p = [x, y] (-1 for an empty mesh). */
export function findNearestNode(mesh, p) {
  const { nodes } = mesh;
  const n = nodes.length / 2;
  let best = -1, bd = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = nodes[2 * i] - p[0], dy = nodes[2 * i + 1] - p[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
