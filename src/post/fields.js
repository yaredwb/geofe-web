// Post-processing: result-field derivation (DOM-free, runs in Node / Worker / browser).
//
// Conventions (see ARCHITECTURE.md): SI with kN, m, kPa. Stresses are EFFECTIVE, tension positive.
// Gauss-point (GP) data are element-major arrays in `stageResult.gp`; `gp.elem[k]` is the element of GP k and
// `gp.x[k], gp.y[k]` its global position. `gxy` is the ENGINEERING shear strain.
//
// Nodal fields are obtained by (1) extrapolating GP values of each element to its corner nodes with a linear
// least-squares/exact fit in area coordinates (exact for 3 GPs of a T6, constant for 1 GP of a T3),
// (2) averaging the corner values over all ACTIVE elements sharing the node, and (3) setting each T6 midside
// node to the average of the two corner values of its edge. Nodes that belong to no active element get NaN.

/** Names accepted by nodalField(). */
export const FIELD_NAMES = [
  'ux', 'uy', 'umag', 'sxx', 'syy', 'sxy', 'szz', 's1', 's3', 'p', 'q', 'pore',
  'eps_xx', 'eps_yy', 'gamma_xy', 'eps_shear', 'eps_vol', 'plastic',
];

const INFO = {
  ux: { label: 'Displacement ux', unit: 'm' },
  uy: { label: 'Displacement uy', unit: 'm' },
  umag: { label: 'Total displacement |u|', unit: 'm' },
  sxx: { label: 'Effective stress σxx', unit: 'kPa' },
  syy: { label: 'Effective stress σyy', unit: 'kPa' },
  sxy: { label: 'Shear stress τxy', unit: 'kPa' },
  szz: { label: 'Effective stress σzz', unit: 'kPa' },
  s1: { label: 'Major principal stress σ1', unit: 'kPa' },
  s3: { label: 'Minor principal stress σ3', unit: 'kPa' },
  p: { label: "Mean effective stress p'", unit: 'kPa' },
  q: { label: 'Deviatoric stress q', unit: 'kPa' },
  pore: { label: 'Pore pressure u', unit: 'kPa' },
  eps_xx: { label: 'Strain εxx', unit: '-' },
  eps_yy: { label: 'Strain εyy', unit: '-' },
  gamma_xy: { label: 'Shear strain γxy', unit: '-' },
  eps_shear: { label: 'Max shear strain γmax', unit: '-' },
  eps_vol: { label: 'Volumetric strain εvol', unit: '-' },
  plastic: { label: 'Plastic point fraction', unit: '-' },
};

/** Human readable label and unit of a field name → {label, unit}. Unknown names echo the name. */
export function fieldInfo(name) {
  return INFO[name] ? { ...INFO[name] } : { label: String(name), unit: '' };
}

/**
 * In-plane principal stresses (tension positive) of the 2D tensor [[sxx,sxy],[sxy,syy]].
 * s1 >= s2. `angle` (rad, in (-pi/2, pi/2]) is the direction of the s1 axis measured from +x towards +y.
 * `tau` is the maximum in-plane shear stress (radius of Mohr's circle).
 */
export function principalStresses(sxx, syy, sxy) {
  const mean = 0.5 * (sxx + syy);
  const tau = Math.hypot(0.5 * (sxx - syy), sxy);
  return { s1: mean + tau, s2: mean - tau, angle: 0.5 * Math.atan2(2 * sxy, sxx - syy), tau };
}

/** {min,max} of the finite entries of an array (NaN/Infinity ignored). Empty → {min:0,max:0}. */
export function fieldRange(values) {
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
  // NaN comparisons are always false, so NaN never enters min/max.
  return min <= max ? { min, max } : { min: 0, max: 0 };
}

// ---------------------------------------------------------------------------------------------------------------
// Element shape functions / barycentric helpers (shared with render.js)
// ---------------------------------------------------------------------------------------------------------------

/** Area (barycentric) coordinates [L0,L1,L2] of (x,y) in the corner triangle (x0,y0),(x1,y1),(x2,y2). */
export function baryCoords(x, y, x0, y0, x1, y1, x2, y2) {
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  const l1 = ((x - x0) * (y2 - y0) - (x2 - x0) * (y - y0)) / det;
  const l2 = ((x1 - x0) * (y - y0) - (x - x0) * (y1 - y0)) / det;
  return [1 - l1 - l2, l1, l2];
}

/** Shape function values at area coordinates; nen = 3 (linear) or 6 (quadratic, mid nodes 3:(0-1) 4:(1-2) 5:(2-0)). */
export function shapeFunctions(nen, l0, l1, l2) {
  if (nen === 3) return [l0, l1, l2];
  return [
    l0 * (2 * l0 - 1), l1 * (2 * l1 - 1), l2 * (2 * l2 - 1),
    4 * l0 * l1, 4 * l1 * l2, 4 * l2 * l0,
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// GP → node extrapolation
// ---------------------------------------------------------------------------------------------------------------

const layoutCache = new WeakMap(); // gp object → {mesh, start, order, W}

/**
 * Per-element GP grouping and extrapolation weights. For element e with n GPs (indices order[start[e]..start[e+1])),
 * the corner value j is  sum_k W[3*start[e] + j*n + k] * v[order[start[e]+k]].
 * n >= 3: linear fit v = sum_j L_j c_j through the GPs in area coordinates (least squares; exact for n = 3).
 * n < 3 or degenerate geometry: constant (mean of GP values).
 */
function gpLayout(mesh, gp) {
  const hit = layoutCache.get(gp);
  if (hit && hit.mesh === mesh) return hit;
  const nen = mesh.nen;
  const nEl = mesh.elements.length / nen;
  const nGp = gp.elem.length;
  const start = new Int32Array(nEl + 1);
  for (let k = 0; k < nGp; k++) start[gp.elem[k] + 1]++;
  for (let e = 0; e < nEl; e++) start[e + 1] += start[e];
  const fill = start.slice(0, nEl);
  const order = new Int32Array(nGp);
  for (let k = 0; k < nGp; k++) order[fill[gp.elem[k]]++] = k;

  const W = new Float64Array(3 * nGp);
  const nodes = mesh.nodes, el = mesh.elements;
  const M = new Float64Array(3 * 64); // up to 64 GPs per element (rows of [L0 L1 L2])
  for (let e = 0; e < nEl; e++) {
    const s = start[e], n = start[e + 1] - s;
    if (n === 0) continue;
    const off = 3 * s;
    let ok = n >= 3 && n <= 64;
    if (ok) {
      const a = el[e * nen] * 2, b = el[e * nen + 1] * 2, c = el[e * nen + 2] * 2;
      const x0 = nodes[a], y0 = nodes[a + 1], x1 = nodes[b], y1 = nodes[b + 1], x2 = nodes[c], y2 = nodes[c + 1];
      const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(det) < 1e-300) ok = false;
      else {
        for (let k = 0; k < n; k++) {
          const g = order[s + k];
          const L = baryCoords(gp.x[g], gp.y[g], x0, y0, x1, y1, x2, y2);
          M[3 * k] = L[0]; M[3 * k + 1] = L[1]; M[3 * k + 2] = L[2];
        }
        // Normal matrix A = M^T M (symmetric 3x3) and its inverse by cofactors.
        let a00 = 0, a01 = 0, a02 = 0, a11 = 0, a12 = 0, a22 = 0;
        for (let k = 0; k < n; k++) {
          const p = M[3 * k], q = M[3 * k + 1], r = M[3 * k + 2];
          a00 += p * p; a01 += p * q; a02 += p * r; a11 += q * q; a12 += q * r; a22 += r * r;
        }
        const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
        const dA = a00 * c00 + a01 * c01 + a02 * c02;
        if (!(Math.abs(dA) > 1e-9)) ok = false;
        else {
          const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
          const inv = [c00 / dA, c01 / dA, c02 / dA, c01 / dA, c11 / dA, c12 / dA, c02 / dA, c12 / dA, c22 / dA];
          for (let j = 0; j < 3; j++) {
            for (let k = 0; k < n; k++) {
              W[off + j * n + k] = inv[3 * j] * M[3 * k] + inv[3 * j + 1] * M[3 * k + 1] + inv[3 * j + 2] * M[3 * k + 2];
            }
          }
        }
      }
    }
    if (!ok) {
      for (let j = 0; j < 3; j++) for (let k = 0; k < n; k++) W[off + j * n + k] = 1 / n;
    }
  }
  const out = { mesh, start, order, W };
  layoutCache.set(gp, out);
  return out;
}

function isActive(stage, e) {
  const a = stage.activeElements;
  return !a || a[e] !== 0;
}

/**
 * Extrapolate a GP-level array to nodes (see file header). `gv` is a Float64Array/array of length nGp.
 * Returns Float64Array(nNodes), NaN where no active element touches the node.
 */
function gpToNodes(mesh, stage, gv) {
  const nen = mesh.nen, nNodes = mesh.nodes.length / 2, nEl = mesh.elements.length / nen;
  const { start, order, W } = gpLayout(mesh, stage.gp);
  const sum = new Float64Array(nNodes), cnt = new Int32Array(nNodes);
  const cv = [0, 0, 0];
  for (let e = 0; e < nEl; e++) {
    if (!isActive(stage, e)) continue;
    const s = start[e], n = start[e + 1] - s;
    if (n === 0) continue;
    const off = 3 * s;
    for (let j = 0; j < 3; j++) {
      let acc = 0;
      for (let k = 0; k < n; k++) acc += W[off + j * n + k] * gv[order[s + k]];
      cv[j] = acc;
    }
    for (let j = 0; j < 3; j++) {
      const nd = mesh.elements[e * nen + j];
      sum[nd] += cv[j];
      cnt[nd]++;
    }
  }
  const out = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) out[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  fillMidsides(mesh, stage, out);
  return out;
}

/** T6: midside values = mean of the two corner values; only for nodes of active elements. */
function fillMidsides(mesh, stage, out) {
  if (mesh.nen !== 6) return;
  const nEl = mesh.elements.length / 6, el = mesh.elements;
  for (let e = 0; e < nEl; e++) {
    if (!isActive(stage, e)) continue;
    const b = e * 6;
    out[el[b + 3]] = 0.5 * (out[el[b]] + out[el[b + 1]]);
    out[el[b + 4]] = 0.5 * (out[el[b + 1]] + out[el[b + 2]]);
    out[el[b + 5]] = 0.5 * (out[el[b + 2]] + out[el[b]]);
  }
}

/** Mask nodal values (in place) to NaN where no active element touches the node. */
function maskInactive(mesh, stage, out) {
  if (!stage.activeElements) return out;
  const nen = mesh.nen, nEl = mesh.elements.length / nen;
  const used = new Uint8Array(out.length);
  for (let e = 0; e < nEl; e++) {
    if (!isActive(stage, e)) continue;
    for (let j = 0; j < nen; j++) used[mesh.elements[e * nen + j]] = 1;
  }
  for (let i = 0; i < out.length; i++) if (!used[i]) out[i] = NaN;
  return out;
}

const GP_DIRECT = { sxx: 'sxx', syy: 'syy', sxy: 'sxy', szz: 'szz', pore: 'pore', eps_xx: 'eps_xx', eps_yy: 'eps_yy', gamma_xy: 'gxy', gxy: 'gxy' };

function needGp(stage) {
  if (!stage || !stage.gp || !stage.gp.elem) throw new Error('nodalField: stage result has no Gauss-point data');
  return stage.gp;
}

/** Element-wise fraction of plastic GPs, averaged to nodes over active elements; mids = mean of corners. */
function plasticField(mesh, stage) {
  const gp = needGp(stage);
  const nen = mesh.nen, nNodes = mesh.nodes.length / 2, nEl = mesh.elements.length / nen;
  const nGp = gp.elem.length;
  const tot = new Int32Array(nEl), pl = new Int32Array(nEl);
  for (let k = 0; k < nGp; k++) { tot[gp.elem[k]]++; if (gp.plastic[k]) pl[gp.elem[k]]++; }
  const sum = new Float64Array(nNodes), cnt = new Int32Array(nNodes);
  for (let e = 0; e < nEl; e++) {
    if (!isActive(stage, e) || tot[e] === 0) continue;
    const f = pl[e] / tot[e];
    for (let j = 0; j < 3; j++) { const nd = mesh.elements[e * nen + j]; sum[nd] += f; cnt[nd]++; }
  }
  const out = new Float64Array(nNodes);
  for (let i = 0; i < nNodes; i++) out[i] = cnt[i] > 0 ? sum[i] / cnt[i] : NaN;
  fillMidsides(mesh, stage, out);
  return out;
}

/**
 * Nodal field for plotting. `name` ∈ FIELD_NAMES (alias 'gxy' for 'gamma_xy').
 *  ux, uy, umag      nodal displacement (m)
 *  sxx..szz, pore    GP stresses (kPa), extrapolated + averaged
 *  s1, s3            in-plane major / minor principal stress, computed at GPs. Tension-positive convention:
 *                    s1 = major = MOST compressive (most negative), s3 = minor = LEAST compressive
 *                    (principalStresses().s2 and .s1 respectively)
 *  p                 mean effective stress, compression positive: -(sxx+syy+szz)/3
 *  q                 von Mises equivalent deviatoric stress sqrt(3 J2)
 *  eps_xx, eps_yy, gamma_xy, eps_shear (= sqrt((exx-eyy)^2 + gxy^2)), eps_vol (= exx+eyy)
 *  plastic           fraction (0..1) of plastic GPs of the elements around a node
 * Returns Float64Array(nNodes); NaN for nodes without an active element.
 */
export function nodalField(mesh, stageResult, name) {
  const stage = stageResult;
  const nNodes = mesh.nodes.length / 2;
  if (name === 'ux' || name === 'uy' || name === 'umag') {
    const d = stage.displacement;
    if (!d) throw new Error('nodalField: stage result has no displacement');
    const out = new Float64Array(nNodes);
    for (let i = 0; i < nNodes; i++) {
      out[i] = name === 'ux' ? d[2 * i] : name === 'uy' ? d[2 * i + 1] : Math.hypot(d[2 * i], d[2 * i + 1]);
    }
    return maskInactive(mesh, stage, out);
  }
  if (name === 'plastic') return plasticField(mesh, stage);
  const gp = needGp(stage);
  if (GP_DIRECT[name]) {
    const arr = gp[GP_DIRECT[name]];
    if (!arr) throw new Error(`nodalField: GP array '${GP_DIRECT[name]}' missing`);
    return gpToNodes(mesh, stage, arr);
  }
  const n = gp.elem.length;
  const g = new Float64Array(n);
  switch (name) {
    case 's1':
      for (let k = 0; k < n; k++) g[k] = principalStresses(gp.sxx[k], gp.syy[k], gp.sxy[k]).s2; // most compressive
      break;
    case 's3':
      for (let k = 0; k < n; k++) g[k] = principalStresses(gp.sxx[k], gp.syy[k], gp.sxy[k]).s1; // least compressive
      break;
    case 'p':
      for (let k = 0; k < n; k++) g[k] = -(gp.sxx[k] + gp.syy[k] + gp.szz[k]) / 3;
      break;
    case 'q':
      for (let k = 0; k < n; k++) {
        const a = gp.sxx[k], b = gp.syy[k], c = gp.szz[k], t = gp.sxy[k];
        g[k] = Math.sqrt(0.5 * ((a - b) ** 2 + (b - c) ** 2 + (c - a) ** 2) + 3 * t * t);
      }
      break;
    case 'eps_shear':
      for (let k = 0; k < n; k++) g[k] = Math.hypot(gp.eps_xx[k] - gp.eps_yy[k], gp.gxy[k]);
      break;
    case 'eps_vol':
      for (let k = 0; k < n; k++) g[k] = gp.eps_xx[k] + gp.eps_yy[k];
      break;
    default:
      throw new Error(`nodalField: unknown field '${name}'`);
  }
  const out = gpToNodes(mesh, stage, g);
  // Extrapolating a non-negative quantity may undershoot slightly below zero.
  if (name === 'q' || name === 'eps_shear') for (let i = 0; i < out.length; i++) if (out[i] < 0) out[i] = 0;
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Point location and line sampling
// ---------------------------------------------------------------------------------------------------------------

const indexCache = new WeakMap(); // mesh → grid index

/** Uniform grid over the mesh bounding box; each cell lists the elements whose corner-triangle bbox overlaps it. */
function spatialIndex(mesh) {
  const hit = indexCache.get(mesh);
  if (hit && hit.nodes === mesh.nodes && hit.elements === mesh.elements) return hit;
  const nen = mesh.nen, nEl = mesh.elements.length / nen, X = mesh.nodes, el = mesh.elements;
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (let i = 0; i < X.length; i += 2) {
    if (X[i] < xmin) xmin = X[i];
    if (X[i] > xmax) xmax = X[i];
    if (X[i + 1] < ymin) ymin = X[i + 1];
    if (X[i + 1] > ymax) ymax = X[i + 1];
  }
  const w = Math.max(xmax - xmin, 1e-12), h = Math.max(ymax - ymin, 1e-12);
  // ~2 elements per cell on average, cells roughly square.
  const target = Math.max(1, Math.sqrt(nEl / 2));
  const nx = Math.max(1, Math.min(2048, Math.round(target * Math.sqrt(w / h))));
  const ny = Math.max(1, Math.min(2048, Math.round(target * Math.sqrt(h / w))));
  const cw = w / nx, ch = h / ny;
  const bounds = new Int32Array(4 * nEl);
  const counts = new Int32Array(nx * ny + 1);
  const cellOf = (v, v0, c, n) => Math.max(0, Math.min(n - 1, Math.floor((v - v0) / c)));
  for (let e = 0; e < nEl; e++) {
    const a = el[e * nen] * 2, b = el[e * nen + 1] * 2, c = el[e * nen + 2] * 2;
    const ex0 = Math.min(X[a], X[b], X[c]), ex1 = Math.max(X[a], X[b], X[c]);
    const ey0 = Math.min(X[a + 1], X[b + 1], X[c + 1]), ey1 = Math.max(X[a + 1], X[b + 1], X[c + 1]);
    const i0 = cellOf(ex0, xmin, cw, nx), i1 = cellOf(ex1, xmin, cw, nx);
    const j0 = cellOf(ey0, ymin, ch, ny), j1 = cellOf(ey1, ymin, ch, ny);
    bounds[4 * e] = i0; bounds[4 * e + 1] = i1; bounds[4 * e + 2] = j0; bounds[4 * e + 3] = j1;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) counts[j * nx + i + 1]++;
  }
  for (let c = 0; c < nx * ny; c++) counts[c + 1] += counts[c];
  const items = new Int32Array(counts[nx * ny]);
  const fill = counts.slice(0, nx * ny);
  for (let e = 0; e < nEl; e++) {
    for (let j = bounds[4 * e + 2]; j <= bounds[4 * e + 3]; j++) {
      for (let i = bounds[4 * e]; i <= bounds[4 * e + 1]; i++) items[fill[j * nx + i]++] = e;
    }
  }
  const idx = { nodes: mesh.nodes, elements: mesh.elements, xmin, ymin, xmax, ymax, nx, ny, cw, ch, start: counts, items };
  indexCache.set(mesh, idx);
  return idx;
}

/** Cell of the spatial index containing (x,y), or -1 when the point is outside the padded bounding box. */
function cellAt(idx, x, y, tol) {
  const pad = tol * Math.max(idx.xmax - idx.xmin, idx.ymax - idx.ymin, 1e-12) * 10;
  if (x < idx.xmin - pad || x > idx.xmax + pad || y < idx.ymin - pad || y > idx.ymax + pad) return -1;
  const i = Math.max(0, Math.min(idx.nx - 1, Math.floor((x - idx.xmin) / idx.cw)));
  const j = Math.max(0, Math.min(idx.ny - 1, Math.floor((y - idx.ymin) / idx.ch)));
  return j * idx.nx + i;
}

/**
 * Locate point (x,y) in the mesh (straight-sided corner triangles).
 * Returns {el, L:[L0,L1,L2]} or null if outside. Tolerance allows points on element edges / mesh boundary.
 * `active` (optional Uint8Array/array over elements, 0 = excavated/inactive) restricts the search to active
 * elements, so a point on an edge shared by an active and an inactive element resolves to the active one.
 */
export function locatePoint(mesh, x, y, tol = 1e-9, active = null) {
  const idx = spatialIndex(mesh);
  const c = cellAt(idx, x, y, tol);
  if (c < 0) return null;
  const nen = mesh.nen, X = mesh.nodes, el = mesh.elements;
  let best = null, bestMin = -Infinity;
  for (let k = idx.start[c]; k < idx.start[c + 1]; k++) {
    const e = idx.items[k];
    if (active && !active[e]) continue;
    const a = el[e * nen] * 2, b = el[e * nen + 1] * 2, d = el[e * nen + 2] * 2;
    const L = baryCoords(x, y, X[a], X[a + 1], X[b], X[b + 1], X[d], X[d + 1]);
    const m = Math.min(L[0], L[1], L[2]);
    if (m >= -tol) return { el: e, L };
    if (m > bestMin) { bestMin = m; best = { el: e, L }; }
  }
  return bestMin >= -1e-6 && best ? best : null; // slightly looser fallback for numerical edge cases
}

function evalAt(mesh, values, loc) {
  const nen = mesh.nen;
  const N = shapeFunctions(nen, loc.L[0], loc.L[1], loc.L[2]);
  let v = 0;
  for (let j = 0; j < nen; j++) {
    if (Math.abs(N[j]) < 1e-14) continue; // a masked (NaN) node with zero weight must not poison the sum
    v += N[j] * values[mesh.elements[loc.el * nen + j]];
  }
  return v;
}

/**
 * Interpolate nodal `values` at (x,y) with element shape functions (T3 linear / T6 quadratic). NaN if outside.
 * `active` (optional) restricts the lookup to active elements. Without it, a point on an edge shared with an
 * element whose nodal values are NaN (excavated) falls back to the other elements containing the point.
 */
export function interpolateAt(mesh, values, x, y, active = null) {
  const loc = locatePoint(mesh, x, y, 1e-9, active);
  if (!loc) return NaN;
  const v = evalAt(mesh, values, loc);
  if (Number.isFinite(v) || active) return v;
  // No mask given: scan the remaining candidate elements containing the point and take the first finite value.
  const idx = spatialIndex(mesh), c = cellAt(idx, x, y, 1e-9);
  const nen = mesh.nen, X = mesh.nodes, el = mesh.elements;
  for (let k = idx.start[c]; k < idx.start[c + 1]; k++) {
    const e = idx.items[k];
    if (e === loc.el) continue;
    const a = el[e * nen] * 2, b = el[e * nen + 1] * 2, d = el[e * nen + 2] * 2;
    const L = baryCoords(x, y, X[a], X[a + 1], X[b], X[b + 1], X[d], X[d + 1]);
    if (Math.min(L[0], L[1], L[2]) < -1e-9) continue;
    const w = evalAt(mesh, values, { el: e, L });
    if (Number.isFinite(w)) return w;
  }
  return v;
}

/**
 * Sample nodal `values` at n equally spaced points from p1 to p2 (both included, n >= 2).
 * Returns [{s, x, y, v}] with s the distance from p1; v = NaN for points outside the mesh (or in inactive areas).
 * `active` (optional per-element mask of the stage) keeps lines along excavation boundaries free of gaps.
 */
export function sampleAlongLine(mesh, values, p1, p2, n = 100, active = null) {
  n = Math.max(2, Math.floor(n));
  const L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const x = p1[0] + t * (p2[0] - p1[0]);
    const y = p1[1] + t * (p2[1] - p1[1]);
    out[i] = { s: t * L, x, y, v: interpolateAt(mesh, values, x, y, active) };
  }
  return out;
}
