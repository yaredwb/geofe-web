import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { generateMesh } from '../src/mesh/mesher.js';
import { solve } from '../src/fem/solver.js';
import {
  nodalField, principalStresses, fieldInfo, sampleAlongLine, interpolateAt, locatePoint, fieldRange, FIELD_NAMES,
} from '../src/post/fields.js';
import {
  uniformLevels, colormaps, levelColors, niceLevels, formatEng, autoDeformScale, clipTriangleToBand, contourBands, freeEdges,
  drawMesh, drawContours, drawDeformed, drawVectors, drawPlasticPoints, drawPrincipalStressCrosses, drawLegend,
  deformedNodes,
} from '../src/post/render.js';

const near = (a, b, tol = 1e-9, msg) => assert.ok(Math.abs(a - b) <= tol * Math.max(1, Math.abs(b)), `${msg ?? ''} ${a} vs ${b}`);

// ---- helpers ---------------------------------------------------------------------------------------------------

// Rectangle [0,2]x[0,1] as two T6 elements.
//  nodes: 0(0,0) 1(2,0) 2(2,1) 3(0,1) 4(1,0) 5(2,.5) 6(1,.5) 7(1,1) 8(0,.5)
function tinyT6() {
  const nodes = Float64Array.from([0, 0, 2, 0, 2, 1, 0, 1, 1, 0, 2, 0.5, 1, 0.5, 1, 1, 0, 0.5]);
  const elements = Int32Array.from([0, 1, 2, 4, 5, 6, 0, 2, 3, 6, 7, 8]);
  return { type: 'T6', nodes, elements, nen: 6, elementRegion: Int32Array.from([0, 1]), boundaryEdges: [], stats: {} };
}

const RULE_INTERIOR = [[1 / 6, 1 / 6, 2 / 3], [2 / 3, 1 / 6, 1 / 6], [1 / 6, 2 / 3, 1 / 6]];
const RULE_MIDSIDE = [[0.5, 0.5, 0], [0, 0.5, 0.5], [0.5, 0, 0.5]];

// Build a stageResult with GP data for a mesh using a given 3-point rule and per-GP function f(x,y) → fields.
function makeStage(mesh, rule, fn, extra = {}) {
  const nEl = mesh.elements.length / mesh.nen;
  const n = nEl * rule.length;
  const gp = { x: new Float64Array(n), y: new Float64Array(n), elem: new Int32Array(n) };
  for (const k of ['sxx', 'syy', 'sxy', 'szz', 'pore', 'eps_xx', 'eps_yy', 'gxy']) gp[k] = new Float64Array(n);
  gp.plastic = new Uint8Array(n);
  let k = 0;
  for (let e = 0; e < nEl; e++) {
    const a = mesh.elements[e * mesh.nen] * 2, b = mesh.elements[e * mesh.nen + 1] * 2, c = mesh.elements[e * mesh.nen + 2] * 2;
    for (const L of rule) {
      const x = L[0] * mesh.nodes[a] + L[1] * mesh.nodes[b] + L[2] * mesh.nodes[c];
      const y = L[0] * mesh.nodes[a + 1] + L[1] * mesh.nodes[b + 1] + L[2] * mesh.nodes[c + 1];
      gp.x[k] = x; gp.y[k] = y; gp.elem[k] = e;
      const f = fn(x, y, k);
      for (const key of Object.keys(f)) gp[key][k] = f[key];
      k++;
    }
  }
  const nN = mesh.nodes.length / 2;
  const displacement = new Float64Array(2 * nN);
  for (let i = 0; i < nN; i++) { displacement[2 * i] = 0.01 * mesh.nodes[2 * i]; displacement[2 * i + 1] = -0.02 * mesh.nodes[2 * i + 1]; }
  return { id: 'S0', name: 'Initial', displacement, gp, reactions: new Float64Array(2 * nN), activeElements: new Uint8Array(nEl).fill(1), converged: true, steps: [], ...extra };
}

// Regular grid of T6 (or T3) triangles on [0,nx]x[0,ny]*h : 2 triangles per cell.
function gridMesh(nx, ny, type = 'T6', h = 1) {
  const nodes = [], idx = new Map();
  const add = (x, y) => {
    const key = `${x},${y}`;
    if (idx.has(key)) return idx.get(key);
    nodes.push(x * h / 2, y * h / 2);
    idx.set(key, nodes.length / 2 - 1);
    return nodes.length / 2 - 1;
  };
  const els = [];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const X = 2 * i, Y = 2 * j; // doubled coordinates so midsides are integers
      const quads = [[[X, Y], [X + 2, Y], [X + 2, Y + 2]], [[X, Y], [X + 2, Y + 2], [X, Y + 2]]];
      for (const [p0, p1, p2] of quads) {
        const n0 = add(...p0), n1 = add(...p1), n2 = add(...p2);
        if (type === 'T3') els.push(n0, n1, n2);
        else {
          const m = (a, b) => add((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
          els.push(n0, n1, n2, m(p0, p1), m(p1, p2), m(p2, p0));
        }
      }
    }
  }
  const nen = type === 'T3' ? 3 : 6;
  const nEl = els.length / nen;
  return { type, nodes: Float64Array.from(nodes), elements: Int32Array.from(els), nen, elementRegion: new Int32Array(nEl), boundaryEdges: [], stats: {} };
}

// Recording mock canvas context.
function mockCtx() {
  const calls = {};
  const props = {};
  const ctx = new Proxy({}, {
    get(_, name) {
      if (name === '__calls') return calls;
      if (name in props) return props[name];
      return (...args) => { (calls[name] ||= []).push(args); };
    },
    set(_, name, value) { props[name] = value; (calls['set:' + name] ||= []).push(value); return true; },
  });
  return ctx;
}
const view = { scale: 10, ox: 20, oy: 200 };
const viewFn = { ...view, toScreen: ([x, y]) => [x * view.scale + view.ox, -y * view.scale + view.oy] };

// ---- principal stresses ----------------------------------------------------------------------------------------

test('principalStresses: known cases', () => {
  let r = principalStresses(10, -10, 0);
  near(r.s1, 10); near(r.s2, -10); near(r.angle, 0);
  r = principalStresses(-10, 10, 0); // major (tension) along y
  near(r.s1, 10); near(Math.abs(r.angle), Math.PI / 2);
  r = principalStresses(0, 0, 5); // pure shear
  near(r.s1, 5); near(r.s2, -5); near(r.angle, Math.PI / 4);
  r = principalStresses(-100, -300, 0); // compression, s1 = -100 (less compressive)
  near(r.s1, -100); near(r.s2, -300);
});

test('principalStresses: invariants and Mohr rotation consistency', () => {
  for (const [a, b, c] of [[3, -7, 4], [-50, -120, 30], [1, 1, 0], [0, 12, -9]]) {
    const r = principalStresses(a, b, c);
    near(r.s1 + r.s2, a + b);
    near(r.s1 * r.s2, a * b - c * c);
    assert.ok(r.s1 >= r.s2);
    // Rotating the tensor by `angle` gives diag(s1, s2): sigma_nn along the s1 direction equals s1.
    const cs = Math.cos(r.angle), sn = Math.sin(r.angle);
    near(a * cs * cs + b * sn * sn + 2 * c * cs * sn, r.s1, 1e-9);
    near((b - a) * cs * sn + c * (cs * cs - sn * sn), 0, 1e-9);
  }
});

// ---- nodal fields ----------------------------------------------------------------------------------------------

test('nodalField: constant stress field is reproduced exactly on T6 (both 3-pt rules)', () => {
  const mesh = tinyT6();
  for (const rule of [RULE_INTERIOR, RULE_MIDSIDE]) {
    const st = makeStage(mesh, rule, () => ({ sxx: -50, syy: -80, sxy: 7, szz: -30, pore: 12, eps_xx: 1e-3, eps_yy: -2e-3, gxy: 4e-3 }));
    for (const [name, exp] of [['sxx', -50], ['syy', -80], ['sxy', 7], ['szz', -30], ['pore', 12], ['eps_xx', 1e-3], ['eps_yy', -2e-3], ['gamma_xy', 4e-3]]) {
      const f = nodalField(mesh, st, name);
      assert.equal(f.length, 9);
      for (const v of f) near(v, exp, 1e-12, name);
    }
  }
});

test('nodalField: linear stress field is reproduced exactly at all T6 nodes (extrapolation exactness)', () => {
  const mesh = tinyT6();
  const F = (x, y) => ({ sxx: 10 + 3 * x - 2 * y, syy: -5 - x + 4 * y, sxy: 2 + 0.5 * x + y, szz: 1 + y, pore: 100 - 9.81 * y });
  for (const rule of [RULE_INTERIOR, RULE_MIDSIDE]) {
    const st = makeStage(mesh, rule, (x, y) => F(x, y));
    for (const name of ['sxx', 'syy', 'sxy', 'szz', 'pore']) {
      const f = nodalField(mesh, st, name);
      for (let i = 0; i < 9; i++) near(f[i], F(mesh.nodes[2 * i], mesh.nodes[2 * i + 1])[name], 1e-11, `${name} node ${i}`);
    }
    // Linear combos stay exact: p = -(sxx+syy+szz)/3
    const p = nodalField(mesh, st, 'p');
    for (let i = 0; i < 9; i++) {
      const f = F(mesh.nodes[2 * i], mesh.nodes[2 * i + 1]);
      near(p[i], -(f.sxx + f.syy + f.szz) / 3, 1e-11);
    }
  }
});

test('nodalField: derived invariants p, q, s1, s3, eps_shear, eps_vol', () => {
  const mesh = tinyT6();
  // Triaxial-like state: syy=-100 (axial), sxx=szz=-20.
  let st = makeStage(mesh, RULE_INTERIOR, () => ({ sxx: -20, syy: -100, szz: -20, sxy: 0, eps_xx: 0.001, eps_yy: -0.004, gxy: 0.003 }));
  for (const v of nodalField(mesh, st, 'p')) near(v, 140 / 3, 1e-12);
  for (const v of nodalField(mesh, st, 'q')) near(v, 80, 1e-12); // |syy - sxx| for axisymmetric state
  for (const v of nodalField(mesh, st, 's1')) near(v, -100, 1e-12); // major = most compressive
  for (const v of nodalField(mesh, st, 's3')) near(v, -20, 1e-12); // minor = least compressive
  for (const v of nodalField(mesh, st, 'eps_vol')) near(v, -0.003, 1e-12);
  for (const v of nodalField(mesh, st, 'eps_shear')) near(v, Math.hypot(0.005, 0.003), 1e-12);
  // Pure shear tau: q = sqrt(3) tau
  st = makeStage(mesh, RULE_INTERIOR, () => ({ sxy: 10 }));
  for (const v of nodalField(mesh, st, 'q')) near(v, Math.sqrt(3) * 10, 1e-12);
  for (const v of nodalField(mesh, st, 's1')) near(v, -10, 1e-12);
});

test('nodalField: displacement fields ux, uy, umag', () => {
  const mesh = tinyT6();
  const st = makeStage(mesh, RULE_INTERIOR, () => ({}));
  const ux = nodalField(mesh, st, 'ux'), uy = nodalField(mesh, st, 'uy'), um = nodalField(mesh, st, 'umag');
  for (let i = 0; i < 9; i++) {
    near(ux[i], 0.01 * mesh.nodes[2 * i]);
    near(uy[i], -0.02 * mesh.nodes[2 * i + 1]);
    near(um[i], Math.hypot(ux[i], uy[i]));
  }
});

test('nodalField: plastic fraction, averaging over shared nodes', () => {
  const mesh = tinyT6();
  const st = makeStage(mesh, RULE_INTERIOR, () => ({}));
  st.gp.plastic.set([1, 0, 2, 0, 0, 0]); // e0: 2 of 3 plastic; e1: none
  const f = nodalField(mesh, st, 'plastic');
  near(f[1], 2 / 3); near(f[3], 0); near(f[0], 1 / 3); near(f[2], 1 / 3);
  near(f[4], 0.5 * (f[0] + f[1])); // midside of edge 0-1
  for (const v of f) assert.ok(v >= 0 && v <= 1);
});

test('nodalField: inactive elements are excluded; exclusive nodes are NaN', () => {
  const mesh = tinyT6();
  // e0 has sxx = 100, e1 has sxx = 0 (discontinuous across the diagonal)
  const st = makeStage(mesh, RULE_INTERIOR, (x, y, k) => ({ sxx: k < 3 ? 100 : 0 }));
  let f = nodalField(mesh, st, 'sxx');
  near(f[0], 50); near(f[2], 50); near(f[1], 100); near(f[3], 0); // averaging across active neighbours
  st.activeElements = Uint8Array.from([1, 0]);
  f = nodalField(mesh, st, 'sxx');
  near(f[0], 100); near(f[1], 100); near(f[2], 100);
  assert.ok(Number.isNaN(f[3])); assert.ok(Number.isNaN(f[7])); assert.ok(Number.isNaN(f[8]));
  assert.ok(Number.isNaN(nodalField(mesh, st, 'ux')[3]));
  const r = fieldRange(f);
  near(r.min, 100); near(r.max, 100);
});

test('nodalField: T3 (constant per element) and unknown field error', () => {
  const nodes = Float64Array.from([0, 0, 1, 0, 0, 1, 1, 1]);
  const mesh = { type: 'T3', nodes, elements: Int32Array.from([0, 1, 2, 1, 3, 2]), nen: 3, elementRegion: new Int32Array(2) };
  const st = makeStage(mesh, [[1 / 3, 1 / 3, 1 / 3]], (x, y, k) => ({ sxx: k === 0 ? 10 : 30 }));
  const f = nodalField(mesh, st, 'sxx');
  near(f[0], 10); near(f[3], 30); near(f[1], 20); near(f[2], 20);
  assert.throws(() => nodalField(mesh, st, 'nonsense'), /unknown field/);
});

test('fieldInfo labels and units', () => {
  assert.equal(fieldInfo('ux').unit, 'm');
  assert.equal(fieldInfo('sxx').unit, 'kPa');
  assert.equal(fieldInfo('eps_shear').unit, '-');
  assert.equal(fieldInfo('p').unit, 'kPa');
  for (const n of FIELD_NAMES) assert.ok(fieldInfo(n).label.length > 0);
  assert.equal(fieldInfo('foo').label, 'foo');
});

// ---- sampling ----------------------------------------------------------------------------------------------------

test('sampleAlongLine: exact for a linear field on T6, NaN outside', () => {
  const mesh = tinyT6();
  const F = (x, y) => 4 + 3 * x - 5 * y;
  const st = makeStage(mesh, RULE_INTERIOR, (x, y) => ({ sxx: F(x, y) }));
  const f = nodalField(mesh, st, 'sxx');
  const pts = sampleAlongLine(mesh, f, [-1, 0.1], [3, 0.9], 41);
  assert.equal(pts.length, 41);
  near(pts[0].s, 0); near(pts[40].s, Math.hypot(4, 0.8));
  let inside = 0;
  for (const p of pts) {
    if (p.x >= 0 && p.x <= 2) { near(p.v, F(p.x, p.y), 1e-10); inside++; } else assert.ok(Number.isNaN(p.v), `outside ${p.x}`);
  }
  assert.ok(inside >= 20);
  // end points on the boundary, diagonal crossing
  near(interpolateAt(mesh, f, 0, 0), F(0, 0));
  near(interpolateAt(mesh, f, 2, 1), F(2, 1));
  near(interpolateAt(mesh, f, 1, 0.5), F(1, 0.5));
});

test('interpolation: quadratic nodal field is reproduced by T6 shape functions', () => {
  const mesh = tinyT6();
  const Q = (x, y) => 1 + x * x - 2 * x * y + 3 * y * y;
  const vals = new Float64Array(9);
  for (let i = 0; i < 9; i++) vals[i] = Q(mesh.nodes[2 * i], mesh.nodes[2 * i + 1]);
  for (const [x, y] of [[0.3, 0.1], [1.7, 0.6], [1.2, 0.9], [0.4, 0.45]]) near(interpolateAt(mesh, vals, x, y), Q(x, y), 1e-11);
});

test('locatePoint on a large grid (spatial index) agrees with brute force', () => {
  const mesh = gridMesh(40, 30, 'T3');
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let i = 0; i < 300; i++) {
    const x = rnd() * 20, y = rnd() * 15;
    const loc = locatePoint(mesh, x, y);
    assert.ok(loc, `${x},${y}`);
    assert.ok(Math.min(...loc.L) >= -1e-9);
  }
  assert.equal(locatePoint(mesh, -0.5, 3), null);
  assert.equal(locatePoint(mesh, 5, 99), null);
});

// ---- contour clipping --------------------------------------------------------------------------------------------

function polyArea(p) {
  let a = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; a += p[i][0] * q[1] - q[0] * p[i][1]; }
  return a / 2;
}

test('clipTriangleToBand: band polygon areas sum to the triangle area and respect bounds', () => {
  const xs = [0, 4, 1], ys = [0, 1, 3], vs = [-3, 2.5, 7];
  const area = Math.abs(polyArea([[0, 0], [4, 1], [1, 3]]));
  const edges = [-Infinity, -1, 0.5, 2, 4, 6, Infinity];
  let sum = 0;
  for (let b = 0; b < edges.length - 1; b++) {
    const poly = clipTriangleToBand(xs, ys, vs, edges[b], edges[b + 1]);
    if (poly.length) {
      sum += Math.abs(polyArea(poly));
      // linear field v at each polygon vertex must lie in [lo, hi]
      // solve v(x,y) = a + bx + cy from the three vertices
      const det = (xs[1] - xs[0]) * (ys[2] - ys[0]) - (xs[2] - xs[0]) * (ys[1] - ys[0]);
      const bx = ((vs[1] - vs[0]) * (ys[2] - ys[0]) - (vs[2] - vs[0]) * (ys[1] - ys[0])) / det;
      const cy = ((xs[1] - xs[0]) * (vs[2] - vs[0]) - (xs[2] - xs[0]) * (vs[1] - vs[0])) / det;
      for (const [x, y] of poly) {
        const v = vs[0] + bx * (x - xs[0]) + cy * (y - ys[0]);
        assert.ok(v >= edges[b] - 1e-9 && v <= edges[b + 1] + 1e-9);
      }
    }
  }
  near(sum, area, 1e-12);
  assert.deepEqual(clipTriangleToBand(xs, ys, vs, 10, 20), []);
});

test('contourBands: all bands tile the whole mesh area (T6 and T3, linear + oscillating fields)', () => {
  for (const type of ['T6', 'T3']) {
    const mesh = gridMesh(6, 4, type, 1);
    const nN = mesh.nodes.length / 2;
    for (const fn of [(x, y) => 3 * x - 2 * y, (x, y) => Math.sin(2.1 * x) * Math.cos(1.3 * y) * 5]) {
      const vals = new Float64Array(nN);
      for (let i = 0; i < nN; i++) vals[i] = fn(mesh.nodes[2 * i], mesh.nodes[2 * i + 1]);
      const { min, max } = fieldRange(vals);
      const edges = Array.from({ length: 9 }, (_, i) => min + ((max - min) * i) / 8);
      const bands = contourBands(mesh, mesh.nodes, vals, edges);
      let total = 0;
      for (const B of bands) {
        let q = 0;
        for (const n of B.counts) {
          const poly = [];
          for (let k = 0; k < n; k++) poly.push([B.pts[q + 2 * k], B.pts[q + 2 * k + 1]]);
          total += Math.abs(polyArea(poly));
          q += 2 * n;
        }
      }
      near(total, 6 * 4 * 1, 1e-10, type); // 6x4 cells of unit size (h=1)
    }
  }
});

test('contourBands: skips NaN nodes and inactive elements', () => {
  const mesh = gridMesh(2, 2, 'T3');
  const vals = new Float64Array(mesh.nodes.length / 2).fill(1);
  vals[0] = NaN;
  const bands = contourBands(mesh, mesh.nodes, vals, [0, 1, 2]);
  const nTri = bands.reduce((s, b) => s + b.counts.length, 0);
  assert.ok(nTri < 8 && nTri > 0);
  const act = new Uint8Array(8); act[0] = 1;
  const b2 = contourBands(mesh, mesh.nodes, new Float64Array(mesh.nodes.length / 2), [-1, 1], act);
  assert.equal(b2.reduce((s, b) => s + b.counts.length, 0), 1);
});

// ---- colormaps / helpers ------------------------------------------------------------------------------------------

test('colormaps: endpoints, range and clamping', () => {
  assert.deepEqual(colormaps.rainbow(0), [0, 0, 255]);
  assert.deepEqual(colormaps.rainbow(1), [255, 0, 0]);
  assert.deepEqual(colormaps.rainbow(0.5), [0, 255, 0]);
  assert.deepEqual(colormaps.viridis(0), [68, 1, 84]);
  assert.deepEqual(colormaps.viridis(1), [253, 231, 37]);
  assert.deepEqual(colormaps.jet(0), [0, 0, 128]);
  assert.deepEqual(colormaps.jet(1), [128, 0, 0]);
  for (const f of Object.values(colormaps)) {
    for (let i = 0; i <= 50; i++) {
      const c = f(i / 50);
      assert.equal(c.length, 3);
      for (const v of c) assert.ok(Number.isInteger(v) && v >= 0 && v <= 255);
    }
    assert.deepEqual(f(-3), f(0));
    assert.deepEqual(f(7), f(1));
  }
  const lc = levelColors('rainbow', 5);
  assert.equal(lc.length, 5);
  assert.deepEqual(lc[0], [0, 0, 255]);
  assert.deepEqual(lc[4], [255, 0, 0]);
  assert.equal(levelColors(colormaps.jet, 1).length, 1);
});

test('niceLevels and formatEng', () => {
  assert.deepEqual(niceLevels(0, 10, 5), [0, 2, 4, 6, 8, 10]);
  assert.deepEqual(niceLevels(0.03, 0.97, 10), [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1]);
  const l = niceLevels(-123, 457, 8);
  assert.ok(l[0] <= -123 && l[l.length - 1] >= 457);
  for (let i = 1; i < l.length; i++) assert.ok(l[i] > l[i - 1]);
  assert.ok(niceLevels(5, 5, 4).length >= 2);
  assert.equal(formatEng(0), '0');
  assert.equal(formatEng(12.3456), '12.3');
  assert.equal(formatEng(-0.5), '-0.5');
  assert.equal(formatEng(0.0000125), '12.5e-6');
  assert.equal(formatEng(2.5e6), '2.5e6');
  assert.equal(formatEng(1234567), '1.23e6');
  assert.equal(formatEng(12345), '12300');
});

test('autoDeformScale: max displacement ≈ 10% of model size', () => {
  const mesh = gridMesh(10, 5, 'T6', 2); // 20 x 10 m
  const nN = mesh.nodes.length / 2;
  const disp = new Float64Array(2 * nN);
  disp[2 * 3] = 0.03; disp[2 * 3 + 1] = 0.04; // |u| = 0.05
  const s = autoDeformScale(mesh, disp);
  near(s * 0.05, 0.1 * 20, 0.02);
  assert.equal(autoDeformScale(mesh, new Float64Array(2 * nN)), 1);
  const dn = deformedNodes(mesh, disp, 10);
  near(dn[6] - mesh.nodes[6], 0.3);
});

test('freeEdges: outer boundary of the domain and of the active subset', () => {
  const mesh = gridMesh(4, 4, 'T6');
  assert.equal(freeEdges(mesh).length / 3, 16); // perimeter = 4 cell edges per side
  const act = new Uint8Array(mesh.elements.length / 6).fill(1);
  act[10] = 0; act[11] = 0; // deactivate the interior cell (1,1) (both triangles): an 'excavation'
  assert.equal(freeEdges(mesh, act).length / 3, 20);
});

// ---- rendering smoke tests -----------------------------------------------------------------------------------------

test('drawMesh: edges drawn once each, boundary emphasised, region fills', () => {
  const mesh = gridMesh(3, 2, 'T6');
  const ctx = mockCtx();
  drawMesh(ctx, view, mesh, { regionColors: ['#c8a26b'] });
  const c = ctx.__calls;
  // edges: unique sub-edges of 3x2 cell T6 grid; each moveTo in the edge path belongs to a unique edge
  assert.ok(c.save.length === 1 && c.restore.length === 1);
  assert.ok(c.fill.length >= 1);
  assert.ok(c.stroke.length >= 3);
  // Number of unique sub-edges: corner-edge count of the T3 skeleton times 2 (via midside)
  const nCornerEdges = 3 * 2 * 3 + 3 + 2; // horizontal+vertical+diagonal edges of a 3x2 grid of cells
  const edgeMoves = c.moveTo.length;
  assert.ok(edgeMoves >= 2 * nCornerEdges, `moveTo count ${edgeMoves}`);
  assert.deepEqual(c['set:lineWidth'].includes(1.8), true);
});

test('drawMesh/draw* accept a view with toScreen and agree with the default transform', () => {
  const mesh = gridMesh(2, 2, 'T3');
  const a = mockCtx(), b = mockCtx();
  drawMesh(a, view, mesh, {});
  drawMesh(b, viewFn, mesh, {});
  assert.deepEqual(a.__calls.moveTo, b.__calls.moveTo);
  assert.deepEqual(a.__calls.lineTo, b.__calls.lineTo);
});

test('drawContours: draws banded polygons per colour, returns levels', () => {
  const mesh = gridMesh(8, 6, 'T6');
  const nN = mesh.nodes.length / 2;
  const vals = new Float64Array(nN);
  for (let i = 0; i < nN; i++) vals[i] = mesh.nodes[2 * i] + 0.5 * mesh.nodes[2 * i + 1];
  const ctx = mockCtx();
  const r = drawContours(ctx, view, mesh, vals, { nLevels: 10, colormap: 'rainbow' });
  assert.equal(r.levels.length, 11);
  assert.equal(r.colors.length, 10);
  const c = ctx.__calls;
  assert.equal(c.fill.length, 10); // exactly one batched fill per band
  assert.equal(c.stroke.length, 10); // seam-hiding strokes
  assert.ok(c.closePath.length > 100);
  const fills = c['set:fillStyle'];
  assert.equal(new Set(fills).size, 10);
  assert.equal(fills[0], 'rgb(0,0,255)');
  assert.equal(fills[9], 'rgb(255,0,0)');
  // explicit levels override and NaN values are skipped
  vals[0] = NaN;
  const ctx2 = mockCtx();
  const r2 = drawContours(ctx2, view, mesh, vals, { levels: [-1, 3, 6, 100], colormap: 'viridis' });
  assert.equal(r2.levels.length, 4);
  assert.ok(ctx2.__calls.fill.length <= 3);
  // flat field does not crash
  drawContours(mockCtx(), view, mesh, new Float64Array(nN).fill(5), {});
});

test('drawDeformed / drawVectors / plastic / crosses / legend: smoke', () => {
  const mesh = tinyT6();
  const F = () => ({ sxx: -50, syy: -120, sxy: 20, szz: -60 });
  const st = makeStage(mesh, RULE_INTERIOR, F);
  st.gp.plastic.set([1, 1, 0, 2, 0, 1]);
  const disp = st.displacement;

  let ctx = mockCtx();
  drawDeformed(ctx, view, mesh, disp, 5);
  assert.ok(ctx.__calls.stroke.length >= 2);
  drawDeformed(mockCtx(), view, mesh, disp, undefined); // auto scale

  ctx = mockCtx();
  drawVectors(ctx, view, mesh, disp, { spacing: 5 });
  assert.ok(ctx.__calls.stroke.length === 1 && ctx.__calls.fill.length === 1);
  assert.ok(ctx.__calls.lineTo.length > 0);
  drawVectors(mockCtx(), view, mesh, new Float64Array(disp.length)); // zero field → nothing, no crash

  ctx = mockCtx();
  drawPlasticPoints(ctx, view, st);
  assert.equal(ctx.__calls.rect.length, 4); // 3 shear + 1 tension (one batched path each)
  assert.equal(ctx.__calls.fill.length, 2);
  ctx = mockCtx();
  drawPlasticPoints(ctx, view, st, { mesh, disp, deformScale: 10 });
  assert.equal(ctx.__calls.rect.length, 4);
  st.activeElements = Uint8Array.from([1, 0]);
  ctx = mockCtx();
  drawPlasticPoints(ctx, view, st);
  assert.equal(ctx.__calls.rect.length, 2); // only element 0's GPs: plastic = [1,1,0] → 2 shear squares
  st.activeElements = Uint8Array.from([1, 1]);

  ctx = mockCtx();
  drawPrincipalStressCrosses(ctx, view, st, { spacing: 0 });
  assert.equal(ctx.__calls.moveTo.length, 12); // 6 GPs × 2 lines
  assert.equal(ctx.__calls.stroke.length, 1); // compression only (both principal stresses < 0)
  drawPrincipalStressCrosses(mockCtx(), view, st, { mesh, disp, deformScale: 5 });

  ctx = mockCtx();
  drawLegend(ctx, 10, 10, 20, 200, -3.5, 12.25, 'jet', 'Displacement |u|', 'm', { nLevels: 8 });
  const texts = ctx.__calls.fillText.map((a) => a[0]);
  assert.ok(texts.includes('Displacement |u|'));
  assert.ok(texts.includes('[m]'));
  assert.ok(texts.includes('-3.5') && texts.includes('12.3'), texts.join(' '));
  assert.equal(ctx.__calls.fillRect.length, 8);
});

test('performance: 20k-element T6 mesh contours + mesh draw are fast with a mock ctx', () => {
  const mesh = gridMesh(100, 100, 'T6'); // 20,000 elements
  assert.equal(mesh.elements.length / 6, 20000);
  const nN = mesh.nodes.length / 2;
  const vals = new Float64Array(nN);
  for (let i = 0; i < nN; i++) vals[i] = Math.sin(mesh.nodes[2 * i] / 7) * Math.cos(mesh.nodes[2 * i + 1] / 9);
  let t0 = performance.now();
  const ctx = mockCtx();
  drawContours(ctx, view, mesh, vals, { nLevels: 12 });
  const tContour = performance.now() - t0;
  t0 = performance.now();
  drawMesh(mockCtx(), view, mesh, { regionColors: ['#ccc'] });
  const tMesh = performance.now() - t0;
  assert.equal(ctx.__calls.fill.length, 12);
  console.log(`  20k T6: drawContours ${tContour.toFixed(0)} ms, drawMesh ${tMesh.toFixed(0)} ms`);
  assert.ok(tContour < 3000 && tMesh < 3000);
});

test('nodalField performance on 20k T6 elements', () => {
  const mesh = gridMesh(100, 100, 'T6');
  const st = makeStage(mesh, RULE_INTERIOR, (x, y) => ({ sxx: -10 * y + x, syy: -20 * y, sxy: x, szz: -5 * y }));
  const t0 = performance.now();
  const f = nodalField(mesh, st, 'sxx');
  const q = nodalField(mesh, st, 'q');
  const dt = performance.now() - t0;
  near(f[100], mesh.nodes[200] - 10 * mesh.nodes[201], 1e-9);
  assert.ok(q.every(Number.isFinite));
  console.log(`  20k T6: 2 nodalField calls ${dt.toFixed(0)} ms`);
  assert.ok(dt < 2000);
});

// ---------------------------------------------------------------------------------------------------------------
// Regression tests (post review)
// ---------------------------------------------------------------------------------------------------------------

test('sampleAlongLine: excavation base / wall at stage 1 has no NaN gaps (edges shared with excavated elements)', () => {
  const model = JSON.parse(fs.readFileSync(new URL('../examples/excavation.json', import.meta.url), 'utf8'));
  const mesh = generateMesh(model);
  const res = solve(model, mesh, {});
  assert.ok(res.ok, res.message);
  const st = res.stages[1];
  for (const f of ['uy', 'syy', 'umag']) {
    const v = nodalField(mesh, st, f);
    for (const active of [null, st.activeElements]) {
      const base = sampleAlongLine(mesh, v, [14, 11], [26, 11], 25, active);
      assert.ok(base.every((q) => Number.isFinite(q.v)), `${f} base, mask=${!!active}: ${base.map((q) => q.v).join(' ')}`);
      const wall = sampleAlongLine(mesh, v, [14, 11], [14, 15], 9, active);
      // the wall line lies on the excavation boundary; the whole profile must be finite where soil is active
      assert.ok(wall.every((q) => Number.isFinite(q.v)), `${f} wall, mask=${!!active}`);
    }
  }
  // Inside the excavation (no active element) stays NaN when the mask is given.
  const ux = nodalField(mesh, st, 'ux');
  assert.ok(Number.isNaN(interpolateAt(mesh, ux, 20, 13, st.activeElements)));
});

test('principal stress fields: s1 = major = most compressive, s3 = minor = least compressive', () => {
  const mesh = tinyT6();
  const st = makeStage(mesh, RULE_INTERIOR, () => ({ sxx: -66.68, syy: -123.79, szz: -66.68, sxy: 0 }));
  for (const v of nodalField(mesh, st, 's1')) near(v, -123.79, 1e-12);
  for (const v of nodalField(mesh, st, 's3')) near(v, -66.68, 1e-12);
});

test('uniformLevels snaps zero noise; legend labels are clean and distinct for narrow ranges', () => {
  assert.equal(formatEng(uniformLevels(-1.1, 0.1, 12)[11]), '0');
  assert.equal(formatEng(uniformLevels(-0.7, 0.5, 12)[7]), '0');
  assert.equal(uniformLevels(-3.3, 1.1, 12)[0], -3.3);
  assert.equal(uniformLevels(-3.3, 1.1, 12)[12], 1.1);
  const ctx = mockCtx();
  drawLegend(ctx, 10, 10, 20, 600, 100, 100.5, 'jet', 't', 'u', { nLevels: 12 });
  const labels = ctx.__calls.fillText.map((a) => a[0]).filter((t) => /^[\d.]+$/.test(t));
  assert.ok(labels.length >= 5);
  assert.equal(new Set(labels).size, labels.length, labels.join(' '));
  const c2 = mockCtx();
  drawLegend(c2, 10, 10, 20, 600, -1.1, 0.1, 'jet', 't', 'u', { nLevels: 12 });
  assert.ok(!c2.__calls.fillText.some((a) => /e-1\d/.test(a[0])), 'no 1e-16 noise labels');
});

test('drawContours: reversed manual range (min > max) behaves like the ascending range', () => {
  const mesh = tinyT6();
  const nN = mesh.nodes.length / 2;
  const vals = new Float64Array(nN);
  for (let i = 0; i < nN; i++) vals[i] = mesh.nodes[2 * i] + 2 * mesh.nodes[2 * i + 1];
  const a = drawContours(mockCtx(), view, mesh, vals, { min: 0, max: 10, nLevels: 8 });
  const b = drawContours(mockCtx(), view, mesh, vals, { min: 10, max: 0, nLevels: 8 });
  assert.deepEqual(b.levels, a.levels);
  assert.ok(b.levels[1] > b.levels[0]);
  const ctxA = mockCtx(), ctxB = mockCtx();
  drawContours(ctxA, view, mesh, vals, { min: 0, max: 10, nLevels: 8 });
  drawContours(ctxB, view, mesh, vals, { min: 10, max: 0, nLevels: 8 });
  assert.equal(ctxB.__calls.fill.length, ctxA.__calls.fill.length);
  const d = drawContours(mockCtx(), view, mesh, vals, { levels: [6, 3, 0, 10] });
  assert.deepEqual(d.levels, [0, 3, 6, 10]);
  const c3 = mockCtx();
  drawLegend(c3, 0, 0, 20, 200, 5, -5, 'jet', null, null, { nLevels: 4 });
  const ys = c3.__calls.fillText.map((a) => a[0]);
  assert.equal(ys[0], '5'); // top label = max
});
