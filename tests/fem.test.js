// FE solver tests: linear algebra, constitutive model, elastic benchmarks, bearing capacity, slope SRM, staging, worker.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { solve } from '../src/fem/solver.js';
import { SkylineLDL, buildNodeGraph, reverseCuthillMcKee } from '../src/fem/sparse.js';
import { makeMaterialParams, updateStress, mcReturn, yieldValue, defaultK0 } from '../src/fem/material.js';
import { buildGeometry, elementStiffness } from '../src/fem/elements.js';
import { nestedDissectionOrder, SparseCholesky, buildUpperPattern } from '../src/fem/cholesky.js';
import { handleMessage, collectTransferables } from '../src/fem/worker.js';
import { createEmptyModel, defaultMaterial, createExampleSlope } from '../src/core/model.js';
import { gridMesh, rectMesh, rectModel, slopeMesh } from './fem-helpers.js';

const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(b), 1e-12);
const elementStiffnessForTest = (geo, e, ke) => elementStiffness(geo, e, 1000, 800, ke);
const constrainedModulus = (E, nu) => (E * (1 - nu)) / ((1 + nu) * (1 - 2 * nu));

function nodeAt(mesh, x, y, tol = 1e-9) {
  for (let n = 0; n < mesh.nodes.length / 2; n++) {
    if (Math.abs(mesh.nodes[2 * n] - x) < tol && Math.abs(mesh.nodes[2 * n + 1] - y) < tol) return n;
  }
  throw new Error(`no node at ${x},${y}`);
}
const sum = (arr, start, step) => { let s = 0; for (let i = start; i < arr.length; i += step) s += arr[i]; return s; };

// ───────────────────────────── sparse solver ─────────────────────────────
describe('sparse skyline LDLt + RCM', () => {
  test('LDLt solves a random banded SPD system', () => {
    const n = 60;
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const first = new Int32Array(n);
    for (let i = 0; i < n; i++) first[i] = Math.max(0, i - 1 - Math.floor(rnd() * 6));
    const K = new SkylineLDL(n, first);
    for (let i = 0; i < n; i++) {
      K.add(i, i, 8 + rnd());
      for (let j = first[i]; j < i; j++) K.add(i, j, rnd() - 0.5);
    }
    const x = Float64Array.from({ length: n }, () => rnd() - 0.5);
    const b = K.mulUnfactored(x);
    K.factor();
    K.solve(b);
    let e = 0; for (let i = 0; i < n; i++) e = Math.max(e, Math.abs(b[i] - x[i]));
    assert.ok(e < 1e-12, `max error ${e}`);
  });

  test('singular matrix is detected', () => {
    const K = new SkylineLDL(2, Int32Array.from([0, 0]));
    K.add(0, 0, 1); K.add(1, 1, 1); K.add(1, 0, 1);
    assert.throws(() => K.factor(), /Singular/);
  });

  test('RCM returns a valid permutation and reduces bandwidth of a scrambled grid', () => {
    const mesh = rectMesh(0, 10, 0, 2, 40, 8, 'T3');
    const nN = mesh.nodes.length / 2;
    // scramble node numbering
    const perm = Array.from({ length: nN }, (_, i) => i).sort((a, b) => ((a * 7919) % 1013) - ((b * 7919) % 1013));
    const inv = new Int32Array(nN); perm.forEach((old, nw) => { inv[old] = nw; });
    const conn = Int32Array.from(mesh.elements, (n) => inv[n]);
    const g = buildNodeGraph(nN, conn, 3);
    const order = reverseCuthillMcKee(nN, g.xadj, g.adj);
    assert.equal(order.length, nN);
    assert.equal(new Set(order).size, nN);
    const pos = new Int32Array(nN); order.forEach((n, i) => { pos[n] = i; });
    const bw = (p) => { let m = 0; for (let i = 0; i < nN; i++) for (let k = g.xadj[i]; k < g.xadj[i + 1]; k++) m = Math.max(m, Math.abs(p(i) - p(g.adj[k]))); return m; };
    const before = bw((i) => i), after = bw((i) => pos[i]);
    assert.ok(after < before / 5, `bandwidth ${before} -> ${after}`);
    assert.ok(after <= 40, `RCM bandwidth ${after}`);
  });
});

describe('sparse Cholesky + nested dissection', () => {
  test('nested dissection is a valid permutation and the sparse factor solves like the skyline solver', () => {
    const mesh = rectMesh(0, 12, 0, 6, 24, 12, 'T6');
    const nN = mesh.nodes.length / 2;
    const act = new Uint8Array(mesh.elementRegion.length).fill(1);
    const g = buildNodeGraph(nN, mesh.elements, 6, act, null);
    const order = nestedDissectionOrder(mesh.nodes, g.xadj, g.adj, null);
    assert.equal(order.length, nN);
    assert.equal(new Set(order).size, nN);
    // fix the bottom edge (all dofs) to make the problem SPD
    const eq = new Int32Array(2 * nN).fill(-1);
    let neq = 0;
    for (const n of order) for (let d = 0; d < 2; d++) if (mesh.nodes[2 * n + 1] > 1e-9) eq[2 * n + d] = neq++;
    const pat = buildUpperPattern(neq, eq, mesh.elements, 6, act);
    const Ks = new SparseCholesky(neq, pat.colPtr, pat.colRows);
    const first = Int32Array.from({ length: neq }, (_, i) => i);
    const geo = buildGeometry(mesh);
    const ke = new Float64Array(144);
    const dofEq = new Int32Array(12);
    const loadEq = (e) => { for (let a = 0; a < 6; a++) { const n = mesh.elements[e * 6 + a]; dofEq[2 * a] = eq[2 * n]; dofEq[2 * a + 1] = eq[2 * n + 1]; } };
    for (let e = 0; e < mesh.elementRegion.length; e++) {
      loadEq(e);
      let mn = Infinity; for (const q of dofEq) if (q >= 0 && q < mn) mn = q;
      for (const q of dofEq) if (q >= 0 && mn < first[q]) first[q] = mn;
    }
    const Kk = new SkylineLDL(neq, first);
    for (let e = 0; e < mesh.elementRegion.length; e++) {
      elementStiffnessForTest(geo, e, ke);
      loadEq(e);
      for (let a = 0; a < 12; a++) for (let b = 0; b < 12; b++) {
        if (dofEq[a] >= 0 && dofEq[b] >= 0 && dofEq[a] >= dofEq[b]) { Ks.add(dofEq[a], dofEq[b], ke[a * 12 + b]); Kk.add(dofEq[a], dofEq[b], ke[a * 12 + b]); }
      }
    }
    Ks.factor(); Kk.factor();
    const b1 = Float64Array.from({ length: neq }, (_, i) => Math.sin(i));
    const b2 = b1.slice();
    Ks.solve(b1); Kk.solve(b2);
    let e = 0, m = 0; for (let i = 0; i < neq; i++) { e = Math.max(e, Math.abs(b1[i] - b2[i])); m = Math.max(m, Math.abs(b2[i])); }
    assert.ok(e < 1e-9 * m, `difference ${e} (max ${m})`);
    assert.ok(Ks.nnzL < 1.2 * Kk.nnz, `nested dissection fill ${Ks.nnzL} vs skyline ${Kk.nnz}`);
  });

  test('forcing either direct solver gives the same FE results (column + slope SRM)', () => {
    const run = (ds) => {
      const model = createExampleSlope();
      model.settings.directSolver = ds;
      return solve(model, slopeMesh(8, 8, 8, 6, 'T6'));
    };
    const a = run('skyline'), b = run('sparse');
    assert.ok(a.ok && b.ok);
    assert.equal(a.fos, b.fos);
    // compare the converged near-failure state (the returned last stage is the non-equilibrium state of the last
    // failed trial, which depends on round-off through the iteration history)
    const da = a.fosStages.stable.displacement, db = b.fosStages.stable.displacement;
    let d = 0, m = 0;
    for (let i = 0; i < da.length; i++) { d = Math.max(d, Math.abs(da[i] - db[i])); m = Math.max(m, Math.abs(da[i])); }
    assert.ok(d < 1e-3 * m, `displacement difference ${d} (max ${m})`);
  });
});

// ───────────────────────────── constitutive model ─────────────────────────────
describe('Mohr-Coulomb return mapping', () => {
  const mat = (o) => defaultMaterial({ E: 1e4, nu: 0.3, c: 5, phi: 30, psi: 0, tensile: 0, ...o });
  let seed = 11;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };

  test('stress inside the yield surface is unchanged (elastic)', () => {
    const P = makeMaterialParams(mat({}), 1, true);
    const s = Float64Array.from([-100, -150, 10, -120]);
    const flag = mcReturn(P, s, 0);
    assert.equal(flag, 0);
    assert.deepEqual(Array.from(s), [-100, -150, 10, -120]);
  });

  test('returned stresses are admissible (f <= 0) for random trial states, with and without tension cut-off', () => {
    for (const cut of [false, true]) {
      for (const [phi, psi, c] of [[30, 0, 5], [30, 30, 5], [20, 5, 0], [0, 0, 10], [40, 10, 2]]) {
        const P = makeMaterialParams(mat({ phi, psi, c, tensile: cut ? 3 : 0 }), 1, cut);
        for (let t = 0; t < 3000; t++) {
          const s = Float64Array.from([(rnd() - 0.6) * 800, (rnd() - 0.6) * 800, (rnd() - 0.5) * 300, (rnd() - 0.6) * 800]);
          const flag = mcReturn(P, s, 0);
          const y = yieldValue(P, s, 0);
          const scale = 1 + Math.abs(s[0]) + Math.abs(s[1]) + Math.abs(s[3]);
          assert.ok(y.f <= 1e-8 * scale, `f=${y.f} phi=${phi} psi=${psi} cut=${cut} flag=${flag}`);
          if (cut) assert.ok(y.ft <= 1e-8 * scale, `ft=${y.ft}`);
        }
      }
    }
  });

  test('associated flow (psi = phi): result is the closest point in the energy norm (convex projection)', () => {
    for (const cut of [false, true]) {
      const m = mat({ phi: 30, psi: 30, c: 5, tensile: cut ? 4 : 0 });
      const P = makeMaterialParams(m, 1, cut);
      // work in principal space: energy norm uses the elastic compliance
      const lam = P.lam, G = P.G;
      const E = (a, b) => { // (a-b)ᵀ D⁻¹ (a-b) for principal triples
        const d = [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
        const tr = d[0] + d[1] + d[2];
        const K = lam + (2 * G) / 3;
        const dev = d.map((v) => v - tr / 3);
        return tr * tr / (9 * K) + (dev[0] ** 2 + dev[1] ** 2 + dev[2] ** 2) / (2 * G);
      };
      const adm = (v) => {
        const [a, b, c3] = v.slice().sort((x, y) => y - x);
        return a * P.p - c3 * P.q - P.k <= 1e-9 && (!cut || a <= P.st + 1e-9);
      };
      let checked = 0;
      for (let t = 0; t < 120; t++) {
        // diagonal stress state (principal directions fixed): sxx, syy, szz principal, sxy = 0
        const tr = [(rnd() - 0.5) * 600, (rnd() - 0.5) * 600, (rnd() - 0.5) * 600];
        if (adm(tr)) continue;
        const s = Float64Array.from([tr[0], tr[1], 0, tr[2]]);
        mcReturn(P, s, 0);
        const res = [s[0], s[1], s[3]];
        assert.ok(adm(res), 'result admissible');
        const d0 = E(tr, res);
        // random admissible competitors must not be closer
        for (let k = 0; k < 600; k++) {
          const cand = res.map((v) => v + (rnd() - 0.5) * 10 * (k % 5 === 0 ? 5 : 1));
          if (!adm(cand)) continue;
          assert.ok(E(tr, cand) >= d0 * (1 - 1e-9) - 1e-12, `closer admissible point found (${E(tr, cand)} < ${d0})`);
        }
        checked++;
      }
      assert.ok(checked > 30);
    }
  });

  test('tension cut-off return agrees with a brute-force active-set return (all 6 MC planes + 3 cut-off planes)', () => {
    const solveLin = (A, b) => {
      const n = b.length; A = A.map((r) => r.slice()); b = b.slice();
      for (let i = 0; i < n; i++) {
        let pv = i;
        for (let k = i + 1; k < n; k++) if (Math.abs(A[k][i]) > Math.abs(A[pv][i])) pv = k;
        [A[i], A[pv]] = [A[pv], A[i]]; [b[i], b[pv]] = [b[pv], b[i]];
        if (Math.abs(A[i][i]) < 1e-14) return null;
        for (let k = i + 1; k < n; k++) { const f = A[k][i] / A[i][i]; for (let j = i; j < n; j++) A[k][j] -= f * A[i][j]; b[k] -= f * b[i]; }
      }
      const x = new Array(n);
      for (let i = n - 1; i >= 0; i--) { let t = b[i]; for (let j = i + 1; j < n; j++) t -= A[i][j] * x[j]; x[i] = t / A[i][i]; }
      return x;
    };
    // every admissible active set of up to 3 surfaces with non-negative multipliers → candidate returns
    const brute = (Pm, s3) => {
      const { lam, G } = Pm;
      const D = (v) => { const t = lam * (v[0] + v[1] + v[2]); return v.map((x) => t + 2 * G * x); };
      const planes = [];
      for (const [i, j] of [[0, 2], [0, 1], [1, 2], [1, 0], [2, 0], [2, 1]]) {
        const a = [0, 0, 0], b = [0, 0, 0]; a[i] = Pm.p; a[j] = -Pm.q; b[i] = Pm.pp; b[j] = -Pm.qq;
        planes.push({ a, b, c: Pm.k });
      }
      for (let i = 0; i < 3; i++) { const a = [0, 0, 0]; a[i] = 1; planes.push({ a, b: a, c: Pm.st }); }
      const fval = (pl, s) => pl.a[0] * s[0] + pl.a[1] * s[1] + pl.a[2] * s[2] - pl.c;
      const tol = 1e-7 * (1 + Math.abs(s3[0]) + Math.abs(s3[2]));
      const sols = [];
      for (let mask = 1; mask < (1 << planes.length); mask++) {
        const act = [];
        for (let i = 0; i < planes.length; i++) if (mask & (1 << i)) act.push(i);
        if (act.length > 3) continue;
        const Db = act.map((i) => D(planes[i].b));
        const A = act.map((i) => act.map((_, jj) => planes[i].a.reduce((acc, ai, k) => acc + ai * Db[jj][k], 0)));
        const x = solveLin(A, act.map((i) => fval(planes[i], s3)));
        if (!x || x.some((v) => v < -1e-9)) continue;
        const r = s3.map((v, k) => v - act.reduce((acc, _, jj) => acc + x[jj] * Db[jj][k], 0));
        if (planes.every((pl) => fval(pl, r) <= tol * 10)) sols.push(r.slice().sort((a, b) => b - a));
      }
      return sols;
    };
    let checked = 0;
    for (const m of [
      { phi: 30, psi: 10, c: 10, tensile: 5 }, { phi: 30, psi: 0, c: 10, tensile: 0 }, { phi: 35, psi: 35, c: 0, tensile: 0 },
      { phi: 0, psi: 0, c: 20, tensile: 0 }, { phi: 0, psi: 0, c: 20, tensile: 100 }, { phi: 25, psi: 5, c: 15, tensile: 100 },
      { phi: 20, psi: 20, c: 5, tensile: 2 }, { phi: 40, psi: 0, c: 1, tensile: 0.5 },
    ]) {
      const Pm = makeMaterialParams(mat(m), 1, true);
      for (let t = 0; t < 1500; t++) {
        const s = [(rnd() - 0.6) * 200, (rnd() - 0.6) * 200, (rnd() - 0.6) * 200].sort((a, b) => b - a);
        const sig = Float64Array.from([s[0], s[2], 0, s[1]]);
        mcReturn(Pm, sig, 0);
        const got = [sig[0], sig[3], sig[1]].sort((a, b) => b - a);
        const sols = brute(Pm, s);
        if (sols.length === 0) {   // elastic (or no reference): the stress must be unchanged
          assert.ok(Math.max(...got.map((v, i) => Math.abs(v - s[i]))) < 1e-6, `elastic trial changed ${JSON.stringify(s)}`);
          continue;
        }
        const best = Math.min(...sols.map((r) => Math.max(...got.map((v, i) => Math.abs(v - r[i])))));
        assert.ok(best < 1e-4 * (1 + Math.abs(s[2])),
          `phi=${m.phi} psi=${m.psi} c=${m.c} st=${m.tensile} trial ${JSON.stringify(s)} got ${JSON.stringify(got)} ref ${JSON.stringify(sols)}`);
        checked++;
      }
    }
    assert.ok(checked > 8000);
  });

  test('cut-off return to the cone edge s2 = s3 (regression: intermediate stress must not jump to the tensile limit)', () => {
    const P = makeMaterialParams(mat({ phi: 30, psi: 0, c: 10, tensile: 0 }), 1, true);
    const s = Float64Array.from([68.84, -64.81, 0, -30.08]);   // principal (sxx, syy, szz) = (68.84, -64.81, -30.08)
    assert.equal(mcReturn(P, s, 0), 2);
    const got = [s[0], s[1], s[3]].sort((a, b) => b - a);
    const sRet = (P.p * 0 - P.k) / P.q;   // -34.64
    assert.ok(Math.abs(got[0]) < 1e-6 && Math.abs(got[1] - sRet) < 1e-6 && Math.abs(got[2] - sRet) < 1e-6, JSON.stringify(got));
    // Tresca (phi = 0): (0, -c·2, -c·2) edge, not (0, 0, -2c)
    const P0 = makeMaterialParams(mat({ phi: 0, psi: 0, c: 20, tensile: 0 }), 1, true);
    const s0 = Float64Array.from([68.84, -64.81, 0, -30.08]);
    mcReturn(P0, s0, 0);
    const g0 = [s0[0], s0[1], s0[3]].sort((a, b) => b - a);
    assert.ok(Math.abs(g0[0]) < 1e-6 && Math.abs(g0[1] + 40) < 1e-6 && Math.abs(g0[2] + 40) < 1e-6, JSON.stringify(g0));
  });

  test('apex return and tension cut-off', () => {
    const P0 = makeMaterialParams(mat({ phi: 30, c: 5, tensile: 0 }), 1, false);
    const apex = 5 / Math.tan((30 * Math.PI) / 180);
    const s = Float64Array.from([200, 200, 0, 200]);
    assert.equal(mcReturn(P0, s, 0), 1);
    for (const i of [0, 1, 3]) assert.ok(Math.abs(s[i] - apex) < 1e-9, `apex ${s[i]} vs ${apex}`);
    const P1 = makeMaterialParams(mat({ phi: 30, c: 5, tensile: 0 }), 1, true);
    const s2 = Float64Array.from([200, 200, 0, 200]);
    assert.equal(mcReturn(P1, s2, 0), 2);
    for (const i of [0, 1, 3]) assert.ok(Math.abs(s2[i]) < 1e-9);
    // finite tensile strength: states whose MC return would stay above the cut-off end exactly on the cut-off
    const P2 = makeMaterialParams(mat({ phi: 30, c: 5, tensile: 2 }), 1, true);
    let nCut = 0;
    for (const t of [[50, -5, 0, -5], [30, 20, 0, 25], [60, 10, 5, -3], [20, -2, 0, 15], [100, 90, 0, 80]]) {
      const s3 = Float64Array.from(t);
      const flag = mcReturn(P2, s3, 0);
      const mx = Math.max(s3[0], s3[1], s3[3]);
      assert.ok(mx <= 2 + 1e-9, `max principal-ish ${mx}`);
      if (flag === 2) { nCut++; assert.ok(yieldValue(P2, s3, 0).ft > -1e-9, 'on the cut-off'); }
    }
    assert.ok(nCut >= 2, `cut-off active in ${nCut} cases`);
  });

  test('simple shear to failure ends on the yield surface; strength reduction reduces the strength', () => {
    const m = mat({ phi: 25, psi: 0, c: 8 });
    const sig = new Float64Array(4);
    sig[0] = -100; sig[1] = -100; sig[3] = -100;
    const P = makeMaterialParams(m, 1, true);
    for (let i = 0; i < 400; i++) updateStress(P, sig, 0, 0, 0, 1e-4);
    // pure shear on isotropic -100: failure when tau = c cosφ + (p) sinφ ... with p the mean of in-plane stresses (-100)
    const phi = (25 * Math.PI) / 180;
    const tauMax = 8 * Math.cos(phi) + 100 * Math.sin(phi);
    assert.ok(Math.abs(sig[2] - tauMax) / tauMax < 0.02, `tau=${sig[2]} expected ${tauMax}`);
    const P2 = makeMaterialParams(m, 2, true);
    const sig2 = Float64Array.from([-100, -100, 0, -100]);
    for (let i = 0; i < 400; i++) updateStress(P2, sig2, 0, 0, 0, 1e-4);
    assert.ok(sig2[2] < sig[2] * 0.7);
  });

  test('defaultK0 follows Jaky for Mohr-Coulomb and nu/(1-nu) for elastic', () => {
    assert.ok(Math.abs(defaultK0({ model: 'mohr-coulomb', phi: 30 }) - 0.5) < 1e-12);
    assert.ok(Math.abs(defaultK0({ model: 'linear-elastic', nu: 0.25 }) - 1 / 3) < 1e-12);
    assert.equal(defaultK0({ model: 'mohr-coulomb', phi: 30, K0: 0.8 }), 0.8);
  });
});

// ───────────────────────────── elements ─────────────────────────────
describe('element geometry', () => {
  test('Gauss weights sum to the area and shape-function derivatives sum to zero (T3, T6)', () => {
    for (const type of ['T3', 'T6']) {
      const mesh = rectMesh(0, 3, 0, 2, 3, 2, type);
      const geo = buildGeometry(mesh);
      assert.ok(Math.abs(geo.w.reduce((a, b) => a + b, 0) - 6) < 1e-12);
      for (let g = 0; g < geo.nGP; g++) {
        let sx = 0, sy = 0, sN = 0;
        for (let a = 0; a < geo.nen; a++) { sx += geo.dndx[g * geo.nen + a]; sy += geo.dndy[g * geo.nen + a]; sN += geo.N[g * geo.nen + a]; }
        assert.ok(Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12 && Math.abs(sN - 1) < 1e-12);
      }
    }
  });
});

// ───────────────────────────── 1. elastic column ─────────────────────────────
describe('1. elastic 1D column (oedometer-like)', () => {
  const E = 1e4, nu = 0.3, H = 10, q = 100, gam = 20;
  const M = constrainedModulus(E, nu);
  for (const type of ['T3', 'T6']) {
    test(`${type}: surface pressure → uy = -q H / M, syy = -q, sxx/syy = nu/(1-nu)`, () => {
      const model = rectModel(0, 1, 0, H, { model: 'linear-elastic', E, nu, gammaUnsat: 0, gammaSat: 0 });
      model.loads.push({ id: 'Q1', type: 'distributed', p1: [0, H], p2: [1, H], qx1: 0, qy1: -q, qx2: 0, qy2: -q });
      const mesh = rectMesh(0, 1, 0, H, 2, 10, type);
      const res = solve(model, mesh);
      assert.ok(res.ok, res.message);
      const st = res.stages[0];
      const top = nodeAt(mesh, 0, H);
      const uy = st.displacement[2 * top + 1];
      assert.ok(rel(uy, -(q * H) / M) < 1e-3, `uy=${uy} expected ${-(q * H) / M}`);
      for (let g = 0; g < st.gp.syy.length; g++) {
        assert.ok(rel(st.gp.syy[g], -q) < 1e-6, `syy ${st.gp.syy[g]}`);
        assert.ok(rel(st.gp.sxx[g], (-q * nu) / (1 - nu)) < 1e-6);
        assert.ok(Math.abs(st.gp.szz[g] - st.gp.sxx[g]) < 1e-6);
      }
      assert.ok(Math.abs(sum(st.reactions, 1, 2) - q * 1) < 1e-8, 'vertical reaction = applied load');
      assert.equal(st.converged, true);
      assert.equal(res.analysis, 'static'); assert.equal(res.fos, null);
    });
  }

  test('gravity: syy = -gamma (H-y), K0 ratio sxx/syy = nu/(1-nu), settlement gamma H²/(2M)', () => {
    const model = rectModel(0, 1, 0, H, { model: 'linear-elastic', E, nu, gammaUnsat: gam, gammaSat: gam });
    const mesh = rectMesh(0, 1, 0, H, 2, 10, 'T6');
    const res = solve(model, mesh);
    assert.ok(res.ok, res.message);
    const st = res.stages[0];
    for (let g = 0; g < st.gp.syy.length; g++) {
      assert.ok(rel(st.gp.syy[g], -gam * (H - st.gp.y[g])) < 1e-8, `syy(y=${st.gp.y[g]})`);
      assert.ok(rel(st.gp.sxx[g] / st.gp.syy[g], nu / (1 - nu)) < 1e-8);
    }
    const top = nodeAt(mesh, 0, H);
    assert.ok(rel(st.displacement[2 * top + 1], -(gam * H * H) / (2 * M)) < 1e-6);
    assert.ok(Math.abs(sum(st.reactions, 1, 2) - gam * H) < 1e-7, 'reaction = weight');
    assert.ok(Math.abs(sum(st.reactions, 0, 2)) < 1e-7, 'no net horizontal reaction');
    assert.equal(st.gp.pore.reduce((a, b) => a + Math.abs(b), 0), 0);
  });

  test('K0 initial stage: support reactions carry the self-weight (same as a gravity stage), also with a water table', () => {
    for (const water of [false, true]) {
      for (const initial of ['gravity', 'k0']) {
        const model = rectModel(0, 1, 0, H, { model: 'linear-elastic', E, nu, gammaUnsat: gam, gammaSat: gam + 2 });
        if (water) model.water = { enabled: true, gammaW: 10, phreatic: [[0, 6], [1, 6]] };
        model.stages = [{ id: 'S0', name: 'I', initial, activeRegions: ['R1'], activeLoads: [], resetDisplacements: true }];
        const res = solve(model, rectMesh(0, 1, 0, H, 2, 10, 'T6'));
        assert.ok(res.ok, res.message);
        const weight = water ? gam * (H - 6) + (gam + 2) * 6 : gam * H;
        const st = res.stages[0];
        assert.ok(Math.abs(sum(st.reactions, 1, 2) - weight) < 1e-6, `${initial} water=${water}: sum Ry ${sum(st.reactions, 1, 2)} vs ${weight}`);
        assert.ok(Math.abs(sum(st.reactions, 0, 2)) < 1e-6);
      }
    }
  });
});

// ───────────────────────────── 2. patch test ─────────────────────────────
describe('2. patch test (uniform stress state, distorted mesh)', () => {
  for (const type of ['T3', 'T6']) {
    test(`${type}: constant stress/strain reproduced exactly`, () => {
      const E = 5e3, nu = 0.25;
      const sx = 50, sy = -30, txy = 20;
      const model = rectModel(0, 1, 0, 1, { model: 'linear-elastic', E, nu, gammaUnsat: 0, gammaSat: 0 });
      model.boundaries = [
        { id: 'B1', type: 'fixity', target: { kind: 'point', p: [0, 0] }, fixX: true, fixY: true },
        { id: 'B2', type: 'fixity', target: { kind: 'point', p: [1, 0] }, fixX: false, fixY: true },
      ];
      const L = (id, p1, p2, qx, qy) => ({ id, type: 'distributed', p1, p2, qx1: qx, qy1: qy, qx2: qx, qy2: qy });
      model.loads.push(L('L', [0, 0], [0, 1], -sx, -txy), L('R', [1, 0], [1, 1], sx, txy),
        L('Bo', [0, 0], [1, 0], -txy, -sy), L('T', [0, 1], [1, 1], txy, sy));
      const n = 4;
      const mesh = gridMesh(n, n, (i, j) => {
        let x = i / n, y = j / n;
        if (i > 0 && i < n && j > 0 && j < n) { x += 0.07 * Math.sin(3 * i + 2 * j); y += 0.07 * Math.cos(2 * i + 5 * j); }
        return [x, y];
      }, type);
      const res = solve(model, mesh);
      assert.ok(res.ok, res.message);
      const st = res.stages[0];
      for (let g = 0; g < st.gp.sxx.length; g++) {
        assert.ok(Math.abs(st.gp.sxx[g] - sx) < 1e-7 * 50, `sxx ${st.gp.sxx[g]}`);
        assert.ok(Math.abs(st.gp.syy[g] - sy) < 1e-7 * 50, `syy ${st.gp.syy[g]}`);
        assert.ok(Math.abs(st.gp.sxy[g] - txy) < 1e-7 * 50, `sxy ${st.gp.sxy[g]}`);
      }
      // exact displacement of the right-top corner from the uniform strain field (plane strain)
      const lam = (E * nu) / ((1 + nu) * (1 - 2 * nu)), G = E / (2 * (1 + nu));
      // stresses -> strains (szz from eps_zz = 0): solve D eps = sigma in 2D
      const exx = ((lam + 2 * G) * sx - lam * sy) / ((lam + 2 * G) ** 2 - lam ** 2);
      const eyy = ((lam + 2 * G) * sy - lam * sx) / ((lam + 2 * G) ** 2 - lam ** 2);
      assert.ok(Math.abs(st.gp.eps_xx[0] - exx) < 1e-10 && Math.abs(st.gp.eps_yy[0] - eyy) < 1e-10);
      assert.ok(Math.abs(st.gp.gxy[0] - txy / G) < 1e-10);
      assert.ok(Math.abs(st.gp.szz[0] - lam * (exx + eyy)) < 1e-6);
    });
  }
});

// ───────────────────────────── 3. beam in pure bending ─────────────────────────────
describe('3. plane-strain beam in pure bending (T6 exact, T3 converging)', () => {
  const E = 1e5, nu = 0.25, L = 10, h = 2, s = 100;
  const Ep = E / (1 - nu * nu);
  const kappa = s / Ep;
  function run(type, nx, ny, distort) {
    const model = rectModel(0, L, -h / 2, h / 2, { model: 'linear-elastic', E, nu, gammaUnsat: 0, gammaSat: 0 });
    model.boundaries = [
      { id: 'B1', type: 'fixity', target: { kind: 'segment', p1: [0, -h / 2], p2: [0, h / 2] }, fixX: true, fixY: false },
      { id: 'B2', type: 'fixity', target: { kind: 'point', p: [0, 0] }, fixX: false, fixY: true },
    ];
    model.loads.push({ id: 'M', type: 'distributed', p1: [L, -h / 2], p2: [L, h / 2], qx1: s, qy1: 0, qx2: -s, qy2: 0 });
    const mesh = gridMesh(nx, ny, (i, j) => {
      let x = (L * i) / nx, y = -h / 2 + (h * j) / ny;
      if (distort && i > 0 && i < nx && j > 0 && j < ny) { x += 0.15 * Math.sin(3 * i + j); y += 0.1 * Math.cos(i + 4 * j); }
      return [x, y];
    }, type);
    const res = solve(model, mesh);
    assert.ok(res.ok, res.message);
    return { res, mesh };
  }
  test('T6 on a distorted mesh reproduces the exact bending solution', () => {
    const { res, mesh } = run('T6', 10, 4, true);
    const st = res.stages[0];
    const tip = nodeAt(mesh, L, 0);
    const uy = st.displacement[2 * tip + 1];
    assert.ok(rel(uy, (kappa * L * L) / 2) < 1e-6, `uy=${uy} expected ${(kappa * L * L) / 2}`);
    const top = nodeAt(mesh, L, h / 2);
    assert.ok(rel(st.displacement[2 * top], -kappa * L * (h / 2)) < 1e-6);
    // stress linear in y, uniform in x
    for (let g = 0; g < st.gp.sxx.length; g++) assert.ok(Math.abs(st.gp.sxx[g] + s * st.gp.y[g] / (h / 2)) < 1e-5, `sxx ${st.gp.sxx[g]}`);
  });
  test('T3 approaches the solution on a fine mesh (error shrinks with refinement)', () => {
    const err = (nx, ny) => {
      const { res, mesh } = run('T3', nx, ny, false);
      const tip = nodeAt(mesh, L, 0);
      return Math.abs(res.stages[0].displacement[2 * tip + 1] - (kappa * L * L) / 2) / ((kappa * L * L) / 2);
    };
    const e1 = err(10, 2), e2 = err(40, 8);
    assert.ok(e2 < e1 && e2 < 0.1, `errors ${e1} -> ${e2}`);
  });
});

// ───────────────────────────── 4. Prandtl bearing capacity ─────────────────────────────
function gradedAxis(n0, h0, L, n1) {
  const xs = [0];
  for (let i = 1; i <= n0; i++) xs.push(i * h0);
  const rem = L - n0 * h0;
  let lo = 1.0001, hi = 3;
  for (let k = 0; k < 100; k++) { const r = (lo + hi) / 2; const sm = (h0 * r * (r ** n1 - 1)) / (r - 1); if (sm > rem) hi = r; else lo = r; }
  const r = (lo + hi) / 2;
  let hh = h0;
  for (let i = 0; i < n1; i++) { hh *= r; xs.push(xs[xs.length - 1] + hh); }
  return xs;
}

describe('4. Prandtl bearing capacity (weightless phi=0 soil, strip footing)', () => {
  test('limit load q_ult/c between 5.0 and 5.6 (Prandtl 5.14)', () => {
    const c = 10, D = 6, b = 1, qmax = 6 * c;
    const xs = gradedAxis(4, 0.25, 10, 10), ds = gradedAxis(4, 0.25, D, 8);
    const mesh = gridMesh(xs.length - 1, ds.length - 1, (i, j) => [xs[i], D - ds[j]], 'T6');
    const m = createEmptyModel();
    m.materials.push(defaultMaterial({ id: 'M1', model: 'mohr-coulomb', E: 1e5, nu: 0.49, c, phi: 0, psi: 0, gammaUnsat: 0, gammaSat: 0 }));
    m.regions.push({ id: 'R1', name: 'Clay', materialId: 'M1', points: [[0, 0], [10, 0], [10, D], [0, D]] });
    m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });   // symmetry plane at x = 0
    m.loads.push({ id: 'Q', type: 'distributed', p1: [0, D], p2: [b, D], qx1: 0, qy1: -qmax, qx2: 0, qy2: -qmax });
    m.settings.loadSteps = 15;
    m.settings.fos.tensionCutoff = false;   // pure Tresca (no cut-off) for the classical solution
    const res = solve(m, mesh);
    const st = res.stages[0];
    const last = st.steps[st.steps.length - 1];
    const qult = (last.loadFactor * qmax) / c;
    console.log(`      Prandtl: max converged q/c = ${qult.toFixed(3)} (Prandtl 5.14), load steps ${st.steps.length}, ok=${res.ok}`);
    assert.ok(qult >= 5.0 && qult <= 5.6, `q_ult/c = ${qult}`);
    // load–displacement: before failure the response is stiff, near q_ult the settlement increases quickly
    const at = (f) => st.steps.find((s) => (s.loadFactor * qmax) / c >= f);
    assert.ok(at(4.0).maxDisp < 0.7 * last.maxDisp);
    assert.equal(st.converged, last.loadFactor >= 1 - 1e-12);   // either completes (not expected) or stops at collapse
    assert.ok(!res.ok || st.converged);
    // the stage reports the last converged state in equilibrium: yielded points exist along the mechanism
    assert.ok(st.gp.plastic.some((v) => v === 1));
  });
});

// ───────────────────────────── 5. slope SRM ─────────────────────────────
describe('5. slope stability by strength reduction (example slope)', () => {
  test('FOS in [1.30, 1.50] (Bishop ≈ 1.38) with a failure mechanism in the last stage', () => {
    const model = createExampleSlope();
    const mesh = slopeMesh(12, 12, 12, 10, 'T6');
    const t0 = Date.now();
    const res = solve(model, mesh);
    const dt = Date.now() - t0;
    console.log(`      Slope SRM: FOS = ${res.fos?.toFixed(3)}  (${res.message}), ${mesh.stats.nNodes} nodes, ${dt} ms, trials ${res.fosHistory.length}`);
    assert.ok(res.ok, res.message);
    assert.equal(res.analysis, 'fos');
    assert.ok(res.fos >= 1.30 && res.fos <= 1.50, `FOS ${res.fos}`);
    assert.ok(res.fosHistory.length >= 5);
    assert.equal(res.fosHistory[0].srf, 1);
    assert.equal(res.fosHistory[0].converged, true);
    // history is a valid bracketing sequence: lowest failing SRF > largest converged SRF within tol
    const conv = res.fosHistory.filter((h) => h.converged).map((h) => h.srf);
    const fail = res.fosHistory.filter((h) => !h.converged).map((h) => h.srf);
    assert.ok(Math.max(...conv) < Math.min(...fail));
    assert.ok(Math.min(...fail) - Math.max(...conv) <= model.settings.fos.tol + 1e-12);
    const last = res.stages[res.stages.length - 1];
    assert.equal(last.converged, false);            // last failed trial
    assert.ok(last.srf > res.fos - 1e-12);
    assert.ok(res.fosStages.stable.converged);
    assert.ok(last.maxDisp >= res.fosHistory[0].maxDisp && last.gp.plastic.filter((v) => v > 0).length > 20, 'plastic zone developed');
    assert.ok(last.activeElements.every((v) => v === 1));
    // internal consistency of the stable near-failure state (equilibrium: reactions balance the weight)
    const area = 60 * 10 + (20 * 10) / 2 + 20 * 10;   // base block + slope triangle + crest block = 900
    assert.ok(rel(sum(res.fosStages.stable.reactions, 1, 2), 20 * area) < 5e-3, `vertical reaction ${sum(res.fosStages.stable.reactions, 1, 2)} vs ${20 * area}`);
  });

  test('FOS does not depend on how the last stage is defined (single gravity stage, single K0 stage, gravity + unchanged stage)', () => {
    const stage = (id, initial) => ({ id, name: id, initial, activeRegions: ['R1'], activeLoads: [], resetDisplacements: true });
    const fosOf = (stages) => {
      const model = createExampleSlope();
      model.stages = stages;
      const res = solve(model, slopeMesh(8, 8, 8, 6, 'T6'));
      assert.ok(res.ok, res.message);
      return res.fos;
    };
    const a = fosOf([stage('S0', 'gravity')]);
    const b = fosOf([stage('S0', 'k0')]);
    const c = fosOf([stage('S0', 'gravity'), stage('S1', 'gravity')]);
    const tol = 2 * createExampleSlope().settings.fos.tol + 1e-9;   // bisection resolution
    assert.ok(Math.abs(a - b) <= tol, `gravity ${a} vs k0 ${b}`);
    assert.ok(Math.abs(a - c) <= tol, `gravity ${a} vs gravity+unchanged ${c}`);
  });

  test('cohesionless slope: FOS close to the infinite-slope value tan(phi)/tan(beta) = 1.155', () => {
    const model = createExampleSlope();
    Object.assign(model.materials[0], { c: 0, phi: 30, psi: 0 });
    const res = solve(model, slopeMesh(12, 12, 12, 10, 'T6'));
    console.log(`      Cohesionless slope (c=0, phi=30): FOS = ${res.fos?.toFixed(3)} (infinite slope 1.155)`);
    assert.ok(res.ok, res.message);
    assert.ok(res.fos > 1.10 && res.fos < 1.25, `FOS ${res.fos}`);
  });

  test('integration with the real mesher (skipped if the mesher module is unavailable)', async (t) => {
    let generateMesh;
    try { ({ generateMesh } = await import('../src/mesh/mesher.js')); } catch { t.skip('mesher not available'); return; }
    const model = createExampleSlope();
    const mesh = generateMesh(model);
    const res = solve(model, mesh);
    console.log(`      Slope with real mesher (${mesh.stats.nNodes} nodes): FOS = ${res.fos?.toFixed(3)}`);
    assert.ok(res.ok, res.message);
    assert.ok(res.fos >= 1.30 && res.fos <= 1.50, `FOS ${res.fos}`);
  });

  test('a linear-elastic slope never fails (FOS reported at the search limit)', () => {
    const model = createExampleSlope();
    model.materials[0].model = 'linear-elastic';
    model.settings.fos.max = 3;
    const res = solve(model, slopeMesh(6, 6, 6, 5, 'T6'));
    assert.ok(res.ok);
    assert.equal(res.fos, 3);
    assert.match(res.message, /exceeds/);
  });
});

// ───────────────────────────── 6. hydrostatic / water ─────────────────────────────
describe('6. hydrostatic pore pressure and effective stress', () => {
  const H = 10, yw = 6, gu = 17, gs = 20, gw = 10;
  test('effective vertical stress below the water table = (gamma_sat - gamma_w) × depth', () => {
    const model = rectModel(0, 1, 0, H, { model: 'linear-elastic', E: 2e4, nu: 0.3, gammaUnsat: gu, gammaSat: gs });
    model.water = { enabled: true, gammaW: gw, phreatic: [[0, yw], [1, yw]] };
    const mesh = rectMesh(0, 1, 0, H, 2, 10, 'T6');
    const res = solve(model, mesh);
    assert.ok(res.ok, res.message);
    const st = res.stages[0];
    for (let g = 0; g < st.gp.syy.length; g++) {
      const y = st.gp.y[g];
      const expected = y >= yw ? -gu * (H - y) : -(gu * (H - yw) + (gs - gw) * (yw - y));
      assert.ok(Math.abs(st.gp.syy[g] - expected) < 1e-6 * Math.max(1, Math.abs(expected)), `y=${y}: ${st.gp.syy[g]} vs ${expected}`);
      assert.ok(Math.abs(st.gp.pore[g] - (y < yw ? gw * (yw - y) : 0)) < 1e-9);
    }
    // total stress (effective − pore, tension positive) carries the full weight at the base
    assert.ok(Math.abs(sum(st.reactions, 1, 2) - (gu * (H - yw) + gs * yw)) < 1e-6, 'reaction = total weight');
  });

  test('phreatic line above the ground (submerged surface): water pressure on the surface, no tension, water weight carried', () => {
    const Hc = 10, hAbove = 3;
    for (const initial of ['gravity', 'k0']) {
      for (const type of ['T3', 'T6']) {
        const model = rectModel(0, 1, 0, Hc, { model: 'linear-elastic', E: 1e4, nu: 0.3, gammaUnsat: 18, gammaSat: 20 });
        model.water = { enabled: true, gammaW: 10, phreatic: [[0, Hc + hAbove], [1, Hc + hAbove]] };
        model.stages = [{ id: 'S0', name: 'I', initial, activeRegions: ['R1'], activeLoads: [], resetDisplacements: true }];
        const mesh = rectMesh(0, 1, 0, Hc, 2, 10, type);
        const res = solve(model, mesh);
        assert.ok(res.ok, res.message);
        assert.ok(res.warnings.some((w) => /phreatic/.test(w)), 'warning about the submerged surface');
        const st = res.stages[0];
        for (let g = 0; g < st.gp.syy.length; g++) {
          const y = st.gp.y[g];
          // total vertical stress = water column + saturated soil; u = gamma_w (13 - y)
          const expected = -(10 * hAbove + 20 * (Hc - y)) + 10 * (Hc + hAbove - y);
          if (type === 'T6') assert.ok(Math.abs(st.gp.syy[g] - expected) < 1e-6, `${initial} y=${y}: ${st.gp.syy[g]} vs ${expected}`);
          assert.ok(st.gp.syy[g] < 0, `${initial} ${type}: effective syy must be compressive, got ${st.gp.syy[g]}`);
        }
        // supports carry soil + water weight
        assert.ok(Math.abs(sum(st.reactions, 1, 2) - (20 * Hc + 10 * hAbove)) < 1e-6, `sum Ry ${sum(st.reactions, 1, 2)}`);
      }
    }
  });

  test('excavation below an unchanged phreatic line: no tension at the excavation floor, water weight carried', () => {
    const m = createEmptyModel();
    m.materials.push(defaultMaterial({ id: 'M1', model: 'linear-elastic', E: 1e4, nu: 0.3, gammaUnsat: 18, gammaSat: 20 }));
    m.regions.push({ id: 'R1', name: 'a', materialId: 'M1', points: [[0, 0], [4, 0], [4, 6], [0, 6]] });
    m.regions.push({ id: 'R2', name: 'b', materialId: 'M1', points: [[0, 6], [4, 6], [4, 10], [0, 10]] });
    m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });
    m.water = { enabled: true, gammaW: 10, phreatic: [[0, 8], [4, 8]] };
    m.stages = [
      { id: 'S0', name: 'a', initial: 'gravity', activeRegions: ['R1', 'R2'], activeLoads: [], resetDisplacements: true },
      { id: 'S1', name: 'b', initial: 'gravity', activeRegions: ['R1'], activeLoads: [], resetDisplacements: true },
    ];
    const res = solve(m, rectMesh(0, 4, 0, 10, 4, 10, 'T6', (ci, cj) => (cj < 6 ? 0 : 1)));
    assert.ok(res.ok, res.message);
    const st = res.stages[1];
    for (let g = 0; g < st.gp.syy.length; g++) {
      if (!st.activeElements[st.gp.elem[g]]) continue;
      assert.ok(st.gp.syy[g] <= 1e-9, `syy' ${st.gp.syy[g]} at y=${st.gp.y[g]} must not be tensile`);
    }
    assert.ok(Math.abs(sum(st.reactions, 1, 2) - 4 * (20 * 6 + 10 * 2)) < 1e-6, `sum Ry ${sum(st.reactions, 1, 2)}`);
    assert.ok(res.warnings.some((w) => /Stage "b"/.test(w)));
  });

  test('lake against a slope: vertical reaction = soil + water weight, horizontal = hydrostatic thrust on the face', () => {
    for (const type of ['T3', 'T6']) {
      const model = createExampleSlope();
      model.settings.analysis = 'static';
      Object.assign(model.materials[0], { model: 'linear-elastic', gammaUnsat: 20, gammaSat: 20 });
      model.water = { enabled: true, gammaW: 10, phreatic: [[0, 14], [60, 14]] };
      const res = solve(model, slopeMesh(12, 12, 12, 10, type));
      assert.ok(res.ok, res.message);
      const st = res.stages[0];
      // water: 4 m over the flat toe (x < 20, area 80) + wedge over the slope face (area 16)
      assert.ok(Math.abs(sum(st.reactions, 1, 2) - (20 * 900 + 10 * 96)) < 1e-6, `sum Ry ${sum(st.reactions, 1, 2)}`);
      assert.ok(Math.abs(sum(st.reactions, 0, 2) + 0.5 * 10 * 16) < 1e-6, `sum Rx ${sum(st.reactions, 0, 2)}`);
    }
  });

  test('K0 initial stress with water table (MC soil): sigma_v hydrostatic, sigma_h = K0 sigma_v, zero displacement', () => {
    const model = rectModel(0, 1, 0, H, { model: 'mohr-coulomb', E: 2e4, nu: 0.3, c: 5, phi: 30, gammaUnsat: gu, gammaSat: gs });
    model.water = { enabled: true, gammaW: gw, phreatic: [[0, yw], [1, yw]] };
    model.stages = [{ id: 'S0', name: 'K0', initial: 'k0', activeRegions: ['R1'], activeLoads: [], resetDisplacements: true }];
    const mesh = rectMesh(0, 1, 0, H, 2, 10, 'T6');
    const res = solve(model, mesh);
    assert.ok(res.ok, res.message);
    const st = res.stages[0];
    let maxU = 0; for (const v of st.displacement) maxU = Math.max(maxU, Math.abs(v));
    assert.ok(maxU < 1e-9, `displacement ${maxU}`);
    for (let g = 0; g < st.gp.syy.length; g++) {
      const y = st.gp.y[g];
      const sv = y >= yw ? gu * (H - y) : gu * (H - yw) + (gs - gw) * (yw - y);
      assert.ok(Math.abs(st.gp.syy[g] + sv) < 1e-6 * Math.max(1, sv));
      assert.ok(Math.abs(st.gp.sxx[g] + 0.5 * sv) < 1e-6 * Math.max(1, sv));
    }
  });
});

// ───────────────────────────── stages, loads ─────────────────────────────
describe('staged construction, K0 stage with loads, point loads', () => {
  const E = 1e4, nu = 0.3, gam = 20, H = 10;
  const M = constrainedModulus(E, nu);
  const twoRegionModel = () => {
    const m = createEmptyModel();
    m.materials.push(defaultMaterial({ id: 'M1', model: 'linear-elastic', E, nu, gammaUnsat: gam, gammaSat: gam }));
    m.regions.push({ id: 'R1', name: 'Lower', materialId: 'M1', points: [[0, 0], [1, 0], [1, 5], [0, 5]] });
    m.regions.push({ id: 'R2', name: 'Upper', materialId: 'M1', points: [[0, 5], [1, 5], [1, 10], [0, 10]] });
    m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });
    return m;
  };
  const twoRegionMesh = () => rectMesh(0, 1, 0, H, 2, 10, 'T6', (ci, cj) => (cj < 5 ? 0 : 1));

  test('K0 stage: exact overburden stresses, zero displacement; stage load then applied incrementally', () => {
    const m = rectModel(0, 1, 0, H, { model: 'mohr-coulomb', E, nu, c: 20, phi: 30, gammaUnsat: gam, gammaSat: gam });
    m.loads.push({ id: 'Q1', type: 'distributed', p1: [0, H], p2: [1, H], qx1: 0, qy1: -40, qx2: 0, qy2: -40 });
    m.stages = [
      { id: 'S0', name: 'K0', initial: 'k0', activeRegions: ['R1'], activeLoads: [], resetDisplacements: true },
      { id: 'S1', name: 'Load', initial: 'gravity', activeRegions: ['R1'], activeLoads: ['Q1'], resetDisplacements: true },
    ];
    const res = solve(m, rectMesh(0, 1, 0, H, 2, 10, 'T6'));
    assert.ok(res.ok, res.message);
    const [s0, s1] = res.stages;
    for (const v of s0.displacement) assert.ok(Math.abs(v) < 1e-12);
    for (let g = 0; g < s0.gp.syy.length; g++) {
      assert.ok(Math.abs(s0.gp.syy[g] + gam * (H - s0.gp.y[g])) < 1e-8);
      assert.ok(Math.abs(s0.gp.sxx[g] + 0.5 * gam * (H - s0.gp.y[g])) < 1e-8, 'K0 = 1 - sin(30°) = 0.5');
    }
    // stage 1 'gravity' continues from stage 0 (K0 state is in vertical equilibrium) and adds the load: uy = -q H / M
    const mesh = rectMesh(0, 1, 0, H, 2, 10, 'T6');
    const top = nodeAt(mesh, 0, H);
    assert.ok(rel(s1.displacement[2 * top + 1], -(40 * H) / M) < 0.02, `uy ${s1.displacement[2 * top + 1]}`);
    for (let g = 0; g < s1.gp.syy.length; g++) assert.ok(Math.abs(s1.gp.syy[g] + gam * (H - s1.gp.y[g]) + 40) < 1e-4);
  });

  test('K0 stage with a stage load: reactions = weight + applied load', () => {
    const m = rectModel(0, 1, 0, H, { model: 'mohr-coulomb', E, nu, c: 20, phi: 30, gammaUnsat: gam, gammaSat: gam });
    m.loads.push({ id: 'Q1', type: 'distributed', p1: [0, H], p2: [1, H], qx1: 0, qy1: -40, qx2: 0, qy2: -40 });
    m.stages = [{ id: 'S0', name: 'K0', initial: 'k0', activeRegions: ['R1'], activeLoads: ['Q1'], resetDisplacements: true }];
    const res = solve(m, rectMesh(0, 1, 0, H, 2, 10, 'T6'));
    assert.ok(res.ok, res.message);
    assert.ok(Math.abs(sum(res.stages[0].reactions, 1, 2) - (gam * H + 40)) < 1e-4, `sum Ry ${sum(res.stages[0].reactions, 1, 2)}`);
  });

  test('construction: placing the upper layer on the lower (stress-free on activation)', () => {
    const m = twoRegionModel();
    m.stages = [
      { id: 'S0', name: 'Lower', initial: 'gravity', activeRegions: ['R1'], activeLoads: [], resetDisplacements: true },
      { id: 'S1', name: 'Upper', initial: 'gravity', activeRegions: ['R1', 'R2'], activeLoads: [], resetDisplacements: true },
    ];
    const mesh = twoRegionMesh();
    const res = solve(m, mesh);
    assert.ok(res.ok, res.message);
    const [s0, s1] = res.stages;
    assert.equal(s0.activeElements.filter((v) => v).length, mesh.elementRegion.filter((r) => r === 0).length);
    for (let g = 0; g < s1.gp.syy.length; g++) assert.ok(Math.abs(s1.gp.syy[g] + gam * (H - s1.gp.y[g])) < 1e-6, `y=${s1.gp.y[g]} syy=${s1.gp.syy[g]}`);
    const top = nodeAt(mesh, 0, H);
    // stage-1 displacement (reset): upper layer settles under its own weight + lower layer compresses under upper weight
    const expected = -(gam * 5 * 5) / M - (gam * 25) / (2 * M);
    assert.ok(rel(s1.displacement[2 * top + 1], expected) < 1e-6, `${s1.displacement[2 * top + 1]} vs ${expected}`);
    assert.ok(Math.abs(sum(s1.reactions, 1, 2) - gam * H) < 1e-6);
  });

  test('excavation: removing the upper layer heaves the remaining column; deactivated nodes untouched', () => {
    const m = twoRegionModel();
    m.stages = [
      { id: 'S0', name: 'Initial', initial: 'k0', activeRegions: ['R1', 'R2'], activeLoads: [], resetDisplacements: true },
      { id: 'S1', name: 'Excavate', initial: 'gravity', activeRegions: ['R1'], activeLoads: [], resetDisplacements: true },
    ];
    const mesh = twoRegionMesh();
    const res = solve(m, mesh);
    assert.ok(res.ok, res.message);
    const s1 = res.stages[1];
    // all upper elements inactive
    for (let e = 0; e < mesh.elementRegion.length; e++) assert.equal(s1.activeElements[e], mesh.elementRegion[e] === 0 ? 1 : 0);
    const iface = nodeAt(mesh, 0, 5);
    assert.ok(rel(s1.displacement[2 * iface + 1], (gam * 5 * 5) / M) < 1e-6, `heave ${s1.displacement[2 * iface + 1]}`);
    for (let g = 0; g < s1.gp.syy.length; g++) {
      if (!s1.activeElements[s1.gp.elem[g]]) { assert.equal(s1.gp.syy[g], 0); continue; }
      assert.ok(Math.abs(s1.gp.syy[g] + gam * (5 - s1.gp.y[g])) < 1e-6);
    }
    assert.ok(Math.abs(sum(s1.reactions, 1, 2) - gam * 5) < 1e-6);
  });

  test('point load: equilibrium with reactions; load goes to the nearest node', () => {
    const m = rectModel(0, 4, 0, 4, { model: 'linear-elastic', E, nu, gammaUnsat: 0, gammaSat: 0 });
    m.loads.push({ id: 'P1', type: 'point', p: [2.02, 3.97], fx: 5, fy: -100 });
    const mesh = rectMesh(0, 4, 0, 4, 8, 8, 'T6');
    const res = solve(m, mesh);
    assert.ok(res.ok, res.message);
    const st = res.stages[0];
    assert.ok(Math.abs(sum(st.reactions, 1, 2) - 100) < 1e-8);
    assert.ok(Math.abs(sum(st.reactions, 0, 2) + 5) < 1e-8);
    const n = nodeAt(mesh, 2, 4);
    assert.ok(st.displacement[2 * n + 1] < 0 && st.displacement[2 * n] > 0);
  });

  test('inclined/linearly varying distributed load integrates to the exact resultant (T6 and T3)', () => {
    for (const type of ['T3', 'T6']) {
      const m = rectModel(0, 4, 0, 4, { model: 'linear-elastic', E, nu, gammaUnsat: 0, gammaSat: 0 });
      m.loads.push({ id: 'Q', type: 'distributed', p1: [1, 4], p2: [3, 4], qx1: 10, qy1: -20, qx2: 30, qy2: -60 });
      const res = solve(m, rectMesh(0, 4, 0, 4, 8, 8, type));
      assert.ok(res.ok, res.message);
      const st = res.stages[0];
      // resultant: length 2 × mean(q): x = 2*20 = 40, y = 2*(-40) = -80
      assert.ok(Math.abs(sum(st.reactions, 0, 2) + 40) < 1e-8, `Rx ${sum(st.reactions, 0, 2)}`);
      assert.ok(Math.abs(sum(st.reactions, 1, 2) - 80) < 1e-8);
    }
  });
});

// ───────────────────────────── API behaviour, worker ─────────────────────────────
describe('progress, cancellation, errors, worker wrapper', () => {
  const simple = () => {
    const model = createExampleSlope();
    model.settings.analysis = 'static';
    return { model, mesh: slopeMesh(6, 6, 6, 5, 'T6') };
  };
  test('onProgress receives messages with the documented fields', () => {
    const { model, mesh } = simple();
    const msgs = [];
    const res = solve(model, mesh, { onProgress: (m) => msgs.push(m) });
    assert.ok(res.ok, res.message);
    assert.ok(msgs.length > 0);
    for (const k of ['stage', 'step', 'iter', 'residual', 'text']) assert.ok(k in msgs[0], k);
  });

  test('shouldCancel aborts the analysis', () => {
    const { model, mesh } = simple();
    let calls = 0;
    const res = solve(model, mesh, { shouldCancel: () => ++calls > 3 });
    assert.equal(res.ok, false);
    assert.equal(res.cancelled, true);
    assert.match(res.message, /cancel/i);
  });

  test('T3 mesh with plastic material / FOS analysis carries a locking warning; T6 does not', () => {
    const run = (type) => solve(createExampleSlope(), slopeMesh(4, 4, 4, 3, type));
    assert.ok(run('T3').warnings.some((w) => /T3/.test(w) && /T6/.test(w)));
    assert.deepEqual(run('T6').warnings, []);
  });

  test('errors are reported in the result, not thrown (insufficient supports)', () => {
    const m = rectModel(0, 1, 0, 1, { model: 'linear-elastic' });
    m.boundaries = [];
    const res = solve(m, rectMesh(0, 1, 0, 1, 2, 2, 'T6'));
    assert.equal(res.ok, false);
    assert.match(res.message, /singular|support|degrees of freedom/i);
  });

  test('worker message handler: progress + done with transferable buffers; error path', () => {
    const { model, mesh } = simple();
    const posted = [];
    handleMessage({ cmd: 'solve', model, mesh }, (data, transfer) => posted.push({ data, transfer }));
    const done = posted.find((p) => p.data.type === 'done');
    assert.ok(done, 'done message');
    assert.ok(done.data.results.ok);
    assert.ok(done.transfer.length > 0 && done.transfer.every((b) => b instanceof ArrayBuffer));
    assert.deepEqual(new Set(done.transfer).size, done.transfer.length);
    assert.ok(posted.some((p) => p.data.type === 'progress'));
    assert.equal(collectTransferables(done.data.results).length, done.transfer.length);
    const bad = [];
    handleMessage({ cmd: 'solve', model, mesh: null }, (data) => bad.push(data));
    assert.ok(bad.some((d) => d.type === 'done' && d.results.ok === false) || bad.some((d) => d.type === 'error'));
  });
});

// ───────────────────────────── performance ─────────────────────────────
describe('performance', () => {
  test('~40k DOF elastic gravity solve (RCM + skyline LDLt) in a few seconds', () => {
    const E = 2e4, nu = 0.3;
    const model = rectModel(0, 100, 0, 50, { model: 'linear-elastic', E, nu, gammaUnsat: 18, gammaSat: 18 });
    const mesh = rectMesh(0, 100, 0, 50, 100, 50, 'T6');
    const nDof = mesh.nodes.length;
    const t0 = Date.now();
    const res = solve(model, mesh);
    const dt = Date.now() - t0;
    console.log(`      Large elastic model: ${nDof} DOF, ${mesh.stats.nElements} elements, solved in ${dt} ms (ok=${res.ok})`);
    assert.ok(res.ok, res.message);
    assert.ok(dt < 30000, `took ${dt} ms`);
    const st = res.stages[0];
    // vertical reaction = total weight
    assert.ok(rel(sum(st.reactions, 1, 2), 18 * 100 * 50) < 1e-8);
    // 1D check in the middle of the model is not exact (finite width) — just sanity: syy at the base ≈ -γH
    const gBase = st.gp.y.reduce((b, y, g) => (y < st.gp.y[b] ? g : b), 0);
    assert.ok(rel(st.gp.syy[gBase], -18 * 50) < 0.05);
  });
});
