// Finite element solver: staged plane-strain analysis (T3/T6), Mohr–Coulomb plasticity, strength-reduction FOS.
// DOM-free; runs in Node and in a Web Worker (see worker.js).
//
// ──────────────────────────────── Algorithm summary ────────────────────────────────
// * Unknowns: nodal displacements; fixed DOFs are eliminated (never enter the system). Equations are numbered
//   following a Reverse Cuthill–McKee ordering of the active node graph and solved with a skyline LDLᵀ (sparse.js).
// * Nonlinear solution: load stepping with MODIFIED Newton–Raphson — the elastic stiffness of the active elements is
//   factorised ONCE per stage (it does not depend on stresses or on the strength-reduction factor) and reused for every
//   iteration, load step and SRM trial. The stress update is an implicit return mapping (material.js), so the iteration
//   is unconditionally stable for perfect plasticity (the elastic stiffness bounds the tangent); convergence is linear
//   and slows down close to collapse, which is exactly how failure is detected in the SRM.
//   Adaptive step cutting halves the load increment when an increment does not converge (or stagnates).
// * Residual:  R(λ) = F(λ) − Fint(σ') with  F(λ) = Fstart + λ (Ftarget − Fstart),
//     Fstart  = Fint(σ'_start)           (the state at the start of the stage is in equilibrium by definition)
//     Ftarget = Fgrav + Fpore + Floads   (initial: 'gravity'),  or  Fstart + Floads (initial: 'k0')
//   Fgrav : total unit weight × volume; Fpore = ∫Bᵀ m u dV (hydrostatic pore pressure from the phreatic line, drained
//   effective stress analysis: σ_total = σ' − m u).  Newly activated elements start stress-free, deactivated ones
//   release their internal force through the difference Ftarget − Fstart.
// * Initial stress 'k0': σ'_v from the overburden above each Gauss point, σ'_h = K0 σ'_v, no displacements; the stage
//   loads (not gravity) are then applied incrementally — gravity is taken to be in equilibrium with the K0 stresses.
// * FOS (settings.analysis === 'fos'): all stages are first solved with the true strength (SRF = 1). The strength
//   reduction is applied to the LAST stage by CONTINUATION: starting from the SRF = 1 equilibrium state (full stage
//   loading, e.g. gravity) the SRF is raised in increments (c/SRF, tanφ/SRF, tanψ/SRF, ψ ≤ φ) and every increment is one
//   modified-Newton solve at full load from the last converged state — the state stays near equilibrium, so each solve is
//   short. (The previous scheme restarted every trial from the stage start and re-applied the whole loading history in
//   `loadSteps` increments: 9 trials × 10 steps, 4–8× more iterations.) The first increment is 0.04 and doubles after
//   every success; an increment that does not converge is cut in half and retried from the same state (a big single
//   strength drop needs many iterations and can fail although the state is stable); a failure at an increment ≤ fos.tol
//   ends the search: lo = last converged SRF, hi = the failed one (bracket ≤ fos.tol), the reported `fos` is `lo`.
//   `fosHistory` has one entry per accepted increment plus the final failed one. If SRF = 1 itself fails (or for a K0
//   last stage, where SRF = 1 is first verified with the full weight applied by a cold restart from the stage start state)
//   the search falls back to cold trials (restart from the stage start, loading in `loadSteps` increments), shrinking
//   the SRF geometrically (÷1.5) and bisecting.
//   A solve FAILS if it does not converge within `maxIterations`, the residual stagnates (< 8 % reduction over 20
//   iterations after the first 40) or the displacements blow up. The last stage of the returned results is the state
//   of the LAST FAILED attempt (= smallest failing SRF found), i.e. the non-equilibrium state in which the failure
//   mechanism is developed (`converged` false, `srf` = that SRF). The last converged near-failure state (in equilibrium)
//   is returned in `results.fosStages.stable`, the failed one also in `results.fosStages.failed`. Typical FE bias:
//   coarse meshes over-predict FOS (T6 3-GP, example slope: 1.42 at h = 3 m, 1.36 at 1.5 m, 1.34 at 0.8 m; Bishop /
//   limit-equilibrium ≈ 1.38). With an unlimited iteration budget the same discretisation collapses at a 0.01–0.03 higher SRF:
//   the FOS reported here is the largest SRF that the modified Newton iteration verifies within `maxIterations`.
// * Direct solver: skyline LDLᵀ with RCM ordering for small systems; sparse Cholesky (up-looking, symbolic analysis
//   cached) with geometric nested-dissection ordering above ~1500 free nodes (settings.directSolver = 'skyline' | 'sparse' forces one).
//   The modified-Newton iteration is accelerated by L-BFGS corrections on top of the elastic factor (quasi.js);
//   a quasi-Newton step that increases the residual more than 2× is undone and the history discarded.

import { effectiveStages } from '../core/model.js';
import { buildGeometry, elementStiffness } from './elements.js';
import { makeMaterialParams, updateStress } from './material.js';
import { LBFGS } from './quasi.js';
import { nestedDissectionOrder, SparseCholesky, buildUpperPattern } from './cholesky.js';
import { buildNodeGraph, reverseCuthillMcKee, SkylineLDL } from './sparse.js';
import {
  meshBounds, resolveFixities, gaussWaterData, bodyForces, addExternalLoads, addSubmergedSurfaceLoads, k0Stress,
} from './loading.js';

class CancelError extends Error { constructor() { super('Analysis cancelled'); this.cancelled = true; } }

const norm2 = (a, fixed) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) if (!fixed[i]) s += a[i] * a[i];
  return Math.sqrt(s);
};

/**
 * Solve the model on the mesh.
 * @param {object} model  model (core/model.js schema)
 * @param {object} mesh   mesh (mesh/mesher.js format)
 * @param {{onProgress?:Function, shouldCancel?:Function}} [opts]
 * @returns {object} results (see ARCHITECTURE.md; extra fields: `fosStages`, per-stage `srf`, `loadFactor`, `maxDisp`)
 */
export function solve(model, mesh, opts = {}) {
  const analysis = model?.settings?.analysis === 'fos' ? 'fos' : 'static';
  const out = { ok: false, message: '', analysis, fos: null, fosHistory: [], stages: [], warnings: [] };
  try {
    const eng = new Engine(model, mesh, opts);
    eng.run(out);
  } catch (err) {
    if (err && err.cancelled) { out.ok = false; out.message = 'Analysis cancelled'; out.cancelled = true; }
    else { out.ok = false; out.message = `Solver error: ${err && err.message ? err.message : err}`; }
  }
  return out;
}

export class Engine {
  constructor(model, mesh, { onProgress, shouldCancel } = {}) {
    this.loadWarnings = new Set();
    this.model = model; this.mesh = mesh;
    this.onProgress = onProgress; this.shouldCancel = shouldCancel;
    this._lastEmit = 0;
    const s = model.settings || {};
    this.tol = s.tolerance > 0 ? s.tolerance : 1e-3;
    this.maxIter = s.maxIterations > 0 ? s.maxIterations : 200;
    this.nSteps = Math.max(1, s.loadSteps | 0 || 10);
    this.quasiNewton = s.quasiNewton !== false;   // L-BFGS acceleration of the modified Newton iteration (internal option)
    this.qnHistory = 8;
    this.directSolver = s.directSolver || 'auto';   // internal option: 'auto' | 'skyline' | 'sparse'
    this.stagnation = true;   // early failure detection for stagnating iterations
    const fos = s.fos || {};
    this.fosOpts = {
      min: fos.min ?? 0.5, max: fos.max ?? 5, tol: fos.tol ?? 0.005, maxBisections: fos.maxBisections ?? 30,
      tensionCutoff: fos.tensionCutoff !== false,
    };
    this.nN = mesh.nodes.length / 2;
    this.nDof = 2 * this.nN;
    this.geo = buildGeometry(mesh);
    this.nEl = this.geo.nEl;
    this.bounds = meshBounds(mesh);
    this.materials = model.materials || [];
    // element → material
    const matIdx = new Map(this.materials.map((m, i) => [m.id, i]));
    const regMat = (model.regions || []).map((r) => {
      const i = matIdx.get(r.materialId);
      if (i === undefined) throw new Error(`Region ${r.id}: unknown material ${r.materialId}`);
      return i;
    });
    this.elMat = new Int32Array(this.nEl);
    for (let e = 0; e < this.nEl; e++) {
      const r = mesh.elementRegion[e];
      if (r < 0 || r >= regMat.length) throw new Error(`Element ${e} has invalid region index ${r}`);
      this.elMat[e] = regMat[r];
    }
    this.fixedBC = resolveFixities(model, mesh, this.bounds);
    const wd = gaussWaterData(model, this.geo, this.elMat, this.materials);
    this.gamma = wd.gamma; this.pore = wd.pore;
    this.Pbase = this.makeParams(1);
    this.sysCache = null;
    this.maxDimension = Math.max(this.bounds.xmax - this.bounds.xmin, this.bounds.ymax - this.bounds.ymin, 1e-9);
  }

  makeParams(srf) {
    return this.materials.map((m) => makeMaterialParams(m, srf, this.fosOpts.tensionCutoff));
  }

  emit(msg, force = false) {
    if (!this.onProgress) return;
    const now = Date.now();
    if (!force && now - this._lastEmit < 80) return;
    this._lastEmit = now;
    this.onProgress(msg);
  }

  checkCancel() { if (this.shouldCancel && this.shouldCancel()) throw new CancelError(); }

  // ───────────────────────────── main driver ─────────────────────────────
  run(out) {
    const { model } = this;
    const stagesDef = effectiveStages(model);
    const fosMode = out.analysis === 'fos';
    const nen = this.mesh.nen || (this.mesh.type === 'T3' ? 3 : 6);
    if (nen === 3 && (fosMode || this.materials.some((m) => m.model === 'mohr-coulomb'))) {
      out.warnings.push('T3 elements overestimate collapse loads and the factor of safety (volumetric locking under plastic flow; e.g. +15-25 % FOS, +8-25 % bearing capacity). Use T6 elements for failure analyses.');
    }
    const S = {
      u: new Float64Array(this.nDof),
      sig: new Float64Array(4 * this.geo.nGP),
      pl: new Uint8Array(this.geo.nGP),
      active: new Uint8Array(this.nEl),
    };
    let lastPrep = null, lastRun = null, lastW = null;
    for (let si = 0; si < stagesDef.length; si++) {
      const def = stagesDef[si];
      const isLast = si === stagesDef.length - 1;
      const ps = this.prepareStage(S, si, def);
      for (const w of this.loadWarnings) if (!out.warnings.includes(w)) out.warnings.push(w);
      if (ps.waterHead > 1e-6 * this.maxDimension) {
        out.warnings.push(`Stage "${def.name || def.id || `Stage ${si}`}": the phreatic line lies above the ground surface (up to ${ps.waterHead.toFixed(2)} m of water); the surface is treated as submerged (hydrostatic water pressure acts on it).`);
      }
      if (fosMode && isLast) ps.snapshot = { u: S.u.slice(), sig: S.sig.slice(), pl: S.pl.slice() };
      const W = this.newWork(S.u, S.sig, S.pl, ps.Fstart);
      const stageName = def.name || def.id || `Stage ${si}`;
      const run = this.runLoadSteps(ps, W, this.Pbase, {
        nSteps: this.nSteps, maxCuts: 8, label: stageName, stageIndex: si, srf: 1,
      });
      // commit converged state back to S
      S.u.set(W.uC); S.sig.set(W.sigC); S.pl.set(W.plC);
      const stageRes = this.extractStage(ps, def, stateOf(W, 'C'), run, 1);
      out.stages.push(stageRes);
      lastPrep = ps; lastRun = run; lastW = W;
      if (!run.converged && !(fosMode && isLast)) {
        out.ok = false;
        out.message = `Stage "${stageName}" did not converge (reached load factor ${run.lam.toFixed(4)})`;
        return out;
      }
    }
    if (!fosMode) {
      out.ok = true;
      out.message = `Analysis completed (${out.stages.length} stage${out.stages.length > 1 ? 's' : ''})`;
      return out;
    }
    this.runFos(out, lastPrep, lastRun, lastW);
    return out;
  }

  // ───────────────────────────── strength reduction ─────────────────────────────
  runFos(out, ps, mainRun, mainW) {
    const fo = this.fosOpts;
    const lastIdx = out.stages.length - 1;
    const def = effectiveStages(this.model)[lastIdx];
    const hist = out.fosHistory;
    hist.push({ srf: 1, converged: mainRun.converged, maxDisp: maxMag(mainW, ps.uBase), iterations: mainRun.iterTotal });
    this.emit({ stage: lastIdx, step: 0, iter: 0, residual: 0, fos: null, text: `SRF 1.000 ${mainRun.converged ? 'converged' : 'failed'}` }, true);

    // Convergence reference of the SRM solves. The stage's own reference (size of its force change) is meaningless here:
    // the full weight acts on the reduced strength, so the plastic redistribution scales with the total load, not with
    // what the stage added (nothing at all for a K0 stage or an unchanged "safety" stage).
    let dsum = 0, gsum = 0;
    for (let i = 0; i < this.nDof; i++) {
      if (ps.sys.fixedAll[i]) continue;
      const d = ps.FtargetGravity[i] - ps.Fstart[i];
      dsum += d * d; gsum += ps.FtargetGravity[i] * ps.FtargetGravity[i];
    }
    const refFos = Math.max(ps.ref, Math.sqrt(dsum), Math.sqrt(gsum));
    // Cold trial: restart from the state at the start of the stage and re-apply the full stage loading in `loadSteps`
    // increments with the strength reduced by `srf` (used where no equilibrium state at a lower SRF exists to continue from).
    const trial = (srf) => {
      const P = this.makeParams(srf);
      const W = this.newWork(ps.snapshot.u, ps.snapshot.sig, ps.snapshot.pl, ps.Fstart);
      const run = this.runLoadSteps(ps, W, P, {
        nSteps: this.nSteps, maxCuts: 1, label: `SRF ${srf.toFixed(3)}`, stageIndex: lastIdx, srf,
        // a K0 stage normally assumes gravity is balanced; in the SRM the full weight must act on the reduced strength
        Ftarget: ps.FtargetGravity, ref: refFos,
      });
      hist.push({ srf, converged: run.converged, maxDisp: maxMag(W, ps.uBase), iterations: run.iterTotal });
      this.emit({ stage: lastIdx, step: 0, iter: run.iterTotal, residual: run.residual, fos: srf, text: `SRF ${srf.toFixed(3)} ${run.converged ? 'converged' : 'FAILED'}` }, true);
      return { srf, run, W };
    };
    // Continuation step: from the converged equilibrium state `from` (full load, strength reduced by from.srf) solve the
    // equilibrium at the larger SRF `srf` directly (one modified-Newton solve at full load).
    const advance = (from, srf) => {
      const Wf = from.W;
      const W = this.newWork(Wf.uC, Wf.sigC, Wf.plC, ps.Fstart);
      W.fintC.set(Wf.fintC); W.fintW.set(Wf.fintC); W.FC.set(Wf.FC);
      const r = this.newton(ps, W, this.makeParams(srf), ps.FtargetGravity, {
        ref: refFos, stageIndex: lastIdx, srf, label: `SRF ${srf.toFixed(3)}`,
      }, 1, 0);
      const run = { converged: r.converged, steps: [{ loadFactor: 1, iterations: r.iters, residual: r.residual }], lam: 1, iterTotal: r.iters, residual: r.residual };
      if (r.converged) {
        for (let i = 0; i < this.nDof; i++) W.uC[i] += W.dU[i];
        W.dU.fill(0);
        W.sigC.set(W.sigW); W.plC.set(W.plW); W.fintC.set(W.fintW); W.FC.set(ps.FtargetGravity);
      } else { W.Ffail = ps.FtargetGravity; run.lamLast = 1; }
      return { srf, run, W };
    };

    let lo = null, hi = null, stable = null, failed = null, nb = 0;
    let base = { srf: 1, run: mainRun, W: mainW };
    if (ps.kind === 'k0') base = trial(1);   // K0 stage: SRF = 1 must be verified with the weight actually applied
    if (base.run.converged) {
      // Strength reduction by continuation: the SRF is raised in increments from the SRF = 1 equilibrium state, every
      // increment starting from the last converged state (the state is always near equilibrium, so each solve is short;
      // independent restarts from the stage start would re-do the whole loading history for every trial). An
      // increment that does not converge is cut in half and retried from the same state; the first failure at an
      // increment ≤ fos.tol brackets the FOS: lo = last converged SRF, hi = the failed one. (A single large strength drop
      // from SRF = 1 needs many iterations and can fail although the state is stable — hence the cutting.)
      lo = 1; stable = base;
      const dmin = fo.tol;
      let delta = Math.max(0.04, 2 * dmin), cut = false, spent = 0;
      while (lo < fo.max) {
        const next = Math.min(fo.max, Math.round((lo + delta) * 1e9) / 1e9);
        const t = advance(stable, next);
        spent += t.run.iterTotal;
        const ok = t.run.converged;
        const terminal = !ok && (next - lo <= dmin * (1 + 1e-9) || nb >= fo.maxBisections);
        if (ok || terminal) {
          hist.push({ srf: next, converged: ok, maxDisp: maxMag(t.W, ps.uBase), iterations: spent });
          this.emit({ stage: lastIdx, step: 0, iter: spent, residual: t.run.residual, fos: next, text: `SRF ${next.toFixed(3)} ${ok ? 'converged' : 'FAILED'}` }, true);
          spent = 0;
        }
        if (ok) { lo = next; stable = t; if (!cut) delta *= 2; }
        else if (terminal) { hi = next; failed = t; break; }
        else { delta = Math.max(dmin, 0.5 * (next - lo)); cut = true; nb++; }
      }
    } else {
      // SRF = 1 itself does not converge: shrink the SRF geometrically until it does, then bisect (cold trials)
      hi = 1; failed = base;
      for (;;) {
        const next = Math.max(fo.min, hi / 1.5);
        if (next >= hi) { lo = hi; break; }      // already at the lower limit and still failing
        const t = trial(next);
        if (t.run.converged) { lo = next; stable = t; break; }
        hi = next; failed = t;
        if (next <= fo.min) { lo = hi; break; }
      }
      if (hi !== null && lo !== null) {
        while (hi - lo > fo.tol && nb < fo.maxBisections) {
          const mid = 0.5 * (lo + hi);
          const t = trial(mid);
          if (t.run.converged) { lo = mid; stable = t; } else { hi = mid; failed = t; }
          nb++;
        }
      }
    }

    // result assembly
    let message;
    if (hi === null) {
      out.fos = fo.max;
      message = `FOS exceeds the upper search limit (${fo.max}); no failure found`;
    } else if (lo === hi) {
      out.fos = fo.min;
      message = `FOS is below the lower search limit (${fo.min}); the slope fails at the minimum strength reduction`;
    } else {
      out.fos = lo;
      message = `FOS = ${lo.toFixed(3)} (bracket ${lo.toFixed(3)} – ${hi.toFixed(3)}, ${nb} bisections)`;
    }
    out.ok = true;
    out.message = message;
    const mk = (t) => this.extractStage(ps, def, t.run.converged ? stateOf(t.W, 'C') : stateOf(t.W, 'F'), t.run, t.srf, true);
    out.fosStages = {};
    if (stable) out.fosStages.stable = mk(stable);
    if (failed) out.fosStages.failed = mk(failed);
    // the last stage shows the failure mechanism: last failed trial, otherwise the near-failure stable state
    if (failed) out.stages[lastIdx] = out.fosStages.failed;
    else if (stable) out.stages[lastIdx] = out.fosStages.stable;
    out.stages[lastIdx].srf = failed ? failed.srf : stable ? stable.srf : 1;
  }

  // ───────────────────────────── stage preparation ─────────────────────────────
  newWork(u0, sig0, pl0, Fstart) {
    const nd = this.nDof;
    const W = {
      uC: u0.slice(), sigC: sig0.slice(), plC: pl0.slice(), fintC: Fstart.slice(),
      dU: new Float64Array(nd), sigW: sig0.slice(), plW: pl0.slice(), fintW: Fstart.slice(),
      F: new Float64Array(nd), FC: Fstart.slice(),
    };
    return W;
  }

  prepareStage(S, si, def) {
    const { model, mesh, geo, nEl } = this;
    const regionActive = new Uint8Array((model.regions || []).length);
    const ids = def.activeRegions;
    (model.regions || []).forEach((r, i) => { regionActive[i] = !ids || ids.includes(r.id) ? 1 : 0; });
    const activeEl = new Uint8Array(nEl);
    let nAct = 0;
    for (let e = 0; e < nEl; e++) {
      activeEl[e] = regionActive[mesh.elementRegion[e]];
      nAct += activeEl[e];
    }
    if (nAct === 0) throw new Error(`Stage "${def.name || def.id}" has no active elements`);
    // elements entering/leaving: reset stress (new elements start stress-free)
    for (let e = 0; e < nEl; e++) {
      if (activeEl[e] !== S.active[e]) {
        for (let k = 0; k < geo.ngp; k++) {
          const g = e * geo.ngp + k;
          S.sig.fill(0, 4 * g, 4 * g + 4); S.pl[g] = 0;
        }
      }
    }
    S.active = activeEl.slice();
    const sys = this.getSystem(activeEl);
    const ps = { index: si, def, activeEl, sys, nAct };
    ps.activeList = new Int32Array(nAct);
    for (let e = 0, k = 0; e < nEl; e++) if (activeEl[e]) ps.activeList[k++] = e;
    ps.uBase = def.resetDisplacements ? S.u.slice() : null;

    // initial stress
    const kind = si === 0 && def.initial === 'k0' ? 'k0' : 'gravity'; // initial stress state applies to the first stage only
    if (kind === 'k0') {
      k0Stress(model, mesh, geo, activeEl, this.elMat, this.materials, this.gamma, this.pore, S.sig);
      // project onto the yield surface (zero strain increment)
      for (const e of ps.activeList) {
        const P = this.Pbase[this.elMat[e]];
        for (let k = 0; k < geo.ngp; k++) {
          const g = e * geo.ngp + k;
          S.pl[g] = updateStress(P, S.sig, 4 * g, 0, 0, 0);
        }
      }
    }
    // loads
    const nd = this.nDof;
    const Fstart = new Float64Array(nd);
    this.internalForce(ps, S.sig, Fstart);
    const Fload = new Float64Array(nd);
    const activeLoads = def.activeLoads || (model.loads || []).map((l) => l.id);
    const loadSummary = addExternalLoads(model, mesh, activeEl, sys.nodeActive, activeLoads, Fload, this.bounds);
    for (const ls of loadSummary) {
      if (!ls.expected) continue;
      const scale = Math.max(Math.abs(ls.expected[0]), Math.abs(ls.expected[1]), 1e-12);
      const err = Math.max(Math.abs(ls.applied[0] - ls.expected[0]), Math.abs(ls.applied[1] - ls.expected[1])) / scale;
      if (err > 1e-3) this.loadWarnings.add(`Load ${ls.id}: the force applied to the mesh differs from the specified resultant by ${(100 * err).toFixed(1)} % (the load line must lie on the boundary of an active region).`);
    }
    const Fgrav = new Float64Array(nd), Fpore = new Float64Array(nd);
    bodyForces(mesh, geo, activeEl, this.gamma, this.pore, Fgrav, Fpore);
    // standing water on submerged free surfaces (phreatic line above the active ground surface): hydrostatic pressure
    // acts on the soil there; it belongs to the water forces (Fpore), like the pore-pressure body force
    ps.waterHead = addSubmergedSurfaceLoads(model, mesh, activeEl, Fpore, this.bounds).maxHead;
    // full-gravity target: weight + pore-pressure forces + loads
    const FtargetGravity = new Float64Array(nd);
    for (let i = 0; i < nd; i++) FtargetGravity[i] = Fgrav[i] + Fpore[i] + Fload[i];
    let Ftarget;
    if (kind === 'k0') {
      // K0 stage: gravity is taken to be in equilibrium with the K0 stresses; only the stage loads are applied
      Ftarget = new Float64Array(nd);
      for (let i = 0; i < nd; i++) Ftarget[i] = Fstart[i] + Fload[i];
    } else Ftarget = FtargetGravity;
    ps.Fstart = Fstart; ps.Ftarget = Ftarget; ps.FtargetGravity = FtargetGravity;
    ps.Fload = Fload;                                   // external stage loads (full)
    ps.Fbody = new Float64Array(nd);                    // weight + pore-pressure forces (full)
    for (let i = 0; i < nd; i++) ps.Fbody[i] = Fgrav[i] + Fpore[i];
    // convergence reference: size of the force change applied in this stage, but not below a small fraction of the
    // total load (a stage that changes (almost) nothing must not be held to a near machine-precision tolerance)
    const fixedAll = sys.fixedAll;
    let dsum = 0, tsum = 0;
    for (let i = 0; i < nd; i++) {
      if (fixedAll[i]) continue;
      const d = Ftarget[i] - Fstart[i];
      dsum += d * d; tsum += Ftarget[i] * Ftarget[i];
    }
    ps.ref = Math.max(Math.sqrt(dsum), 1e-3 * Math.sqrt(tsum), 1e-12);
    ps.kind = kind;
    return ps;
  }

  // Build (or reuse) the factorised elastic stiffness for an active-element set.
  getSystem(activeEl) {
    const c = this.sysCache;
    if (c && c.activeEl.length === activeEl.length && c.activeEl.every((v, i) => v === activeEl[i])) return c.sys;
    const sys = this.buildSystem(activeEl);
    this.sysCache = { activeEl: activeEl.slice(), sys };
    return sys;
  }

  buildSystem(activeEl) {
    const { mesh, geo, nN, nEl } = this;
    const nen = geo.nen;
    const nodeActive = new Uint8Array(nN);
    for (let e = 0; e < nEl; e++) if (activeEl[e]) for (let a = 0; a < nen; a++) nodeActive[mesh.elements[e * nen + a]] = 1;
    const fixedAll = this.fixedBC.slice();
    for (let n = 0; n < nN; n++) if (!nodeActive[n]) { fixedAll[2 * n] = 1; fixedAll[2 * n + 1] = 1; }
    const nodeMask = new Uint8Array(nN);
    for (let n = 0; n < nN; n++) nodeMask[n] = nodeActive[n] && !(fixedAll[2 * n] && fixedAll[2 * n + 1]) ? 1 : 0;
    const graph = buildNodeGraph(nN, mesh.elements, nen, activeEl, nodeMask);
    // direct solver: skyline LDLᵀ + RCM for small systems, sparse Cholesky + nested dissection for larger ones
    let nFreeNodes = 0;
    for (let n = 0; n < nN; n++) nFreeNodes += nodeMask[n];
    const kind = this.directSolver === 'auto' ? (nFreeNodes * 2 > 3000 ? 'sparse' : 'skyline') : this.directSolver;
    const order = kind === 'sparse'
      ? nestedDissectionOrder(mesh.nodes, graph.xadj, graph.adj, nodeMask)
      : reverseCuthillMcKee(nN, graph.xadj, graph.adj, nodeMask);
    const eq = new Int32Array(2 * nN).fill(-1);
    let neq = 0;
    for (let i = 0; i < order.length; i++) {
      const n = order[i];
      for (let d = 0; d < 2; d++) if (!fixedAll[2 * n + d]) eq[2 * n + d] = neq++;
    }
    if (neq === 0) throw new Error('No free degrees of freedom (all nodes fixed)');
    const freeDofs = new Int32Array(neq);
    for (let i = 0; i < 2 * nN; i++) if (eq[i] >= 0) freeDofs[eq[i]] = i;
    const nd = 2 * nen;
    const dofEq = new Int32Array(nd);
    const loadDofEq = (e) => {
      let mn = Infinity;
      for (let a = 0; a < nen; a++) {
        const n = mesh.elements[e * nen + a];
        dofEq[2 * a] = eq[2 * n]; dofEq[2 * a + 1] = eq[2 * n + 1];
      }
      for (let i = 0; i < nd; i++) if (dofEq[i] >= 0 && dofEq[i] < mn) mn = dofEq[i];
      return mn;
    };
    let K;
    if (kind === 'sparse') {
      const pat = buildUpperPattern(neq, eq, mesh.elements, nen, activeEl);
      K = new SparseCholesky(neq, pat.colPtr, pat.colRows);
    } else {
      const first = new Int32Array(neq);
      for (let i = 0; i < neq; i++) first[i] = i;
      for (let e = 0; e < nEl; e++) {
        if (!activeEl[e]) continue;
        const mn = loadDofEq(e);
        for (let i = 0; i < nd; i++) { const q = dofEq[i]; if (q >= 0 && mn < first[q]) first[q] = mn; }
      }
      K = new SkylineLDL(neq, first);
    }
    const ke = new Float64Array(nd * nd);
    for (let e = 0; e < nEl; e++) {
      if (!activeEl[e]) continue;
      const P = this.Pbase[this.elMat[e]];
      elementStiffness(geo, e, P.lam, P.G, ke);
      loadDofEq(e);
      for (let a = 0; a < nd; a++) {
        const ea = dofEq[a];
        if (ea < 0) continue;
        for (let b = 0; b < nd; b++) {
          const eb = dofEq[b];
          if (eb >= 0 && ea >= eb) K.add(ea, eb, ke[a * nd + b]);
        }
      }
    }
    K.factor();
    const buf = new Float64Array(neq);
    const work = { rc: new Float64Array(neq), rcOld: new Float64Array(neq), dir: new Float64Array(neq), yv: new Float64Array(neq) };
    let qn = null;
    return {
      neq, eq, K, fixedAll, nodeActive, freeDofs, work, kind, nnzFactor: K.nnzL ?? K.nnz,
      getQN(m) { if (!qn) qn = new LBFGS(neq, m, (v) => K.solve(v)); return qn; },
      solve(R, du) {
        for (let i = 0; i < neq; i++) buf[i] = R[freeDofs[i]];
        K.solve(buf);
        du.fill(0);
        for (let i = 0; i < neq; i++) du[freeDofs[i]] = buf[i];
      },
    };
  }

  // ───────────────────────────── element loops ─────────────────────────────
  /** Internal force Fint = Σ ∫ Bᵀ σ dV for stresses `sig` (active elements only). */
  internalForce(ps, sig, fint) {
    const { geo, mesh } = this;
    const { nen, ngp } = geo;
    fint.fill(0);
    for (let ii = 0; ii < ps.activeList.length; ii++) {
      const e = ps.activeList[ii];
      for (let k = 0; k < ngp; k++) {
        const g = e * ngp + k;
        const w = geo.w[g], o = 4 * g;
        const sxx = sig[o] * w, syy = sig[o + 1] * w, sxy = sig[o + 2] * w;
        for (let a = 0; a < nen; a++) {
          const n = mesh.elements[e * nen + a];
          const dx = geo.dndx[g * nen + a], dy = geo.dndy[g * nen + a];
          fint[2 * n] += dx * sxx + dy * sxy;
          fint[2 * n + 1] += dy * syy + dx * sxy;
        }
      }
    }
  }

  /**
   * Stress update for the displacement increment dU since the last converged state, plus internal force.
   * sigW/plW are overwritten for the active elements.
   */
  response(ps, P, dU, sigC, sigW, plW, fint) {
    const { geo, mesh, elMat } = this;
    const { nen, ngp } = geo;
    const conn = mesh.elements;
    fint.fill(0);
    for (let ii = 0; ii < ps.activeList.length; ii++) {
      const e = ps.activeList[ii];
      const Pm = P[elMat[e]];
      for (let k = 0; k < ngp; k++) {
        const g = e * ngp + k;
        const base = g * nen;
        let dexx = 0, deyy = 0, dgxy = 0;
        for (let a = 0; a < nen; a++) {
          const n = conn[e * nen + a];
          const ux = dU[2 * n], uy = dU[2 * n + 1];
          const dx = geo.dndx[base + a], dy = geo.dndy[base + a];
          dexx += dx * ux; deyy += dy * uy; dgxy += dy * ux + dx * uy;
        }
        const o = 4 * g;
        sigW[o] = sigC[o]; sigW[o + 1] = sigC[o + 1]; sigW[o + 2] = sigC[o + 2]; sigW[o + 3] = sigC[o + 3];
        plW[g] = updateStress(Pm, sigW, o, dexx, deyy, dgxy);
        const w = geo.w[g];
        const sxx = sigW[o] * w, syy = sigW[o + 1] * w, sxy = sigW[o + 2] * w;
        for (let a = 0; a < nen; a++) {
          const n = conn[e * nen + a];
          const dx = geo.dndx[base + a], dy = geo.dndy[base + a];
          fint[2 * n] += dx * sxx + dy * sxy;
          fint[2 * n + 1] += dy * syy + dx * sxy;
        }
      }
    }
  }

  // ───────────────────────────── load stepping / Newton ─────────────────────────────
  runLoadSteps(ps, W, P, o) {
    const nd = this.nDof;
    const steps = [];
    const dl0 = 1 / o.nSteps;
    const minDl = dl0 / Math.pow(2, o.maxCuts);
    let dl = dl0, lam = 0, iterTotal = 0, residual = 0;
    const out = { converged: true, steps, lam: 0, iterTotal: 0, residual: 0, failLam: null };
    let stepNo = 0;
    while (lam < 1 - 1e-12) {
      this.checkCancel();
      let lamNew = Math.min(1, lam + dl);
      if (1 - lamNew < 0.25 * dl) lamNew = 1;
      const F = W.F;
      const Ft = o.Ftarget || ps.Ftarget;
      for (let i = 0; i < nd; i++) F[i] = ps.Fstart[i] + lamNew * (Ft[i] - ps.Fstart[i]);
      const r = this.newton(ps, W, P, F, o, lamNew, stepNo);
      iterTotal += r.iters;
      residual = r.residual;
      if (r.converged) {
        // commit
        for (let i = 0; i < nd; i++) W.uC[i] += W.dU[i];
        W.dU.fill(0);
        W.sigC.set(W.sigW); W.plC.set(W.plW); W.fintC.set(W.fintW); W.FC.set(F);
        lam = lamNew;
        stepNo++;
        steps.push({ loadFactor: lam, iterations: r.iters, residual: r.residual, maxDisp: maxAbs(W.uC, null) });
        if (r.iters < 0.3 * this.maxIter && dl < dl0) dl = Math.min(dl0, dl * 1.5);
      } else {
        if (dl * 0.5 < minDl * (1 - 1e-9)) {
          out.converged = false; out.failLam = lamNew; out.lamLast = lam;
          W.Ffail = F; W.lamFail = lamNew;
          break;
        }
        dl *= 0.5;
      }
    }
    out.lam = lam; out.iterTotal = iterTotal; out.residual = residual;
    out.lamF = out.converged ? 1 : out.failLam;
    return out;
  }

  /**
   * Modified Newton iteration for the force vector F, starting from the last converged state.
   * Leaves the trial state in W (dU, sigW, plW, fintW) — whether or not it converged.
   * Vectors rc/dir/rcOld/yv live in the compact free-DOF space (freeDofs maps back to the global numbering).
   */
  newton(ps, W, P, F, o, lamNew, stepNo) {
    const { dU, sigC, sigW, plW, fintW, fintC } = W;
    const sys = ps.sys;
    const { neq, freeDofs, K } = sys;
    const nd = this.nDof;
    const ref = o.ref ?? ps.ref;   // convergence reference (SRM trials pass their own)
    const tolAbs = this.tol * ref;
    dU.fill(0);
    sigW.set(sigC); plW.set(W.plC); fintW.set(fintC);
    // re-evaluate the stress at zero increment: with a changed (reduced) strength the converged stresses may violate
    // the yield criterion and the return mapping then produces the initial out-of-balance force
    this.response(ps, P, dU, sigC, sigW, plW, fintW);
    const qn = this.quasiNewton ? sys.getQN(this.qnHistory) : null;
    const rc = sys.work.rc, rcOld = sys.work.rcOld, dir = sys.work.dir, yv = sys.work.yv;
    if (qn) qn.reset();
    const residual = () => {
      let s = 0;
      for (let i = 0; i < neq; i++) {
        const d = freeDofs[i];
        const r = F[d] - fintW[d];
        rc[i] = r; s += r * r;
      }
      return Math.sqrt(s);
    };
    let rn = residual();
    const hist = [rn];
    const limit = 0.5 * this.maxDimension;
    let it = 0;
    const fail = (reason) => ({ converged: false, iters: it, residual: rn / ref, reason });
    for (;;) {
      if (rn <= tolAbs) return { converged: true, iters: it, residual: rn / ref };
      if (it >= this.maxIter) return fail('maxIter');
      if (!Number.isFinite(rn)) return fail('nan');
      this.checkCancel();
      // search direction: elastic modified Newton, accelerated by L-BFGS corrections
      if (qn && qn.size > 0) qn.direction(rc, dir);
      else { dir.set(rc); K.solve(dir); }
      for (let i = 0; i < neq; i++) dU[freeDofs[i]] += dir[i];
      this.response(ps, P, dU, sigC, sigW, plW, fintW);
      rcOld.set(rc);
      const rnOld = rn;
      rn = residual();
      it++;
      hist.push(rn);
      if (qn && qn.size > 0 && !(rn <= 2 * rnOld)) {
        // the quasi-Newton step made things worse: undo it, drop the history and fall back to the elastic step
        for (let i = 0; i < neq; i++) dU[freeDofs[i]] -= dir[i];
        this.response(ps, P, dU, sigC, sigW, plW, fintW);
        rn = residual();
        qn.reset();
        hist[hist.length - 1] = rn;
        continue;
      }
      if (qn) {
        for (let i = 0; i < neq; i++) yv[i] = rcOld[i] - rc[i];
        qn.push(dir, yv);
      }
      if (this.onProgress) {
        this.emit({
          stage: o.stageIndex, step: stepNo + 1, iter: it, residual: rn / ref,
          fos: o.srf !== 1 ? o.srf : null, text: `${o.label}: load ${lamNew.toFixed(3)}, iteration ${it}, residual ${(rn / ref).toExponential(2)}`,
        });
      }
      // stagnation / blow-up → treat as non-convergence of this increment
      if (this.stagnation && it >= 40 && rn > 0.92 * hist[it - 20] && rn > 5 * tolAbs) return fail('stagnation');
      if (it % 8 === 0 && maxAbs(W.uC, dU) > limit) return fail('blowup');
    }
  }

  // ───────────────────────────── result extraction ─────────────────────────────
  /**
   * Build a contract stage result. `st` = {u (cumulative displacement), sig, pl, fint, F (force vector at that state)}.
   */
  extractStage(ps, def, st, run, srf, trial = false) {
    const { geo, mesh, nEl, nN } = this;
    const { nen, ngp, nGP } = geo;
    const nd = this.nDof;
    const disp = new Float64Array(nd);
    for (let i = 0; i < nd; i++) disp[i] = st.u[i] - (ps.uBase ? ps.uBase[i] : 0);
    const gp = {
      x: geo.x.slice(), y: geo.y.slice(), elem: new Int32Array(nGP),
      sxx: new Float64Array(nGP), syy: new Float64Array(nGP), sxy: new Float64Array(nGP), szz: new Float64Array(nGP),
      pore: new Float64Array(nGP), plastic: new Uint8Array(nGP),
      eps_xx: new Float64Array(nGP), eps_yy: new Float64Array(nGP), gxy: new Float64Array(nGP),
    };
    for (let e = 0; e < nEl; e++) {
      for (let k = 0; k < ngp; k++) {
        const g = e * ngp + k;
        gp.elem[g] = e;
        if (!ps.activeEl[e]) continue;
        const o = 4 * g;
        gp.sxx[g] = st.sig[o]; gp.syy[g] = st.sig[o + 1]; gp.sxy[g] = st.sig[o + 2]; gp.szz[g] = st.sig[o + 3];
        gp.pore[g] = this.pore[g];
        gp.plastic[g] = st.pl[g];
        let exx = 0, eyy = 0, gxy = 0;
        for (let a = 0; a < nen; a++) {
          const n = mesh.elements[e * nen + a];
          const dx = geo.dndx[g * nen + a], dy = geo.dndy[g * nen + a];
          exx += dx * disp[2 * n]; eyy += dy * disp[2 * n + 1];
          gxy += dy * disp[2 * n] + dx * disp[2 * n + 1];
        }
        gp.eps_xx[g] = exx; gp.eps_yy[g] = eyy; gp.gxy[g] = gxy;
      }
    }
    // reactions at fixed DOFs of active nodes: support force on the body = Fint − F (F = external force incl. weight).
    // A K0 stage does not apply the weight (F = Fstart + λ Fload, Fstart = Fint of the K0 stress): the weight carried
    // by the supports is then Fbody, so the external force at the fixed DOFs is Fbody + λ Fload. (An SRM trial applies
    // the full weight and its F is already complete.)
    const reactions = new Float64Array(nd);
    const fixed = ps.sys.fixedAll;
    const k0Weight = ps.kind === 'k0' && !trial;
    const lamReached = run.converged ? 1 : (run.lamLast ?? run.lam);
    for (let i = 0; i < nd; i++) {
      if (fixed[i] && ps.sys.nodeActive[i >> 1]) {
        const Fext = k0Weight ? ps.Fbody[i] + lamReached * ps.Fload[i] : st.F[i];
        reactions[i] = st.fint[i] - Fext;
      }
    }
    let maxDisp = 0;
    for (let n = 0; n < nN; n++) maxDisp = Math.max(maxDisp, Math.hypot(disp[2 * n], disp[2 * n + 1]));
    return {
      id: def.id, name: def.name || def.id,
      displacement: disp, gp, reactions,
      activeElements: ps.activeEl.slice(),
      converged: !!run.converged,
      steps: run.steps.map((s) => ({ ...s })),
      srf, loadFactor: run.converged ? 1 : (run.lamLast ?? run.lam), maxDisp,
    };
  }
}

// maximum displacement magnitude of a work state relative to the stage's displacement reference
function maxMag(W, base) {
  let m = 0;
  for (let n = 0; n < W.uC.length; n += 2) {
    const ux = W.uC[n] + W.dU[n] - (base ? base[n] : 0), uy = W.uC[n + 1] + W.dU[n + 1] - (base ? base[n + 1] : 0);
    const v = ux * ux + uy * uy;
    if (v > m) m = v;
  }
  return Math.sqrt(m);
}

function maxAbs(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i++) {
    const v = Math.abs(b ? a[i] + b[i] : a[i]);
    if (v > m) m = v;
  }
  return m;
}

// State accessor for extraction: 'C' = last converged, 'F' = failed attempt (working arrays)
function stateOf(W, which) {
  if (which === 'C') {
    return { u: W.uC, sig: W.sigC, pl: W.plC, fint: W.fintC, F: W.FC };
  }
  const u = W.uC.slice();
  for (let i = 0; i < u.length; i++) u[i] += W.dU[i];
  return { u, sig: W.sigW, pl: W.plW, fint: W.fintW, F: W.Ffail || W.F };
}
