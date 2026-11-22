// Constrained Delaunay triangulation by Ruppert/Chew-style Delaunay refinement (DOM-free).
//
// Pipeline (see buildTriangulation):
//   1. discretise every PSLG segment at the local target size and triangulate all vertices (Delaunay);
//   2. split encroached segments (vertex inside the diametral circle) until every segment is a
//      strongly-Delaunay edge, i.e. is present in the triangulation without any explicit edge recovery;
//   3. label connected triangle groups (separated by segments) with their region / "outside";
//   4. refine triangles that are too large or have a small angle by inserting circumcentres/off-centres
//      (Ungor); a point that would encroach a segment splits that segment instead.
// Termination is guaranteed by size and edge-length floors plus an insertion cap.
import { Triangulation, PREP_OK } from './triangulation.js';

const KEY = 67108864; // 2^26
function segKey(a, b) { return a < b ? a * KEY + b : b * KEY + a; }

/**
 * @param {object} pslg    {x[], y[], segs[[a,b]], featureVerts:Set, onSegment}
 * @param {Uint8Array} apex acute-apex flags per PSLG vertex
 * @param {object} sizeField from makeSizeField
 * @param {object} P params: {minAngle, sizeFactor, maxInsertions, regionOf(x,y), meshSize, diag, shellUnit}
 */
export function buildTriangulation(pslg, apex, sizeField, P) {
  const { x: px, y: py, segs: atomic } = pslg;
  const nPslg = px.length;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < nPslg; i++) {
    if (px[i] < xmin) xmin = px[i];
    if (px[i] > xmax) xmax = px[i];
    if (py[i] < ymin) ymin = py[i];
    if (py[i] > ymax) ymax = py[i];
  }
  const cx = 0.5 * (xmin + xmax), cy = 0.5 * (ymin + ymax);
  const half = Math.max(0.5 * (xmax - xmin), 0.5 * (ymax - ymin), 1e-12);
  const diag = P.diag;

  const tri = new Triangulation(Math.max(1024, nPslg * 8), 4096);
  tri.initSuper(cx, cy, half);
  tri.dupTol2 = (1e-11 * diag) ** 2;

  // Vertex attribute arrays (index = triangulation vertex id; 0..2 are the super vertices).
  const vfixed = [1, 1, 1];
  const vapex = [0, 0, 0];
  for (let i = 0; i < nPslg; i++) {
    tri.addVertex(px[i], py[i]);
    vfixed.push(1);
    vapex.push(apex[i]);
  }

  // ---- Segment bookkeeping -------------------------------------------------------------------
  const segA = [], segB = [], segAlive = [], inQ = [];
  const segMap = new Map();
  function addSeg(a, b) {
    const id = segA.length;
    segA.push(a); segB.push(b); segAlive.push(1); inQ.push(0);
    segMap.set(segKey(a, b), id);
    return id;
  }

  // ---- Step 1: discretise PSLG segments ------------------------------------------------------
  const hconst = sizeField.constant ? sizeField.meshSize : 0;
  function subdivisionParams(ax, ay, bx, by) {
    const L = Math.hypot(bx - ax, by - ay);
    if (hconst) {
      const n = Math.max(1, Math.round(L / hconst));
      const ts = [];
      for (let k = 1; k < n; k++) ts.push(k / n);
      return ts;
    }
    const M = Math.min(4000, Math.max(16, Math.ceil(L / (0.25 * sizeField.hmin))));
    const cum = new Float64Array(M + 1);
    for (let i = 0; i < M; i++) {
      const s = (i + 0.5) / M;
      cum[i + 1] = cum[i] + (L / M) / sizeField.at(ax + s * (bx - ax), ay + s * (by - ay));
    }
    const I = cum[M];
    const n = Math.max(1, Math.round(I));
    const ts = [];
    let i = 0;
    for (let k = 1; k < n; k++) {
      const target = (k * I) / n;
      while (i < M - 1 && cum[i + 1] < target) i++;
      const f = (target - cum[i]) / (cum[i + 1] - cum[i] || 1);
      ts.push((i + f) / M);
    }
    return ts;
  }

  for (const [a0, b0] of atomic) {
    const a = a0 + 3, b = b0 + 3;
    const ax = tri.xs[a], ay = tri.ys[a], bx = tri.xs[b], by = tri.ys[b];
    const ts = subdivisionParams(ax, ay, bx, by);
    let prev = a;
    for (const t of ts) {
      const v = tri.addVertex(ax + t * (bx - ax), ay + t * (by - ay));
      vfixed.push(1); vapex.push(0);
      addSeg(prev, v);
      prev = v;
    }
    addSeg(prev, b);
  }

  // ---- Step 1b: Delaunay triangulation of all vertices (spatially sorted insertion) ----------
  {
    const n = tri.nv - 3;
    const order = new Array(n);
    for (let i = 0; i < n; i++) order[i] = i + 3;
    const cell = Math.max(Math.sqrt(((xmax - xmin) * (ymax - ymin) || half * half) / Math.max(1, n)), 1e-12);
    const row = (v) => Math.floor((tri.ys[v] - ymin) / cell);
    order.sort((p, q) => {
      const rp = row(p), rq = row(q);
      if (rp !== rq) return rp - rq;
      const d = tri.xs[p] - tri.xs[q];
      if (d !== 0) return (rp & 1) ? -d : d;
      return p - q;
    });
    for (const v of order) {
      const st = tri.insertVertex(v, tri.last);
      if (st !== PREP_OK) throw new Error(`Mesh generation failed: could not insert geometry vertex (${tri.xs[v]}, ${tri.ys[v]})`);
    }
  }

  // ---- Segment encroachment / splitting -------------------------------------------------------
  const queue = [];
  let qHead = 0;
  function enqueue(s) {
    if (segAlive[s] && !inQ[s]) { inQ[s] = 1; queue.push(s); }
  }
  // segments shorter than this are never split (guards against infinite refinement at tiny features)
  const minSplitLen = Math.max(1e-6 * diag, 2e-4 * sizeField.hmin);
  let nIns = 0;
  let capped = false;
  let phase2 = false;
  // bookkeeping for label repair after segment-split chains (phase 2)
  let recent = [];          // [triangle id, generation] created by segment splits since the last repair
  let dirty = false;        // a segment was destroyed (and must be restored) in the current chain
  let relabelStamp = 0;
  const recentMark = [];

  function isEncroached(s) {
    const a = segA[s], b = segB[s];
    const ap = tri.edgeApexes(a, b);
    if (!ap) { dirty = true; return true; } // missing from the triangulation => something is inside its diametral circle
    const ax = tri.xs[a], ay = tri.ys[a], bx = tri.xs[b], by = tri.ys[b];
    const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
    for (let k = 0; k < 2; k++) {
      const c = ap[k];
      if (c < 3) continue;
      const cx_ = tri.xs[c], cy_ = tri.ys[c];
      const dot = (cx_ - ax) * (cx_ - bx) + (cy_ - ay) * (cy_ - by);
      if (dot < -1e-10 * L2) return true;
    }
    return false;
  }

  function splitSegment(s) {
    if (nIns >= P.maxInsertions) { capped = true; return false; }
    const a = segA[s], b = segB[s];
    const ax = tri.xs[a], ay = tri.ys[a], bx = tri.xs[b], by = tri.ys[b];
    const L = Math.hypot(bx - ax, by - ay);
    if (L <= minSplitLen) return false;
    let t = 0.5;
    if (vapex[a] !== vapex[b]) {
      // concentric-shell rule: split at a power-of-two distance from the acute apex
      const u = P.shellUnit;
      const k = Math.round(Math.log2((0.5 * L) / u));
      const r = u * 2 ** k;
      const f = r / L;
      if (f > 0.2 && f < 0.8) t = vapex[a] ? f : 1 - f;
    }
    const mx = ax + t * (bx - ax), my = ay + t * (by - ay);
    const st = tri.prepare(mx, my, tri.vtri[a]);
    if (st !== PREP_OK) return false;
    const touched = [];
    for (let q = 0; q < tri.cav.length; q++) {
      const tt = tri.cav[q];
      for (let i = 0; i < 3; i++) {
        const u = tri.tv[3 * tt + (i + 1) % 3], w = tri.tv[3 * tt + (i + 2) % 3];
        const sid = segMap.get(segKey(u, w));
        if (sid !== undefined && sid !== s) touched.push(sid);
      }
    }
    const v = tri.addVertex(mx, my);
    vfixed.push(1); vapex.push(0);
    segMap.delete(segKey(a, b));
    segAlive[s] = 0;
    const s1 = addSeg(a, v), s2 = addSeg(v, b);
    tri.commit(v);
    nIns++;
    enqueue(s1); enqueue(s2);
    for (const sid of touched) enqueue(sid);
    if (phase2) {
      for (const t of tri.newTris) recent.push([t, tri.gen[t]]);
      considerAll(tri.newTris);
    }
    return true;
  }

  function processQueue() {
    while (qHead < queue.length) {
      const s = queue[qHead++];
      inQ[s] = 0;
      if (!segAlive[s]) continue;
      if (isEncroached(s)) {
        splitSegment(s); // may refuse (too short / insertion cap): the segment then stays as is
      }
      if (capped) break;
    }
    if (qHead >= queue.length || capped) {
      for (let i = qHead; i < queue.length; i++) inQ[queue[i]] = 0;
      queue.length = 0;
      qHead = 0;
    }
  }

  const nSeg0 = segA.length;
  for (let s = 0; s < nSeg0; s++) enqueue(s);
  processQueue();

  // every constrained segment must now be an edge of the triangulation
  for (let s = 0; s < segA.length; s++) {
    if (!segAlive[s]) continue;
    if (!tri.edgeApexes(segA[s], segB[s])) {
      const f = (v) => (+v.toPrecision(8)).toString();
      const a = segA[s], b = segB[s];
      throw new Error(`Mesh generation failed: could not recover the boundary segment (${f(tri.xs[a])}, ${f(tri.ys[a])})-(${f(tri.xs[b])}, ${f(tri.ys[b])}) ` +
        '(geometry too degenerate? look for vertices or edges that nearly coincide and merge them or move them apart)');
    }
  }

  // ---- Step 3: classify connected groups of triangles (separated by segments) ------------------
  // Region label of a set of triangles that form (part of) one connected group: the label of the
  // region containing the incentre of the group's triangle with the largest inradius, -1 if outside.
  function classifyGroup(list) {
    const { tv, xs, ys } = tri;
    let bestR = -1, bx = 0, by = 0;
    for (const u of list) {
      const a = tv[3 * u], b = tv[3 * u + 1], c = tv[3 * u + 2];
      // anything touching the super triangle is outside by definition
      if (a < 3 || b < 3 || c < 3) return -1;
      const la = Math.hypot(xs[b] - xs[c], ys[b] - ys[c]);
      const lb = Math.hypot(xs[c] - xs[a], ys[c] - ys[a]);
      const lc = Math.hypot(xs[a] - xs[b], ys[a] - ys[b]);
      const A2 = (xs[b] - xs[a]) * (ys[c] - ys[a]) - (ys[b] - ys[a]) * (xs[c] - xs[a]);
      const per = la + lb + lc;
      const r = per > 0 ? A2 / per : 0;
      if (r > bestR) {
        bestR = r;
        bx = (la * xs[a] + lb * xs[b] + lc * xs[c]) / per;
        by = (la * ys[a] + lb * ys[b] + lc * ys[c]) / per;
      }
    }
    return P.regionOf(bx, by);
  }

  {
    const { tv, tn, alive, label } = tri;
    const seen = new Uint8Array(tri.nt);
    const list = [];
    for (let t0 = 0; t0 < tri.nt; t0++) {
      if (!alive[t0] || seen[t0]) continue;
      list.length = 0;
      list.push(t0);
      seen[t0] = 1;
      for (let i = 0; i < list.length; i++) {
        const u = list[i];
        for (let e = 0; e < 3; e++) {
          const n = tn[3 * u + e];
          if (n < 0 || seen[n]) continue;
          const a = tv[3 * u + (e + 1) % 3], b = tv[3 * u + (e + 2) % 3];
          if (segMap.has(segKey(a, b))) continue;
          seen[n] = 1;
          list.push(n);
        }
      }
      const reg = classifyGroup(list);
      for (const u of list) label[u] = reg;
    }
  }

  // A segment split can destroy a neighbouring (encroached) segment, after which the labels inherited by the
  // new triangles are unreliable. Once all segments are restored, re-derive the labels of the triangles
  // created in the chain from their (still valid) old neighbours across non-segment edges.
  function relabelRecent() {
    const live = recent.filter(([t, g]) => tri.alive[t] && tri.gen[t] === g).map(([t]) => t);
    const stampId = ++relabelStamp;
    for (const t of live) recentMark[t] = stampId;
    const visited = new Set();
    for (const t0 of live) {
      if (visited.has(t0)) continue;
      const cluster = [t0];
      visited.add(t0);
      let oldLabel = null;
      let conflict = false;
      for (let i = 0; i < cluster.length; i++) {
        const u = cluster[i];
        for (let e = 0; e < 3; e++) {
          const n = tri.tn[3 * u + e];
          if (n < 0) continue;
          const a = tri.tv[3 * u + (e + 1) % 3], b = tri.tv[3 * u + (e + 2) % 3];
          if (segMap.has(segKey(a, b))) continue;
          if (recentMark[n] === stampId) {
            if (!visited.has(n)) { visited.add(n); cluster.push(n); }
          } else if (oldLabel === null) oldLabel = tri.label[n];
          else if (oldLabel !== tri.label[n]) conflict = true;
        }
      }
      const reg = oldLabel === null || conflict ? classifyGroup(cluster) : oldLabel;
      for (const u of cluster) tri.label[u] = reg;
    }
    considerAll(live);
    recent = [];
    dirty = false;
  }
  // ---- Step 4: quality / size refinement --------------------------------------------------------
  phase2 = true;
  recent = [];
  dirty = false;
  const theta = (P.minAngle * Math.PI) / 180;
  const B = 1 / (2 * Math.sin(theta));
  const offc = 0.475 * Math.sqrt((1 + Math.cos(theta)) / (1 - Math.cos(theta)));
  const f = P.sizeFactor;
  const qFloorFrac = 0.04;

  // max-heap on priority with FIFO tie-break
  const hP = [], hT = [], hG = [], hS = [];
  let seq = 0;
  const qg = [];
  function heapPush(prio, t) {
    let i = hP.length;
    hP.push(prio); hT.push(t); hG.push(tri.gen[t]); hS.push(seq++);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (hP[p] > hP[i] || (hP[p] === hP[i] && hS[p] < hS[i])) break;
      swap(i, p);
      i = p;
    }
  }
  function swap(i, j) {
    let tmp = hP[i]; hP[i] = hP[j]; hP[j] = tmp;
    tmp = hT[i]; hT[i] = hT[j]; hT[j] = tmp;
    tmp = hG[i]; hG[i] = hG[j]; hG[j] = tmp;
    tmp = hS[i]; hS[i] = hS[j]; hS[j] = tmp;
  }
  function heapPop() {
    const n = hP.length - 1;
    swap(0, n);
    const out = [hT.pop(), hG.pop()];
    hP.pop(); hS.pop();
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < n && (hP[l] > hP[m] || (hP[l] === hP[m] && hS[l] < hS[m]))) m = l;
      if (r < n && (hP[r] > hP[m] || (hP[r] === hP[m] && hS[r] < hS[m]))) m = r;
      if (m === i) break;
      swap(i, m);
      i = m;
    }
    return out;
  }

  function considerAll(list) {
    for (let i = 0; i < list.length; i++) consider(list[i]);
  }

  function consider(t) {
    if (!tri.alive[t] || tri.label[t] < 0) return;
    if (qg[t] === tri.gen[t]) return;
    const { tv, xs, ys } = tri;
    const a = tv[3 * t], b = tv[3 * t + 1], c = tv[3 * t + 2];
    const abx = xs[b] - xs[a], aby = ys[b] - ys[a];
    const acx = xs[c] - xs[a], acy = ys[c] - ys[a];
    const A2 = abx * acy - aby * acx;
    if (!(A2 > 0)) return;
    const la2 = (xs[b] - xs[c]) ** 2 + (ys[b] - ys[c]) ** 2;
    const lb2 = acx * acx + acy * acy;
    const lc2 = abx * abx + aby * aby;
    const lmin2 = Math.min(la2, lb2, lc2);
    const R = Math.sqrt(la2 * lb2 * lc2) / (2 * A2);
    const h = sizeField.at((xs[a] + xs[b] + xs[c]) / 3, (ys[a] + ys[b] + ys[c]) / 3);
    const sizeRatio = R / (f * h);
    let angleRatio = 0;
    if (lmin2 > (qFloorFrac * h) ** 2) angleRatio = (R / Math.sqrt(lmin2)) / B;
    const prio = Math.max(sizeRatio, angleRatio);
    if (prio > 1) {
      qg[t] = tri.gen[t];
      heapPush(prio, t);
    }
  }

  // initial scan
  for (let t = 0; t < tri.nt; t++) consider(t);

  // find the point to insert for bad triangle t (off-centre/circumcentre relative to shortest edge)
  const pt = [0, 0];
  function steinerPoint(t) {
    const { tv, xs, ys } = tri;
    const v0 = tv[3 * t], v1 = tv[3 * t + 1], v2 = tv[3 * t + 2];
    const ex = [xs[v1] - xs[v2], xs[v2] - xs[v0], xs[v0] - xs[v1]];
    const ey = [ys[v1] - ys[v2], ys[v2] - ys[v0], ys[v0] - ys[v1]];
    // edge i is opposite vertex i
    const l2 = [ex[0] ** 2 + ey[0] ** 2, ex[1] ** 2 + ey[1] ** 2, ex[2] ** 2 + ey[2] ** 2];
    let i = 0;
    if (l2[1] < l2[i]) i = 1;
    if (l2[2] < l2[i]) i = 2;
    const org = tv[3 * t + (i + 1) % 3], dest = tv[3 * t + (i + 2) % 3], apexV = tv[3 * t + i];
    const ox = xs[org], oy = ys[org];
    const dx = xs[dest] - ox, dy = ys[dest] - oy;
    const cx_ = xs[apexV] - ox, cy_ = ys[apexV] - oy;
    const D = 2 * (dx * cy_ - dy * cx_);
    const d2 = dx * dx + dy * dy, c2 = cx_ * cx_ + cy_ * cy_;
    let ux = (cy_ * d2 - dy * c2) / D;
    let uy = (dx * c2 - cx_ * d2) / D;
    const offx = 0.5 * dx - offc * dy;
    const offy = 0.5 * dy + offc * dx;
    if (offx * offx + offy * offy < ux * ux + uy * uy) { ux = offx; uy = offy; }
    pt[0] = ox + ux;
    pt[1] = oy + uy;
  }

  const enc = [];
  function collectEncroached(qx, qy) {
    enc.length = 0;
    for (let q = 0; q < tri.cav.length; q++) {
      const tt = tri.cav[q];
      for (let i = 0; i < 3; i++) {
        const u = tri.tv[3 * tt + (i + 1) % 3], w = tri.tv[3 * tt + (i + 2) % 3];
        const sid = segMap.get(segKey(u, w));
        if (sid === undefined) continue;
        const ax = tri.xs[u], ay = tri.ys[u], bx = tri.xs[w], by = tri.ys[w];
        const dot = (qx - ax) * (qx - bx) + (qy - ay) * (qy - by);
        const L2 = (bx - ax) ** 2 + (by - ay) ** 2;
        const nb = tri.tn[3 * tt + i];
        const interior = nb >= 0 && tri.mark[nb] === 2 * tri.curMark; // both sides in the cavity: it would be destroyed
        if ((dot < -1e-10 * L2 || interior) && !enc.includes(sid)) enc.push(sid);
      }
    }
  }

  let nSkipped = 0;
  while (hP.length) {
    if (nIns >= P.maxInsertions) { capped = true; break; }
    const [t, g] = heapPop();
    if (!tri.alive[t] || tri.gen[t] !== g) continue;
    qg[t] = -1;
    if (tri.label[t] < 0) continue;
    steinerPoint(t);
    const qx = pt[0], qy = pt[1];
    if (!Number.isFinite(qx) || !Number.isFinite(qy)) { nSkipped++; continue; }
    const st = tri.prepare(qx, qy, t);
    if (st !== PREP_OK) { nSkipped++; continue; }
    // all cavity triangles must belong to the same group as the triangle being refined
    const lab = tri.label[t];
    let ok = true;
    for (let q = 0; q < tri.cav.length; q++) if (tri.label[tri.cav[q]] !== lab) { ok = false; break; }
    collectEncroached(qx, qy);
    if (ok && enc.length === 0) {
      const v = tri.addVertex(qx, qy);
      vfixed.push(0); vapex.push(0);
      tri.commit(v);
      nIns++;
      considerAll(tri.newTris);
      continue;
    }
    // encroached (or the point left its group): split encroached segments instead
    const todo = enc.slice();
    let split = false;
    for (const s of todo) {
      if (!segAlive[s]) continue;
      if (splitSegment(s)) { split = true; processQueue(); }
    }
    if (split) {
      if (dirty) relabelRecent(); else recent = [];
      if (tri.alive[t] && tri.gen[t] === g) consider(t);
    } else {
      nSkipped++;
    }
  }

  return { tri, vfixed, capped, nSkipped, nInsertions: nIns, segMap };
}
