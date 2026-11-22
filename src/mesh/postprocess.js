// Mesh post-processing: extraction, smoothing, T6 conversion, RCM renumbering, quality (DOM-free).

/** Collect alive, in-domain triangles of the triangulation into compact arrays. */
export function extractTriangles(tri, vfixed) {
  const { tv, alive, label, xs, ys } = tri;
  const map = new Int32Array(tri.nv).fill(-1);
  let nT = 0;
  for (let t = 0; t < tri.nt; t++) if (alive[t] && label[t] >= 0) nT++;
  const T = new Int32Array(3 * nT);
  const R = new Int32Array(nT);
  let k = 0;
  let nV = 0;
  const used = new Uint8Array(tri.nv);
  for (let t = 0; t < tri.nt; t++) {
    if (!alive[t] || label[t] < 0) continue;
    for (let i = 0; i < 3; i++) used[tv[3 * t + i]] = 1;
  }
  for (let v = 0; v < tri.nv; v++) if (used[v]) map[v] = nV++;
  const X = new Float64Array(nV), Y = new Float64Array(nV), fixed = new Uint8Array(nV);
  for (let v = 0; v < tri.nv; v++) {
    if (!used[v]) continue;
    const m = map[v];
    X[m] = xs[v]; Y[m] = ys[v]; fixed[m] = vfixed[v] ? 1 : 0;
  }
  for (let t = 0; t < tri.nt; t++) {
    if (!alive[t] || label[t] < 0) continue;
    T[3 * k] = map[tv[3 * t]];
    T[3 * k + 1] = map[tv[3 * t + 1]];
    T[3 * k + 2] = map[tv[3 * t + 2]];
    R[k] = label[t];
    k++;
  }
  return { X, Y, T, R, fixed };
}

/** Normalised triangle quality 4*sqrt(3)*A / sum(l^2): 1 for equilateral, <= 0 for degenerate/inverted. */
function triQ(X, Y, a, b, c) {
  const abx = X[b] - X[a], aby = Y[b] - Y[a];
  const acx = X[c] - X[a], acy = Y[c] - Y[a];
  const A2 = abx * acy - aby * acx;
  const s = abx * abx + aby * aby + acx * acx + acy * acy + (X[b] - X[c]) ** 2 + (Y[b] - Y[c]) ** 2;
  return (2 * Math.sqrt(3) * A2) / s;
}

/**
 * Smart Laplacian smoothing of free (non-fixed) vertices: a vertex moves to the average of its
 * neighbours only if the worst triangle quality around it does not get worse. Deterministic.
 */
export function smoothMesh(X, Y, T, fixed, passes) {
  const nV = X.length, nT = T.length / 3;
  const start = new Int32Array(nV + 1);
  for (let i = 0; i < T.length; i++) start[T[i] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV);
  const star = new Int32Array(T.length);
  for (let t = 0; t < nT; t++) for (let i = 0; i < 3; i++) star[fill[T[3 * t + i]]++] = t;

  for (let pass = 0; pass < passes; pass++) {
    let moved = 0;
    for (let v = 0; v < nV; v++) {
      if (fixed[v]) continue;
      const s0 = start[v], s1 = start[v + 1];
      if (s1 - s0 < 3) continue;
      let sx = 0, sy = 0, cnt = 0;
      let qold = Infinity;
      for (let q = s0; q < s1; q++) {
        const t = star[q];
        const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
        const qq = triQ(X, Y, a, b, c);
        if (qq < qold) qold = qq;
        if (a !== v) { sx += X[a]; sy += Y[a]; cnt++; }
        if (b !== v) { sx += X[b]; sy += Y[b]; cnt++; }
        if (c !== v) { sx += X[c]; sy += Y[c]; cnt++; }
      }
      const ox = X[v], oy = Y[v];
      X[v] = sx / cnt; Y[v] = sy / cnt;
      let qnew = Infinity;
      for (let q = s0; q < s1; q++) {
        const t = star[q];
        const qq = triQ(X, Y, T[3 * t], T[3 * t + 1], T[3 * t + 2]);
        if (qq < qnew) qnew = qq;
      }
      if (qnew > 0 && qnew >= qold) moved++;
      else { X[v] = ox; Y[v] = oy; }
    }
    if (moved === 0) break;
  }
}

/** Build T6 connectivity (shared straight mid-side nodes). Returns {X,Y,E} with E = 6 nodes per element. */
export function toQuadratic(X, Y, T) {
  const nC = X.length, nT = T.length / 3;
  const edgeNode = new Map();
  const mx = [], my = [];
  const E = new Int32Array(6 * nT);
  const mid = (a, b) => {
    const key = a < b ? a * nC + b : b * nC + a;
    let n = edgeNode.get(key);
    if (n === undefined) {
      n = nC + mx.length;
      mx.push(0.5 * (X[a] + X[b]));
      my.push(0.5 * (Y[a] + Y[b]));
      edgeNode.set(key, n);
    }
    return n;
  };
  for (let t = 0; t < nT; t++) {
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    E[6 * t] = a; E[6 * t + 1] = b; E[6 * t + 2] = c;
    E[6 * t + 3] = mid(a, b);
    E[6 * t + 4] = mid(b, c);
    E[6 * t + 5] = mid(c, a);
  }
  const nN = nC + mx.length;
  const X2 = new Float64Array(nN), Y2 = new Float64Array(nN);
  X2.set(X); Y2.set(Y);
  for (let i = 0; i < mx.length; i++) { X2[nC + i] = mx[i]; Y2[nC + i] = my[i]; }
  return { X: X2, Y: Y2, E };
}

/**
 * Reverse Cuthill-McKee ordering of the node graph defined by element connectivity (full element cliques).
 * Returns perm with perm[old] = new. Deterministic; handles disconnected graphs.
 */
export function rcmOrdering(nN, E, nen) {
  const nel = E.length / nen;
  const cnt = new Int32Array(nN + 1);
  for (let e = 0; e < nel; e++) for (let i = 0; i < nen; i++) cnt[E[e * nen + i] + 1] += nen - 1;
  for (let v = 0; v < nN; v++) cnt[v + 1] += cnt[v];
  const fill = cnt.slice(0, nN);
  const raw = new Int32Array(cnt[nN]);
  for (let e = 0; e < nel; e++) {
    for (let i = 0; i < nen; i++) {
      const a = E[e * nen + i];
      for (let j = 0; j < nen; j++) if (j !== i) raw[fill[a]++] = E[e * nen + j];
    }
  }
  // sort + unique each adjacency list
  const adjStart = new Int32Array(nN + 1);
  const adj = new Int32Array(raw.length);
  let w = 0;
  for (let v = 0; v < nN; v++) {
    adjStart[v] = w;
    const seg = raw.subarray(cnt[v], cnt[v + 1]);
    seg.sort();
    let prev = -1;
    for (let i = 0; i < seg.length; i++) if (seg[i] !== prev) { adj[w++] = seg[i]; prev = seg[i]; }
  }
  adjStart[nN] = w;
  const deg = new Int32Array(nN);
  for (let v = 0; v < nN; v++) deg[v] = adjStart[v + 1] - adjStart[v];

  const visited = new Uint8Array(nN);
  const order = new Int32Array(nN);
  let nOrd = 0;
  const stamp = new Int32Array(nN);
  let curStamp = 0;
  const lvlQ = new Int32Array(nN);
  const lvl = new Int32Array(nN);

  // BFS levels from root; returns {depth, lastStart, lastEnd} with nodes in lvlQ[0..n)
  function bfsLevels(root) {
    curStamp++;
    let head = 0, tail = 0;
    lvlQ[tail++] = root; stamp[root] = curStamp; lvl[root] = 0;
    while (head < tail) {
      const v = lvlQ[head++];
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const u = adj[k];
        if (stamp[u] !== curStamp) { stamp[u] = curStamp; lvl[u] = lvl[v] + 1; lvlQ[tail++] = u; }
      }
    }
    return { n: tail, depth: lvl[lvlQ[tail - 1]] };
  }

  const byDeg = Array.from({ length: nN }, (_, i) => i).sort((p, q) => deg[p] - deg[q] || p - q);
  for (const s of byDeg) {
    if (visited[s]) continue;
    // George-Liu pseudo-peripheral root
    let root = s;
    let { n, depth } = bfsLevels(root);
    for (let it = 0; it < 10; it++) {
      let best = -1;
      for (let i = n - 1; i >= 0 && lvl[lvlQ[i]] === depth; i--) {
        const v = lvlQ[i];
        if (best < 0 || deg[v] < deg[best] || (deg[v] === deg[best] && v < best)) best = v;
      }
      const r2 = bfsLevels(best);
      if (r2.depth > depth) { root = best; depth = r2.depth; n = r2.n; } else break;
    }
    // Cuthill-McKee from root
    let head = nOrd;
    order[nOrd++] = root; visited[root] = 1;
    while (head < nOrd) {
      const v = order[head++];
      const first = nOrd;
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const u = adj[k];
        if (!visited[u]) { visited[u] = 1; order[nOrd++] = u; }
      }
      // sort the newly added neighbours by degree (insertion sort; small)
      for (let i = first + 1; i < nOrd; i++) {
        const x = order[i];
        let j = i - 1;
        while (j >= first && (deg[order[j]] > deg[x] || (deg[order[j]] === deg[x] && order[j] > x))) { order[j + 1] = order[j]; j--; }
        order[j + 1] = x;
      }
    }
  }
  const perm = new Int32Array(nN);
  for (let i = 0; i < nN; i++) perm[order[i]] = nN - 1 - i;
  return perm;
}

/** Half-bandwidth of the node graph (max |i-j| over nodes sharing an element). */
export function bandwidth(E, nen) {
  let bw = 0;
  const nel = E.length / nen;
  for (let e = 0; e < nel; e++) {
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < nen; i++) { const v = E[e * nen + i]; if (v < mn) mn = v; if (v > mx) mx = v; }
    if (mx - mn > bw) bw = mx - mn;
  }
  return bw;
}

const RAD2DEG = 180 / Math.PI;

/** Per-triangle geometry metrics for corner coordinates. Angles in degrees. */
export function triangleMetrics(x1, y1, x2, y2, x3, y3) {
  const l1 = Math.hypot(x3 - x2, y3 - y2); // opposite vertex 1
  const l2 = Math.hypot(x1 - x3, y1 - y3);
  const l3 = Math.hypot(x2 - x1, y2 - y1);
  const area = 0.5 * ((x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1));
  const ang = (a, b, c) => Math.acos(Math.max(-1, Math.min(1, (b * b + c * c - a * a) / (2 * b * c || 1))));
  const A1 = ang(l1, l2, l3), A2 = ang(l2, l3, l1), A3 = Math.PI - A1 - A2;
  const lmax = Math.max(l1, l2, l3);
  const aspect = area > 0 ? (lmax * (l1 + l2 + l3)) / (4 * Math.sqrt(3) * area) : Infinity;
  return {
    area,
    minAngle: Math.min(A1, A2, A3) * RAD2DEG,
    maxAngle: Math.max(A1, A2, A3) * RAD2DEG,
    aspect,
  };
}
