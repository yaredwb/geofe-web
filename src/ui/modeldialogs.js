// Model-specific dialogs: materials, analysis settings, region coordinates, loads, fixity, water, stages.
import { MATERIAL_MODELS } from '../core/model.js';
import { polygonArea } from '../core/geom.js';
import { h } from './dom.js';
import { icon } from './icons.js';
import { openModal, formDialog, parseNum } from './dialogs.js';
import { polygonProblem, ensureCCW, dedupeRing, moveVertexEverywhere, conformAll, samePt } from './edit.js';
import { fmtCoord, fmtNum } from './format.js';

// ------------------------------------------------------------------ materials

/** Edit or create a material. `mat` is a full material object (existing or fresh). Resolves with the edited copy or null. */
export async function materialDialog(mat, { isNew = false } = {}) {
  const mc = (v) => v.model === 'mohr-coulomb';
  const r = await formDialog({
    title: isNew ? 'New material' : `Edit material ${mat.id}`,
    width: 430,
    fields: [
      { key: 'name', label: 'Name', type: 'text', value: mat.name, required: true },
      { key: 'color', label: 'Colour', type: 'color', value: mat.color },
      { key: 'model', label: 'Material model', type: 'select', value: mat.model, options: MATERIAL_MODELS.map((m) => ({ value: m, label: m === 'mohr-coulomb' ? 'Mohr-Coulomb' : 'Linear elastic' })) },
      { section: 'Elasticity' },
      { key: 'E', label: "Young's modulus E", type: 'number', value: mat.E, unit: 'kPa', minExclusive: 0 },
      { key: 'nu', label: "Poisson's ratio ν", type: 'number', value: mat.nu, min: 0, maxExclusive: 0.5 },
      { section: 'Unit weights' },
      { key: 'gammaUnsat', label: 'γ unsaturated', type: 'number', value: mat.gammaUnsat, unit: 'kN/m³', min: 0 },
      { key: 'gammaSat', label: 'γ saturated', type: 'number', value: mat.gammaSat, unit: 'kN/m³', min: 0 },
      { section: 'Strength (Mohr-Coulomb)', showIf: mc },
      { key: 'c', label: 'Cohesion c′', type: 'number', value: mat.c, unit: 'kPa', min: 0, showIf: mc },
      { key: 'phi', label: 'Friction angle φ′', type: 'number', value: mat.phi, unit: '°', min: 0, maxExclusive: 90, showIf: mc },
      { key: 'psi', label: 'Dilation angle ψ', type: 'number', value: mat.psi, unit: '°', min: 0, showIf: mc },
      { key: 'tensile', label: 'Tensile strength', type: 'number', value: mat.tensile, unit: 'kPa', min: 0, showIf: mc, hint: 'Used when the tension cut-off is on' },
      { section: 'Initial stress / flow' },
      { key: 'K0', label: 'K0 (blank = Jaky)', type: 'number', value: mat.K0, nullable: true, min: 0, hint: 'Blank gives 1 − sin φ′' },
      { key: 'drainage', label: 'Drainage', type: 'select', value: mat.drainage || 'drained', options: [{ value: 'drained', label: 'Drained (effective stress)' }] },
    ],
    validate: (v) => {
      if (v.model === 'mohr-coulomb') {
        if (v.psi > v.phi) return 'Dilation angle ψ must not exceed friction angle φ′';
        if (v.c === 0 && v.phi === 0) return 'c′ and φ′ cannot both be zero';
      }
      return null;
    },
  });
  if (!r) return null;
  return { ...mat, ...r, name: r.name.trim() };
}

// ------------------------------------------------------------------ settings

/** Analysis settings dialog; mutates model.settings (and title) in place. Resolves true if applied. */
export async function settingsDialog(model) {
  const s = model.settings;
  const fos = (v) => v.analysis === 'fos';
  const r = await formDialog({
    title: 'Analysis settings',
    width: 440,
    fields: [
      { key: 'title', label: 'Model title', type: 'text', value: model.title },
      { section: 'Analysis' },
      { key: 'analysis', label: 'Analysis type', type: 'select', value: s.analysis, options: [{ value: 'static', label: 'Static (staged, gravity + loads)' }, { value: 'fos', label: 'Factor of safety (strength reduction)' }] },
      { key: 'gravity', label: 'Gravity g', type: 'number', value: s.gravity, unit: 'm/s²', minExclusive: 0 },
      { key: 'elementType', label: 'Element type', type: 'select', value: s.elementType, options: [{ value: 'T6', label: 'T6 (6-node quadratic triangle)' }, { value: 'T3', label: 'T3 (3-node linear; overestimates collapse loads and FOS, use T6)' }] },
      { key: 'meshSize', label: 'Target mesh size', type: 'number', value: s.meshSize, unit: 'm', minExclusive: 0 },
      { section: 'Nonlinear solution' },
      { key: 'loadSteps', label: 'Load steps per stage', type: 'number', value: s.loadSteps, integer: true, min: 1 },
      { key: 'tolerance', label: 'Residual tolerance', type: 'number', value: s.tolerance, minExclusive: 0 },
      { key: 'maxIterations', label: 'Max iterations per step', type: 'number', value: s.maxIterations, integer: true, min: 1 },
      { section: 'Strength reduction (FOS)', showIf: fos },
      { key: 'fosMin', label: 'SRF minimum', type: 'number', value: s.fos.min, minExclusive: 0, showIf: fos },
      { key: 'fosMax', label: 'SRF maximum', type: 'number', value: s.fos.max, minExclusive: 0, showIf: fos },
      { key: 'fosTol', label: 'SRF tolerance', type: 'number', value: s.fos.tol, minExclusive: 0, showIf: fos },
      { key: 'fosBis', label: 'Max bisections', type: 'number', value: s.fos.maxBisections ?? 30, integer: true, min: 1, showIf: fos },
      { key: 'tensionCutoff', label: 'Tension cut-off', type: 'checkbox', value: s.fos.tensionCutoff, showIf: fos },
    ],
    validate: (v) => (fos(v) && !(v.fosMax > v.fosMin) ? 'SRF maximum must exceed SRF minimum' : null),
  });
  if (!r) return false;
  model.title = r.title;
  Object.assign(s, { analysis: r.analysis, gravity: r.gravity, elementType: r.elementType, meshSize: r.meshSize, loadSteps: r.loadSteps, tolerance: r.tolerance, maxIterations: r.maxIterations });
  Object.assign(s.fos, { min: r.fosMin, max: r.fosMax, tol: r.fosTol, maxBisections: r.fosBis, tensionCutoff: r.tensionCutoff });
  return true;
}

// ------------------------------------------------------------------ loads / fixity / water

export function pointLoadDialog(p, load = null) {
  return formDialog({
    title: load ? `Edit point load ${load.id}` : 'Point load',
    fields: [
      { note: `Applied at (${fmtCoord(p[0])}, ${fmtCoord(p[1])}) m. Force per metre out of plane; +x right, +y up.` },
      { key: 'fx', label: 'Fx', type: 'number', value: load ? load.fx : 0, unit: 'kN/m' },
      { key: 'fy', label: 'Fy', type: 'number', value: load ? load.fy : -100, unit: 'kN/m' },
    ],
    validate: (v) => (v.fx === 0 && v.fy === 0 ? 'Load is zero' : null),
  });
}

export function distLoadDialog(p1, p2, load = null) {
  return formDialog({
    title: load ? `Edit distributed load ${load.id}` : 'Distributed load',
    width: 420,
    fields: [
      { note: `From (${fmtCoord(p1[0])}, ${fmtCoord(p1[1])}) to (${fmtCoord(p2[0])}, ${fmtCoord(p2[1])}) m. Pressure in global axes (kPa), linear variation.` },
      { section: 'Start point' },
      { key: 'qx1', label: 'qx', type: 'number', value: load ? load.qx1 : 0, unit: 'kPa' },
      { key: 'qy1', label: 'qy', type: 'number', value: load ? load.qy1 : -50, unit: 'kPa' },
      { key: 'uniform', label: 'Uniform (end = start)', type: 'checkbox', value: load ? load.qx1 === load.qx2 && load.qy1 === load.qy2 : true },
      { section: 'End point', showIf: (v) => !v.uniform },
      { key: 'qx2', label: 'qx', type: 'number', value: load ? load.qx2 : 0, unit: 'kPa', showIf: (v) => !v.uniform },
      { key: 'qy2', label: 'qy', type: 'number', value: load ? load.qy2 : -50, unit: 'kPa', showIf: (v) => !v.uniform },
    ],
    validate: (v) => {
      const e = v.uniform ? [v.qx1, v.qy1] : [v.qx2, v.qy2];
      return v.qx1 === 0 && v.qy1 === 0 && e[0] === 0 && e[1] === 0 ? 'Load is zero' : null;
    },
  }).then((r) => (r ? { qx1: r.qx1, qy1: r.qy1, qx2: r.uniform ? r.qx1 : r.qx2, qy2: r.uniform ? r.qy1 : r.qy2 } : null));
}

export function fixityDialog(desc, init = { fixX: true, fixY: true }) {
  return formDialog({
    title: 'Fixity',
    width: 340,
    fields: [
      { note: desc },
      { key: 'fixX', label: 'Fix x displacement', type: 'checkbox', value: init.fixX },
      { key: 'fixY', label: 'Fix y displacement', type: 'checkbox', value: init.fixY },
    ],
    validate: (v) => (!v.fixX && !v.fixY ? 'Select at least one direction' : null),
  });
}

export function waterLevelDialog(y0 = 0) {
  return formDialog({
    title: 'Horizontal water table',
    width: 340,
    fields: [{ note: 'Creates a horizontal phreatic line across the model.' }, { key: 'y', label: 'Water level y', type: 'number', value: y0, unit: 'm' }],
  });
}

// ------------------------------------------------------------------ region coordinates

/**
 * Edit a region's name, material and vertex coordinates in a table. Applies to the model on OK.
 * Returns true if modified.
 */
export function regionDialog(model, region) {
  let rows = region.points.map((p) => [p[0], p[1]]);
  const origRows = rows.map((p) => [...p]);
  const nameInp = h('input', { type: 'text', value: region.name || region.id });
  const matSel = h('select', model.materials.map((m) => h('option', { value: m.id, selected: m.id === region.materialId }, m.name)));
  if (!region.materialId || !model.materials.some((m) => m.id === region.materialId)) matSel.insertBefore(h('option', { value: '' }, '(none)'), matSel.firstChild), (matSel.value = '');
  const tbody = h('tbody');
  const info = h('div.gf-form-note');
  const err = h('div.gf-form-error');
  function sync() {
    const pts = rows.map((r) => [parseNum(r[0]), parseNum(r[1])]);
    const ok = pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
    info.textContent = ok && pts.length >= 3 ? `${pts.length} vertices, area ${fmtNum(Math.abs(polygonArea(pts)), 6)} m²` : '';
  }
  function build() {
    tbody.textContent = '';
    rows.forEach((r, i) => {
      const bind = (k) => {
        const inp = h('input', { type: 'text', value: String(r[k]), inputMode: 'decimal', spellcheck: false });
        inp.addEventListener('input', () => { r[k] = inp.value; sync(); });
        return inp;
      };
      const del = h('button.gf-iconbtn', { type: 'button', title: 'Remove vertex', html: icon('close', 12), onclick: () => { if (rows.length > 3) { rows.splice(i, 1); build(); } } });
      const ins = h('button.gf-iconbtn', { type: 'button', title: 'Insert vertex after', html: icon('plus', 12), onclick: () => {
        const a = rows[i], b = rows[(i + 1) % rows.length];
        rows.splice(i + 1, 0, [(parseNum(a[0]) + parseNum(b[0])) / 2, (parseNum(a[1]) + parseNum(b[1])) / 2]);
        build();
      } });
      tbody.appendChild(h('tr', h('td.idx', String(i + 1)), h('td', bind(0)), h('td', bind(1)), h('td.act', ins, del)));
    });
    sync();
  }
  build();
  const table = h('table.gf-table.edit', h('thead', h('tr', h('th', '#'), h('th', 'x (m)'), h('th', 'y (m)'), h('th', ''))), tbody);
  const body = h('div', h('div.gf-form', h('div.gf-form-row', h('label', 'Name'), h('div.gf-form-ctl', nameInp)), h('div.gf-form-row', h('label', 'Material'), h('div.gf-form-ctl', matSel))),
    h('div.gf-scroll', { style: { maxHeight: '260px' } }, table), info, err);
  return openModal({
    title: `Region ${region.id} coordinates`, body, width: 380,
    buttons: [
      { label: 'Cancel', value: false },
      {
        label: 'Apply', primary: true,
        onClick: () => {
          const pts = rows.map((r) => [parseNum(r[0]), parseNum(r[1])]);
          if (!pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) { err.textContent = 'All coordinates must be valid numbers'; return false; }
          const clean = dedupeRing(pts);
          const prob = polygonProblem(clean);
          if (prob) { err.textContent = prob; return false; }
          region.name = nameInp.value.trim() || region.id;
          region.materialId = matSel.value || null;
          if (clean.length === origRows.length && pts.length === origRows.length) {
            // Same topology: move shared vertices together so neighbours stay conforming.
            const pairs = origRows.map((o, i) => [o, pts[i]]).filter(([o, n]) => !samePt(o, n));
            for (const [o, n] of pairs) moveVertexEverywhere(model, o, n);
            if (polygonArea(region.points) < 0) region.points = ensureCCW(region.points);
          } else region.points = ensureCCW(clean);
          conformAll(model);
        },
      },
    ],
  }).promise;
}

// ------------------------------------------------------------------ stages

/**
 * Stage list editor. Edits model.stages (replaced on OK). Resolves true if applied.
 * Stages: name, initial ('gravity' | 'k0'), reset displacements, active regions/loads via checkboxes.
 */
export function stagesDialog(model) {
  const stages = JSON.parse(JSON.stringify(model.stages || []));
  let sel = Math.min(0, stages.length - 1);
  const listEl = h('div.gf-stage-list');
  const editEl = h('div.gf-stage-edit');
  const note = h('div.gf-form-note');

  const allRegions = () => model.regions.map((r) => r.id);
  const allLoads = () => model.loads.map((l) => l.id);

  function addStage() {
    const first = stages.length === 0;
    const prev = stages[stages.length - 1];
    const ids = new Set(stages.map((s) => s.id));
    let n = first ? 0 : 1; while (ids.has('S' + n)) n++;
    stages.push({
      id: 'S' + n, name: first ? 'Initial' : `Stage ${stages.length}`, initial: 'gravity',
      activeRegions: prev ? [...prev.activeRegions] : allRegions(), activeLoads: prev ? [...prev.activeLoads] : allLoads(), resetDisplacements: first,
    });
    sel = stages.length - 1;
    render();
  }

  function render() {
    listEl.textContent = '';
    stages.forEach((s, i) => {
      listEl.appendChild(h('div.gf-stage-item' + (i === sel ? '.sel' : ''), { onclick: () => { sel = i; render(); } },
        h('span.n', String(i + 1)), h('span.t', s.name)));
    });
    note.textContent = stages.length ? '' : 'No explicit stages: a single default stage with all regions and loads active is used. Add a stage to define staged construction.';
    editEl.textContent = '';
    const s = stages[sel];
    if (!s) return;
    const nameInp = h('input', { type: 'text', value: s.name });
    nameInp.addEventListener('input', () => { s.name = nameInp.value; listEl.children[sel].querySelector('.t').textContent = s.name; });
    const initSel = h('select', { disabled: sel !== 0 }, h('option', { value: 'gravity', selected: s.initial === 'gravity' }, 'Gravity loading'), h('option', { value: 'k0', selected: s.initial === 'k0' }, 'K0 procedure'));
    initSel.addEventListener('change', () => { s.initial = initSel.value; });
    const reset = h('input', { type: 'checkbox', checked: !!s.resetDisplacements });
    reset.addEventListener('change', () => { s.resetDisplacements = reset.checked; });
    const check = (arr, id, label, color) => {
      const cb = h('input', { type: 'checkbox', checked: arr.includes(id) });
      cb.addEventListener('change', () => { const i = arr.indexOf(id); if (cb.checked && i < 0) arr.push(id); else if (!cb.checked && i >= 0) arr.splice(i, 1); });
      return h('label.gf-check', cb, color ? h('span.gf-swatch', { style: { background: color } }) : null, label);
    };
    const matColor = (r) => model.materials.find((m) => m.id === r.materialId)?.color;
    editEl.append(
      h('div.gf-form', h('div.gf-form-row', h('label', 'Name'), h('div.gf-form-ctl', nameInp)),
        h('div.gf-form-row', h('label', 'Initial stresses'), h('div.gf-form-ctl', initSel)),
        h('div.gf-form-row.check', h('label', 'Reset displacements'), h('div.gf-form-ctl', reset))),
      h('div.gf-form-section', 'Active regions'),
      h('div.gf-checklist', model.regions.length ? model.regions.map((r) => check(s.activeRegions, r.id, `${r.name || r.id}`, matColor(r))) : h('i', 'no regions')),
      h('div.gf-form-section', 'Active loads'),
      h('div.gf-checklist', model.loads.length ? model.loads.map((l) => check(s.activeLoads, l.id, `${l.id} (${l.type})`)) : h('i', 'no loads')),
    );
  }

  const toolbar = h('div.gf-stage-tools',
    h('button.gf-btn', { type: 'button', onclick: addStage }, 'Add stage'),
    h('button.gf-btn', { type: 'button', onclick: () => { if (stages.length) { stages.splice(sel, 1); sel = Math.min(sel, stages.length - 1); render(); } } }, 'Delete'),
    h('button.gf-btn', { type: 'button', title: 'Move up', onclick: () => { if (sel > 0) { [stages[sel - 1], stages[sel]] = [stages[sel], stages[sel - 1]]; sel--; render(); } } }, '↑'),
    h('button.gf-btn', { type: 'button', title: 'Move down', onclick: () => { if (sel < stages.length - 1) { [stages[sel + 1], stages[sel]] = [stages[sel], stages[sel + 1]]; sel++; render(); } } }, '↓'));
  const body = h('div.gf-stages', h('div.gf-stage-left', toolbar, listEl), editEl, note);
  render();
  return openModal({
    title: 'Construction stages', body, width: 640, closeValue: false,
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', primary: true, onClick: () => { model.stages = stages; } }],
  }).promise;
}
