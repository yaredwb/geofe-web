// Limited-memory BFGS acceleration for the modified Newton iteration.
// The inverse-Hessian approximation H is built on top of the (factorised) elastic stiffness inverse H0 = K⁻¹ using the
// standard two-loop recursion (Nocedal). Vectors live in the compact free-DOF space.
// We solve R(u) = F − Fint(u) = 0; with s = Δu and y = Fint(u+s) − Fint(u) = R_old − R_new the update keeps H ≈ K_tan⁻¹.

export class LBFGS {
  /**
   * @param {number} n  vector length (number of free DOFs)
   * @param {number} m  history length
   * @param {(v: Float64Array) => void} applyH0  in-place product with the initial inverse Hessian (K⁻¹)
   */
  constructor(n, m, applyH0) {
    this.n = n; this.m = m; this.applyH0 = applyH0;
    this.S = []; this.Y = []; this.rho = [];
    this.alpha = new Float64Array(m);
    this.pool = [];
  }

  get size() { return this.S.length; }

  reset() {
    while (this.S.length) { this.pool.push(this.S.pop(), this.Y.pop()); }
    this.rho.length = 0;
  }

  /** Add a correction pair (copied). Returns false (and ignores the pair) if the curvature condition fails. */
  push(s, y) {
    let sy = 0, ss = 0, yy = 0;
    for (let i = 0; i < this.n; i++) { sy += s[i] * y[i]; ss += s[i] * s[i]; yy += y[i] * y[i]; }
    if (!(sy > 1e-10 * Math.sqrt(ss * yy)) || !Number.isFinite(sy)) return false;
    let S, Y;
    if (this.S.length >= this.m) { S = this.S.shift(); Y = this.Y.shift(); this.rho.shift(); }
    else { S = this.pool.pop() || new Float64Array(this.n); Y = this.pool.pop() || new Float64Array(this.n); }
    S.set(s); Y.set(y);
    this.S.push(S); this.Y.push(Y); this.rho.push(1 / sy);
    return true;
  }

  /** out = H r (r is not modified). */
  direction(r, out) {
    const { n, S, Y, rho, alpha } = this;
    out.set(r);
    const k = S.length;
    for (let i = k - 1; i >= 0; i--) {
      let a = 0; const si = S[i], yi = Y[i];
      for (let j = 0; j < n; j++) a += si[j] * out[j];
      a *= rho[i]; alpha[i] = a;
      for (let j = 0; j < n; j++) out[j] -= a * yi[j];
    }
    this.applyH0(out);
    for (let i = 0; i < k; i++) {
      let b = 0; const si = S[i], yi = Y[i];
      for (let j = 0; j < n; j++) b += yi[j] * out[j];
      b *= rho[i];
      const c = alpha[i] - b;
      for (let j = 0; j < n; j++) out[j] += c * si[j];
    }
    return out;
  }
}
