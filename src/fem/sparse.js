// Sparse symmetric positive-definite direct solver: skyline (profile) LDLᵀ with Reverse Cuthill–McKee ordering.
// DOM-free, dependency-free. Everything is typed-array based so it runs identically in Node and in a Worker.
//
// Usage:
//   const g = buildNodeGraph(nNodes, elements, nen, activeEl, nodeMask);
//   const order = reverseCuthillMcKee(nNodes, g.xadj, g.adj, nodeMask);   // node order (new → old)
//   ... number equations following `order`, compute `first[]` (profile), then
//   const K = new SkylineLDL(n, first);  K.add(i, j, v) (i >= j) ...; K.factor(); K.solve(b);

/**
 * Node adjacency graph (CSR) from element connectivity.
 * @param {number} nNodes
 * @param {Int32Array} elements  flat connectivity, `nen` entries per element
 * @param {number} nen
 * @param {Uint8Array|null} activeEl  1 = element participates (null = all)
 * @param {Uint8Array|null} nodeMask  1 = node participates (null = all). Edges to masked-out nodes are dropped.
 * @returns {{xadj: Int32Array, adj: Int32Array}}
 */
export function buildNodeGraph(nNodes, elements, nen, activeEl = null, nodeMask = null) {
  const nEl = (elements.length / nen) | 0;
  const cnt = new Int32Array(nNodes + 1);
  for (let e = 0; e < nEl; e++) {
    if (activeEl && !activeEl[e]) continue;
    for (let a = 0; a < nen; a++) {
      const na = elements[e * nen + a];
      if (nodeMask && !nodeMask[na]) continue;
      cnt[na + 1] += nen - 1;
    }
  }
  for (let i = 0; i < nNodes; i++) cnt[i + 1] += cnt[i];
  const raw = new Int32Array(cnt[nNodes]);
  const fill = cnt.slice(0, nNodes);
  for (let e = 0; e < nEl; e++) {
    if (activeEl && !activeEl[e]) continue;
    for (let a = 0; a < nen; a++) {
      const na = elements[e * nen + a];
      if (nodeMask && !nodeMask[na]) continue;
      for (let b = 0; b < nen; b++) {
        if (a === b) continue;
        const nb = elements[e * nen + b];
        if (nodeMask && !nodeMask[nb]) continue;
        raw[fill[na]++] = nb;
      }
    }
  }
  // de-duplicate per node using a stamp array
  const xadj = new Int32Array(nNodes + 1);
  const stamp = new Int32Array(nNodes).fill(-1);
  let w = 0;
  for (let i = 0; i < nNodes; i++) {
    xadj[i] = w;
    for (let k = cnt[i]; k < fill[i]; k++) {
      const j = raw[k];
      if (stamp[j] !== i) { stamp[j] = i; raw[w++] = j; }
    }
  }
  xadj[nNodes] = w;
  return { xadj, adj: raw.slice(0, w) };
}

/**
 * Reverse Cuthill–McKee ordering with a pseudo-peripheral root per connected component.
 * @param {number} n
 * @param {Int32Array} xadj
 * @param {Int32Array} adj
 * @param {Uint8Array|null} include  nodes to order (others are skipped)
 * @returns {Int32Array} nodes in new order (position = new index, value = old node id), length = #included
 */
export function reverseCuthillMcKee(n, xadj, adj, include = null) {
  const deg = new Int32Array(n);
  let nInc = 0;
  for (let i = 0; i < n; i++) {
    if (include && !include[i]) continue;
    deg[i] = xadj[i + 1] - xadj[i];
    nInc++;
  }
  const byDeg = new Int32Array(nInc);
  { let k = 0; for (let i = 0; i < n; i++) if (!include || include[i]) byDeg[k++] = i; }
  byDeg.sort((a, b) => deg[a] - deg[b] || a - b);

  const visited = new Uint8Array(n);
  const lev = new Int32Array(n).fill(-1);
  const queue = new Int32Array(n);
  const order = new Int32Array(nInc);
  let nOrd = 0;

  // BFS from `root` over the component; returns {count, ecc, last} using `queue` as storage. Resets `lev` afterwards.
  function bfs(root) {
    let head = 0, tail = 0;
    queue[tail++] = root; lev[root] = 0;
    let ecc = 0;
    while (head < tail) {
      const v = queue[head++];
      const lv = lev[v];
      if (lv > ecc) ecc = lv;
      for (let k = xadj[v]; k < xadj[v + 1]; k++) {
        const w = adj[k];
        if (lev[w] < 0) { lev[w] = lv + 1; queue[tail++] = w; }
      }
    }
    // pick min-degree node of the last level
    let best = -1;
    for (let i = tail - 1; i >= 0 && lev[queue[i]] === ecc; i--) {
      const v = queue[i];
      if (best < 0 || deg[v] < deg[best]) best = v;
    }
    for (let i = 0; i < tail; i++) lev[queue[i]] = -1;
    return { ecc, best, count: tail };
  }

  for (let s = 0; s < nInc; s++) {
    const start = byDeg[s];
    if (visited[start]) continue;
    // pseudo-peripheral root search (George–Liu)
    let root = start;
    let r = bfs(root);
    for (let it = 0; it < 8; it++) {
      const r2 = bfs(r.best);
      if (r2.ecc > r.ecc) { root = r.best; r = r2; } else break;
    }
    // Cuthill–McKee numbering from root
    let head = nOrd;
    order[nOrd++] = root; visited[root] = 1;
    const nb = [];
    while (head < nOrd) {
      const v = order[head++];
      nb.length = 0;
      for (let k = xadj[v]; k < xadj[v + 1]; k++) {
        const w = adj[k];
        if (!visited[w]) { visited[w] = 1; nb.push(w); }
      }
      nb.sort((a, b) => deg[a] - deg[b] || a - b);
      for (const w of nb) order[nOrd++] = w;
    }
  }
  // reverse
  for (let i = 0, j = nOrd - 1; i < j; i++, j--) { const t = order[i]; order[i] = order[j]; order[j] = t; }
  return order;
}

/**
 * Symmetric skyline matrix with LDLᵀ factorization. Only the strictly lower profile + diagonal are stored.
 * Row i holds columns first[i] .. i-1 (contiguous) and a separate diagonal.
 */
export class SkylineLDL {
  /**
   * @param {number} n  number of equations
   * @param {Int32Array} first  first[i] = lowest column index with a (potential) non-zero in row i (≤ i)
   */
  constructor(n, first) {
    this.n = n;
    this.first = first;
    const rowptr = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) rowptr[i + 1] = rowptr[i] + (i - first[i]);
    this.rowptr = rowptr;
    this.nnz = rowptr[n];
    this.L = new Float64Array(this.nnz);
    this.D = new Float64Array(n);
    this.factored = false;
    this._t = new Float64Array(n);
  }

  /** Add v to entry (i, j), requires j <= i and j >= first[i]. */
  add(i, j, v) {
    if (i === j) this.D[i] += v;
    else this.L[this.rowptr[i] - this.first[i] + j] += v;
  }

  /** In-place LDLᵀ. Throws if a pivot is non-positive (singular / insufficiently supported model). */
  factor() {
    const { n, first, rowptr, L, D, _t: t } = this;
    const diag0 = D.slice();
    for (let i = 0; i < n; i++) {
      const fi = first[i];
      const ri = rowptr[i] - fi;
      for (let j = fi; j < i; j++) {
        const fj = first[j];
        const k0 = fj > fi ? fj : fi;
        const rj = rowptr[j] - fj;
        let s = L[ri + j];
        for (let k = k0; k < j; k++) s -= L[rj + k] * t[k];
        t[j] = s;
        L[ri + j] = s / D[j];
      }
      let d = D[i];
      for (let k = fi; k < i; k++) d -= L[ri + k] * t[k];
      if (!(d > 1e-11 * diag0[i]) || !Number.isFinite(d)) {
        throw new Error(`Singular stiffness matrix at equation ${i} (pivot ${d}); the model is probably not sufficiently supported`);
      }
      D[i] = d;
    }
    this.factored = true;
  }

  /** Solve A x = b in place (b is overwritten by x). */
  solve(b) {
    const { n, first, rowptr, L, D } = this;
    for (let i = 0; i < n; i++) {
      const fi = first[i];
      const ri = rowptr[i] - fi;
      let s = b[i];
      for (let k = fi; k < i; k++) s -= L[ri + k] * b[k];
      b[i] = s;
    }
    for (let i = 0; i < n; i++) b[i] /= D[i];
    for (let i = n - 1; i >= 0; i--) {
      const xi = b[i];
      if (xi === 0) continue;
      const fi = first[i];
      const ri = rowptr[i] - fi;
      for (let k = fi; k < i; k++) b[k] -= L[ri + k] * xi;
    }
    return b;
  }

  /** y = A x using the *unfactored* matrix; only valid before factor() (used in tests). */
  mulUnfactored(x) {
    const { n, first, rowptr, L, D } = this;
    if (this.factored) throw new Error('matrix already factored');
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      y[i] += D[i] * x[i];
      const fi = first[i];
      const ri = rowptr[i] - fi;
      for (let k = fi; k < i; k++) { const a = L[ri + k]; y[i] += a * x[k]; y[k] += a * x[i]; }
    }
    return y;
  }
}
