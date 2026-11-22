import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateMesh, meshQuality, findNodesOnSegment, findNearestNode, bandwidth,
} from '../src/mesh/mesher.js';
import { orient2d, incircle } from '../src/mesh/predicates.js';
import { makeSizeField } from '../src/mesh/sizefield.js';
import {
  createEmptyModel, createExampleSlope, createExampleFooting, defaultMaterial,
} from '../src/core/model.js';
import { polygonArea, pointInPolygon, distPointSegment } from '../src/core/geom.js';
import { solve } from '../src/fem/solver.js';

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------
function makeModel(regions, { lines = [], size = 1, type = 'T6', loads = [], boundaries = [] } = {}) {
  const m = createEmptyModel();
  m.materials.push(defaultMaterial());
  regions.forEach((p, i) => m.regions.push({ id: 'R' + (i + 1), name: 'r' + i, materialId: 'M1', points: p }));
  m.lines = lines.map((p, i) => ({ id: 'L' + (i + 1), points: p }));
  m.loads = loads;
  m.boundaries = boundaries;
  m.settings.meshSize = size;
  m.settings.elementType = type;
  return m;
}

const rect = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

function node(mesh, i) { return [mesh.nodes[2 * i], mesh.nodes[2 * i + 1]]; }
function elemCorners(mesh, e) { return [0, 1, 2].map((k) => node(mesh, mesh.elements[e * mesh.nen + k])); }
function nEl(mesh) { return mesh.elements.length / mesh.nen; }

function totalArea(mesh) {
  let a = 0;
  for (let e = 0; e < nEl(mesh); e++) a += polygonArea(elemCorners(mesh, e));
  return a;
}

/** Structural checks shared by all tests. Returns nothing, asserts on failure. */
function checkMesh(mesh, model, { checkRegions = true } = {}) {
  const n = nEl(mesh);
  const nN = mesh.nodes.length / 2;
  assert.equal(mesh.elements.length, mesh.nen * n);
  assert.equal(mesh.elementRegion.length, n);
  assert.equal(mesh.stats.nNodes, nN);
  assert.equal(mesh.stats.nElements, n);
  // positive area (CCW), valid indices
  for (let e = 0; e < n; e++) {
    for (let k = 0; k < mesh.nen; k++) {
      const v = mesh.elements[e * mesh.nen + k];
      assert.ok(v >= 0 && v < nN, 'node index in range');
    }
    assert.ok(polygonArea(elemCorners(mesh, e)) > 0, `element ${e} has positive area`);
  }
  // no duplicate nodes, every node used
  const seen = new Map();
  for (let i = 0; i < nN; i++) {
    const key = mesh.nodes[2 * i].toPrecision(13) + ',' + mesh.nodes[2 * i + 1].toPrecision(13);
    assert.ok(!seen.has(key), `duplicate node coordinates ${key}`);
    seen.set(key, i);
  }
  const used = new Uint8Array(nN);
  for (const v of mesh.elements) used[v] = 1;
  assert.ok(used.every((u) => u === 1), 'no orphan nodes');
  // conformity: every corner edge shared by 1 or 2 elements; boundary edges are exactly those with count 1
  const cnt = new Map();
  const edgeKey = (a, b) => (a < b ? a * nN + b : b * nN + a);
  for (let e = 0; e < n; e++) {
    for (let i = 0; i < 3; i++) {
      const a = mesh.elements[e * mesh.nen + i], b = mesh.elements[e * mesh.nen + (i + 1) % 3];
      const k = edgeKey(a, b);
      cnt.set(k, (cnt.get(k) || 0) + 1);
    }
  }
  let nb = 0;
  for (const c of cnt.values()) { assert.ok(c === 1 || c === 2, 'edge shared by 1 or 2 elements'); if (c === 1) nb++; }
  assert.equal(mesh.boundaryEdges.length, nb, 'boundaryEdges lists all single-element edges');
  for (const [a, b] of mesh.boundaryEdges) assert.equal(cnt.get(edgeKey(a, b)), 1);
  // boundary edges lie on region polygon edges
  const polyEdges = [];
  for (const r of model.regions) for (let i = 0; i < r.points.length; i++) polyEdges.push([r.points[i], r.points[(i + 1) % r.points.length]]);
  const diag = Math.hypot(...[0, 1].map((k) => Math.max(...model.regions.flatMap((r) => r.points.map((p) => p[k]))) - Math.min(...model.regions.flatMap((r) => r.points.map((p) => p[k])))));
  for (const [a, b] of mesh.boundaryEdges) {
    const mid = [(node(mesh, a)[0] + node(mesh, b)[0]) / 2, (node(mesh, a)[1] + node(mesh, b)[1]) / 2];
    const d = Math.min(...polyEdges.map(([p, q]) => distPointSegment(mid, p, q)));
    assert.ok(d < 1e-9 * Math.max(1, diag), `boundary edge midpoint lies on the geometry boundary (d=${d})`);
  }
  // all region vertices are nodes
  for (const r of model.regions) for (const p of r.points) {
    assert.ok(findNodesOnSegment(mesh, p, p, 1e-9 * Math.max(1, diag)).length >= 1, `region vertex ${p} is a node`);
  }
  // elementRegion is consistent with the element location
  if (checkRegions) {
    for (let e = 0; e < n; e++) {
      const c = elemCorners(mesh, e);
      const cen = [(c[0][0] + c[1][0] + c[2][0]) / 3, (c[0][1] + c[1][1] + c[2][1]) / 3];
      const r = model.regions[mesh.elementRegion[e]];
      assert.ok(r && pointInPolygon(cen, r.points), `element ${e} centroid is inside its region`);
    }
  }
  // quadratic elements: exact mid-side nodes, shared between neighbours
  if (mesh.nen === 6) {
    const mids = new Map();
    for (let e = 0; e < n; e++) {
      const el = mesh.elements.subarray(e * 6, e * 6 + 6);
      for (let i = 0; i < 3; i++) {
        const a = el[i], b = el[(i + 1) % 3], m = el[3 + i];
        const A = node(mesh, a), B = node(mesh, b), M = node(mesh, m);
        assert.equal(M[0], 0.5 * (A[0] + B[0]));
        assert.equal(M[1], 0.5 * (A[1] + B[1]));
        const k = edgeKey(a, b);
        if (mids.has(k)) assert.equal(mids.get(k), m, 'neighbouring elements share the mid-side node');
        else mids.set(k, m);
      }
    }
    assert.equal(mids.size, cnt.size);
    assert.equal(new Set(mids.values()).size, mids.size, 'one distinct mid node per edge');
    assert.equal(nN, mesh.stats.nCornerNodes + mids.size);
  }
}

function unionArea(model) {
  return model.regions.reduce((s, r) => s + Math.abs(polygonArea(r.points)), 0);
}

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------
// predicates
// ---------------------------------------------------------------------------------------------
test('predicates: exact on degenerate and near-degenerate input', () => {
  assert.equal(Math.sign(orient2d(0, 0, 1, 1, 2, 2)), 0);
  assert.equal(Math.sign(orient2d(0, 0, 1, 0, 0.5, 1e-300)), 1);
  assert.equal(Math.sign(orient2d(0, 0, 1, 0, 0.5, -1e-300)), -1);
  // nearly collinear points that fool the naive determinant
  const a = [0.5, 0.5], b = [12, 12], c = [24, 24];
  assert.equal(Math.sign(orient2d(a[0], a[1], b[0], b[1], c[0], c[1])), 0);
  assert.equal(Math.sign(orient2d(a[0], a[1], b[0], b[1], c[0], 24 + 1e-14)), 1);
  // cocircular lattice points (unit square) -> 0
  assert.equal(Math.sign(incircle(0, 0, 1, 0, 1, 1, 0, 1)), 0);
  assert.equal(Math.sign(incircle(0, 0, 1, 0, 1, 1, 0.5, 0.5)), 1);
  assert.equal(Math.sign(incircle(0, 0, 1, 0, 1, 1, 2, 2)), -1);
  assert.equal(Math.sign(incircle(0, 0, 1, 0, 1, 1, 0, 1 + 1e-15)), -1);
  assert.equal(Math.sign(incircle(0, 0, 1, 0, 1, 1, 0, 1 - 1e-15)), 1);
});

// ---------------------------------------------------------------------------------------------
// basic shapes
// ---------------------------------------------------------------------------------------------
test('unit square: T3 and T6', () => {
  for (const type of ['T3', 'T6']) {
    const model = makeModel([rect(0, 0, 1, 1)], { size: 0.1, type });
    const mesh = generateMesh(model);
    assert.equal(mesh.type, type);
    assert.equal(mesh.nen, type === 'T3' ? 3 : 6);
    checkMesh(mesh, model);
    assert.ok(Math.abs(totalArea(mesh) - 1) < 1e-12);
    assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
    assert.ok(mesh.elementRegion.every((r) => r === 0));
    // element count close to the one expected for edge length h (equilateral: area / (sqrt(3)/4 h^2) = 231)
    assert.ok(nEl(mesh) > 150 && nEl(mesh) < 340, `n elements ${nEl(mesh)}`);
    // boundary edges chain around the unit square: total length 4
    let len = 0;
    for (const [a, b] of mesh.boundaryEdges) len += Math.hypot(...[0, 1].map((k) => node(mesh, a)[k] - node(mesh, b)[k]));
    assert.ok(Math.abs(len - 4) < 1e-12);
  }
});

test('opts override settings (meshSize/size, type)', () => {
  const model = makeModel([rect(0, 0, 1, 1)], { size: 0.5, type: 'T6' });
  const a = generateMesh(model, { meshSize: 0.1, type: 'T3' });
  assert.equal(a.type, 'T3');
  assert.ok(nEl(a) > 150);
  const b = generateMesh(model, { size: 0.5 });
  assert.equal(b.type, 'T6');
  assert.ok(nEl(b) < 40);
});

test('L-shape', () => {
  const model = makeModel([[[0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]]], { size: 0.1 });
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  assert.ok(Math.abs(totalArea(mesh) / 3 - 1) < 1e-12);
  assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
  // reflex corner (1,1) must be a node
  assert.ok(findNodesOnSegment(mesh, [1, 1], [1, 1], 1e-12).length === 1);
});

test('slope example', () => {
  const model = createExampleSlope();
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  const A = unionArea(model);
  assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-9);
  assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
  assert.ok(mesh.stats.maxAspect < 4);
  // element size ~ meshSize (1.5): T3 count ~ A / (0.433 h^2)
  const expected = A / (0.433 * 1.5 * 1.5);
  assert.ok(nEl(mesh) > 0.7 * expected && nEl(mesh) < 1.4 * expected, `${nEl(mesh)} vs ~${expected}`);
  // fixity "auto" needs nodes on bottom and sides
  assert.ok(findNodesOnSegment(mesh, [0, 0], [60, 0]).length >= 2 * 40 - 1);
  assert.ok(findNodesOnSegment(mesh, [0, 0], [0, 10]).length >= 7);
});

test('footing example: conforms to the interface y=6 and has nodes at the load ends', () => {
  const model = createExampleFooting();
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  const A = unionArea(model);
  assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-9);
  assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
  // two materials -> both region indices present, areas per region exact
  const areaOf = [0, 0];
  for (let e = 0; e < nEl(mesh); e++) areaOf[mesh.elementRegion[e]] += polygonArea(elemCorners(mesh, e));
  assert.ok(Math.abs(areaOf[0] - 80) < 1e-9 && Math.abs(areaOf[1] - 120) < 1e-9, `${areaOf}`);
  // no element straddles y = 6
  for (let e = 0; e < nEl(mesh); e++) {
    const ys = elemCorners(mesh, e).map((p) => p[1]);
    assert.ok(Math.min(...ys) >= 6 - 1e-12 || Math.max(...ys) <= 6 + 1e-12, 'element straddles interface');
    const region = mesh.elementRegion[e];
    assert.equal(region, Math.min(...ys) >= 6 - 1e-12 ? 0 : 1);
  }
  // interface nodes along y=6 span the full width and are shared (T6: also mid-side nodes)
  const iface = findNodesOnSegment(mesh, [0, 6], [20, 6], 1e-12);
  assert.ok(iface.length >= 2 * 20 + 1);
  assert.equal(node(mesh, iface[0])[0], 0);
  assert.equal(node(mesh, iface[iface.length - 1])[0], 20);
  // load end points are exact nodes on y=10
  for (const x of [9, 11]) {
    const hit = findNodesOnSegment(mesh, [x, 10], [x, 10], 1e-12);
    assert.equal(hit.length, 1, `node at (${x}, 10)`);
    assert.deepEqual(node(mesh, hit[0]), [x, 10]);
  }
  // the load segment is covered by a chain of nodes
  const loaded = findNodesOnSegment(mesh, [9, 10], [11, 10], 1e-12);
  assert.ok(loaded.length >= 5);
  assert.deepEqual(node(mesh, loaded[0]), [9, 10]);
  assert.deepEqual(node(mesh, loaded[loaded.length - 1]), [11, 10]);
});

test('T6 mid-side nodes are exact midpoints and shared (all examples)', () => {
  for (const model of [createExampleSlope(), createExampleFooting()]) {
    const mesh = generateMesh(model, { type: 'T6' });
    assert.equal(mesh.nen, 6);
    checkMesh(mesh, model); // includes the midpoint / sharing checks
  }
});

// ---------------------------------------------------------------------------------------------
// geometry handling
// ---------------------------------------------------------------------------------------------
test('T-junctions: region vertices on the neighbour edge become nodes (conforming interfaces)', () => {
  const model = makeModel([rect(0, 0, 10, 5), [[0, 5], [5, 5], [5, 10], [0, 10]], [[5, 5], [10, 5], [10, 10], [5, 10]]], { size: 0.5 });
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  assert.ok(Math.abs(totalArea(mesh) - 100) < 1e-10);
  // the vertex (5,5) lies on the bottom region's top edge: nodes must exist there
  assert.equal(findNodesOnSegment(mesh, [5, 5], [5, 5], 1e-12).length, 1);
  // interface y=5 is conforming: no element crosses it
  for (let e = 0; e < nEl(mesh); e++) {
    const ys = elemCorners(mesh, e).map((p) => p[1]);
    assert.ok(Math.min(...ys) >= 5 - 1e-12 || Math.max(...ys) <= 5 + 1e-12);
  }
});

test('regions with a hole (uncovered area) are meshed around the hole', () => {
  const model = makeModel([
    rect(0, 0, 10, 3), [[0, 3], [3, 3], [3, 7], [0, 7]], [[7, 3], [10, 3], [10, 7], [7, 7]], rect(0, 7, 10, 10),
  ], { size: 0.5 });
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  assert.ok(Math.abs(totalArea(mesh) - 84) < 1e-10);
  // no element inside the hole (3..7 x 3..7)
  for (let e = 0; e < nEl(mesh); e++) {
    const c = elemCorners(mesh, e);
    const cx = (c[0][0] + c[1][0] + c[2][0]) / 3, cy = (c[0][1] + c[1][1] + c[2][1]) / 3;
    assert.ok(!(cx > 3 && cx < 7 && cy > 3 && cy < 7));
  }
  // the hole boundary is part of the outer boundary
  assert.ok(mesh.boundaryEdges.some(([a, b]) => Math.abs(node(mesh, a)[0] - 5) < 2 && Math.abs(node(mesh, a)[1] - 3) < 1e-12 && Math.abs(node(mesh, b)[1] - 3) < 1e-12));
});

test('internal lines: mesh conforms to crossing lines (split at intersections)', () => {
  const model = makeModel([rect(0, 0, 10, 10)], { size: 0.7, lines: [[[0, 2.3], [10, 7.1]], [[2, 0], [5, 10]]] });
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  assert.ok(Math.abs(totalArea(mesh) - 100) < 1e-10);
  // every element edge is either on a line or does not cross it: test that line nodes form chains covering the lines
  for (const l of model.lines) {
    const nodesOn = findNodesOnSegment(mesh, l.points[0], l.points[1], 1e-9);
    const L = Math.hypot(l.points[1][0] - l.points[0][0], l.points[1][1] - l.points[0][1]);
    assert.ok(nodesOn.length >= 2 * L / 0.7 * 0.8, `${nodesOn.length} nodes on line`);
  }
  // the intersection point is a node
  const cross = [0, 0];
  {
    const [a, b] = model.lines[0].points, [c, d] = model.lines[1].points;
    const r = [b[0] - a[0], b[1] - a[1]], s = [d[0] - c[0], d[1] - c[1]];
    const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / (r[0] * s[1] - r[1] * s[0]);
    cross[0] = a[0] + t * r[0]; cross[1] = a[1] + t * r[1];
  }
  assert.equal(findNodesOnSegment(mesh, cross, cross, 1e-9).length, 1);
  // no element edge crosses a line: for each element, the signed distances of its corners to a line
  // may not have strictly different signs unless the element touches the line only at nodes
  for (const l of model.lines) {
    const [a, b] = l.points;
    for (let e = 0; e < nEl(mesh); e++) {
      const c = elemCorners(mesh, e);
      const Ll = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const s = c.map((p) => ((b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0])) / Ll); // signed distance
      const pos = s.filter((v) => v > 1e-9).length, neg = s.filter((v) => v < -1e-9).length;
      if (pos && neg) {
        // element straddles the infinite line: it must lie beyond the segment ends
        const mid = c.reduce((q, p) => [q[0] + p[0] / 3, q[1] + p[1] / 3], [0, 0]);
        const proj = ((mid[0] - a[0]) * (b[0] - a[0]) + (mid[1] - a[1]) * (b[1] - a[1])) / ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2);
        assert.ok(proj < 0 || proj > 1, 'element crosses an internal line');
      }
    }
  }
});

test('nested region (island) conforms and takes the inner region index', () => {
  const model = makeModel([rect(0, 0, 10, 10), rect(4, 4, 6, 6)], { size: 0.5 });
  const mesh = generateMesh(model);
  checkMesh(mesh, model, { checkRegions: false });
  assert.ok(Math.abs(totalArea(mesh) - 100) < 1e-10);
  let inner = 0;
  for (let e = 0; e < nEl(mesh); e++) {
    const c = elemCorners(mesh, e);
    const cx = (c[0][0] + c[1][0] + c[2][0]) / 3, cy = (c[0][1] + c[1][1] + c[2][1]) / 3;
    const inside = cx > 4 && cx < 6 && cy > 4 && cy < 6;
    assert.equal(mesh.elementRegion[e], inside ? 1 : 0);
    if (inside) inner += polygonArea(c);
  }
  assert.ok(Math.abs(inner - 4) < 1e-10);
});

test('CW region polygons and duplicate/closing points are accepted', () => {
  const cw = [[0, 0], [0, 2], [2, 2], [2, 0], [0, 0]]; // clockwise, closing point repeated
  const model = makeModel([cw], { size: 0.25 });
  const mesh = generateMesh(model);
  assert.ok(Math.abs(totalArea(mesh) - 4) < 1e-12);
  checkMesh(mesh, makeModel([rect(0, 0, 2, 2)]));
});

test('point features inside the domain become nodes; outside ones are ignored', () => {
  const model = makeModel([rect(0, 0, 10, 10)], {
    size: 1,
    loads: [
      { id: 'P1', type: 'point', p: [3.3, 4.4], fx: 0, fy: -10 },
      { id: 'P2', type: 'point', p: [50, 50], fx: 0, fy: -10 },
      { id: 'Q1', type: 'distributed', p1: [7.3, 10], p2: [8.9, 10], qx1: 0, qy1: -1, qx2: 0, qy2: -1 },
    ],
    boundaries: [
      { id: 'B1', type: 'fixity', target: { kind: 'auto' } },
      { id: 'B2', type: 'fixity', target: { kind: 'point', p: [0, 3.7] }, fixX: true, fixY: true },
      { id: 'B3', type: 'fixity', target: { kind: 'segment', p1: [10, 1.1], p2: [10, 2.9] }, fixX: true, fixY: false },
    ],
  });
  const mesh = generateMesh(model);
  checkMesh(mesh, model);
  for (const p of [[3.3, 4.4], [7.3, 10], [8.9, 10], [0, 3.7], [10, 1.1], [10, 2.9]]) {
    const hit = findNodesOnSegment(mesh, p, p, 1e-12);
    assert.equal(hit.length, 1, `node at ${p}`);
    assert.deepEqual(node(mesh, hit[0]), p);
  }
  assert.equal(findNodesOnSegment(mesh, [50, 50], [50, 50], 1e-6).length, 0);
});

test('local refinement via opts.refine', () => {
  const model = makeModel([rect(0, 0, 10, 10)], { size: 1, type: 'T3' });
  const plain = generateMesh(model);
  const refined = generateMesh(model, { refine: [{ p: [5, 5], size: 0.1, radius: 0.5 }] });
  checkMesh(refined, model);
  assert.ok(nEl(refined) > nEl(plain) * 1.5);
  assert.ok(Math.abs(totalArea(refined) - 100) < 1e-10);
  // elements near the point are small, far elements stay near meshSize
  let nearMax = 0, farMax = 0;
  for (let e = 0; e < nEl(refined); e++) {
    const c = elemCorners(refined, e);
    const cx = (c[0][0] + c[1][0] + c[2][0]) / 3, cy = (c[0][1] + c[1][1] + c[2][1]) / 3;
    const d = Math.hypot(cx - 5, cy - 5);
    const a = polygonArea(c);
    if (d < 0.5) nearMax = Math.max(nearMax, a);
    if (d > 5) farMax = Math.max(farMax, a);
  }
  assert.ok(nearMax < 0.02, `near area ${nearMax}`);
  assert.ok(farMax > 0.2, `far area ${farMax}`);
  assert.ok(refined.stats.minAngle >= 20);
  // line refinement
  const lr = generateMesh(model, { refine: [{ p1: [0, 0], p2: [10, 0], size: 0.25, radius: 0.5 }] });
  checkMesh(lr, model);
  assert.ok(findNodesOnSegment(lr, [0, 0], [10, 0]).length >= 38);
});

test('quality target: minAngle option', () => {
  const model = createExampleSlope();
  const mesh = generateMesh(model, { minAngle: 30, type: 'T3' });
  checkMesh(mesh, model);
  assert.ok(mesh.stats.minAngle >= 25, `min angle ${mesh.stats.minAngle}`);
});

test('small input angles terminate, stay valid and conserve area', () => {
  for (const deg of [30, 15, 5, 1]) {
    const a = (deg * Math.PI) / 180;
    const model = makeModel([[[0, 0], [10, 0], [10 * Math.cos(a), 10 * Math.sin(a)]]], { size: 1 });
    const mesh = generateMesh(model);
    checkMesh(mesh, model);
    const A = unionArea(model);
    assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-9, `area, wedge ${deg} deg`);
    assert.ok(!mesh.stats.capped);
    assert.ok(mesh.stats.minAngle > 0.9 * Math.min(deg, 20), `min angle ${mesh.stats.minAngle} for ${deg} deg wedge`);
  }
});

test('regression: segment split chains at an acute corner keep region labels consistent', () => {
  // The midpoint of one edge at the 24-degree corner encroaches (and temporarily destroys) the other edge;
  // the corner triangles must still end up inside the domain (area conserved).
  const model = makeModel([[[11.202822647355546, 7.291889613823313], [8.026868992897201, 6.133843681747287], [14.860294535438115, 2.3577725479650575]]], {
    size: 0.5,
    lines: [[[10.853999126702547, 9.197398943360895], [4.776458451524377, 4.037954001687467]], [[14.806822570972145, 2.850047848187387], [0.8426914783194661, 9.893967588432133]]],
  });
  for (const type of ['T3', 'T6']) {
    model.settings.elementType = type;
    const mesh = generateMesh(model);
    checkMesh(mesh, model);
    const A = unionArea(model);
    assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-12, `area ${totalArea(mesh)} vs ${A}`);
  }
  // acute corners shared by two regions
  const m2 = makeModel([[[0, 0], [10, 0], [10, 1.2]], [[0, 0], [10, 1.2], [10, 3]]], { size: 0.5 });
  const mesh2 = generateMesh(m2);
  checkMesh(mesh2, m2);
  assert.ok(Math.abs(totalArea(mesh2) - unionArea(m2)) < 1e-10);
});

test('size field: grading away from features, point and segment features', () => {
  const sf = makeSizeField(2, [{ p: [0, 0], size: 0.2, radius: 1 }, { p1: [10, 0], p2: [10, 10], size: 0.5, radius: 0 }], 0.5);
  assert.equal(sf.at(0, 0), 0.2);
  assert.equal(sf.at(1, 0), 0.2);
  assert.ok(Math.abs(sf.at(2, 0) - 0.7) < 1e-12);
  assert.equal(sf.at(5, 5), 2); // far from everything
  assert.ok(Math.abs(sf.at(10, 5) - 0.5) < 1e-12);
  assert.ok(Math.abs(sf.at(11, 3) - 1.0) < 1e-12);
  assert.equal(sf.hmin, 0.2);
  assert.equal(makeSizeField(3).constant, true);
  assert.equal(makeSizeField(3).at(1, 2), 3);
});

test('thin layer and very different scales', () => {
  for (const [pts, size] of [
    [rect(0, 0, 20, 0.05), 1],
    [rect(0, 0, 1e-3, 1e-3), 1e-4],
    [rect(0, 0, 1e5, 1e5), 1e4],
    [rect(1e6, 1e6, 1e6 + 10, 1e6 + 10), 1],
  ]) {
    const model = makeModel([pts], { size });
    const mesh = generateMesh(model);
    const A = unionArea(model);
    assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-9);
    let neg = 0;
    for (let e = 0; e < nEl(mesh); e++) if (polygonArea(elemCorners(mesh, e)) <= 0) neg++;
    assert.equal(neg, 0);
    assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
  }
});

test('errors: no regions, bad size, excessive element count', () => {
  const empty = createEmptyModel();
  assert.throws(() => generateMesh(empty), /no valid regions/);
  const model = makeModel([rect(0, 0, 1, 1)], { size: 1 });
  assert.throws(() => generateMesh(model, { meshSize: 0 }), /meshSize/);
  assert.throws(() => generateMesh(model, { meshSize: 1e-4 }), /refused/);
});

test('deterministic output', () => {
  const model = createExampleFooting();
  const a = generateMesh(model), b = generateMesh(model);
  assert.deepEqual(Array.from(a.nodes), Array.from(b.nodes));
  assert.deepEqual(Array.from(a.elements), Array.from(b.elements));
  assert.deepEqual(a.boundaryEdges, b.boundaryEdges);
});

test('RCM numbering keeps the bandwidth small', () => {
  const model = makeModel([rect(0, 0, 50, 10)], { size: 0.5 });
  const mesh = generateMesh(model);
  const bw = bandwidth(mesh.elements, mesh.nen);
  const nN = mesh.nodes.length / 2;
  // a long strip ~ 100 x 20 corner nodes: bandwidth ~ short side * nodes per T6 element row; far below n/4
  assert.ok(bw < nN / 8, `bandwidth ${bw} of ${nN} nodes`);
  // much better than numbering by x only is not required, but must beat a random-ish numbering by a wide margin
  const rnd = mulberry32(7);
  const perm = Array.from({ length: nN }, (_, i) => i).sort(() => rnd() - 0.5);
  const E = mesh.elements.map((v) => perm[v]);
  assert.ok(bw * 5 < bandwidth(E, mesh.nen));
});

// ---------------------------------------------------------------------------------------------
// helpers exported by the mesher
// ---------------------------------------------------------------------------------------------
test('findNodesOnSegment / findNearestNode / meshQuality', () => {
  const model = makeModel([rect(0, 0, 4, 4)], { size: 1 });
  const mesh = generateMesh(model);
  const bottom = findNodesOnSegment(mesh, [0, 0], [4, 0]);
  assert.ok(bottom.length >= 9); // T6 incl. mid-side nodes
  const xs = bottom.map((i) => node(mesh, i)[0]);
  assert.deepEqual(xs, [...xs].sort((a, b) => a - b), 'ordered along the segment');
  assert.equal(xs[0], 0);
  assert.equal(xs[xs.length - 1], 4);
  for (const i of bottom) assert.ok(Math.abs(node(mesh, i)[1]) < 1e-12);
  // reversed direction reverses the order
  assert.deepEqual(findNodesOnSegment(mesh, [4, 0], [0, 0]), [...bottom].reverse());
  // tolerance respected
  assert.deepEqual(findNodesOnSegment(mesh, [0, 0.5], [4, 0.5], 1e-9).filter((i) => Math.abs(node(mesh, i)[1] - 0.5) > 1e-9), []);
  // nearest node
  const i0 = findNearestNode(mesh, [-0.1, -0.1]);
  assert.deepEqual(node(mesh, i0), [0, 0]);
  const i1 = findNearestNode(mesh, [4.2, 3.9]);
  assert.ok(Math.hypot(node(mesh, i1)[0] - 4.2, node(mesh, i1)[1] - 3.9) < 0.5);
  assert.equal(findNearestNode({ nodes: new Float64Array(0) }, [0, 0]), -1);
  // quality
  const q = meshQuality(mesh);
  assert.equal(q.nElements, nEl(mesh));
  assert.equal(q.nInverted, 0);
  assert.ok(Math.abs(q.totalArea - 16) < 1e-12);
  assert.ok(q.minAngle > 20 && q.maxAngle < 120 && q.maxAspect >= 1);
  assert.equal(q.minAngle, mesh.stats.minAngle);
});

// ---------------------------------------------------------------------------------------------
// stress and performance
// ---------------------------------------------------------------------------------------------
test('randomised stress: star polygons with random internal lines and point loads', () => {
  const rnd = mulberry32(12345);
  for (let k = 0; k < 40; k++) {
    const nV = 3 + Math.floor(rnd() * 10);
    const pts = [];
    for (let i = 0; i < nV; i++) {
      const ang = ((i + 0.2 + 0.6 * rnd()) / nV) * 2 * Math.PI;
      const r = 3 + 7 * rnd();
      pts.push([10 + r * Math.cos(ang), 10 + r * Math.sin(ang)]);
    }
    if (polygonArea(pts) < 5) continue;
    const lines = [];
    for (let i = 0; i < Math.floor(rnd() * 3); i++) lines.push([[20 * rnd(), 20 * rnd()], [20 * rnd(), 20 * rnd()]]);
    const loads = [{ id: 'P', type: 'point', p: [10 + 2 * rnd(), 10 + 2 * rnd()], fx: 0, fy: -1 }];
    const model = makeModel([pts], { size: 0.8 + rnd(), lines, loads, type: k % 2 ? 'T3' : 'T6' });
    const mesh = generateMesh(model);
    checkMesh(mesh, model);
    const A = unionArea(model);
    assert.ok(Math.abs(totalArea(mesh) - A) / A < 1e-9, `case ${k}: area`);
    assert.ok(!mesh.stats.capped, `case ${k}: capped`);
  }
});

test('performance: ~20k T6 elements in < 2 s', () => {
  const model = makeModel([rect(0, 0, 100, 100)], { size: 1.0, type: 'T6' });
  generateMesh(makeModel([rect(0, 0, 10, 10)], { size: 1 })); // warm-up
  const t0 = performance.now();
  const mesh = generateMesh(model);
  const dt = performance.now() - t0;
  console.log(`  perf: ${nEl(mesh)} T6 elements, ${mesh.stats.nNodes} nodes in ${dt.toFixed(0)} ms, min angle ${mesh.stats.minAngle.toFixed(1)} deg`);
  assert.ok(nEl(mesh) > 15000 && nEl(mesh) < 30000, `n elements ${nEl(mesh)}`);
  assert.ok(dt < 2000, `took ${dt} ms`);
  assert.ok(Math.abs(totalArea(mesh) - 1e4) < 1e-6);
  assert.ok(mesh.stats.minAngle >= 20);
  // structural validity on the big mesh (sampled by the generic checker)
  checkMesh(mesh, model);
});

// ---------------------------------------------------------------------------------------------
// near-coincident geometry: snapping, warnings, self-intersection, thin layers
// ---------------------------------------------------------------------------------------------
function boundaryOnBox(mesh, box, tol = 1e-6) {
  for (const [a, b] of mesh.boundaryEdges) {
    const [ax, ay] = node(mesh, a), [bx, by] = node(mesh, b);
    const onSide = (f) => Math.abs(f(ax)) < tol && Math.abs(f(bx)) < tol;
    const ok = onSide((x) => x - box[0]) || onSide((x) => x - box[2]) ||
      (Math.abs(ay - box[1]) < tol && Math.abs(by - box[1]) < tol) || (Math.abs(ay - box[3]) < tol && Math.abs(by - box[3]) < tol);
    if (!ok) return false;
  }
  return true;
}

test('regions whose vertex is slightly off the neighbour edge are connected (no internal crack)', async () => {
  const top = {};
  for (const d of [0, 2e-7, 1e-5, 1e-4]) {
    const m = createEmptyModel();
    m.materials = [defaultMaterial({ id: 'M1', model: 'linear-elastic', E: 1e4, nu: 0.3, gammaUnsat: 20, gammaSat: 20 })];
    m.regions = [
      { id: 'R1', points: [[0, 0], [10, 0], [10, 5], [0, 5]], materialId: 'M1' },
      { id: 'R2', points: [[0, 5], [5, 5 + d], [10, 5], [10, 10], [0, 10]], materialId: 'M1' },
    ];
    m.boundaries = [{ id: 'B1', type: 'fixity', target: { kind: 'auto' } }];
    m.settings.meshSize = 1;
    m.stages = [{ id: 'S0', name: 'Initial', initial: 'gravity', activeRegions: ['R1', 'R2'], activeLoads: [], resetDisplacements: true }];
    const mesh = generateMesh(m);
    assert.ok(boundaryOnBox(mesh, [0, 0, 10, 10]), `d=${d}: interface must not be an outer boundary`);
    assert.ok(Math.abs(totalArea(mesh) - 100) < 1e-3, `d=${d}: area`);
    const r = await solve(m, mesh, {});
    assert.ok(r.ok, `d=${d}: solve ok`);
    const st = r.stages.at(-1);
    let uy = NaN;
    for (let i = 0; i < mesh.nodes.length / 2; i++) if (Math.abs(mesh.nodes[2 * i] - 5) < 1e-9 && Math.abs(mesh.nodes[2 * i + 1] - 10) < 1e-9) uy = st.displacement[2 * i + 1];
    top[d] = uy;
  }
  assert.ok(Math.abs(top[0] - -0.0742857) < 1e-4, `reference settlement ${top[0]}`);
  for (const d of [2e-7, 1e-5, 1e-4]) assert.ok(Math.abs(top[d] - top[0]) < 2e-3 * Math.abs(top[0]), `d=${d}: uy ${top[d]} vs ${top[0]}`);
});

test('slope regions typed with rounding (3.333333 vs 3.3333333) mesh normally', () => {
  const a = [[0, 0], [30, 0], [30, 10], [20, 10], [0, 3.333333]];
  for (const d of [3.3e-7, 5e-7, 1e-5, 1e-4]) {
    const model = makeModel([a, [[0, 3.333333 + d], [20, 10], [0, 10]]], { size: 1, type: 'T3' });
    const mesh = generateMesh(model);
    assert.ok(nEl(mesh) > 600 && nEl(mesh) < 900, `d=${d}: ${nEl(mesh)} elements`);
    assert.ok(mesh.stats.minAngle > 10, `d=${d}: min angle ${mesh.stats.minAngle}`);
    assert.ok(Math.abs(totalArea(mesh) - 300) < 1e-2, `d=${d}: area`);
    assert.equal(mesh.stats.warnings.length, 0);
  }
  // both whole edges offset
  for (const d of [5e-7, 1e-5, 1e-4]) {
    const mesh = generateMesh(makeModel([rect(0, 0, 10, 5), [[0, 5 + d], [10, 5 + d], [10, 10], [0, 10]]], { size: 1, type: 'T3' }));
    assert.ok(boundaryOnBox(mesh, [0, 0, 10, 10]), `shifted edge d=${d}`);
  }
});

test('a real but unconnected gap (vertex 1e-2 off the neighbour edge) produces a warning', () => {
  const model = makeModel([rect(0, 0, 10, 5), [[0, 5], [5, 5.01], [10, 5], [10, 10], [0, 10]]], { size: 1 });
  const mesh = generateMesh(model);
  assert.ok(mesh.stats.warnings.some((w) => /not connected/.test(w) && /crack/.test(w)), JSON.stringify(mesh.stats.warnings));
  // clean geometry: no warnings
  assert.equal(generateMesh(makeModel([rect(0, 0, 10, 5), rect(0, 5, 10, 10)], { size: 1 })).stats.warnings.length, 0);
});

test('loads, distributed-load ends and line ends a hair off an edge give well-shaped elements', () => {
  const W = 40, H = 20;
  for (const d of [1e-4, -1e-4, 1e-6, -1e-6]) {
    const loads = [
      { id: 'P', type: 'point', p: [13.3, H + d], fx: 0, fy: -100 },
      { id: 'Q', type: 'distributed', p1: [20, H + d], p2: [26.7, H + d], qx1: 0, qy1: -10, qx2: 0, qy2: -10 },
    ];
    const lines = [
      [[8, H - 6], [8, H + d]],            // line ending just at/inside/outside the top edge
      [[30, 10], [W + d, 10]],              // ends at the right edge
      [[1e-5 + d * 0, 5], [d, 12]],         // starts 1e-5 from the left edge, runs nearly along it
      [[2, H - 1e-4 * Math.sign(d)], [9, H - 1e-4 * Math.sign(d)]], // nearly collinear with the top edge
      [[W - 1e-5, H], [W - 1e-5, 12]],      // starts 1e-5 from a corner
    ];
    for (const type of ['T3', 'T6']) {
      const model = makeModel([rect(0, 0, W, H)], { size: 2, type, loads, lines });
      const refine = loads.flatMap((l) => (l.type === 'point' ? [{ p: l.p, size: 0.8, radius: 4 }] : [{ p: l.p1, size: 1, radius: 4 }, { p: l.p2, size: 1, radius: 4 }]));
      const mesh = generateMesh(model, { refine });
      assert.ok(mesh.stats.minAngle > 20, `d=${d} ${type}: min angle ${mesh.stats.minAngle}`);
      assert.ok(Math.abs(totalArea(mesh) - W * H) < 1e-2, `d=${d}: area`);
      assert.ok(boundaryOnBox(mesh, [0, 0, W, H], 1e-9), `d=${d}: boundary stays on the box`);
    }
  }
});

test('a point load just outside the edge is put on the edge at its projected position', () => {
  const model = makeModel([rect(0, 0, 40, 20)], { size: 2, loads: [{ id: 'P', type: 'point', p: [13.3, 20.0001], fx: 0, fy: -100 }] });
  const mesh = generateMesh(model);
  const n = findNearestNode(mesh, [13.3, 20.0001]);
  const [x, y] = node(mesh, n);
  assert.ok(Math.abs(x - 13.3) < 1e-9 && Math.abs(y - 20) < 1e-9, `nearest node (${x}, ${y})`);
  assert.ok(mesh.snaps.some((s) => Math.abs(s.to[0] - 13.3) < 1e-9 && Math.abs(s.to[1] - 20) < 1e-9));
  assert.ok(mesh.stats.minAngle > 20);
});

test('footing example with load ends offset by 1e-4 converges to the same settlement', async () => {
  const run = async (d) => {
    const m = createExampleFooting();
    for (const l of m.loads) if (l.type === 'distributed') { l.p1 = [l.p1[0], l.p1[1] - d]; l.p2 = [l.p2[0], l.p2[1] - d]; }
    const refine = m.loads.flatMap((l) => [{ p: l.p1, size: m.settings.meshSize / 2, radius: 2 * m.settings.meshSize }, { p: l.p2, size: m.settings.meshSize / 2, radius: 2 * m.settings.meshSize }]);
    const mesh = generateMesh(m, { refine });
    assert.ok(mesh.stats.minAngle > 20, `d=${d}: min angle ${mesh.stats.minAngle}`);
    const r = await solve(m, mesh, {});
    assert.ok(r.ok, r.message);
    let mn = 0;
    const u = r.stages.at(-1).displacement;
    for (let i = 0; i < mesh.nodes.length / 2; i++) mn = Math.min(mn, u[2 * i + 1]);
    return mn;
  };
  const ref = await run(0);
  for (const d of [1e-4, -1e-4]) assert.ok(Math.abs((await run(d)) - ref) < 0.01 * Math.abs(ref), `d=${d}`);
});

test('self-intersecting region outlines are rejected with an explicit message', () => {
  for (const pts of [
    [[0, 0], [10, 10], [10, 0], [0, 20]],            // bowtie, even-odd area 83.33
    [[0, 0], [10, 0], [10, 10], [5, -5], [0, 10]],   // loop
    [[0, 0], [10, 10], [10, 0], [0, 10]],            // symmetric bowtie, zero signed area
  ]) {
    assert.throws(() => generateMesh(makeModel([pts], { size: 1 })), /region R1: Region outline intersects itself/);
  }
  // a concave but simple polygon is fine
  const mesh = generateMesh(makeModel([[[0, 0], [10, 0], [10, 10], [6, 10], [6, 4], [4, 4], [4, 10], [0, 10]]], { size: 1 }));
  assert.ok(nEl(mesh) > 0);
});

test('a thin layer is refined to its thickness (no slivers)', () => {
  const model = makeModel([rect(0, 0, 20, 5), rect(0, 5, 20, 5.01), rect(0, 5.01, 20, 10)], { size: 1, type: 'T3' });
  const mesh = generateMesh(model);
  assert.ok(mesh.stats.minAngle >= 20, `min angle ${mesh.stats.minAngle}`);
  assert.ok(Math.abs(totalArea(mesh) - 200) < 1e-6);
  // 0.1 m layer stays fine as well, and the layer gets elements
  const m2 = generateMesh(makeModel([rect(0, 0, 20, 5), rect(0, 5, 20, 5.1), rect(0, 5.1, 20, 10)], { size: 1, type: 'T3' }));
  assert.ok(m2.stats.minAngle >= 20, `min angle ${m2.stats.minAngle}`);
  assert.ok(m2.elementRegion.some((r) => r === 1));
});
