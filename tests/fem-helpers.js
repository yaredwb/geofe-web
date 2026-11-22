// Test helpers for the FE solver: simple structured triangle meshes in the contract's mesh format and model builders.
// (Not a test file: it defines no tests.)
import { createEmptyModel, defaultMaterial } from '../src/core/model.js';

/**
 * Build a mesh from a (nx × ny) logical grid of quadrilateral cells, each split into two triangles.
 * @param {number} nx  cells in i
 * @param {number} ny  cells in j
 * @param {(i:number,j:number)=>[number,number]} map  node coordinates, i = 0..nx, j = 0..ny (orientation preserving)
 * @param {'T3'|'T6'} type
 * @param {(ci:number,cj:number)=>number} [regionOf]  region index of a cell (default 0)
 */
export function gridMesh(nx, ny, map, type = 'T6', regionOf = () => 0) {
  const nCorner = (nx + 1) * (ny + 1);
  const cid = (i, j) => j * (nx + 1) + i;
  const coords = [];
  for (let j = 0; j <= ny; j++) for (let i = 0; i <= nx; i++) coords.push(...map(i, j));
  const tris = [], reg = [];
  for (let cj = 0; cj < ny; cj++) {
    for (let ci = 0; ci < nx; ci++) {
      const a = cid(ci, cj), b = cid(ci + 1, cj), c = cid(ci + 1, cj + 1), d = cid(ci, cj + 1);
      const r = regionOf(ci, cj);
      const t = (ci + cj) % 2 === 0 ? [[a, b, c], [a, c, d]] : [[a, b, d], [b, c, d]];
      for (const tri of t) { tris.push(tri); reg.push(r); }
    }
  }
  // make CCW
  for (const t of tris) {
    const [p, q, r] = t.map((n) => [coords[2 * n], coords[2 * n + 1]]);
    const area = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
    if (area < 0) { const tmp = t[1]; t[1] = t[2]; t[2] = tmp; }
  }
  // edge usage (boundary detection)
  const edgeCount = new Map();
  const ekey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
  for (const t of tris) for (let k = 0; k < 3; k++) {
    const key = ekey(t[k], t[(k + 1) % 3]);
    edgeCount.set(key, (edgeCount.get(key) || 0) + 1);
  }
  const boundaryEdges = [];
  for (const [key, n] of edgeCount) if (n === 1) boundaryEdges.push(key.split('_').map(Number));
  let nodes, elements, nen;
  if (type === 'T3') {
    nodes = Float64Array.from(coords);
    elements = Int32Array.from(tris.flat());
    nen = 3;
  } else {
    nen = 6;
    const all = coords.slice();
    const mid = new Map();
    const getMid = (a, b) => {
      const key = ekey(a, b);
      if (!mid.has(key)) {
        mid.set(key, all.length / 2);
        all.push(0.5 * (all[2 * a] + all[2 * b]), 0.5 * (all[2 * a + 1] + all[2 * b + 1]));
      }
      return mid.get(key);
    };
    const el = [];
    for (const [a, b, c] of tris) el.push(a, b, c, getMid(a, b), getMid(b, c), getMid(c, a));
    nodes = Float64Array.from(all);
    elements = Int32Array.from(el);
  }
  void nCorner;
  return {
    type, nodes, elements, nen,
    elementRegion: Int32Array.from(reg),
    boundaryEdges,
    stats: { nNodes: nodes.length / 2, nElements: tris.length, minAngle: 0, maxAspect: 0 },
  };
}

/** Rectangle [x0,x1]×[y0,y1] meshed with nx × ny cells. */
export function rectMesh(x0, x1, y0, y1, nx, ny, type = 'T6', regionOf) {
  return gridMesh(nx, ny, (i, j) => [x0 + ((x1 - x0) * i) / nx, y0 + ((y1 - y0) * j) / ny], type, regionOf);
}

/** Single-region model on a rectangle with one material, auto fixity and no loads. */
export function rectModel(x0, x1, y0, y1, matOverrides = {}) {
  const m = createEmptyModel();
  m.materials.push(defaultMaterial({ id: 'M1', ...matOverrides }));
  m.regions.push({ id: 'R1', name: 'Soil', materialId: 'M1', points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });
  m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });
  return m;
}

/** Slope mesh (createExampleSlope polygon): columns at x_i, each column has ny cells between y=0 and the surface. */
export function slopeMesh(nxL, nxM, nxR, ny, type = 'T6') {
  const xs = [];
  for (let i = 0; i <= nxL; i++) xs.push((20 * i) / nxL);
  for (let i = 1; i <= nxM; i++) xs.push(20 + (20 * i) / nxM);
  for (let i = 1; i <= nxR; i++) xs.push(40 + (20 * i) / nxR);
  const top = (x) => (x <= 20 ? 10 : x >= 40 ? 20 : 10 + (x - 20) / 2);
  return gridMesh(xs.length - 1, ny, (i, j) => [xs[i], (top(xs[i]) * j) / ny], type);
}
