// Model schema: factory, examples, validation. Source of truth for the data contract (see ARCHITECTURE.md).
import { polygonArea, ringSelfIntersects } from './geom.js';

export const MATERIAL_MODELS = ['linear-elastic', 'mohr-coulomb'];
const PALETTE = ['#c8a26b', '#9db86b', '#7aa6c2', '#c27a7a', '#b08cc2', '#d6c36b', '#8a8a8a', '#6bc2ae'];

export function defaultSettings() {
  return {
    analysis: 'static',
    planeStrain: true,
    gravity: 9.81,
    elementType: 'T6',
    meshSize: 2.0,
    tolerance: 1e-3,
    maxIterations: 200,
    loadSteps: 10,
    fos: { min: 0.5, max: 5.0, tol: 0.005, maxBisections: 30, tensionCutoff: true },
  };
}

export function createEmptyModel() {
  return {
    version: 1,
    title: 'Untitled model',
    units: { length: 'm', force: 'kN', stress: 'kPa' },
    settings: defaultSettings(),
    regions: [],
    lines: [],
    materials: [],
    boundaries: [],
    loads: [],
    water: { enabled: false, gammaW: 9.81, phreatic: [] },
    stages: [],
  };
}

export function newId(prefix, arr) {
  let i = 1;
  const used = new Set((arr || []).map((o) => o.id));
  while (used.has(prefix + i)) i++;
  return prefix + i;
}

export function defaultMaterial(overrides = {}) {
  return {
    id: 'M1', name: 'Soil', color: PALETTE[0], model: 'mohr-coulomb',
    E: 20000, nu: 0.3, gammaUnsat: 18, gammaSat: 20,
    c: 10, phi: 30, psi: 0, tensile: 0, K0: null, drainage: 'drained',
    ...overrides,
  };
}

export function materialColor(i) {
  return PALETTE[i % PALETTE.length];
}

export function cloneModel(m) {
  return JSON.parse(JSON.stringify(m));
}

// Classic homogeneous slope: 2:1-ish slope, toe at x=20, crest at x=40, height 10 m above a 10 m foundation layer.
export function createExampleSlope() {
  const m = createEmptyModel();
  m.title = 'Example: homogeneous slope (SRM FOS)';
  m.settings.analysis = 'fos';
  m.settings.meshSize = 1.5;
  m.materials.push(defaultMaterial({ id: 'M1', name: 'Slope soil', E: 1e5, nu: 0.3, gammaUnsat: 20, gammaSat: 20, c: 10, phi: 20, psi: 0 }));
  m.regions.push({
    id: 'R1', name: 'Slope', materialId: 'M1',
    points: [[0, 0], [60, 0], [60, 20], [40, 20], [20, 10], [0, 10]],
  });
  m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });
  return m;
}

// Strip footing on a two-layer soil, half-width 1 m footing modelled as a distributed load.
export function createExampleFooting() {
  const m = createEmptyModel();
  m.title = 'Example: strip footing on layered soil';
  m.settings.meshSize = 1.0;
  m.settings.loadSteps = 20;
  m.materials.push(defaultMaterial({ id: 'M1', name: 'Sand', color: PALETTE[5], E: 30000, nu: 0.3, gammaUnsat: 18, gammaSat: 20, c: 1, phi: 32, psi: 2 }));
  m.materials.push(defaultMaterial({ id: 'M2', name: 'Clay', color: PALETTE[2], E: 15000, nu: 0.35, gammaUnsat: 17, gammaSat: 19, c: 15, phi: 22, psi: 0 }));
  m.regions.push({ id: 'R1', name: 'Sand', materialId: 'M1', points: [[0, 6], [20, 6], [20, 10], [0, 10]] });
  m.regions.push({ id: 'R2', name: 'Clay', materialId: 'M2', points: [[0, 0], [20, 0], [20, 6], [0, 6]] });
  m.boundaries.push({ id: 'B1', type: 'fixity', target: { kind: 'auto' } });
  m.loads.push({ id: 'Q1', type: 'distributed', p1: [9, 10], p2: [11, 10], qx1: 0, qy1: -80, qx2: 0, qy2: -80 });
  m.water = { enabled: true, gammaW: 9.81, phreatic: [[0, 7], [20, 7]] };
  return m;
}

function isPt(p) {
  return Array.isArray(p) && p.length === 2 && p.every(Number.isFinite);
}

export function validateModel(m) {
  const errors = [];
  if (!m || typeof m !== 'object') return { ok: false, errors: ['Model is not an object'] };
  if (!Array.isArray(m.regions) || m.regions.length === 0) errors.push('No regions defined');
  const matIds = new Set((m.materials || []).map((x) => x.id));
  for (const r of m.regions || []) {
    if (!Array.isArray(r.points) || r.points.length < 3 || !r.points.every(isPt)) errors.push(`Region ${r.id}: needs ≥3 valid points`);
    else if (ringSelfIntersects(r.points)) errors.push(`Region ${r.id}: outline intersects itself`);
    else if (Math.abs(polygonArea(r.points)) < 1e-9) errors.push(`Region ${r.id}: zero area`);
    if (!r.materialId || !matIds.has(r.materialId)) errors.push(`Region ${r.id}: no valid material assigned`);
  }
  for (const mat of m.materials || []) {
    if (!(mat.E > 0)) errors.push(`Material ${mat.id}: E must be > 0`);
    if (!(mat.nu >= 0 && mat.nu < 0.5)) errors.push(`Material ${mat.id}: 0 ≤ nu < 0.5`);
    if (!['linear-elastic', 'mohr-coulomb'].includes(mat.model)) errors.push(`Material ${mat.id}: unknown model ${mat.model}`);
    if (mat.model === 'mohr-coulomb') {
      if (!(mat.c >= 0)) errors.push(`Material ${mat.id}: c must be ≥ 0`);
      if (!(mat.phi >= 0 && mat.phi < 90)) errors.push(`Material ${mat.id}: 0 ≤ phi < 90`);
      if (!(mat.psi >= 0 && mat.psi <= mat.phi)) errors.push(`Material ${mat.id}: 0 ≤ psi ≤ phi`);
      if (mat.c === 0 && mat.phi === 0) errors.push(`Material ${mat.id}: c and phi cannot both be zero`);
    }
  }
  if (!(m.boundaries || []).some((b) => b.type === 'fixity')) errors.push('No fixity boundary conditions (use auto fixity)');
  for (const l of m.loads || []) {
    if (l.type === 'point' && !isPt(l.p)) errors.push(`Load ${l.id}: invalid point`);
    if (l.type === 'distributed' && !(isPt(l.p1) && isPt(l.p2))) errors.push(`Load ${l.id}: invalid end points`);
  }
  if (m.water?.enabled && !(Array.isArray(m.water.phreatic) && m.water.phreatic.length >= 2)) errors.push('Water enabled but phreatic line has < 2 points');
  if (!(m.settings?.meshSize > 0)) errors.push('settings.meshSize must be > 0');
  return { ok: errors.length === 0, errors };
}

// Effective stages: explicit stages, or a single default stage with everything active.
export function effectiveStages(m) {
  if (m.stages && m.stages.length) return m.stages;
  return [{
    id: 'S0', name: 'Initial', initial: 'gravity',
    activeRegions: m.regions.map((r) => r.id),
    activeLoads: (m.loads || []).map((l) => l.id),
    resetDisplacements: true,
  }];
}
