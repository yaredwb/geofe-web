// Sparse Cholesky (up-looking, CSparse style) with geometric nested-dissection ordering.
// Used for larger systems where the fill of a banded/skyline factor (RCM) is much higher than with nested dissection
// (2-D meshes: O(N log N) fill instead of O(N^1.5)). Same interface as SkylineLDL: factor(), solve(b).
//
// Matrix storage: upper triangle in compressed-column form of the PERMUTED system (equation numbers already follow the
// elimination order chosen by the caller), pattern built once by `SparsePattern`, values added with `add(i, j, v)`.

/**
 * Geometric nested-dissection ordering of a node graph.
 * @param {Float64Array} coords  interleaved x,y of all nodes
 * @param {Int32Array} xadj  CSR adjacency (node graph)
 * @param {Int32Array} adj
 * @param {Uint8Array|null} include  nodes to order (others ignored)
 * @param {number} leafSize  stop recursion below this many nodes
 * @returns {Int32Array} nodes in elimination order (position = new index)
 */
export function nestedDissectionOrder(coords, xadj, adj, include = null, leafSize = 4) {
  const n = xadj.length - 1;
  const nodes = [];
  for (let i = 0; i < n; i++) if (!include || include[i]) nodes.push(i);
  const order = new Int32Array(nodes.length);
  let pos = 0;
  const part = new Int32Array(n).fill(-1);   // stamp: id of the current sub-problem membership marker
  let stamp = 0;

  // iterative recursion with an explicit stack of tasks: {list, emitSeparatorAfter}
  // task kinds: 0 = dissect list, 1 = emit list as is
  const stack = [{ kind: 0, list: nodes }];
  while (stack.length) {
    const t = stack.pop();
    if (t.kind === 1) { for (const v of t.list) order[pos++] = v; continue; }
    const list = t.list;
    if (list.length <= leafSize) {
      // small leaf: order along the longest coordinate direction (cheap, keeps profile small)
      emitSorted(list, coords, order, pos);
      pos += list.length;
      continue;
    }
    // bisect geometrically along the longer extent at the median
    let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
    for (const v of list) {
      const x = coords[2 * v], y = coords[2 * v + 1];
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
    const ax = xmax - xmin >= ymax - ymin ? 0 : 1;
    const sorted = list.slice().sort((a, b) => coords[2 * a + ax] - coords[2 * b + ax] || a - b);
    const half = sorted.length >> 1;
    const A = sorted.slice(0, half), B = sorted.slice(half);
    // membership stamps: A -> s, B -> s+1
    const sA = ++stamp, sB = ++stamp;
    for (const v of A) part[v] = sA;
    for (const v of B) part[v] = sB;
    // separator: nodes of B adjacent to A (use whichever side gives the smaller separator)
    const sepB = [], restB = [];
    for (const v of B) {
      let touch = false;
      for (let k = xadj[v]; k < xadj[v + 1]; k++) if (part[adj[k]] === sA) { touch = true; break; }
      (touch ? sepB : restB).push(v);
    }
    const sepA = [], restA = [];
    for (const v of A) {
      let touch = false;
      for (let k = xadj[v]; k < xadj[v + 1]; k++) if (part[adj[k]] === sB) { touch = true; break; }
      (touch ? sepA : restA).push(v);
    }
    let sub1, sub2, sep;
    if (sepA.length <= sepB.length) { sub1 = restA; sub2 = B; sep = sepA; } else { sub1 = A; sub2 = restB; sep = sepB; }
    // clear stamps (so later tasks do not see stale marks)
    for (const v of list) part[v] = -1;
    // order: sub1, sub2, separator  (stack is LIFO)
    stack.push({ kind: 1, list: sep.sort((a, b) => coords[2 * a + (1 - ax)] - coords[2 * b + (1 - ax)] || a - b) });
    if (sub2.length) stack.push({ kind: 0, list: sub2 });
    if (sub1.length) stack.push({ kind: 0, list: sub1 });
  }
  return order;
}

function emitSorted(list, coords, order, pos) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const v of list) {
    const x = coords[2 * v], y = coords[2 * v + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  const ax = xmax - xmin >= ymax - ymin ? 0 : 1;
  const s = list.slice().sort((a, b) => coords[2 * a + ax] - coords[2 * b + ax] || a - b);
  for (let i = 0; i < s.length; i++) order[pos + i] = s[i];
}

/**
 * Sparse symmetric positive-definite matrix with Cholesky (LLᵀ) factorization.
 */
export class SparseCholesky {
  /**
   * @param {number} n
   * @param {Int32Array} colPtr  upper-triangular CSC pattern: column j has rows colRows[colPtr[j]..colPtr[j+1]) (sorted, ≤ j, includes j)
   * @param {Int32Array} colRows
   */
  constructor(n, colPtr, colRows) {
    this.n = n; this.Ap = colPtr; this.Ai = colRows;
    this.Ax = new Float64Array(colRows.length);
    this.factored = false;
    this.nnzL = 0;
  }

  /** Add v to the entry (i, j); either triangle may be given. */
  add(i, j, v) {
    if (i > j) { const t = i; i = j; j = t; }
    const { Ap, Ai } = this;
    let lo = Ap[j], hi = Ap[j + 1] - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const r = Ai[mid];
      if (r === i) { this.Ax[mid] += v; return; }
      if (r < i) lo = mid + 1; else hi = mid - 1;
    }
    throw new Error(`SparseCholesky.add: entry (${i},${j}) not in the pattern`);
  }

  /** Symbolic analysis (elimination tree, column counts, L pattern storage) — done once per pattern. */
  _symbolic() {
    const { n, Ap, Ai } = this;
    const parent = new Int32Array(n).fill(-1);
    const anc = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) {
      for (let p = Ap[k]; p < Ap[k + 1]; p++) {
        let i = Ai[p];
        while (i !== -1 && i < k) {
          const inext = anc[i];
          anc[i] = k;
          if (inext === -1) parent[i] = k;
          i = inext;
        }
      }
    }
    this.parent = parent;
    this.s = new Int32Array(n); this.w = new Uint8Array(n); this.stk = new Int32Array(n);
    const cnt = new Int32Array(n + 1);
    for (let k = 0; k < n; k++) {
      cnt[k]++;                      // diagonal
      const top = this._ereach(k);
      for (let p = top; p < n; p++) cnt[this.s[p]]++;
    }
    const Lp = new Int32Array(n + 1);
    for (let j = 0; j < n; j++) Lp[j + 1] = Lp[j] + cnt[j];
    this.Lp = Lp; this.nnzL = Lp[n];
    this.Li = new Int32Array(this.nnzL); this.Lx = new Float64Array(this.nnzL);
    this.c = new Int32Array(n); this.x = new Float64Array(n);
    this.work = new Float64Array(n);
    this.symbolic = true;
  }

  // pattern of row k of L (reach in the etree), stored in s[top..n); returns top
  _ereach(k) {
    const { n, Ap, Ai, parent, s, w, stk } = this;
    let top = n;
    w[k] = 1;
    for (let p = Ap[k]; p < Ap[k + 1]; p++) {
      let i = Ai[p];
      if (i > k) continue;
      let len = 0;
      for (; !w[i]; i = parent[i]) { stk[len++] = i; w[i] = 1; }
      while (len > 0) s[--top] = stk[--len];
    }
    for (let p = top; p < n; p++) w[s[p]] = 0;
    w[k] = 0;
    return top;
  }

  factor() {
    if (!this.symbolic) this._symbolic();
    const { n, Ap, Ai, Ax, Lp, Li, Lx, s, c, x } = this;
    c.set(Lp.subarray(0, n));        // next free slot per column
    for (let k = 0; k < n; k++) {
      const top = this._ereach(k);
      x[k] = 0;
      for (let p = Ap[k]; p < Ap[k + 1]; p++) if (Ai[p] <= k) x[Ai[p]] = Ax[p];
      let d = x[k];
      const d0 = d;
      x[k] = 0;
      for (let t = top; t < n; t++) {
        const i = s[t];
        const lki = x[i] / Lx[Lp[i]];
        x[i] = 0;
        const end = c[i];
        for (let p = Lp[i] + 1; p < end; p++) x[Li[p]] -= Lx[p] * lki;
        d -= lki * lki;
        const q = c[i]++;
        Li[q] = k; Lx[q] = lki;
      }
      if (!(d > 1e-11 * d0) || !Number.isFinite(d)) {
        throw new Error(`Singular stiffness matrix at equation ${k} (pivot ${d}); the model is probably not sufficiently supported`);
      }
      const q = c[k]++;
      Li[q] = k; Lx[q] = Math.sqrt(d);
    }
    this.factored = true;
  }

  /** Solve A x = b in place. */
  solve(b) {
    const { n, Lp, Li, Lx } = this;
    for (let j = 0; j < n; j++) {
      const xj = b[j] / Lx[Lp[j]];
      b[j] = xj;
      if (xj !== 0) for (let p = Lp[j] + 1, e = Lp[j + 1]; p < e; p++) b[Li[p]] -= Lx[p] * xj;
    }
    for (let j = n - 1; j >= 0; j--) {
      let sj = b[j];
      for (let p = Lp[j] + 1, e = Lp[j + 1]; p < e; p++) sj -= Lx[p] * b[Li[p]];
      b[j] = sj / Lx[Lp[j]];
    }
    return b;
  }
}

/**
 * Build the upper-triangular CSC pattern of the permuted matrix from element connectivity.
 * @param {number} neq
 * @param {Int32Array} eq  dof → equation number (-1 fixed)
 * @param {Int32Array} elements  connectivity
 * @param {number} nen
 * @param {Uint8Array} activeEl
 * @returns {{colPtr: Int32Array, colRows: Int32Array}}
 */
export function buildUpperPattern(neq, eq, elements, nen, activeEl) {
  const nEl = (elements.length / nen) | 0;
  // count raw entries per column (upper part incl. duplicates), then fill, sort and de-duplicate per column
  const cnt = new Int32Array(neq + 1);
  const nd = 2 * nen;
  const dofEq = new Int32Array(nd);
  const loadEq = (e) => {
    for (let a = 0; a < nen; a++) {
      const n = elements[e * nen + a];
      dofEq[2 * a] = eq[2 * n]; dofEq[2 * a + 1] = eq[2 * n + 1];
    }
  };
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    loadEq(e);
    for (let a = 0; a < nd; a++) {
      const ea = dofEq[a];
      if (ea < 0) continue;
      for (let b = 0; b < nd; b++) {
        const eb = dofEq[b];
        if (eb >= 0 && ea <= eb) cnt[eb + 1]++;   // column eb, row ea
      }
    }
  }
  for (let j = 0; j < neq; j++) cnt[j + 1] += cnt[j];
  const raw = new Int32Array(cnt[neq]);
  const fill = cnt.slice(0, neq);
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    loadEq(e);
    for (let a = 0; a < nd; a++) {
      const ea = dofEq[a];
      if (ea < 0) continue;
      for (let b = 0; b < nd; b++) {
        const eb = dofEq[b];
        if (eb >= 0 && ea <= eb) raw[fill[eb]++] = ea;
      }
    }
  }
  const colPtr = new Int32Array(neq + 1);
  const rows = new Int32Array(raw.length);
  let w = 0;
  const tmp = [];
  for (let j = 0; j < neq; j++) {
    colPtr[j] = w;
    tmp.length = 0;
    for (let k = cnt[j]; k < cnt[j + 1]; k++) tmp.push(raw[k]);
    tmp.sort((a, b) => a - b);
    let prev = -1;
    for (const r of tmp) if (r !== prev) { rows[w++] = r; prev = r; }
  }
  colPtr[neq] = w;
  return { colPtr, colRows: rows.slice(0, w) };
}
