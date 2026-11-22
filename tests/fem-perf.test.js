// Solver performance / regression tests: strength-reduction FOS on refined meshes of the example slope, and the
// Mohr–Coulomb return mapping at yield-surface edges (a robustness bug that used to send converged plastic points
// to the apex and hence to zero stress through the tension cut-off).
//
// Reference FOS values (T6, example slope, settings.meshSize = h) of the previous trial-restart solver:
//   h = 1.5: 1.363 (913 el), h = 1.0: 1.344 (2070 el), h = 0.8: 1.332 (3191 el)
// Runtime is recorded (printed) — wall-clock limits are generous to stay stable on slow machines; the iteration count
// (deterministic) is the strict performance guard.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExampleSlope } from '../src/core/model.js';
import { generateMesh } from '../src/mesh/mesher.js';
import { solve } from '../src/fem/solver.js';
import { makeMaterialParams, mcReturn } from '../src/fem/material.js';

function slopeFos(h) {
  const model = createExampleSlope();
  model.settings.meshSize = h;
  const mesh = generateMesh(model);
  const t0 = performance.now();
  const res = solve(model, mesh);
  const ms = performance.now() - t0;
  const iterations = res.fosHistory.reduce((a, x) => a + x.iterations, 0);
  console.log(`      slope h = ${h}: ${mesh.stats.nElements} T6 el, FOS = ${res.fos?.toFixed(4)}, ${res.fosHistory.length} trials, ${iterations} iterations, ${ms.toFixed(0)} ms`);
  return { model, mesh, res, ms, iterations };
}

function checkBracket(model, res) {
  assert.ok(res.ok, res.message);
  const conv = res.fosHistory.filter((x) => x.converged).map((x) => x.srf);
  const fail = res.fosHistory.filter((x) => !x.converged).map((x) => x.srf);
  assert.equal(res.fosHistory[0].srf, 1);
  assert.ok(Math.max(...conv) < Math.min(...fail), 'converged SRFs lie below the failed ones');
  assert.ok(Math.min(...fail) - Math.max(...conv) <= model.settings.fos.tol + 1e-9, 'bracket narrower than fos.tol');
  assert.equal(res.fos, Math.max(...conv));
  const last = res.stages[res.stages.length - 1];
  assert.equal(last.converged, false);                       // failure mechanism of the last failed solve
  assert.ok(res.fosStages.stable.converged);
  assert.ok(last.gp.plastic.filter((v) => v > 0).length > 100, 'plastic zone developed');
}

test('SRM FOS of the example slope, h = 1.5 (913 T6): 1.363 ± 0.01', () => {
  const { model, res, ms, iterations } = slopeFos(1.5);
  checkBracket(model, res);
  assert.ok(Math.abs(res.fos - 1.363) <= 0.01, `FOS ${res.fos}`);
  assert.ok(iterations < 1800, `${iterations} iterations (previous solver: 2710)`);
  assert.ok(ms < 15000, `${ms} ms`);
});

test('SRM FOS of the example slope, h = 1.0 (2070 T6): 1.344 ± 0.01, solved in a few seconds', () => {
  const { model, res, ms, iterations } = slopeFos(1.0);
  checkBracket(model, res);
  assert.ok(Math.abs(res.fos - 1.344) <= 0.01, `FOS ${res.fos}`);
  assert.ok(iterations < 2500, `${iterations} iterations (previous solver: 4933)`);
  assert.ok(ms < 30000, `${ms} ms (previous solver: ~10-12 s, now ~2 s)`);
});

test('SRM FOS of the example slope, h = 0.8 (3191 T6): 1.332 ± 0.01 (set FEM_PERF_FULL=1)', { skip: !process.env.FEM_PERF_FULL }, () => {
  const { model, res, ms, iterations } = slopeFos(0.8);
  checkBracket(model, res);
  assert.ok(Math.abs(res.fos - 1.332) <= 0.01, `FOS ${res.fos}`);
  assert.ok(iterations < 4000, `${iterations} iterations (previous solver: 8458)`);
  assert.ok(ms < 60000, `${ms} ms (previous solver: ~37 s, now ~5 s)`);
});

test('return mapping is idempotent for trial stresses near the s1 = s2 edge of the yield surface (no jump to the apex / zero)', () => {
  const P = makeMaterialParams({ model: 'mohr-coulomb', E: 1e5, nu: 0.3, c: 10, phi: 20, psi: 0, tensile: 0 }, 1.34, true);
  // a returned plastic point lies ON the surface (often on an edge, in-plane principal = out-of-plane stress); a second
  // return with zero strain increment must not move it. Round-off in the multiplier sign used to send ~0.3 % of such
  // states to the apex and, through the tension cut-off, to zero stress (a large spurious out-of-balance force).
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  // known offender of the old code
  const known = Float64Array.from([-239.66769489415645, -453.60004207315563, 14.307918625060331, -235.79783071102474]);
  const cases = [known];
  for (let i = 0; i < 20000; i++) {
    const szz = -50 - 300 * rnd(), pa = szz + (rnd() - 0.5) * 6, pb = pa - 20 - 200 * rnd();
    const m = 0.5 * (pa + pb), R = 0.5 * (pa - pb), th = rnd() * 0.3;
    cases.push(Float64Array.from([m + R * Math.cos(2 * th), m - R * Math.cos(2 * th), R * Math.sin(2 * th), szz]));
  }
  let bad = 0;
  for (const sig of cases) {
    const t = Array.from(sig);
    mcReturn(P, sig, 0);
    const a = Array.from(sig);
    mcReturn(P, sig, 0);
    const d = Math.max(...a.map((x, k) => Math.abs(x - sig[k])));
    if (d > 1e-6) { bad++; if (bad < 3) console.log('      not idempotent:', JSON.stringify({ t, a, b: Array.from(sig) })); }
  }
  assert.equal(bad, 0, `${bad} of ${cases.length} returned stresses moved on a second return`);
});
