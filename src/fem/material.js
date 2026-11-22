// Constitutive models: isotropic linear elasticity and Mohr–Coulomb elastic–perfectly-plastic (non-associated flow)
// with optional tension cut-off, plane strain.
//
// Sign convention (internal AND output): stress TENSION POSITIVE, effective stress. Stress vector layout per Gauss
// point: [sxx, syy, sxy, szz]. Strain increments: (dexx, deyy, dgxy) with dgxy = engineering shear strain; dezz = 0.
//
// Mohr–Coulomb with principal stresses s1 >= s2 >= s3 (tension positive):
//   f13 = (s1 - s3) + (s1 + s3) sinφ - 2c cosφ  =  s1 (1+sinφ) - s3 (1-sinφ) - 2c cosφ
//   g13 = (s1 - s3) + (s1 + s3) sinψ                      (plastic potential, ψ = dilation angle)
//   tension cut-off:  s1 <= st   (associated), st = min(tensile, c cotφ)
// The stress update is an implicit (fully elastic-predictor / plastic-corrector) return mapping in principal stress
// space (Clausen, Damkilde & Andersen 2007): return to the main plane, to the two edges (s1=s2, s2=s3) or to the
// apex, and — if the tension cut-off is active — to the cut-off plane, its edge with the cone, or the cut-off vertex.
// 3-D principal values are used (sxx, syy, sxy, szz) so plane strain (ezz = 0, szz tracked) is handled consistently.

const DEG = Math.PI / 180;

/**
 * Build solver-ready constitutive parameters for one material.
 * @param {object} mat  model material
 * @param {number} srf  strength reduction factor (1 = none): c/srf, tanφ/srf, tanψ/srf (ψ ≤ φ)
 * @param {boolean} tensionCutoff  apply the tension cut-off with strength `mat.tensile`
 */
export function makeMaterialParams(mat, srf = 1, tensionCutoff = true) {
  const E = mat.E, nu = mat.nu;
  const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu));
  const G = E / (2 * (1 + nu));
  const P = { mc: mat.model === 'mohr-coulomb', E, nu, lam, G, K: lam + (2 * G) / 3 };
  if (!P.mc) return P;
  const tanPhi = Math.tan((mat.phi || 0) * DEG) / srf;
  const tanPsi = Math.tan((mat.psi || 0) * DEG) / srf;
  const phi = Math.atan(tanPhi);
  const psi = Math.min(Math.atan(tanPsi), phi);
  const c = (mat.c || 0) / srf;
  P.c = c; P.phi = phi; P.psi = psi;
  P.sphi = Math.sin(phi); P.cphi = Math.cos(phi); P.spsi = Math.sin(psi);
  P.p = 1 + P.sphi; P.q = 1 - P.sphi;                    // yield-plane coefficients
  P.pp = 1 + P.spsi; P.qq = 1 - P.spsi;                  // potential coefficients
  P.k = 2 * c * P.cphi;
  P.l2s = 2 * lam * P.spsi;
  P.A13 = 4 * lam * P.sphi * P.spsi + 4 * G * (1 + P.sphi * P.spsi);   // a13ᵀ D b13
  P.Aab = 4 * lam * P.sphi * P.spsi + 2 * G * P.q * P.qq;               // coupling for the s1=s2 edge
  P.Aac = 4 * lam * P.sphi * P.spsi + 2 * G * P.p * P.pp;               // coupling for the s2=s3 edge
  P.apex = P.sphi > 1e-9 ? c * P.cphi / P.sphi : Infinity;               // c cotφ
  const tens = Math.max(0, mat.tensile || 0);
  P.st = tensionCutoff ? Math.min(tens, P.apex) : Infinity;             // tension cut-off stress
  P.hasCut = Number.isFinite(P.st);
  P.lg = lam + 2 * G;
  P.detT = P.lg * P.lg - lam * lam;
  return P;
}

/** Elastic constants → mean K0 (lateral coefficient) used for initial stresses. */
export function defaultK0(mat) {
  if (mat.K0 != null && Number.isFinite(mat.K0)) return mat.K0;
  if (mat.model === 'mohr-coulomb') return 1 - Math.sin((mat.phi || 0) * DEG);
  return mat.nu / (1 - mat.nu);
}

/**
 * Update the stress at one Gauss point in place: sig[o..o+3] holds the converged stress on entry; on exit the new
 * stress after the strain increment. Returns plastic flag 0 elastic / 1 shear yield / 2 tension cut-off.
 */
export function updateStress(P, sig, o, dexx, deyy, dgxy) {
  const tr = P.lam * (dexx + deyy);
  sig[o] += tr + 2 * P.G * dexx;
  sig[o + 1] += tr + 2 * P.G * deyy;
  sig[o + 2] += P.G * dgxy;
  sig[o + 3] += tr;
  if (!P.mc) return 0;
  return mcReturn(P, sig, o);
}

/** Elastic stress increment only (used by tests / initial states). */
export function elasticStress(P, sig, o, dexx, deyy, dgxy) {
  const tr = P.lam * (dexx + deyy);
  sig[o] += tr + 2 * P.G * dexx;
  sig[o + 1] += tr + 2 * P.G * deyy;
  sig[o + 2] += P.G * dgxy;
  sig[o + 3] += tr;
}

const _ret = new Float64Array(3);
const _val = new Float64Array(3);
const _id = new Int32Array(3);

/**
 * Check the trial stress in sig[o..o+3] against the yield criteria and, if violated, project it (return mapping).
 * Returns plastic flag (0/1/2). Modifies sig in place.
 */
export function mcReturn(P, sig, o) {
  const sxx = sig[o], syy = sig[o + 1], sxy = sig[o + 2], szz = sig[o + 3];
  const m = 0.5 * (sxx + syy), d = 0.5 * (sxx - syy);
  const R = Math.sqrt(d * d + sxy * sxy);
  const pa = m + R, pb = m - R;
  const hi = pa > szz ? pa : szz;
  const lo = pb < szz ? pb : szz;
  const f = hi * P.p - lo * P.q - P.k;
  const tolF = 1e-9 * (1 + P.k + Math.abs(hi) + Math.abs(lo));
  if (f < -tolF && (!P.hasCut || hi < P.st - tolF)) return 0;

  // rank the three principal values (index 0 = in-plane max, 1 = in-plane min, 2 = out-of-plane)
  _val[0] = pa; _val[1] = pb; _val[2] = szz;
  _id[0] = 0; _id[1] = 1; _id[2] = 2;
  if (_val[_id[0]] < _val[_id[1]]) { const t = _id[0]; _id[0] = _id[1]; _id[1] = t; }
  if (_val[_id[1]] < _val[_id[2]]) { const t = _id[1]; _id[1] = _id[2]; _id[2] = t; }
  if (_val[_id[0]] < _val[_id[1]]) { const t = _id[0]; _id[0] = _id[1]; _id[1] = t; }
  const flag = returnSorted(P, _val[_id[0]], _val[_id[1]], _val[_id[2]], _ret);

  // map back
  const out = _val; // reuse (values copied out below)
  const n0 = _ret[0], n1 = _ret[1], n2 = _ret[2];
  const i0 = _id[0], i1 = _id[1], i2 = _id[2];
  out[i0] = n0; out[i1] = n1; out[i2] = n2;
  const na = out[0], nb = out[1], nz = out[2];
  let c2 = 1, s2 = 0;
  if (R > 1e-12 * (1 + Math.abs(m))) { c2 = d / R; s2 = sxy / R; }
  const nm = 0.5 * (na + nb), nr = 0.5 * (na - nb);
  sig[o] = nm + nr * c2;
  sig[o + 1] = nm - nr * c2;
  sig[o + 2] = nr * s2;
  sig[o + 3] = nz;
  return flag;
}

/**
 * Return mapping in sorted principal space. (s1 >= s2 >= s3) trial → out[0..2] (sorted). Returns flag 1 or 2.
 */
function returnSorted(P, s1, s2, s3, out) {
  const { lam, G, p, q, k, st } = P;
  const l2s = P.l2s, pp = P.pp, qq = P.qq;
  const f = Math.max(0, s1 * p - s3 * q - k);
  let flag = 1;
  let r1 = s1, r2 = s2, r3 = s3;

  // ---------- Mohr–Coulomb return ----------
  if (f > 0) {
    const dg = f / P.A13;
    r1 = s1 - dg * (l2s + 2 * G * pp);
    r2 = s2 - dg * l2s;
    r3 = s3 - dg * (l2s - 2 * G * qq);
    if (r1 < r2 || r2 < r3) {
      let ok = false;
      // multiplier sign tolerance: a trial that lies ON an edge of the yield surface (typical for Gauss points that are
      // already plastic: s1 = s2 or s2 = s3 after a previous return) must not be sent to the apex by round-off
      const tm = 1e-9 * (1 + P.k + Math.abs(s1) + Math.abs(s3)) / P.A13;
      if (r1 < r2 && !(r2 < r3)) {
        // edge s1 = s2 : planes 13 and 23
        const fa = f, fb = s2 * p - s3 * q - k;
        const Aaa = P.A13, Aab = P.Aab;
        const det = Aaa * Aaa - Aab * Aab;
        const da = (Aaa * fa - Aab * fb) / det;
        const db = (Aaa * fb - Aab * fa) / det;
        const e1 = l2s + 2 * G * pp, e3 = l2s - 2 * G * qq;
        const n1 = s1 - da * e1 - db * l2s;
        const n2 = s2 - da * l2s - db * e1;
        const n3 = s3 - (da + db) * e3;
        if (da >= -tm && db >= -tm && n2 >= n3 - 1e-12) { r1 = r2 = 0.5 * (n1 + n2); r3 = n3; ok = true; }
      } else if (r2 < r3 && !(r1 < r2)) {
        // edge s2 = s3 : planes 13 and 12
        const fa = f, fc = s1 * p - s2 * q - k;
        const Aaa = P.A13, Aac = P.Aac;
        const det = Aaa * Aaa - Aac * Aac;
        const da = (Aaa * fa - Aac * fc) / det;
        const dc = (Aaa * fc - Aac * fa) / det;
        const e1 = l2s + 2 * G * pp, e2 = l2s - 2 * G * qq;
        const n1 = s1 - (da + dc) * e1;
        const n2 = s2 - da * l2s - dc * e2;
        const n3 = s3 - da * e2 - dc * l2s;
        if (da >= -tm && dc >= -tm && n1 >= n2 - 1e-12) { r1 = n1; r2 = r3 = 0.5 * (n2 + n3); ok = true; }
      }
      if (!ok) {
        // apex
        if (Number.isFinite(P.apex)) { r1 = r2 = r3 = P.apex; }
        // phi = 0 (Tresca): apex at infinity — the edge solutions are always admissible; keep the main-plane result
        // sorted to stay safe.
        else { const t = (r1 + r2 + r3) / 3; r1 = r2 = r3 = t; }
      }
    }
  }

  // ---------- tension cut-off ----------
  if (P.hasCut && r1 > st + 1e-9) {
    flag = 2;
    if (cutOffReturn(P, s1, s2, s3, out)) { r1 = out[0]; r2 = out[1]; r3 = out[2]; }
    else { r1 = r2 = r3 = st; }   // cut-off apex: always admissible because st <= c cotφ
  }
  out[0] = r1; out[1] = r2; out[2] = r3;
  return flag;
}

/**
 * Return to the tension cut-off s1 <= st (associated) for the sorted trial (s1 >= s2 >= s3) that violates it. The
 * candidates are tried from low to high dimension; each is accepted only if its plastic multipliers are non-negative and
 * the result lies inside the cone and below the cut-off (Kuhn–Tucker conditions), so the first accepted one is the
 * return:
 *   (a) cut-off plane only                                      (st, t2, t3)
 *   (b) corner of cone plane 13 and the cut-off                 (st, c2, c3)
 *   (c) cut-off with the cone edge s2 = s3 (planes 13, 12, s1)  (st, s, s),  s = (p st - k)/q
 *   (d) edge of two cut-off planes s1 = s2 = st                 (st, st, t3)
 *   (e) cut-off vertex (cone plane 13 and two cut-off planes)   (st, st, (p st - k)/q)
 * Writes the result to out[0..2] and returns false if no candidate qualifies (the caller then uses the apex).
 */
function cutOffReturn(P, s1, s2, s3, out) {
  const { lam, G, p, q, k, st, lg, l2s, pp, qq } = P;
  const f13 = s1 * p - s3 * q - k;
  const ds = s1 - st;
  const tolM = -1e-12 * (1 + Math.abs(s1) + Math.abs(s3) + Math.abs(st)) / lg;   // multiplier sign tolerance
  const e1 = l2s + 2 * G * pp, e3 = l2s - 2 * G * qq;
  const AT = p * lg - q * lam;

  // (a) cut-off plane only
  const dgT = ds / lg;
  const t2 = s2 - dgT * lam, t3 = s3 - dgT * lam;
  if (t2 <= st && st * p - t3 * q - k <= 0) { out[0] = st; out[1] = t2; out[2] = t3; return true; }

  // (b) corner of cone plane 13 and the cut-off plane
  {
    const det = P.A13 * lg - AT * e1;
    const da = (f13 * lg - AT * ds) / det;
    const dt = (P.A13 * ds - e1 * f13) / det;
    const c2 = s2 - da * l2s - dt * lam;
    const c3 = s3 - da * e3 - dt * lam;
    if (da >= tolM && dt >= tolM && c2 <= st && c2 >= c3 - 1e-12) { out[0] = st; out[1] = c2; out[2] = c3; return true; }
  }

  // (d) edge of two cut-off planes
  const e2 = s2 - st;
  const d1 = (lg * ds - lam * e2) / P.detT, d2 = (lg * e2 - lam * ds) / P.detT;
  const t3e = s3 - lam * (d1 + d2);
  if (d1 >= tolM && d2 >= tolM && t3e <= st && st * p - t3e * q - k <= 0) { out[0] = out[1] = st; out[2] = t3e; return true; }

  // (c) cone edge s2 = s3 with the cut-off: planes 13 and 12 and s1 = st; unknowns (da, dc, dt)
  {
    const f12 = s1 * p - s2 * q - k;
    // A_ij = a_iᵀ D b_j; rows/columns (13, 12, cut-off). a13ᵀDb13 = a12ᵀDb12 = A13, a13ᵀDb12 = a12ᵀDb13 = Aac
    const m = [P.A13, P.Aac, AT, P.Aac, P.A13, AT, e1, e1, lg];
    const x = solve3(m, f13, f12, ds);
    if (x && x[0] >= tolM && x[1] >= tolM && x[2] >= tolM) {
      const se = (p * st - k) / q;
      out[0] = st; out[1] = out[2] = Math.min(se, st);
      return true;
    }
  }

  // (e) cut-off vertex s1 = s2 = st on the cone. Active surfaces: planes 13 and 23 and the cut-offs on s1 and s2; the
  // trial must lie in the cone of their flow directions (checked on every set of three, Carathéodory).
  {
    const sv = Math.min((p * st - k) / q, st);
    const vx = s1 - st, vy = s2 - st, vz = s3 - sv;
    const g = [e1, l2s, e3, l2s, e1, e3, lg, lam, lam, lam, lg, lam];   // D b13, D b23, D bt1, D bt2
    for (let omit = 0; omit < 4; omit++) {
      const c = [0, 1, 2, 3].filter((i) => i !== omit);
      const m = [g[3 * c[0]], g[3 * c[1]], g[3 * c[2]], g[3 * c[0] + 1], g[3 * c[1] + 1], g[3 * c[2] + 1],
        g[3 * c[0] + 2], g[3 * c[1] + 2], g[3 * c[2] + 2]];
      const x = solve3(m, vx, vy, vz);
      if (x && x[0] >= tolM && x[1] >= tolM && x[2] >= tolM) { out[0] = out[1] = st; out[2] = sv; return true; }
    }
  }
  return false;
}

// Cramer's rule for a 3×3 system (row-major m); null if singular.
function solve3(m, b0, b1, b2) {
  const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  if (!(Math.abs(det) > 1e-300)) return null;
  const x0 = (b0 * (m[4] * m[8] - m[5] * m[7]) - m[1] * (b1 * m[8] - m[5] * b2) + m[2] * (b1 * m[7] - m[4] * b2)) / det;
  const x1 = (m[0] * (b1 * m[8] - m[5] * b2) - b0 * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * b2 - b1 * m[6])) / det;
  const x2 = (m[0] * (m[4] * b2 - b1 * m[7]) - m[1] * (m[3] * b2 - b1 * m[6]) + b0 * (m[3] * m[7] - m[4] * m[6])) / det;
  return [x0, x1, x2];
}

// Cut-off vertex: s1 = s2 = st on the cone, s3 = (p st - k) / q  (admissible because st <= c cotφ).
function vertex(P, out, st) {
  const s3 = (P.p * st - P.k) / P.q;
  out[0] = st; out[1] = st; out[2] = Math.min(s3, st);
}

/**
 * Yield function value f13 (compression/tension-positive) for a stress vector — handy for tests/diagnostics.
 * Returns the maximum of the MC function over principal permutations (= f13 for sorted values) and the tension check.
 */
export function yieldValue(P, sig, o) {
  const m = 0.5 * (sig[o] + sig[o + 1]), d = 0.5 * (sig[o] - sig[o + 1]);
  const R = Math.sqrt(d * d + sig[o + 2] * sig[o + 2]);
  const hi = Math.max(m + R, sig[o + 3]), lo = Math.min(m - R, sig[o + 3]);
  return { f: hi * P.p - lo * P.q - P.k, ft: P.hasCut ? hi - P.st : -Infinity };
}
