// Incremental Delaunay triangulation (Bowyer-Watson) with adjacency, used by the mesher.
//
// Storage is struct-of-arrays. Triangle t has vertices tv[3t..3t+2] in counter-clockwise order and
// neighbours tn[3t+i] = triangle across the edge opposite to vertex slot i (edge v[i+1] -> v[i+2]), or -1.
// Vertices 0,1,2 are the corners of a large "super triangle" that encloses all real input.
//
// Point insertion is split into prepare() (locate + compute the cavity, read-only) and commit()
// (retriangulate), so callers can inspect the cavity (e.g. for segment encroachment) before deciding.
import { orient2d, incircle } from './predicates.js';

export const PREP_OK = 0;
export const PREP_DUPLICATE = 1;
export const PREP_FAIL = 2;

export class Triangulation {
  constructor(vertCap = 1024, triCap = 2048) {
    this.vertCap = vertCap;
    this.triCap = triCap;
    this.xs = new Float64Array(vertCap);
    this.ys = new Float64Array(vertCap);
    this.vtri = new Int32Array(vertCap).fill(-1);
    this.fanStart = new Int32Array(vertCap);
    this.fanEnd = new Int32Array(vertCap);
    this.nv = 0;
    this.tv = new Int32Array(3 * triCap);
    this.tn = new Int32Array(3 * triCap);
    this.alive = new Uint8Array(triCap);
    this.label = new Int32Array(triCap);
    this.gen = new Int32Array(triCap);
    this.mark = new Int32Array(triCap);
    this.nt = 0; // high-water mark of allocated triangle ids
    this.free = [];
    this.curMark = 0;
    this.last = 0;
    this.dupTol2 = 0;
    // cavity scratch
    this.cav = [];
    this.bA = []; this.bB = []; this.bN = []; this.bJ = []; this.bL = [];
    this.newTris = [];
    this._stack = [];
    this.dupVertex = -1;
  }

  _growV() {
    const cap = this.vertCap * 2;
    const g = (A, T) => { const B = new T(cap); B.set(A); return B; };
    this.xs = g(this.xs, Float64Array);
    this.ys = g(this.ys, Float64Array);
    const vt = new Int32Array(cap).fill(-1); vt.set(this.vtri); this.vtri = vt;
    this.fanStart = g(this.fanStart, Int32Array);
    this.fanEnd = g(this.fanEnd, Int32Array);
    this.vertCap = cap;
  }

  _growT() {
    const cap = this.triCap * 2;
    const g = (A, T, k = 1) => { const B = new T(cap * k); B.set(A); return B; };
    this.tv = g(this.tv, Int32Array, 3);
    this.tn = g(this.tn, Int32Array, 3);
    this.alive = g(this.alive, Uint8Array);
    this.label = g(this.label, Int32Array);
    this.gen = g(this.gen, Int32Array);
    this.mark = g(this.mark, Int32Array);
    this.triCap = cap;
  }

  addVertex(x, y) {
    if (this.nv >= this.vertCap) this._growV();
    const v = this.nv++;
    this.xs[v] = x;
    this.ys[v] = y;
    this.vtri[v] = -1;
    return v;
  }

  /** Create the super triangle (vertices 0,1,2) around a box centred at (cx,cy) with half-size D. */
  initSuper(cx, cy, D) {
    const big = 60 * D;
    this.addVertex(cx - 2 * big, cy - big);
    this.addVertex(cx + 2 * big, cy - big);
    this.addVertex(cx, cy + 3 * big);
    const t = this._newTri(0, 1, 2, 0);
    this.tn[3 * t] = this.tn[3 * t + 1] = this.tn[3 * t + 2] = -1;
    this.last = t;
  }

  _newTri(a, b, c, label) {
    let t;
    if (this.free.length) t = this.free.pop();
    else {
      if (this.nt >= this.triCap) this._growT();
      t = this.nt++;
    }
    const k = 3 * t;
    this.tv[k] = a; this.tv[k + 1] = b; this.tv[k + 2] = c;
    this.tn[k] = this.tn[k + 1] = this.tn[k + 2] = -1;
    this.alive[t] = 1;
    this.label[t] = label;
    this.gen[t]++;
    return t;
  }

  /** Find an alive triangle containing (px,py) (closed) by a visibility walk starting from hint. */
  locate(px, py, hint) {
    const { xs, ys, tv, tn, alive } = this;
    let t = hint >= 0 && hint < this.nt && alive[hint] ? hint : this.last;
    if (!alive[t]) t = this._anyAlive();
    const maxSteps = 20 + 3 * this.nt;
    for (let steps = 0; steps < maxSteps; steps++) {
      const base = 3 * t;
      let moved = false;
      const s0 = steps % 3;
      for (let q = 0; q < 3; q++) {
        const i = (s0 + q) % 3;
        const a = tv[base + (i + 1) % 3];
        const b = tv[base + (i + 2) % 3];
        if (orient2d(xs[a], ys[a], xs[b], ys[b], px, py) < 0) {
          const n = tn[base + i];
          if (n < 0) return t; // outside the super triangle (should not happen)
          t = n;
          moved = true;
          break;
        }
      }
      if (!moved) return t;
    }
    return this._locateBrute(px, py);
  }

  _anyAlive() {
    for (let t = 0; t < this.nt; t++) if (this.alive[t]) return t;
    return 0;
  }

  _locateBrute(px, py) {
    const { xs, ys, tv, alive } = this;
    let best = -1, bestVal = -Infinity;
    for (let t = 0; t < this.nt; t++) {
      if (!alive[t]) continue;
      let m = Infinity;
      for (let i = 0; i < 3; i++) {
        const a = tv[3 * t + (i + 1) % 3], b = tv[3 * t + (i + 2) % 3];
        const o = orient2d(xs[a], ys[a], xs[b], ys[b], px, py);
        if (o < m) m = o;
      }
      if (m >= 0) return t;
      if (m > bestVal) { bestVal = m; best = t; }
    }
    return best;
  }

  /**
   * Locate p and compute its Delaunay cavity without modifying the triangulation.
   * Results are left in this.cav (cavity triangles) and this.bA/bB/bN/bJ/bL (boundary edges).
   * Returns PREP_OK, PREP_DUPLICATE (this.dupVertex set) or PREP_FAIL.
   */
  prepare(px, py, hint = -1) {
    const { xs, ys, tv, tn } = this;
    const t0 = this.locate(px, py, hint);
    if (t0 < 0) return PREP_FAIL;
    for (let k = 0; k < 3; k++) {
      const v = tv[3 * t0 + k];
      const dx = xs[v] - px, dy = ys[v] - py;
      if (dx * dx + dy * dy <= this.dupTol2) { this.dupVertex = v; return PREP_DUPLICATE; }
    }
    const cur = ++this.curMark;
    const mark = this.mark;
    const cav = this.cav;
    cav.length = 0;
    const stack = this._stack;
    stack.length = 0;
    mark[t0] = 2 * cur;
    stack.push(t0);
    while (stack.length) {
      const t = stack.pop();
      cav.push(t);
      for (let i = 0; i < 3; i++) {
        const n = tn[3 * t + i];
        if (n < 0 || mark[n] >= 2 * cur) continue;
        const a = tv[3 * n], b = tv[3 * n + 1], c = tv[3 * n + 2];
        if (incircle(xs[a], ys[a], xs[b], ys[b], xs[c], ys[c], px, py) > 0) {
          mark[n] = 2 * cur;
          stack.push(n);
        } else {
          mark[n] = 2 * cur + 1;
        }
      }
    }
    // boundary of the cavity
    const { bA, bB, bN, bJ, bL, label } = this;
    bA.length = bB.length = bN.length = bJ.length = bL.length = 0;
    for (let q = 0; q < cav.length; q++) {
      const t = cav[q];
      for (let i = 0; i < 3; i++) {
        const n = tn[3 * t + i];
        if (n >= 0 && mark[n] === 2 * cur) continue;
        const a = tv[3 * t + (i + 1) % 3];
        const b = tv[3 * t + (i + 2) % 3];
        if (orient2d(xs[a], ys[a], xs[b], ys[b], px, py) <= 0) return PREP_FAIL;
        let j = -1;
        if (n >= 0) {
          const nb = 3 * n;
          j = tn[nb] === t ? 0 : tn[nb + 1] === t ? 1 : 2;
        }
        bA.push(a); bB.push(b); bN.push(n); bJ.push(j); bL.push(label[t]);
      }
    }
    return PREP_OK;
  }

  /** Commit the cavity computed by the last successful prepare(), connecting vertex v to it. */
  commit(v) {
    const { cav, bA, bB, bN, bJ, bL, fanStart, fanEnd, vtri } = this;
    for (let q = 0; q < cav.length; q++) {
      const t = cav[q];
      this.alive[t] = 0;
      this.free.push(t);
    }
    const nb = bA.length;
    const nts = this.newTris;
    nts.length = 0;
    // free list is LIFO; allocate in a deterministic order
    for (let e = 0; e < nb; e++) {
      const k = this._newTri(v, bA[e], bB[e], bL[e]);
      nts.push(k);
    }
    // _newTri may have reallocated tn: re-read
    const TN = this.tn;
    for (let e = 0; e < nb; e++) {
      const k = nts[e];
      TN[3 * k] = bN[e];
      if (bN[e] >= 0) TN[3 * bN[e] + bJ[e]] = k;
      fanStart[bA[e]] = k;
      fanEnd[bB[e]] = k;
    }
    for (let e = 0; e < nb; e++) {
      const k = nts[e];
      TN[3 * k + 1] = fanStart[bB[e]];
      TN[3 * k + 2] = fanEnd[bA[e]];
      vtri[v] = k;
      vtri[bA[e]] = k;
      vtri[bB[e]] = k;
    }
    this.last = nts[0];
  }

  /** Convenience: insert an already-added vertex v at its own coordinates. Returns a PREP_* status. */
  insertVertex(v, hint = -1) {
    const st = this.prepare(this.xs[v], this.ys[v], hint);
    if (st === PREP_OK) this.commit(v);
    return st;
  }

  /**
   * Apex vertices of the two triangles adjacent to edge a-b: returns [left, right] (-1 where there is no
   * triangle) or null if a-b is not an edge of the triangulation. Left apex c makes (a,b,c) CCW.
   */
  edgeApexes(a, b) {
    const { tv, tn } = this;
    const t0 = this.vtri[a];
    if (t0 < 0 || !this.alive[t0]) return null;
    let t = t0;
    let guard = 0;
    do {
      const k = 3 * t;
      const i = tv[k] === a ? 0 : tv[k + 1] === a ? 1 : 2;
      const u = tv[k + (i + 1) % 3];
      const w = tv[k + (i + 2) % 3];
      if (u === b) {
        const n = tn[k + (i + 2) % 3];
        return [w, n >= 0 ? this._apexOf(n, a, b) : -1];
      }
      if (w === b) {
        const n = tn[k + (i + 1) % 3];
        return [n >= 0 ? this._apexOf(n, a, b) : -1, u];
      }
      t = tn[k + (i + 1) % 3];
      if (++guard > 100000) return null;
    } while (t >= 0 && t !== t0);
    return null;
  }

  _apexOf(t, a, b) {
    const k = 3 * t;
    for (let i = 0; i < 3; i++) {
      const v = this.tv[k + i];
      if (v !== a && v !== b) return v;
    }
    return -1;
  }
}
