// Post-processing canvas renderers. Only uses the CanvasRenderingContext2D passed in (no DOM, no Path2D),
// so it also runs against a mock context in Node tests.
//
// `view` = {scale, ox, oy, toScreen?([x,y]) → [sx,sy]}. If `toScreen` is absent the convention of
// src/app/state.js is used: screen = (x*scale + ox, -y*scale + oy).
// Most functions accept `opts.coords` (Float64Array of node positions, e.g. from deformedNodes()) to draw on a
// deformed configuration, and `opts.activeElements` (Uint8Array) to hide elements of inactive stage regions.

import { fieldRange, baryCoords, shapeFunctions, principalStresses } from './fields.js';

// ---------------------------------------------------------------------------------------------------------------
// Colormaps
// ---------------------------------------------------------------------------------------------------------------

function lerpStops(stops, t) {
  if (!(t > 0)) t = 0; // also catches NaN
  if (t > 1) t = 1;
  const f = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(f));
  const u = f - i;
  const a = stops[i], b = stops[i + 1];
  return [
    Math.round(a[0] + u * (b[0] - a[0])),
    Math.round(a[1] + u * (b[1] - a[1])),
    Math.round(a[2] + u * (b[2] - a[2])),
  ];
}

const RAINBOW = [[0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0]];
const JET = [[0, 0, 128], [0, 0, 255], [0, 255, 255], [255, 255, 0], [255, 0, 0], [128, 0, 0]];
const VIRIDIS = [
  [68, 1, 84], [71, 45, 123], [59, 82, 139], [44, 114, 142], [33, 145, 140],
  [40, 174, 128], [94, 201, 98], [170, 220, 50], [253, 231, 37],
];

/** Colormaps: functions t ∈ [0,1] → [r,g,b] (0..255 integers). rainbow = blue→cyan→green→yellow→red. */
export const colormaps = {
  rainbow: (t) => lerpStops(RAINBOW, t),
  viridis: (t) => lerpStops(VIRIDIS, t),
  jet: (t) => lerpStops(JET, t),
};

/** Accepts a colormap name or function; unknown names fall back to rainbow. */
export function resolveColormap(cm) {
  if (typeof cm === 'function') return cm;
  return colormaps[cm] || colormaps.rainbow;
}

/** n discrete band colours [[r,g,b],...] (band 0 = lowest = t 0, last band = t 1). */
export function levelColors(colormap, n) {
  const f = resolveColormap(colormap);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = f(n === 1 ? 0.5 : i / (n - 1));
  return out;
}

/** Same as levelColors but as CSS strings 'rgb(r,g,b)'. */
export function levelColorStrings(colormap, n) {
  return levelColors(colormap, n).map((c) => `rgb(${c[0]},${c[1]},${c[2]})`);
}

// ---------------------------------------------------------------------------------------------------------------
// Levels / number formatting
// ---------------------------------------------------------------------------------------------------------------

/**
 * "Nice" ascending band edges covering [min,max] with roughly n bands (step ∈ {1,2,5}·10^k).
 * Returns edges (length bands+1), first ≤ min and last ≥ max.
 */
export function niceLevels(min, max, n = 10) {
  n = Math.max(1, Math.floor(n));
  if (!isFinite(min) || !isFinite(max)) return [0, 1];
  if (max < min) [min, max] = [max, min];
  if (max - min < 1e-300 || max - min < 1e-12 * Math.max(Math.abs(min), Math.abs(max))) {
    const d = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1; // degenerate range → symmetric window
    min -= d; max += d;
  }
  const raw = (max - min) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const f = raw / mag;
  const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  const i0 = Math.floor(min / step + 1e-9), i1 = Math.ceil(max / step - 1e-9);
  const out = [];
  for (let i = i0; i <= i1; i++) out.push(Number((i * step).toPrecision(12)) + 0); // +0 turns -0 into 0
  return out;
}

/** Equal-width band edges between min and max (nBands bands → nBands+1 edges). */
export function uniformLevels(min, max, nBands) {
  const out = new Array(nBands + 1);
  for (let i = 0; i <= nBands; i++) out[i] = min + ((max - min) * i) / nBands;
  // Snap rounding noise around zero (e.g. 2.2e-16 instead of 0) and keep the end edges exact.
  const tol = 1e-9 * Math.abs(max - min);
  for (let i = 1; i < nBands; i++) if (Math.abs(out[i]) < tol) out[i] = 0;
  out[0] = min; out[nBands] = max;
  return out;
}

/**
 * Engineering-style number: ≤ `digits` significant digits; plain decimal for 0.01 ≤ |v| < 1e5,
 * otherwise mantissa·e(multiple of 3), e.g. 0.0000125 → "12.5e-6", 2.5e6 → "2.5e6".
 */
export function formatEng(v, digits = 3) {
  if (v === 0 || !isFinite(v)) return v === 0 ? '0' : String(v);
  const a = Math.abs(v);
  if (a >= 0.01 && a < 1e5) return String(parseFloat(v.toPrecision(digits)));
  let e = Math.floor(Math.log10(a));
  e -= ((e % 3) + 3) % 3; // down to a multiple of 3
  let s = parseFloat((v / Math.pow(10, e)).toPrecision(digits));
  if (Math.abs(s) >= 1000) { s /= 1000; e += 3; } // rounding spill-over (e.g. 999.9 → 1000)
  return `${parseFloat(s.toPrecision(digits))}e${e}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------------------------------------------

/** Node positions after adding scale·disp (new Float64Array, same layout as mesh.nodes). */
export function deformedNodes(mesh, disp, scale = 1) {
  const out = new Float64Array(mesh.nodes.length);
  for (let i = 0; i < out.length; i++) out[i] = mesh.nodes[i] + scale * (disp ? disp[i] : 0);
  return out;
}

/** Scale factor so that the largest displacement is drawn as ~10% of the model size (rounded to 2 digits). */
export function autoDeformScale(mesh, disp) {
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let i = 0; i < mesh.nodes.length; i += 2) {
    const x = mesh.nodes[i], y = mesh.nodes[i + 1];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  const size = Math.max(xmax - xmin, ymax - ymin);
  let umax = 0;
  if (disp) for (let i = 0; i + 1 < disp.length; i += 2) umax = Math.max(umax, Math.hypot(disp[i], disp[i + 1]));
  if (!(umax > 0) || !(size > 0)) return 1;
  return Number((0.1 * size / umax).toPrecision(2));
}

/** {pt(x,y) → [sx,sy], dir(ux,uy) → unit screen direction} for a view. */
function makeScreen(view) {
  const f = typeof view.toScreen === 'function'
    ? (x, y) => view.toScreen([x, y])
    : (x, y) => [x * view.scale + view.ox, -y * view.scale + view.oy];
  return {
    pt: f,
    dir(ux, uy) {
      const o = f(0, 0), e = f(ux, uy);
      const dx = e[0] - o[0], dy = e[1] - o[1], L = Math.hypot(dx, dy);
      return L > 0 ? [dx / L, dy / L] : [1, 0];
    },
  };
}

/** Project interleaved world coordinates to interleaved screen coordinates. */
function projectAll(view, xy) {
  const scr = makeScreen(view);
  const out = new Float64Array(xy.length);
  for (let i = 0; i < xy.length; i += 2) {
    const p = scr.pt(xy[i], xy[i + 1]);
    out[i] = p[0];
    out[i + 1] = p[1];
  }
  return out;
}

function nodesOf(mesh, opts) {
  return (opts && opts.coords) || mesh.nodes;
}

function elemActive(opts, e) {
  const a = opts && opts.activeElements;
  return !a || a[e] !== 0;
}

/** Sub-edges of an element as node-index pairs (T6 edges go through the midside node). */
function subEdges(nen) {
  return nen === 6 ? [[0, 3], [3, 1], [1, 4], [4, 2], [2, 5], [5, 0]] : [[0, 1], [1, 2], [2, 0]];
}

/**
 * Free (boundary) edges of the active part of the mesh, as flat Int32Array triples [a, mid, b] (mid = -1 for T3).
 * An edge is free when exactly one active element owns it; works for interior excavations of staged analyses.
 */
export function freeEdges(mesh, activeElements) {
  const nen = mesh.nen, nEl = mesh.elements.length / nen, el = mesh.elements, nN = mesh.nodes.length / 2;
  const map = new Map(); // key → index in lists
  const A = [], B = [], M = [], C = [];
  const pairs = nen === 6 ? [[0, 1, 3], [1, 2, 4], [2, 0, 5]] : [[0, 1, -1], [1, 2, -1], [2, 0, -1]];
  for (let e = 0; e < nEl; e++) {
    if (activeElements && activeElements[e] === 0) continue;
    for (const [i, j, m] of pairs) {
      const a = el[e * nen + i], b = el[e * nen + j];
      const key = a < b ? a * nN + b : b * nN + a;
      const idx = map.get(key);
      if (idx === undefined) {
        map.set(key, A.length);
        A.push(a); B.push(b); M.push(m < 0 ? -1 : el[e * nen + m]); C.push(1);
      } else C[idx]++;
    }
  }
  const out = [];
  for (let k = 0; k < A.length; k++) if (C[k] === 1) out.push(A[k], M[k], B[k]);
  return Int32Array.from(out);
}

function strokeFreeEdges(ctx, xy, fe) {
  ctx.beginPath();
  for (let k = 0; k < fe.length; k += 3) {
    const a = fe[k] * 2, m = fe[k + 1], b = fe[k + 2] * 2;
    ctx.moveTo(xy[a], xy[a + 1]);
    if (m >= 0) ctx.lineTo(xy[m * 2], xy[m * 2 + 1]);
    ctx.lineTo(xy[b], xy[b + 1]);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------------------------------------------
// drawMesh / drawDeformed
// ---------------------------------------------------------------------------------------------------------------

function paintMesh(ctx, view, mesh, world, opts) {
  const nen = mesh.nen, nEl = mesh.elements.length / nen, el = mesh.elements;
  const nN = mesh.nodes.length / 2;
  const xy = projectAll(view, world);
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  // Region fill: one path per region colour (polygon through corner and midside nodes).
  const rc = opts.regionColors;
  if (rc && mesh.elementRegion) {
    const buckets = new Map();
    for (let e = 0; e < nEl; e++) {
      if (!elemActive(opts, e)) continue;
      const col = rc[mesh.elementRegion[e]];
      if (!col) continue;
      let b = buckets.get(col);
      if (!b) buckets.set(col, (b = []));
      b.push(e);
    }
    const order = nen === 6 ? [0, 3, 1, 4, 2, 5] : [0, 1, 2];
    ctx.globalAlpha = opts.fillAlpha ?? 1;
    ctx.lineWidth = 1;
    for (const [col, list] of buckets) {
      ctx.fillStyle = col;
      ctx.strokeStyle = col;
      ctx.beginPath();
      for (const e of list) {
        for (let k = 0; k < order.length; k++) {
          const n = el[e * nen + order[k]] * 2;
          if (k === 0) ctx.moveTo(xy[n], xy[n + 1]);
          else ctx.lineTo(xy[n], xy[n + 1]);
        }
        ctx.closePath();
      }
      ctx.fill();
      ctx.stroke(); // same-colour stroke hides anti-aliasing seams between neighbouring fills
    }
    ctx.globalAlpha = 1;
  }

  // Element edges (each shared sub-edge drawn once, in one batched path).
  if (opts.showEdges !== false) {
    const seen = new Set();
    const se = subEdges(nen);
    ctx.strokeStyle = opts.edgeColor ?? 'rgba(0,0,0,0.45)';
    ctx.lineWidth = opts.lineWidth ?? 0.6;
    ctx.beginPath();
    for (let e = 0; e < nEl; e++) {
      if (!elemActive(opts, e)) continue;
      for (const [i, j] of se) {
        const a = el[e * nen + i], b = el[e * nen + j];
        const key = a < b ? a * nN + b : b * nN + a;
        if (seen.has(key)) continue;
        seen.add(key);
        ctx.moveTo(xy[2 * a], xy[2 * a + 1]);
        ctx.lineTo(xy[2 * b], xy[2 * b + 1]);
      }
    }
    ctx.stroke();
  }

  // Emphasised outer boundary of the (active) domain.
  if (opts.showBoundary !== false) {
    ctx.strokeStyle = opts.boundaryColor ?? '#000';
    ctx.lineWidth = opts.boundaryWidth ?? 1.8;
    strokeFreeEdges(ctx, xy, freeEdges(mesh, opts.activeElements));
  }

  if (opts.nodes) {
    const s = opts.nodeSize ?? 2;
    ctx.fillStyle = opts.nodeColor ?? '#000';
    ctx.beginPath();
    for (let i = 0; i < nN; i++) ctx.rect(xy[2 * i] - s / 2, xy[2 * i + 1] - s / 2, s, s);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw the undeformed mesh. opts: {regionColors: array (by region index) of CSS colours, fillAlpha, showEdges,
 * edgeColor, lineWidth, showBoundary, boundaryColor, boundaryWidth, nodes, activeElements, coords}.
 */
export function drawMesh(ctx, view, mesh, opts = {}) {
  paintMesh(ctx, view, mesh, nodesOf(mesh, opts), opts);
}

/**
 * Draw the deformed mesh: node positions = x + scale·disp. Defaults to red-brown thin edges, no fill.
 * Same opts as drawMesh.
 */
export function drawDeformed(ctx, view, mesh, disp, scale, opts = {}) {
  const o = { edgeColor: '#a33b1d', boundaryColor: '#a33b1d', boundaryWidth: 1.4, lineWidth: 0.6, ...opts };
  paintMesh(ctx, view, mesh, deformedNodes(mesh, disp, scale ?? autoDeformScale(mesh, disp)), o);
}

// ---------------------------------------------------------------------------------------------------------------
// Banded filled contours
// ---------------------------------------------------------------------------------------------------------------

const SCRATCH_A = new Float64Array(3 * 16);
const SCRATCH_B = new Float64Array(3 * 16);

/** Sutherland–Hodgman clip of a polygon (stride 3: x,y,v) against v ≥ thr (above) or v ≤ thr. Returns vertex count. */
function clipPoly(src, n, dst, thr, above) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const vi = src[3 * i + 2], vj = src[3 * j + 2];
    const inI = above ? vi >= thr : vi <= thr;
    const inJ = above ? vj >= thr : vj <= thr;
    if (inI) { dst[3 * m] = src[3 * i]; dst[3 * m + 1] = src[3 * i + 1]; dst[3 * m + 2] = vi; m++; }
    if (inI !== inJ) {
      const t = (thr - vi) / (vj - vi);
      dst[3 * m] = src[3 * i] + t * (src[3 * j] - src[3 * i]);
      dst[3 * m + 1] = src[3 * i + 1] + t * (src[3 * j + 1] - src[3 * i + 1]);
      dst[3 * m + 2] = thr;
      m++;
    }
  }
  return m;
}

/**
 * Part of triangle (xs[3], ys[3]) where lo ≤ v ≤ hi, with v linear over the triangle (vs[3]).
 * lo/hi may be ±Infinity. Returns polygon [[x,y],...] (empty if no overlap).
 */
export function clipTriangleToBand(xs, ys, vs, lo, hi) {
  let a = SCRATCH_A, b = SCRATCH_B;
  for (let i = 0; i < 3; i++) { a[3 * i] = xs[i]; a[3 * i + 1] = ys[i]; a[3 * i + 2] = vs[i]; }
  let n = 3;
  if (lo > -Infinity) { n = clipPoly(a, n, b, lo, true); [a, b] = [b, a]; }
  if (n >= 3 && hi < Infinity) { n = clipPoly(a, n, b, hi, false); [a, b] = [b, a]; }
  const out = [];
  if (n >= 3) for (let i = 0; i < n; i++) out.push([a[3 * i], a[3 * i + 1]]);
  return out;
}

/** Index of the band containing v (edges ascending, bands 0..n-1; outside values clamp to the end bands). */
function bandOf(v, edges) {
  let lo = 0, hi = edges.length - 2; // band index range
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (v >= edges[mid]) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Sub-triangle connectivity (local node indices) of a T6: 3 corner triangles + the medial one.
const T6_SUB = [[0, 3, 5], [3, 1, 4], [5, 4, 2], [3, 4, 5]];

/**
 * Compute band polygons. `xy` = interleaved node coordinates in whatever space polygons are wanted (screen or world),
 * `values` nodal values, `edges` ascending band edges. Triangles with non-finite values or inactive elements are skipped.
 * Returns an array (one entry per band) of {pts: flat [x,y,...], counts: vertices per polygon}.
 * Every sub-triangle is clipped exactly against the band edges, so the polygons of all bands tile the triangle.
 */
export function contourBands(mesh, xy, values, edges, activeElements) {
  const nb = edges.length - 1;
  const bands = Array.from({ length: nb }, () => ({ pts: [], counts: [] }));
  const nen = mesh.nen, nEl = mesh.elements.length / nen, el = mesh.elements;
  const subs = nen === 6 ? T6_SUB : [[0, 1, 2]];
  const xs = [0, 0, 0], ys = [0, 0, 0], vs = [0, 0, 0];
  for (let e = 0; e < nEl; e++) {
    if (activeElements && activeElements[e] === 0) continue;
    for (const s of subs) {
      const n0 = el[e * nen + s[0]], n1 = el[e * nen + s[1]], n2 = el[e * nen + s[2]];
      const v0 = values[n0], v1 = values[n1], v2 = values[n2];
      if (!(isFinite(v0) && isFinite(v1) && isFinite(v2))) continue;
      const b0 = bandOf(v0, edges), b1 = bandOf(v1, edges), b2 = bandOf(v2, edges);
      const bmin = Math.min(b0, b1, b2), bmax = Math.max(b0, b1, b2);
      if (bmin === bmax) { // common case: whole triangle inside one band
        const B = bands[bmin];
        B.pts.push(xy[2 * n0], xy[2 * n0 + 1], xy[2 * n1], xy[2 * n1 + 1], xy[2 * n2], xy[2 * n2 + 1]);
        B.counts.push(3);
        continue;
      }
      xs[0] = xy[2 * n0]; ys[0] = xy[2 * n0 + 1]; vs[0] = v0;
      xs[1] = xy[2 * n1]; ys[1] = xy[2 * n1 + 1]; vs[1] = v1;
      xs[2] = xy[2 * n2]; ys[2] = xy[2 * n2 + 1]; vs[2] = v2;
      for (let b = bmin; b <= bmax; b++) {
        const poly = clipTriangleToBand(xs, ys, vs, b > 0 ? edges[b] : -Infinity, b < nb - 1 ? edges[b + 1] : Infinity);
        if (poly.length < 3) continue;
        const B = bands[b];
        for (const p of poly) B.pts.push(p[0], p[1]);
        B.counts.push(poly.length);
      }
    }
  }
  return bands;
}

/**
 * Banded filled contours of nodal `values`. T6 elements are split into 4 sub-triangles and each triangle is clipped
 * against the band edges (true iso-band polygons, not flat per-triangle fills). Same-colour strokes close seams.
 * opts: {min, max (default: data range), nLevels (default 12), levels (explicit ascending edges, overrides),
 *        colormap (name|fn, default 'rainbow'), coords, activeElements, alpha, seamWidth (default 1, 0 = off)}.
 * Returns {levels, colors, min, max} (what was drawn, for building a matching legend).
 */
export function drawContours(ctx, view, mesh, values, opts = {}) {
  let edges = opts.levels;
  let min = opts.min, max = opts.max;
  if (!edges) {
    if (!isFinite(min) || !isFinite(max)) {
      const r = fieldRange(values);
      if (!isFinite(min)) min = r.min;
      if (!isFinite(max)) max = r.max;
    }
    if (max < min) [min, max] = [max, min]; // reversed manual range → ascending
    if (!(max > min)) { // flat field → a single visible band around the value
      const d = Math.abs(min) > 0 ? Math.abs(min) * 1e-3 : 1e-3;
      min -= d; max += d;
    }
    edges = uniformLevels(min, max, Math.max(1, opts.nLevels ?? 12));
  } else {
    edges = Array.from(edges).sort((a, b) => a - b);
    min = edges[0]; max = edges[edges.length - 1];
  }
  const nb = edges.length - 1;
  const css = levelColorStrings(opts.colormap, nb);
  const xy = projectAll(view, nodesOf(mesh, opts));
  const bands = contourBands(mesh, xy, values, edges, opts.activeElements);

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineWidth = opts.seamWidth ?? 1;
  ctx.globalAlpha = opts.alpha ?? 1;
  for (let b = 0; b < nb; b++) {
    const { pts, counts } = bands[b];
    if (counts.length === 0) continue;
    ctx.fillStyle = css[b];
    ctx.strokeStyle = css[b];
    ctx.beginPath();
    let q = 0;
    for (let c = 0; c < counts.length; c++) {
      const n = counts[c];
      ctx.moveTo(pts[q], pts[q + 1]);
      for (let k = 1; k < n; k++) ctx.lineTo(pts[q + 2 * k], pts[q + 2 * k + 1]);
      ctx.closePath();
      q += 2 * n;
    }
    ctx.fill();
    if (ctx.lineWidth > 0) ctx.stroke();
  }
  ctx.restore();
  return { levels: edges, colors: levelColors(opts.colormap, nb), min, max };
}

// ---------------------------------------------------------------------------------------------------------------
// Vectors, plastic points, principal stress crosses
// ---------------------------------------------------------------------------------------------------------------

/** Keep, per `spacing`×`spacing` screen cell, the candidate with the largest weight. Returns kept indices. */
function thin(sx, sy, weight, n, spacing) {
  if (!(spacing > 0)) return Array.from({ length: n }, (_, i) => i);
  const best = new Map();
  for (let i = 0; i < n; i++) {
    if (!isFinite(sx[i]) || !isFinite(sy[i])) continue;
    const key = Math.floor(sx[i] / spacing) * 1e7 + Math.floor(sy[i] / spacing);
    const j = best.get(key);
    if (j === undefined || weight[i] > weight[j]) best.set(key, i);
  }
  return Array.from(best.values());
}

/**
 * Displacement arrows at a screen-space subsample of nodes, length ∝ |u| with the largest drawn at opts.maxLen px.
 * opts: {maxLen (36), spacing (28 px), color, lineWidth, headSize, refMax (reference |u| for the max length),
 *        coords, activeElements}.
 */
export function drawVectors(ctx, view, mesh, disp, opts = {}) {
  const nN = mesh.nodes.length / 2;
  const nen = mesh.nen, nEl = mesh.elements.length / nen;
  const xyW = nodesOf(mesh, opts);
  const used = new Uint8Array(nN);
  for (let e = 0; e < nEl; e++) {
    if (!elemActive(opts, e)) continue;
    for (let j = 0; j < nen; j++) used[mesh.elements[e * nen + j]] = 1;
  }
  const mag = new Float64Array(nN);
  let umax = 0;
  for (let i = 0; i < nN; i++) {
    if (!used[i]) continue;
    mag[i] = Math.hypot(disp[2 * i], disp[2 * i + 1]);
    if (mag[i] > umax) umax = mag[i];
  }
  umax = opts.refMax ?? umax;
  if (!(umax > 0)) return;
  const scr = makeScreen(view);
  const sx = new Float64Array(nN), sy = new Float64Array(nN);
  for (let i = 0; i < nN; i++) {
    if (!used[i]) { sx[i] = NaN; sy[i] = NaN; continue; }
    const p = scr.pt(xyW[2 * i], xyW[2 * i + 1]);
    sx[i] = p[0]; sy[i] = p[1];
  }
  const keep = thin(sx, sy, mag, nN, opts.spacing ?? 28);
  const maxLen = opts.maxLen ?? 36;
  const headLen = opts.headSize ?? 6;
  ctx.save();
  ctx.strokeStyle = opts.color ?? '#1f4e9c';
  ctx.fillStyle = opts.color ?? '#1f4e9c';
  ctx.lineWidth = opts.lineWidth ?? 1.2;
  ctx.lineCap = 'round';
  const heads = [];
  ctx.beginPath();
  for (const i of keep) {
    if (mag[i] <= 1e-9 * umax) continue;
    const L = (mag[i] / umax) * maxLen;
    const d = scr.dir(disp[2 * i], disp[2 * i + 1]);
    const ex = sx[i] + d[0] * L, ey = sy[i] + d[1] * L;
    ctx.moveTo(sx[i], sy[i]);
    ctx.lineTo(ex, ey);
    const h = Math.min(headLen, 0.45 * L);
    heads.push([ex, ey, d[0], d[1], h]);
  }
  ctx.stroke();
  ctx.beginPath();
  for (const [ex, ey, dx, dy, h] of heads) {
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - h * dx + 0.4 * h * dy, ey - h * dy - 0.4 * h * dx);
    ctx.lineTo(ex - h * dx - 0.4 * h * dy, ey - h * dy + 0.4 * h * dx);
    ctx.closePath();
  }
  ctx.fill();
  ctx.restore();
}

/**
 * GP positions in world space, optionally moved to the deformed configuration when opts.mesh, opts.disp (and
 * opts.deformScale) are given. Returns {x,y,idx[]} for GPs in active elements only.
 */
function gpPositions(stage, opts) {
  const gp = stage.gp;
  const n = gp.elem.length;
  const idx = [];
  const x = new Float64Array(n), y = new Float64Array(n);
  const mesh = opts.mesh, disp = opts.disp;
  const def = mesh && disp;
  const scale = opts.deformScale ?? 1;
  for (let k = 0; k < n; k++) {
    const e = gp.elem[k];
    if (stage.activeElements && stage.activeElements[e] === 0) continue;
    let px = gp.x[k], py = gp.y[k];
    if (def) {
      const nen = mesh.nen, el = mesh.elements, X = mesh.nodes;
      const a = el[e * nen], b = el[e * nen + 1], c = el[e * nen + 2];
      const L = baryCoords(px, py, X[2 * a], X[2 * a + 1], X[2 * b], X[2 * b + 1], X[2 * c], X[2 * c + 1]);
      const N = shapeFunctions(nen, L[0], L[1], L[2]);
      let ux = 0, uy = 0;
      for (let j = 0; j < nen; j++) { const nd = el[e * nen + j]; ux += N[j] * disp[2 * nd]; uy += N[j] * disp[2 * nd + 1]; }
      px += scale * ux; py += scale * uy;
    }
    x[k] = px; y[k] = py;
    idx.push(k);
  }
  return { x, y, idx };
}

/**
 * Plastic Gauss points: red squares = shear (plastic==1), white squares with cyan outline = tension (plastic==2).
 * opts: {size (5 px), shearColor, tensionColor, tensionFill, mesh+disp+deformScale (follow deformed shape)}.
 */
export function drawPlasticPoints(ctx, view, stageResult, opts = {}) {
  const gp = stageResult && stageResult.gp;
  if (!gp || !gp.plastic) return;
  const scr = makeScreen(view);
  const { x, y, idx } = gpPositions(stageResult, opts);
  const s = opts.size ?? 5;
  const shear = [], tens = [];
  for (const k of idx) {
    const p = gp.plastic[k];
    if (p === 1) shear.push(k); else if (p === 2) tens.push(k);
  }
  ctx.save();
  ctx.lineWidth = 1;
  if (shear.length) {
    ctx.fillStyle = opts.shearColor ?? '#e00000';
    ctx.beginPath();
    for (const k of shear) { const q = scr.pt(x[k], y[k]); ctx.rect(q[0] - s / 2, q[1] - s / 2, s, s); }
    ctx.fill();
  }
  if (tens.length) {
    ctx.fillStyle = opts.tensionFill ?? '#ffffff';
    ctx.strokeStyle = opts.tensionColor ?? '#00bcd4';
    ctx.beginPath();
    for (const k of tens) { const q = scr.pt(x[k], y[k]); ctx.rect(q[0] - s / 2, q[1] - s / 2, s, s); }
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * Principal stress crosses at Gauss points: two orthogonal lines along the in-plane principal directions, length ∝ |σ|
 * (largest = opts.maxLen px). Compression red, tension blue. Thinned to one cross per opts.spacing px cell.
 * opts: {maxLen (24), spacing (18), compColor, tensColor, lineWidth, refMax, mesh+disp+deformScale}.
 */
export function drawPrincipalStressCrosses(ctx, view, stageResult, opts = {}) {
  const gp = stageResult && stageResult.gp;
  if (!gp) return;
  const scr = makeScreen(view);
  const { x, y, idx } = gpPositions(stageResult, opts);
  if (!idx.length) return;
  const n = gp.elem.length;
  const s1 = new Float64Array(n), s2 = new Float64Array(n), ang = new Float64Array(n), w = new Float64Array(n);
  const sx = new Float64Array(n).fill(NaN), sy = new Float64Array(n).fill(NaN);
  let smax = 0;
  for (const k of idx) {
    const ps = principalStresses(gp.sxx[k], gp.syy[k], gp.sxy[k]);
    s1[k] = ps.s1; s2[k] = ps.s2; ang[k] = ps.angle;
    w[k] = Math.max(Math.abs(ps.s1), Math.abs(ps.s2));
    if (w[k] > smax) smax = w[k];
    const q = scr.pt(x[k], y[k]);
    sx[k] = q[0]; sy[k] = q[1];
  }
  smax = opts.refMax ?? smax;
  if (!(smax > 0)) return;
  const keep = thin(sx, sy, w, n, opts.spacing ?? 18);
  const maxLen = opts.maxLen ?? 24;
  ctx.save();
  ctx.lineWidth = opts.lineWidth ?? 1.2;
  ctx.lineCap = 'butt';
  // Batch: compression lines and tension lines each in one path.
  const groups = [[opts.compColor ?? '#d32f2f', []], [opts.tensColor ?? '#1565c0', []]];
  for (const k of keep) {
    const c = Math.cos(ang[k]), s = Math.sin(ang[k]);
    const dirs = [[c, s, s1[k]], [-s, c, s2[k]]];
    for (const [dx, dy, val] of dirs) {
      const sd = scr.dir(dx, dy);
      const h = 0.5 * (Math.abs(val) / smax) * maxLen;
      if (h < 0.25) continue;
      groups[val < 0 ? 0 : 1][1].push(sx[k] - sd[0] * h, sy[k] - sd[1] * h, sx[k] + sd[0] * h, sy[k] + sd[1] * h);
    }
  }
  for (const [color, segs] of groups) {
    if (!segs.length) continue;
    ctx.strokeStyle = color;
    ctx.beginPath();
    for (let i = 0; i < segs.length; i += 4) { ctx.moveTo(segs[i], segs[i + 1]); ctx.lineTo(segs[i + 2], segs[i + 3]); }
    ctx.stroke();
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------------------------------
// Legend
// ---------------------------------------------------------------------------------------------------------------

/**
 * Vertical colour bar with tick labels (engineering format), title and unit.
 * The box (x,y,w,h) holds title/unit lines on top and the bar below; labels are drawn right of the bar.
 * opts: {nLevels (12), levels (explicit edges, e.g. from drawContours), font, textColor, digits}.
 */
export function drawLegend(ctx, x, y, w, h, min, max, colormap, title, unit, opts = {}) {
  let edges = opts.levels;
  if (!edges) {
    if (max < min) [min, max] = [max, min];
    edges = uniformLevels(min, max, Math.max(1, opts.nLevels ?? 12));
  }
  const nb = edges.length - 1;
  const css = levelColorStrings(colormap, nb);
  const lines = (title ? 1 : 0) + (unit ? 1 : 0);
  const headH = lines ? 6 + 14 * lines : 0;
  const barY = y + headH, barH = Math.max(1, h - headH);
  const font = opts.font ?? '11px sans-serif';
  ctx.save();
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = opts.textColor ?? '#222';
  let ty = y + 7;
  if (title) { ctx.fillText(String(title), x, ty); ty += 14; }
  if (unit) { ctx.fillText(`[${unit}]`, x, ty); }
  // Bands: top = max. Positions are proportional to value so non-uniform (nice) levels are drawn truthfully.
  const lo = edges[0], span = edges[nb] - lo || 1;
  const yOf = (v) => barY + barH * (1 - (v - lo) / span);
  for (let b = 0; b < nb; b++) {
    const yTop = yOf(edges[b + 1]), yBot = yOf(edges[b]);
    ctx.fillStyle = css[b];
    ctx.fillRect(x, yTop, w, Math.max(1, yBot - yTop + 0.5));
  }
  ctx.strokeStyle = opts.textColor ?? '#222';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, barY + 0.5, w, barH);
  // Tick labels at band edges, thinned so that labels are ≥ 14 px apart.
  ctx.fillStyle = opts.textColor ?? '#222';
  let lastY = -Infinity;
  // Label precision follows the edge spacing so narrow ranges (100 … 100.5) do not print identical labels.
  let digits = opts.digits;
  if (digits == null) {
    let step = Infinity;
    for (let i = 0; i < nb; i++) { const d = Math.abs(edges[i + 1] - edges[i]); if (d > 0 && d < step) step = d; }
    const mag = Math.max(Math.abs(edges[0]), Math.abs(edges[nb]));
    digits = Number.isFinite(step) && mag > 0 ? Math.min(8, Math.max(3, Math.ceil(Math.log10(mag / step)) + 1)) : 3;
  }
  const zeroTol = 1e-9 * Math.abs(span);
  for (let i = nb; i >= 0; i--) {
    const ty2 = yOf(edges[i]);
    if (ty2 - lastY < 14) continue;
    ctx.fillText(formatEng(Math.abs(edges[i]) < zeroTol ? 0 : edges[i], digits), x + w + 5, ty2);
    ctx.beginPath();
    ctx.moveTo(x + w, ty2);
    ctx.lineTo(x + w + 3, ty2);
    ctx.stroke();
    lastY = ty2;
  }
  ctx.restore();
}
