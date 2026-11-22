// Stub mesher / solver / API for the UI dev harness only (the real modules are used when they exist).
import { pointInPolygon } from '../../core/geom.js';
import { bbox } from '../../core/geom.js';
import { createExampleSlope, createExampleFooting, createEmptyModel, effectiveStages } from '../../core/model.js';

/** Crude structured T3 mesh over the region bounding box (centroid-in-region test). Not production quality. */
export function stubMesh(model) {
  const pts = model.regions.flatMap((r) => r.points);
  const b = bbox(pts);
  const h = model.settings.meshSize;
  const nx = Math.max(1, Math.round((b.xmax - b.xmin) / h)), ny = Math.max(1, Math.round((b.ymax - b.ymin) / h));
  const dx = (b.xmax - b.xmin) / nx, dy = (b.ymax - b.ymin) / ny;
  const nodeId = new Map(); const nodes = [];
  const nid = (i, j) => { const k = i + ',' + j; if (!nodeId.has(k)) { nodeId.set(k, nodes.length / 2); nodes.push(b.xmin + i * dx, b.ymin + j * dy); } return nodeId.get(k); };
  const els = [], reg = [];
  const regionAt = (p) => model.regions.findIndex((r) => pointInPolygon(p, r.points));
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x0 = b.xmin + i * dx, y0 = b.ymin + j * dy;
    for (const tri of [[[0, 0], [1, 0], [1, 1]], [[0, 0], [1, 1], [0, 1]]]) {
      const c = [x0 + dx * (tri[0][0] + tri[1][0] + tri[2][0]) / 3, y0 + dy * (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
      const r = regionAt(c);
      if (r < 0) continue;
      els.push(...tri.map(([a, bb]) => nid(i + a, j + bb))); reg.push(r);
    }
  }
  const edgeCount = new Map();
  for (let e = 0; e < els.length / 3; e++) for (let k = 0; k < 3; k++) { const a = els[e * 3 + k], c = els[e * 3 + (k + 1) % 3]; const key = a < c ? a + '_' + c : c + '_' + a; edgeCount.set(key, (edgeCount.get(key) || 0) + 1); }
  const boundaryEdges = [...edgeCount].filter(([, n]) => n === 1).map(([k]) => k.split('_').map(Number));
  return { type: 'T3', nodes: new Float64Array(nodes), elements: new Int32Array(els), nen: 3, elementRegion: Int32Array.from(reg), boundaryEdges, stats: { nNodes: nodes.length / 2, nElements: els.length / 3, minAngle: 26.6, maxAspect: 1.8 } };
}

/** Fake results with smooth fields; reports progress through onProgress. */
export async function stubSolve(model, mesh, { onProgress, shouldCancel } = {}) {
  const stages = effectiveStages(model);
  const nN = mesh.nodes.length / 2, nEl = mesh.elements.length / 3;
  const res = { ok: true, message: 'stub solution', analysis: model.settings.analysis, fos: null, fosHistory: [], stages: [] };
  const bb = bbox(mesh.nodes.length ? Array.from({ length: nN }, (_, i) => [mesh.nodes[2 * i], mesh.nodes[2 * i + 1]]) : [[0, 0]]);
  stages.forEach((st, si) => {
    const disp = new Float64Array(2 * nN);
    for (let i = 0; i < nN; i++) {
      const x = mesh.nodes[2 * i], y = mesh.nodes[2 * i + 1];
      const fx = (x - bb.xmin) / (bb.xmax - bb.xmin || 1), fy = (y - bb.ymin) / (bb.ymax - bb.ymin || 1);
      disp[2 * i] = 0.02 * Math.sin(Math.PI * fx) * fy; disp[2 * i + 1] = -0.05 * Math.sin(Math.PI * fx) * fy * fy;
    }
    const gx = new Float64Array(nEl), gy = new Float64Array(nEl), elem = new Int32Array(nEl), plastic = new Uint8Array(nEl);
    const z = () => new Float64Array(nEl);
    const g = { x: gx, y: gy, elem, sxx: z(), syy: z(), sxy: z(), szz: z(), pore: z(), plastic, eps_xx: z(), eps_yy: z(), gxy: z() };
    for (let e = 0; e < nEl; e++) {
      let cx = 0, cy = 0; for (let k = 0; k < 3; k++) { cx += mesh.nodes[2 * mesh.elements[e * 3 + k]] / 3; cy += mesh.nodes[2 * mesh.elements[e * 3 + k] + 1] / 3; }
      gx[e] = cx; gy[e] = cy; elem[e] = e;
      g.syy[e] = -18 * (bb.ymax - cy); g.sxx[e] = 0.5 * g.syy[e]; g.sxy[e] = 3 * Math.sin(cx / 5); g.szz[e] = 0.4 * g.syy[e];
      g.eps_xx[e] = 1e-3 * Math.sin(cx / 7); g.eps_yy[e] = -2e-3 * Math.cos(cy / 5); g.gxy[e] = 1e-3 * Math.sin(cx / 9) * Math.cos(cy / 9);
      plastic[e] = (cx - bb.xmin) / (bb.xmax - bb.xmin || 1) > 0.7 && cy > bb.ymax - 0.4 * (bb.ymax - bb.ymin) ? 1 : 0;
    }
    res.stages.push({ id: st.id, name: st.name, displacement: disp, gp: g, reactions: new Float64Array(2 * nN), activeElements: new Uint8Array(nEl).fill(1), converged: true, steps: [] });
  });
  if (model.settings.analysis === 'fos') {
    for (const s of [1, 2, 3, 1.5, 1.25, 1.375, 1.4375]) {
      if (shouldCancel?.()) throw new Error('cancelled');
      onProgress?.({ stage: 0, step: 1, iter: 3, residual: 1e-4, fos: s, text: `SRF ${s}` });
      await new Promise((r) => setTimeout(r, 120));
      res.fosHistory.push({ srf: s, converged: s < 1.4, maxDisp: 0.02 * s, iterations: 12 });
    }
    res.fos = 1.41;
  } else {
    for (let i = 1; i <= 10; i++) {
      if (shouldCancel?.()) throw new Error('cancelled');
      onProgress?.({ stage: 0, step: i, iter: 4, residual: 1e-5 / i, text: `load step ${i}/10` });
      await new Promise((r) => setTimeout(r, 80));
    }
  }
  return res;
}

export { createExampleSlope, createExampleFooting, createEmptyModel };
