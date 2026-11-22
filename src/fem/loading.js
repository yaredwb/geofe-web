// Boundary conditions, external loads, body force / pore pressure and K0 initial stress.
// All functions are pure helpers working on the mesh/geometry arrays; they never touch the model.
import { polylineYAt, distPointSegment } from '../core/geom.js';
import { defaultK0 } from './material.js';

/** Bounding box of mesh nodes + characteristic size. */
export function meshBounds(mesh) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  const nd = mesh.nodes;
  for (let i = 0; i < nd.length; i += 2) {
    const x = nd[i], y = nd[i + 1];
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
  }
  return { xmin, ymin, xmax, ymax, diag: Math.hypot(xmax - xmin, ymax - ymin) };
}

/**
 * Resolve the model's fixity boundary conditions to a per-DOF flag array (1 = fixed, zero prescribed displacement).
 * 'auto': y = ymin → fixed x & y; x = xmin or xmax → fixed x. 'segment': all nodes within tolerance of the segment.
 * 'point': nearest node.
 */
export function resolveFixities(model, mesh, bounds = meshBounds(mesh)) {
  const nN = mesh.nodes.length / 2;
  const fixed = new Uint8Array(2 * nN);
  const tol = 1e-5 * bounds.diag + 1e-12;
  const nd = mesh.nodes;
  for (const b of model.boundaries || []) {
    if (b.type !== 'fixity') continue;
    const t = b.target || {};
    if (t.kind === 'auto') {
      for (let i = 0; i < nN; i++) {
        const x = nd[2 * i], y = nd[2 * i + 1];
        if (Math.abs(y - bounds.ymin) <= tol) { fixed[2 * i] = 1; fixed[2 * i + 1] = 1; }
        if (Math.abs(x - bounds.xmin) <= tol || Math.abs(x - bounds.xmax) <= tol) fixed[2 * i] = 1;
      }
    } else {
      // both flags undefined → fix both directions
      const both = b.fixX === undefined && b.fixY === undefined;
      const fx = both || !!b.fixX, fy = both || !!b.fixY;
      if (t.kind === 'segment') {
        for (let i = 0; i < nN; i++) {
          if (distPointSegment([nd[2 * i], nd[2 * i + 1]], t.p1, t.p2) <= tol) {
            if (fx) fixed[2 * i] = 1;
            if (fy) fixed[2 * i + 1] = 1;
          }
        }
      } else if (t.kind === 'point') {
        const i = nearestNode(nd, t.p);
        if (i >= 0) { if (fx) fixed[2 * i] = 1; if (fy) fixed[2 * i + 1] = 1; }
      }
    }
  }
  return fixed;
}

/** Nearest node to point p among nodes with mask[node] = 1 (mask optional). */
export function nearestNode(nodes, p, mask = null) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < nodes.length / 2; i++) {
    if (mask && !mask[i]) continue;
    const dx = nodes[2 * i] - p[0], dy = nodes[2 * i + 1] - p[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

/**
 * Gauss-point unit weight (total) and pore pressure from the phreatic line (hydrostatic, drained effective-stress
 * analysis). Below the phreatic line: gammaSat and u = gammaW (y_phr - y); above: gammaUnsat and u = 0.
 */
export function gaussWaterData(model, geo, elMat, materials) {
  const { nGP, ngp } = geo;
  const gamma = new Float64Array(nGP);
  const pore = new Float64Array(nGP);
  const w = model.water;
  const useWater = !!(w && w.enabled && w.phreatic && w.phreatic.length >= 2);
  const gw = useWater ? (w.gammaW ?? 9.81) : 0;
  for (let g = 0; g < nGP; g++) {
    const mat = materials[elMat[(g / ngp) | 0]];
    let gam = mat.gammaUnsat;
    let u = 0;
    if (useWater) {
      const yp = polylineYAt(w.phreatic, geo.x[g]);
      if (geo.y[g] < yp) { gam = mat.gammaSat; u = gw * (yp - geo.y[g]); }
    }
    gamma[g] = gam;
    pore[g] = u;
  }
  return { gamma, pore };
}

/**
 * Body-force and pore-pressure equivalent nodal forces for the active elements.
 *   Fgrav_i = -∫ N_i gamma dV  (y direction)
 *   Fpore_i =  ∫ (dN_i/dx u, dN_i/dy u) dV     (so that  ∫Bᵀσ' = F_ext + Fpore ,  σ_total = σ' - m u)
 */
export function bodyForces(mesh, geo, activeEl, gamma, pore, Fgrav, Fpore) {
  const { nen, ngp } = geo;
  Fgrav.fill(0); Fpore.fill(0);
  for (let e = 0; e < geo.nEl; e++) {
    if (!activeEl[e]) continue;
    for (let k = 0; k < ngp; k++) {
      const g = e * ngp + k;
      const w = geo.w[g];
      const wg = w * gamma[g], wu = w * pore[g];
      for (let a = 0; a < nen; a++) {
        const n = mesh.elements[e * nen + a];
        Fgrav[2 * n + 1] -= geo.N[g * nen + a] * wg;
        if (wu !== 0) {
          Fpore[2 * n] += geo.dndx[g * nen + a] * wu;
          Fpore[2 * n + 1] += geo.dndy[g * nen + a] * wu;
        }
      }
    }
  }
}

/**
 * Hydrostatic water pressure on SUBMERGED free surfaces. The pore pressure field of the phreatic line (`gaussWaterData`)
 * is also non-zero in soil that lies below the phreatic line at a free (non-supported) boundary of the active
 * elements — ground under standing water, an excavation floor/wall below the water table. Effective-stress equilibrium
 * ∫Bᵀσ' = ∫Bᵀ m u + ∫N γ_sat + ∮N t_total requires the total traction t_total = −u n there (water pressure acting on the
 * soil, pointing into it); without it the effective stresses near that surface are wrong (tension) and the weight of
 * the water is missing. The pressure p = γw (y_phr(x) − y) is integrated along each such edge (3-point Gauss, T6 edges
 * quadratic, an edge crossing the phreatic line is clipped at the crossing) and ADDED to F.
 * Edges on the outer bottom/side lines of the mesh bounding box are skipped (they are supports; no uplift is modelled
 * there, and the phreatic line normally meets the side boundaries below ground).
 * @returns {{maxHead:number, nEdges:number}} largest water head (m) on a submerged free surface, number of loaded edges
 */
export function addSubmergedSurfaceLoads(model, mesh, activeEl, F, bounds) {
  const w = model.water;
  const res = { maxHead: 0, nEdges: 0 };
  if (!(w && w.enabled && w.phreatic && w.phreatic.length >= 2)) return res;
  const gw = w.gammaW ?? 9.81;
  const nen = mesh.nen;
  const nEl = (mesh.elements.length / nen) | 0;
  const nd = mesh.nodes;
  const nN = nd.length / 2;
  const tol = 1e-5 * bounds.diag + 1e-12;
  const pairs = nen === 6 ? [[0, 1, 3], [1, 2, 4], [2, 0, 5]] : [[0, 1, -1], [1, 2, -1], [2, 0, -1]];
  // edges used by exactly one active element, oriented as in that (counter-clockwise) element
  const count = new Map();
  const first = new Map();
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    for (const [i, j, m] of pairs) {
      const a = mesh.elements[e * nen + i], b = mesh.elements[e * nen + j];
      const key = a < b ? a * nN + b : b * nN + a;
      count.set(key, (count.get(key) || 0) + 1);
      if (!first.has(key)) first.set(key, [a, b, m >= 0 ? mesh.elements[e * nen + m] : -1]);
    }
  }
  const yPhr = (x) => polylineYAt(w.phreatic, x);
  for (const [key, c] of count) {
    if (c !== 1) continue;
    const [a, b, m] = first.get(key);
    const xa = nd[2 * a], ya = nd[2 * a + 1], xb = nd[2 * b], yb = nd[2 * b + 1];
    const onLine = (v0, v1, ref) => Math.abs(v0 - ref) <= tol && Math.abs(v1 - ref) <= tol;
    if (onLine(ya, yb, bounds.ymin) || onLine(xa, xb, bounds.xmin) || onLine(xa, xb, bounds.xmax)) continue;
    const pa = gw * (yPhr(xa) - ya), pb = gw * (yPhr(xb) - yb);
    if (pa <= 0 && pb <= 0) continue;
    // sub-interval of xi in [-1, 1] where the pressure is positive (pressure linear along the edge for the clip)
    let x0 = -1, x1 = 1;
    if (pa <= 0 || pb <= 0) {
      const xc = -1 + (2 * pa) / (pa - pb);
      if (pa <= 0) x0 = xc; else x1 = xc;
    }
    if (x1 - x0 < 1e-9) continue;
    const dx = xb - xa, dy = yb - ya, L = Math.hypot(dx, dy);
    const nx = dy / L, ny = -dx / L;               // outward normal (interior is on the left of a → b)
    const half = 0.5 * (x1 - x0);
    let used = false;
    for (let ig = 0; ig < 3; ig++) {
      const xi = 0.5 * (x0 + x1) + half * EG[ig];
      const t = 0.5 * (xi + 1);
      const px = xa + dx * t, py = ya + dy * t;
      const p = Math.max(0, gw * (yPhr(px) - py));
      if (p <= 0) continue;
      used = true;
      const wgt = EW[ig] * half * 0.5 * L * p;      // dl = L/2 dxi
      const fx = -nx * wgt, fy = -ny * wgt;          // pressure pushes into the soil
      if (m >= 0) {
        const Na = 0.5 * xi * (xi - 1), Nb = 0.5 * xi * (xi + 1), Nm = 1 - xi * xi;
        F[2 * a] += Na * fx; F[2 * a + 1] += Na * fy;
        F[2 * b] += Nb * fx; F[2 * b + 1] += Nb * fy;
        F[2 * m] += Nm * fx; F[2 * m + 1] += Nm * fy;
      } else {
        const Na = 0.5 * (1 - xi), Nb = 0.5 * (1 + xi);
        F[2 * a] += Na * fx; F[2 * a + 1] += Na * fy;
        F[2 * b] += Nb * fx; F[2 * b + 1] += Nb * fy;
      }
      res.maxHead = Math.max(res.maxHead, p / gw);
    }
    if (used) res.nEdges++;
  }
  return res;
}

// Gauss points on [-1, 1] (3-point)
const EG = [-Math.sqrt(0.6), 0, Math.sqrt(0.6)];
const EW = [5 / 9, 8 / 9, 5 / 9];

/**
 * Add the nodal forces of the given loads (only those whose id is in `activeLoadIds`) to F.
 * Point loads go to the nearest node of an active element; distributed loads are integrated consistently over every
 * active element edge lying on the load segment (linear variation of the traction between the end values; quadratic
 * edge shape functions for T6, linear for T3). Edges straddling a segment end are clipped.
 */
function sumDof(F, c) { let t = 0; for (let i = c; i < F.length; i += 2) t += F[i]; return t; }

export function addExternalLoads(model, mesh, activeEl, activeNode, activeLoadIds, F, bounds) {
  const nen = mesh.nen;
  const nEl = (mesh.elements.length / nen) | 0;
  const tol = 1e-5 * bounds.diag + 1e-12;
  const nd = mesh.nodes;
  const active = new Set(activeLoadIds);
  let edgeList = null;
  const getEdges = () => {
    if (edgeList) return edgeList;
    // unique edges of active elements: [a, b, mid(-1 for T3)]
    const seen = new Set();
    edgeList = [];
    const pairs = nen === 6 ? [[0, 1, 3], [1, 2, 4], [2, 0, 5]] : [[0, 1, -1], [1, 2, -1], [2, 0, -1]];
    const nN = nd.length / 2;
    for (let e = 0; e < nEl; e++) {
      if (!activeEl[e]) continue;
      for (const [i, j, m] of pairs) {
        const a = mesh.elements[e * nen + i], b = mesh.elements[e * nen + j];
        const key = a < b ? a * nN + b : b * nN + a;
        if (seen.has(key)) continue;
        seen.add(key);
        edgeList.push([a, b, m >= 0 ? mesh.elements[e * nen + m] : -1]);
      }
    }
    return edgeList;
  };
  const summary = [];
  // The mesher moves points that lie a hair off an edge onto it (mesh.snaps); apply the same move to load coordinates.
  const snaps = mesh.snaps || [];
  const snapPt = (p) => {
    for (const s of snaps) if (Math.abs(s.from[0] - p[0]) <= 1e-12 + 1e-10 * bounds.diag && Math.abs(s.from[1] - p[1]) <= 1e-12 + 1e-10 * bounds.diag) return s.to;
    return p;
  };
  for (const L0 of model.loads || []) {
    if (!active.has(L0.id)) continue;
    const L = L0.type === 'point' ? { ...L0, p: snapPt(L0.p) } : L0.type === 'distributed' ? { ...L0, p1: snapPt(L0.p1), p2: snapPt(L0.p2) } : L0;
    if (L.type === 'point') {
      const n = nearestNode(nd, L.p, activeNode);
      if (n >= 0) { F[2 * n] += L.fx || 0; F[2 * n + 1] += L.fy || 0; }
    } else if (L.type === 'distributed') {
      const p1 = L.p1, p2 = L.p2;
      const dx = p2[0] - p1[0], dy = p2[1] - p1[1];
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      let applied = 0;
      const F0x = sumDof(F, 0), F0y = sumDof(F, 1);
      for (const [a, b, m] of getEdges()) {
        const A = [nd[2 * a], nd[2 * a + 1]], B = [nd[2 * b], nd[2 * b + 1]];
        // both end nodes must lie on the load segment's line (edges straddling a segment end are clipped below)
        const Ld = Math.sqrt(len2);
        if (Math.abs((A[0] - p1[0]) * dy - (A[1] - p1[1]) * dx) / Ld > tol) continue;
        if (Math.abs((B[0] - p1[0]) * dy - (B[1] - p1[1]) * dx) / Ld > tol) continue;
        // parameter of the load segment at both ends (unclamped, to allow clipping)
        const ta = ((A[0] - p1[0]) * dx + (A[1] - p1[1]) * dy) / len2;
        const tb = ((B[0] - p1[0]) * dx + (B[1] - p1[1]) * dy) / len2;
        // xi in [-1,1] ↔ t = ta + (tb-ta)(xi+1)/2 ; clip to t ∈ [0,1]
        let x0 = -1, x1 = 1;
        if (tb !== ta) {
          const xi0 = ((0 - ta) / (tb - ta)) * 2 - 1, xi1 = ((1 - ta) / (tb - ta)) * 2 - 1;
          const lo = Math.min(xi0, xi1), hi = Math.max(xi0, xi1);
          x0 = Math.max(-1, lo); x1 = Math.min(1, hi);
        } else if (ta < -1e-9 || ta > 1 + 1e-9) continue;
        if (x1 - x0 < 1e-9) continue;
        const Le = Math.hypot(B[0] - A[0], B[1] - A[1]);
        const half = 0.5 * (x1 - x0);
        for (let ig = 0; ig < 3; ig++) {
          const xi = 0.5 * (x0 + x1) + half * EG[ig];
          const wgt = EW[ig] * half * 0.5 * Le;   // dl = Le/2 dxi
          const t = ta + (tb - ta) * (xi + 1) / 2;
          const qx = L.qx1 + (L.qx2 - L.qx1) * t, qy = L.qy1 + (L.qy2 - L.qy1) * t;
          if (m >= 0) {
            const Na = 0.5 * xi * (xi - 1), Nb = 0.5 * xi * (xi + 1), Nm = 1 - xi * xi;
            F[2 * a] += Na * qx * wgt; F[2 * a + 1] += Na * qy * wgt;
            F[2 * b] += Nb * qx * wgt; F[2 * b + 1] += Nb * qy * wgt;
            F[2 * m] += Nm * qx * wgt; F[2 * m + 1] += Nm * qy * wgt;
          } else {
            const Na = 0.5 * (1 - xi), Nb = 0.5 * (1 + xi);
            F[2 * a] += Na * qx * wgt; F[2 * a + 1] += Na * qy * wgt;
            F[2 * b] += Nb * qx * wgt; F[2 * b + 1] += Nb * qy * wgt;
          }
        }
        applied++;
      }
      const Lseg = Math.sqrt(len2);
      summary.push({
        id: L.id, edges: applied,
        expected: [Lseg * 0.5 * (L.qx1 + L.qx2), Lseg * 0.5 * (L.qy1 + L.qy2)],
        applied: [sumDof(F, 0) - F0x, sumDof(F, 1) - F0y],
      });
    }
  }
  return summary;
}

/**
 * K0 initial effective stress for the active elements: σ'_v from the overburden above each Gauss point (integrated
 * along the vertical line through the point over all active elements above it, total unit weights, minus pore
 * pressure), σ'_h = K0 σ'_v (also σ'_zz), σ_xy = 0.
 * @returns {number} number of Gauss points initialised
 */
export function k0Stress(model, mesh, geo, activeEl, elMat, materials, gamma, pore, sig) {
  const { nen, ngp, nEl } = geo;
  const nd = mesh.nodes, conn = mesh.elements;
  const useWater = !!(model.water && model.water.enabled && model.water.phreatic && model.water.phreatic.length >= 2);
  const gw = useWater ? (model.water.gammaW ?? 9.81) : 0;
  // x-bucketed element lists (corner nodes only)
  let xmin = Infinity, xmax = -Infinity, nAct = 0;
  const exmin = new Float64Array(nEl), exmax = new Float64Array(nEl);
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    nAct++;
    let lo = Infinity, hi = -Infinity;
    for (let a = 0; a < 3; a++) { const x = nd[2 * conn[e * nen + a]]; if (x < lo) lo = x; if (x > hi) hi = x; }
    exmin[e] = lo; exmax[e] = hi;
    if (lo < xmin) xmin = lo; if (hi > xmax) xmax = hi;
  }
  if (nAct === 0) return 0;
  const width = Math.max(xmax - xmin, 1e-12);
  const nb = Math.max(1, Math.min(4096, Math.ceil(Math.sqrt(nAct))));
  const bw = width / nb;
  const bucketOf = (x) => Math.max(0, Math.min(nb - 1, Math.floor((x - xmin) / bw)));
  const cnt = new Int32Array(nb + 1);
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    for (let b = bucketOf(exmin[e]); b <= bucketOf(exmax[e]); b++) cnt[b + 1]++;
  }
  for (let b = 0; b < nb; b++) cnt[b + 1] += cnt[b];
  const items = new Int32Array(cnt[nb]);
  const fillp = cnt.slice(0, nb);
  for (let e = 0; e < nEl; e++) {
    if (!activeEl[e]) continue;
    for (let b = bucketOf(exmin[e]); b <= bucketOf(exmax[e]); b++) items[fillp[b]++] = e;
  }
  const shift = 1.2345678e-7 * width; // avoid lines exactly through mesh vertices / vertical edges
  let n = 0;
  for (let e0 = 0; e0 < nEl; e0++) {
    if (!activeEl[e0]) continue;
    const mat = materials[elMat[e0]];
    const K0 = defaultK0(mat);
    for (let k = 0; k < ngp; k++) {
      const g = e0 * ngp + k;
      const x = geo.x[g] + shift, y = geo.y[g];
      const yp = useWater ? polylineYAt(model.water.phreatic, x) : -Infinity;
      let W = 0, yTop = -Infinity;
      const b = bucketOf(x);
      for (let it = cnt[b]; it < cnt[b + 1]; it++) {
        const e = items[it];
        if (x < exmin[e] || x > exmax[e]) continue;
        // chord of triangle e (corner nodes) at abscissa x
        let ylo = Infinity, yhi = -Infinity, nHit = 0;
        for (let a = 0; a < 3; a++) {
          const na = conn[e * nen + a], nbn = conn[e * nen + (a + 1) % 3];
          const x1 = nd[2 * na], y1 = nd[2 * na + 1], x2 = nd[2 * nbn], y2 = nd[2 * nbn + 1];
          if ((x1 - x) * (x2 - x) > 0 || x1 === x2) continue;
          const yy = y1 + ((y2 - y1) * (x - x1)) / (x2 - x1);
          if (yy < ylo) ylo = yy; if (yy > yhi) yhi = yy;
          nHit++;
        }
        if (nHit < 2) continue;
        const lo = Math.max(ylo, y);
        if (yhi <= lo) continue;
        if (yhi > yTop) yTop = yhi;
        const m2 = materials[elMat[e]];
        const wet = useWater ? Math.max(0, Math.min(yhi, yp) - lo) : 0;
        W += m2.gammaSat * wet + m2.gammaUnsat * (yhi - lo - wet);
      }
      // standing water above the ground surface adds to the total vertical stress (pore pressure already includes it)
      if (useWater && yp > yTop && yTop > -Infinity) W += gw * (yp - yTop);
      // gammaSat applies only with water; without water the whole chord used gammaUnsat (wet = 0)
      const sv = Math.max(0, W - pore[g]);
      sig[4 * g] = -K0 * sv;
      sig[4 * g + 1] = -sv;
      sig[4 * g + 2] = 0;
      sig[4 * g + 3] = -K0 * sv;
      n++;
    }
  }
  return n;
}
