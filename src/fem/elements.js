// Triangular continuum elements (plane strain): T3 (1 Gauss point) and T6 (3 Gauss points).
// All per-Gauss-point geometry is precomputed once per mesh:
//   w[g]            integration weight (area × quadrature weight, out-of-plane thickness 1)
//   dndx/dndy[g*nen+a]  shape-function derivatives w.r.t. global x / y
//   N[g*nen+a]      shape-function values
//   x[g], y[g]      global coordinates of the Gauss point
// Gauss points are ordered element-major: g = e*ngp + k.

// 3-point interior rule for the T6 (exact for quadratics); weights sum to the reference area 1/2.
const GP6 = [[1 / 6, 1 / 6], [2 / 3, 1 / 6], [1 / 6, 2 / 3]];
const W6 = 1 / 6;
const GP3 = [[1 / 3, 1 / 3]];
const W3 = 0.5;

/** Shape functions and natural derivatives for T3/T6 at (xi, eta). Returns {N, dN:[dxi..., deta...]} */
export function shapeFunctions(nen, xi, eta) {
  const L1 = 1 - xi - eta, L2 = xi, L3 = eta;
  if (nen === 3) {
    return { N: [L1, L2, L3], dNdxi: [-1, 1, 0], dNdeta: [-1, 0, 1] };
  }
  const N = [
    L1 * (2 * L1 - 1), L2 * (2 * L2 - 1), L3 * (2 * L3 - 1),
    4 * L1 * L2, 4 * L2 * L3, 4 * L3 * L1,
  ];
  // dLi/dxi = (-1, 1, 0), dLi/deta = (-1, 0, 1)
  const dNdxi = [
    (4 * L1 - 1) * -1, (4 * L2 - 1) * 1, 0,
    4 * (L2 * -1 + L1 * 1), 4 * (L3 * 1 + L2 * 0), 4 * (L1 * 0 + L3 * -1),
  ];
  const dNdeta = [
    (4 * L1 - 1) * -1, 0, (4 * L3 - 1) * 1,
    4 * (L2 * -1 + L1 * 0), 4 * (L3 * 0 + L2 * 1), 4 * (L1 * 1 + L3 * -1),
  ];
  return { N, dNdxi, dNdeta };
}

/**
 * Precompute Gauss-point geometry for a whole mesh.
 * @returns {{nen, nEl, ngp, nGP, w, dndx, dndy, N, x, y}}
 */
export function buildGeometry(mesh) {
  const nen = mesh.nen;
  if (nen !== 3 && nen !== 6) throw new Error(`Unsupported element: nen=${nen}`);
  const nEl = (mesh.elements.length / nen) | 0;
  const rule = nen === 6 ? GP6 : GP3;
  const wq = nen === 6 ? W6 : W3;
  const ngp = rule.length;
  const nGP = nEl * ngp;
  const w = new Float64Array(nGP);
  const dndx = new Float64Array(nGP * nen);
  const dndy = new Float64Array(nGP * nen);
  const N = new Float64Array(nGP * nen);
  const gx = new Float64Array(nGP);
  const gy = new Float64Array(nGP);
  const sf = rule.map(([xi, eta]) => shapeFunctions(nen, xi, eta));
  const nodes = mesh.nodes;
  const conn = mesh.elements;
  for (let e = 0; e < nEl; e++) {
    for (let k = 0; k < ngp; k++) {
      const g = e * ngp + k;
      const s = sf[k];
      let j11 = 0, j12 = 0, j21 = 0, j22 = 0, px = 0, py = 0;
      for (let a = 0; a < nen; a++) {
        const n = conn[e * nen + a];
        const x = nodes[2 * n], y = nodes[2 * n + 1];
        j11 += s.dNdxi[a] * x; j12 += s.dNdxi[a] * y;   // dx/dxi, dy/dxi
        j21 += s.dNdeta[a] * x; j22 += s.dNdeta[a] * y; // dx/deta, dy/deta
        px += s.N[a] * x; py += s.N[a] * y;
      }
      const det = j11 * j22 - j12 * j21;
      if (!(Math.abs(det) > 1e-14)) throw new Error(`Degenerate element ${e} (zero Jacobian)`);
      const inv = 1 / det;
      // [dN/dx; dN/dy] = J^-1 [dN/dxi; dN/deta]  with J = [[j11, j12],[j21, j22]] (rows: xi, eta)
      for (let a = 0; a < nen; a++) {
        dndx[g * nen + a] = (j22 * s.dNdxi[a] - j12 * s.dNdeta[a]) * inv;
        dndy[g * nen + a] = (-j21 * s.dNdxi[a] + j11 * s.dNdeta[a]) * inv;
        N[g * nen + a] = s.N[a];
      }
      w[g] = Math.abs(det) * wq;
      gx[g] = px; gy[g] = py;
    }
  }
  return { nen, nEl, ngp, nGP, w, dndx, dndy, N, x: gx, y: gy };
}

/**
 * Element stiffness (2*nen)² (row-major, dof order ux0,uy0,ux1,uy1,...) for an isotropic plane-strain elastic material.
 * @param {object} geo  from buildGeometry
 * @param {number} e    element index
 * @param {number} lam  Lamé λ
 * @param {number} G    shear modulus
 * @param {Float64Array} ke  output (length (2*nen)²)
 */
export function elementStiffness(geo, e, lam, G, ke) {
  const { nen, ngp } = geo;
  const nd = 2 * nen;
  ke.fill(0, 0, nd * nd);
  const d11 = lam + 2 * G, d12 = lam;
  for (let k = 0; k < ngp; k++) {
    const g = e * ngp + k;
    const w = geo.w[g];
    const o = g * nen;
    for (let a = 0; a < nen; a++) {
      const ax = geo.dndx[o + a], ay = geo.dndy[o + a];
      for (let b = 0; b < nen; b++) {
        const bx = geo.dndx[o + b], by = geo.dndy[o + b];
        // B_a^T D B_b with B_a = [[ax,0],[0,ay],[ay,ax]]
        const kxx = d11 * ax * bx + G * ay * by;
        const kxy = d12 * ax * by + G * ay * bx;
        const kyx = d12 * ay * bx + G * ax * by;
        const kyy = d11 * ay * by + G * ax * bx;
        ke[(2 * a) * nd + 2 * b] += kxx * w;
        ke[(2 * a) * nd + 2 * b + 1] += kxy * w;
        ke[(2 * a + 1) * nd + 2 * b] += kyx * w;
        ke[(2 * a + 1) * nd + 2 * b + 1] += kyy * w;
      }
    }
  }
}
