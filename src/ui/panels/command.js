// Right Command Panel: big mode buttons + a context sub-panel (tools and properties) for the current mode.
import { polygonArea } from '../../core/geom.js';
import { h, clear } from '../dom.js';
import { icon } from '../icons.js';
import { fmtNum, fmtCoord, FIELD_ORDER, fieldMeta } from '../format.js';
import { moveVertexEverywhere, conformAll, samePt } from '../edit.js';
import { parseNum } from '../dialogs.js';
import { resolveStageIndex, plotData } from '../draw.js';

export const MODES = [
  { id: 'geometry', label: 'Geometry', icon: 'geometry', key: '1' },
  { id: 'mesh', label: 'Mesh', icon: 'mesh', key: '2' },
  { id: 'material', label: 'Material', icon: 'material', key: '3' },
  { id: 'boundary', label: 'Boundary', icon: 'boundary', key: '4' },
  { id: 'loads', label: 'Loads', icon: 'pointload', key: '5' },
  { id: 'water', label: 'Water', icon: 'water', key: '6' },
  { id: 'settings', label: 'Settings', icon: 'settings', key: '7' },
  { id: 'solve', label: 'Solve', icon: 'solve', key: '8' },
  { id: 'plot', label: 'Plot', icon: 'plot', key: '9' },
];

const FIELD_GROUPS = [
  ['Displacement', ['ux', 'uy', 'umag']],
  ['Stress', ['sxx', 'syy', 'sxy', 'szz', 's1', 's3', 'p', 'q', 'pore']],
  ['Strain', ['eps_xx', 'eps_yy', 'gamma_xy', 'eps_shear', 'eps_vol']],
  ['State', ['plastic']],
];

// -------- small widget builders
const btn = (label, onclick, { primary = false, ic = null, title = '', disabled = false, cls = '' } = {}) =>
  h('button.gf-btn' + (primary ? '.primary' : '') + (cls ? '.' + cls : ''), { type: 'button', title, disabled, onclick }, ic ? h('span.ic', { html: icon(ic, 16) }) : null, label);
const group = (title, ...kids) => h('div.gf-group', title ? h('div.gf-group-title', title) : null, ...kids);
const frow = (label, ctl, unit) => h('div.gf-frow', h('label', label), h('div.gf-fctl', ctl, unit ? h('span.gf-unit', unit) : null));
const note = (t, cls = '') => h('div.gf-note' + (cls ? '.' + cls : ''), t);
/** Solver warnings (results.warnings) as persistent notes. */
const warningNotes = (r) => (r?.warnings?.length ? group('Solver warnings', ...r.warnings.map((w) => note(`⚠ ${w}`, 'warn'))) : null);

function numInput(value, onCommit, { width = null, min = null, max = null } = {}) {
  const el = h('input', { type: 'text', value: value === null || value === undefined ? '' : String(value), inputMode: 'decimal', spellcheck: false });
  if (width) el.style.width = width;
  const commit = () => {
    const v = parseNum(el.value);
    if (!Number.isFinite(v) || (min !== null && v < min) || (max !== null && v > max)) { el.value = String(value ?? ''); el.classList.add('bad'); setTimeout(() => el.classList.remove('bad'), 600); return; }
    if (v === value) return;
    const old = value;
    value = v; // remember it: Enter commits, then the blur fires 'change' again
    if (onCommit(v) === false) { value = old; el.value = String(old ?? ''); } // onCommit may reject the value
  };
  el.addEventListener('change', commit);
  el.addEventListener('keydown', (e) => { if (e.key === 'Enter') { commit(); el.blur(); } e.stopPropagation(); });
  return el;
}

function selectEl(options, value, onChange) {
  const el = h('select', options.map((o) => (typeof o === 'string' ? h('option', { value: o, selected: o === value }, o) : h('option', { value: o.value, selected: o.value === value }, o.label))));
  el.addEventListener('change', () => onChange(el.value));
  return el;
}

function checkEl(label, checked, onChange, title = '') {
  const cb = h('input', { type: 'checkbox', checked: !!checked });
  cb.addEventListener('change', () => onChange(cb.checked));
  return h('label.gf-check', { title }, cb, label);
}

/** Signature of everything the sub-panel depends on (rebuild only when it changes). */
function signature(app) {
  const { state } = app;
  const m = state.model, mode = state.mode;
  const base = [mode, state.tool];
  switch (mode) {
    case 'geometry': base.push(state.selection, m.regions.map((r) => [r.id, r.name, r.materialId, r.points.length]), m.lines.length, sigPoint(state.selection, m)); break;
    case 'mesh': base.push(m.settings.elementType, m.settings.meshSize, state.mesh?.stats, !!state.mesh, state.busy, app.opts.showMesh, state.selection); break;
    case 'material': base.push(m.materials, m.regions.map((r) => r.materialId), app.activeMaterialId()); break;
    case 'boundary': base.push(m.boundaries, state.selection); break;
    case 'loads': base.push(m.loads, state.selection); break;
    case 'water': base.push(m.water, state.selection); break;
    case 'settings': base.push(m.settings, m.title, (m.stages || []).length); break;
    case 'solve': base.push(state.busy, !!state.mesh, state.results ? [state.results.ok, state.results.fos, state.results.message, state.results.warnings] : null, app.validation, m.settings.analysis); break;
    case 'plot': base.push(state.plot, state.results ? [state.results.stages?.length, state.results.fos, state.results.fosHistory?.length, state.results.warnings] : null, !!state.mesh); break;
  }
  return JSON.stringify(base);
}
function sigPoint(sel, m) {
  if (sel?.kind !== 'vertex') return null;
  const o = (sel.owner === 'line' ? m.lines : m.regions).find((x) => x.id === sel.id);
  return o?.points[sel.index] || null;
}

export function createCommandPanel(app, host) {
  const { state } = app;
  const modeGrid = h('div.gf-modegrid');
  const ctx = h('div.gf-ctx');
  host.append(h('div.gf-panel-head', 'Command Panel'), modeGrid, ctx);

  for (const m of MODES) {
    const b = h('button.gf-modebtn', { type: 'button', title: `${m.label} (${m.key})`, dataset: { mode: m.id }, onclick: () => app.setMode(m.id), html: `${icon(m.icon, 26)}<span>${m.label}</span>` });
    modeGrid.appendChild(b);
  }

  let lastSig = '';
  function update() {
    for (const b of modeGrid.children) b.classList.toggle('active', b.dataset.mode === state.mode);
    const sig = signature(app);
    if (sig === lastSig) return;
    if (app.suppressPanel) { lastSig = sig; return; }
    lastSig = sig;
    build();
  }

  function toolRow() {
    const tools = app.toolsFor(state.mode);
    const row = h('div.gf-toolrow');
    for (const t of [...tools, app.panTool]) {
      row.appendChild(h('button.gf-toolbtn' + (state.tool === t.id ? '.active' : ''), { type: 'button', title: t.label, onclick: () => app.setTool(t.id), html: icon(t.icon, 20) + `<span>${t.label.replace(/ (region|line)$/i, '')}</span>` }));
    }
    const tool = app.currentTool();
    return [row, tool?.hint ? note(tool.hint, 'hint') : null];
  }

  function build() {
    clear(ctx);
    const mode = MODES.find((m) => m.id === state.mode);
    ctx.appendChild(h('div.gf-ctx-title', { html: icon(mode.icon, 18) + `<span>${mode.label}</span>` }));
    const body = h('div.gf-ctx-body');
    ctx.appendChild(body);
    const builder = BUILDERS[state.mode];
    if (builder) builder(app, body, { toolRow });
  }

  update();
  return { update, rebuild: () => { lastSig = ''; update(); } };
}

// ------------------------------------------------------------------ per-mode builders

const BUILDERS = {
  geometry(app, body, { toolRow }) {
    const { state } = app, m = state.model, A = app.actions;
    body.append(...toolRow());
    const sel = state.selection;
    const card = h('div.gf-card');
    if (!sel) card.append(note('Nothing selected.'));
    else if (sel.kind === 'region') {
      const r = m.regions.find((x) => x.id === sel.id);
      if (r) {
        const mat = m.materials.find((x) => x.id === r.materialId);
        card.append(h('div.gf-card-title', `Region ${r.id}`), h('table.gf-kv', h('tbody',
          h('tr', h('th', 'Name'), h('td', r.name)), h('tr', h('th', 'Material'), h('td', mat ? mat.name : '-')),
          h('tr', h('th', 'Vertices'), h('td', String(r.points.length))), h('tr', h('th', 'Area'), h('td', `${fmtNum(Math.abs(polygonArea(r.points)), 5)} m²`)))),
          h('div.gf-btnrow', btn('Edit coordinates…', () => A.editRegion(r.id), { ic: 'table' }), btn('Delete', () => A.deleteSelection(), { ic: 'delete' })));
      }
    } else if (sel.kind === 'vertex') {
      const o = (sel.owner === 'line' ? m.lines : m.regions).find((x) => x.id === sel.id);
      const p = o?.points[sel.index];
      if (p) {
        const apply = (nx, ny) => {
          const to = [nx, ny];
          if (samePt(p, to)) return;
          moveVertexEverywhere(m, p, to); conformAll(m); app.commit();
        };
        card.append(h('div.gf-card-title', `Vertex ${sel.index + 1} of ${o.id}`),
          frow('x', numInput(p[0], (v) => apply(v, p[1])), 'm'), frow('y', numInput(p[1], (v) => apply(p[0], v)), 'm'),
          note('Shared vertices of neighbouring regions move together.'),
          h('div.gf-btnrow', btn('Delete vertex', () => A.deleteSelection(), { ic: 'delete' })));
      }
    } else if (sel.kind === 'line') {
      card.append(h('div.gf-card-title', `Line ${sel.id}`), h('div.gf-btnrow', btn('Delete', () => A.deleteSelection(), { ic: 'delete' })));
    } else card.append(note(`Selected: ${sel.kind} ${sel.id ?? ''}`));
    body.append(card);
    body.append(group('Region list', m.regions.length ? h('div.gf-list', m.regions.map((r) => {
      const mat = m.materials.find((x) => x.id === r.materialId);
      return h('div.gf-listitem' + (sel?.kind === 'region' && sel.id === r.id ? '.sel' : ''), { onclick: () => app.select({ kind: 'region', id: r.id }), ondblclick: () => A.editRegion(r.id) },
        h('span.gf-swatch', { style: { background: mat?.color || '#fff' } }), h('span.t', r.name || r.id), h('span.s', mat ? mat.name : 'no material'));
    })) : note('No regions yet. Use the polygon or rectangle tool.')));
    body.append(h('div.gf-btnrow', btn('Zoom extents', () => A.zoomExtents(), { ic: 'extents' }), btn('Clear all geometry', () => A.clearGeometry(), { ic: 'clear' })));
  },

  mesh(app, body, { toolRow }) {
    const { state } = app, m = state.model, s = m.settings, A = app.actions;
    body.append(...toolRow());
    body.append(group('Mesh parameters',
      frow('Element type', selectEl([{ value: 'T6', label: 'T6 quadratic' }, { value: 'T3', label: 'T3 linear (stiff in plasticity)' }], s.elementType, (v) => { s.elementType = v; app.commit(); })),
      frow('Mesh size', numInput(s.meshSize, (v) => { s.meshSize = v; app.commit(); }, { min: 1e-6 }), 'm'),
      checkEl('Show mesh on model', app.opts.showMesh, (v) => { app.opts.showMesh = v; app.canvas.invalidate(); }),
      h('div.gf-btnrow', btn(state.mesh ? 'Regenerate mesh' : 'Generate mesh', () => A.generateMesh(), { primary: true, ic: 'generate', disabled: state.busy })),
    ));
    const st = state.mesh?.stats;
    body.append(group('Statistics', state.mesh ? h('table.gf-kv', h('tbody',
      h('tr', h('th', 'Type'), h('td', state.mesh.type)),
      h('tr', h('th', 'Nodes'), h('td', String(st?.nNodes ?? state.mesh.nodes.length / 2))),
      h('tr', h('th', 'Elements'), h('td', String(st?.nElements ?? state.mesh.elements.length / state.mesh.nen))),
      st?.minAngle !== undefined ? h('tr', h('th', 'Min. angle'), h('td', `${fmtNum(st.minAngle, 3)}°`)) : null,
      st?.maxAspect !== undefined ? h('tr', h('th', 'Max. aspect ratio'), h('td', fmtNum(st.maxAspect, 3))) : null)) : note('No mesh. Press Generate (F9).')));
    if (state.mesh) body.append(h('div.gf-btnrow', btn('Discard mesh', () => { state.mesh = null; state.results = null; state.notify(); }, { ic: 'clear' })));
  },

  material(app, body, { toolRow }) {
    const { state } = app, m = state.model, A = app.actions;
    body.append(...toolRow());
    const active = app.activeMaterialId();
    body.append(group('Materials', m.materials.length ? h('div.gf-list', m.materials.map((mat) =>
      h('div.gf-listitem' + (mat.id === active ? '.sel' : ''), { onclick: () => app.setActiveMaterial(mat.id), ondblclick: () => A.editMaterial(mat.id), title: 'Click: make active · double-click: edit' },
        h('span.gf-swatch', { style: { background: mat.color } }), h('span.t', mat.name), h('span.s', mat.model === 'mohr-coulomb' ? 'MC' : 'LE')))) : note('No materials. Press Add.'),
      h('div.gf-btnrow', btn('Add…', () => A.addMaterial(), { ic: 'plus' }), btn('Edit…', () => active && A.editMaterial(active), { ic: 'edit', disabled: !active }), btn('Delete', () => active && A.deleteMaterial(active), { ic: 'delete', disabled: !active }))));
    const mat = m.materials.find((x) => x.id === active);
    if (mat) {
      const kv = (k, v) => h('tr', h('th', k), h('td', v));
      body.append(group('Active material', h('table.gf-kv', h('tbody',
        kv('Model', mat.model), kv('E', `${fmtNum(mat.E)} kPa`), kv('ν', fmtNum(mat.nu)), kv('γ (unsat/sat)', `${fmtNum(mat.gammaUnsat)} / ${fmtNum(mat.gammaSat)} kN/m³`),
        ...(mat.model === 'mohr-coulomb' ? [kv("c′", `${fmtNum(mat.c)} kPa`), kv("φ′", `${fmtNum(mat.phi)}°`), kv('ψ', `${fmtNum(mat.psi)}°`), kv('tension', `${fmtNum(mat.tensile)} kPa`)] : []),
        kv('K0', mat.K0 === null || mat.K0 === undefined ? 'Jaky' : fmtNum(mat.K0))))));
    }
    const unassigned = m.regions.filter((r) => !m.materials.some((x) => x.id === r.materialId));
    if (unassigned.length) body.append(note(`${unassigned.length} region(s) without material: ${unassigned.map((r) => r.name || r.id).join(', ')}`, 'warn'));
  },

  boundary(app, body, { toolRow }) {
    const { state } = app, m = state.model, A = app.actions;
    body.append(...toolRow());
    body.append(group('Fixities',
      h('div.gf-btnrow', btn('Auto fixity', () => A.autoFixity(), { primary: true, ic: 'auto', title: 'Base fixed in x and y, sides fixed in x' }), btn('Clear all', () => A.clearBoundaries(), { ic: 'clear', disabled: !m.boundaries.length })),
      m.boundaries.length ? h('div.gf-list', m.boundaries.map((b) => {
        const t = b.target;
        const desc = t.kind === 'auto' ? 'Automatic (base xy, sides x)' : t.kind === 'segment' ? `Segment ${fixTxt(b)}` : `Point ${fixTxt(b)}`;
        return h('div.gf-listitem' + (state.selection?.kind === 'boundary' && state.selection.id === b.id ? '.sel' : ''), { onclick: () => app.select({ kind: 'boundary', id: b.id }) },
          h('span.t', `${b.id}`), h('span.s.grow', desc), h('button.gf-iconbtn', { type: 'button', title: 'Delete', onclick: (e) => { e.stopPropagation(); A.deleteBoundary(b.id); }, html: icon('close', 12) }));
      })) : note('No supports defined. Use Auto fixity for a typical soil block.', 'warn')));
  },

  loads(app, body, { toolRow }) {
    const { state } = app, m = state.model, A = app.actions;
    body.append(...toolRow());
    body.append(group('Loads', m.loads.length ? h('div.gf-list', m.loads.map((l) => h('div.gf-listitem' + (state.selection?.kind === 'load' && state.selection.id === l.id ? '.sel' : ''), { onclick: () => app.select({ kind: 'load', id: l.id }), ondblclick: () => A.editLoad(l.id) },
      h('span.t', l.id), h('span.s.grow', l.type === 'point' ? `F = (${fmtNum(l.fx)}, ${fmtNum(l.fy)}) kN/m` : `q = (${fmtNum(l.qx1)}, ${fmtNum(l.qy1)}) → (${fmtNum(l.qx2)}, ${fmtNum(l.qy2)}) kPa`),
      h('button.gf-iconbtn', { type: 'button', title: 'Delete', onclick: (e) => { e.stopPropagation(); A.deleteLoad(l.id); }, html: icon('close', 12) }))))
      : note('No loads. Gravity acts automatically from the unit weights.'),
      m.loads.length ? h('div.gf-btnrow', btn('Clear all', () => A.clearLoads(), { ic: 'clear' })) : null));
    body.append(note('Sign convention: +x right, +y up. Point loads in kN/m, distributed loads in kPa (global axes).'));
  },

  water(app, body, { toolRow }) {
    const { state } = app, m = state.model, w = m.water, A = app.actions;
    body.append(...toolRow());
    body.append(group('Phreatic line',
      checkEl('Water table active', w.enabled, (v) => { w.enabled = v; app.commit(); }),
      frow('γw', numInput(w.gammaW, (v) => { w.gammaW = v; app.commit(); }, { min: 0 }), 'kN/m³'),
      h('div.gf-btnrow', btn('Horizontal level…', () => A.waterLevel(), { ic: 'water' }), btn('Clear', () => A.clearWater(), { ic: 'clear', disabled: !w.phreatic.length })),
      w.phreatic.length ? h('div.gf-list', w.phreatic.map((p, i) => h('div.gf-listitem' + (state.selection?.kind === 'water' && state.selection.index === i ? '.sel' : ''), { onclick: () => app.select({ kind: 'water', index: i }) },
        h('span.t', `P${i + 1}`), h('span.s.grow', `(${fmtCoord(p[0])}, ${fmtCoord(p[1])})`)))) : note('No phreatic line. Draw one or use Horizontal level.')));
  },

  settings(app, body) {
    const { state } = app, m = state.model, s = m.settings, A = app.actions;
    const kv = (k, v) => h('tr', h('th', k), h('td', v));
    body.append(group('Analysis', h('table.gf-kv', h('tbody',
      kv('Title', m.title), kv('Type', s.analysis === 'fos' ? 'FOS (strength reduction)' : 'Static'), kv('Gravity', `${fmtNum(s.gravity)} m/s²`),
      kv('Load steps', String(s.loadSteps)), kv('Tolerance', fmtNum(s.tolerance)), kv('Max. iterations', String(s.maxIterations)),
      ...(s.analysis === 'fos' ? [kv('SRF range', `${fmtNum(s.fos.min)} … ${fmtNum(s.fos.max)}`), kv('SRF tolerance', fmtNum(s.fos.tol)), kv('Tension cut-off', s.fos.tensionCutoff ? 'on' : 'off')] : [])))),
      h('div.gf-btnrow', btn('Analysis settings…', () => A.openSettings(), { primary: true, ic: 'settings' })));
    const stg = m.stages || [];
    body.append(group('Construction stages', stg.length ? h('div.gf-list', stg.map((x, i) => h('div.gf-listitem', h('span.t', `${i + 1}. ${x.name}`), h('span.s.grow', `${x.activeRegions.length} regions, ${x.activeLoads.length} loads`)))) : note('Single default stage (all regions and loads).'),
      h('div.gf-btnrow', btn('Edit stages…', () => A.openStages(), { ic: 'stage' }))));
    body.append(group('Quick switch', h('div.gf-btnrow',
      btn('Static', () => { s.analysis = 'static'; app.commit(); }, { cls: s.analysis === 'static' ? 'toggled' : '' }),
      btn('FOS (SRM)', () => { s.analysis = 'fos'; app.commit(); }, { cls: s.analysis === 'fos' ? 'toggled' : '' }))));
  },

  solve(app, body) {
    const { state } = app, A = app.actions, m = state.model;
    body.append(group('Pre-checks',
      h('div.gf-btnrow', btn('Validate model', () => A.validate(), { ic: 'check' })),
      app.validation ? (app.validation.ok ? note('Model is valid.', 'ok') : h('ul.gf-errlist', app.validation.errors.map((e) => h('li', e)))) : null,
      h('div.gf-dim', state.mesh ? `Mesh ready: ${state.mesh.stats?.nElements ?? state.mesh.elements.length / state.mesh.nen} elements` : 'No mesh yet (generated automatically).')));
    body.append(group('Run',
      h('div.gf-dim', `Analysis: ${m.settings.analysis === 'fos' ? 'factor of safety (strength reduction)' : 'static staged'}`),
      h('div.gf-btnrow', btn(state.busy ? 'Running…' : 'Run analysis', () => A.runSolve(), { primary: true, ic: 'solve', disabled: state.busy, cls: 'big' }), btn('Cancel', () => A.cancelSolve(), { ic: 'stop', disabled: !state.busy }))));
    const r = state.results;
    if (r) {
      body.append(group('Last result',
        r.ok ? note('Analysis completed.', 'ok') : note(r.message || 'Analysis failed.', 'warn'),
        r.analysis === 'fos' && r.fos != null ? h('div.gf-bigfos', `FOS = ${Number(r.fos).toFixed(2)}`) : null,
        h('div.gf-btnrow', btn('Show results', () => app.setMode('plot'), { ic: 'plot' }))));
      if (r.warnings?.length) body.append(warningNotes(r));
    }
  },

  plot(app, body, { toolRow }) {
    const { state } = app, A = app.actions, res = state.results, plot = state.plot;
    body.append(...toolRow());
    const set = (patch) => state.set({ plot: { ...state.plot, ...patch } });
    if (!res || !state.mesh) { body.append(note('No results yet. Run an analysis in Solve mode.', 'warn'), h('div.gf-btnrow', btn('Go to Solve', () => app.setMode('solve'), { ic: 'solve' }))); return; }
    const fieldSel = h('select', FIELD_GROUPS.map(([g, names]) => h('optgroup', { label: g }, names.filter((n) => FIELD_ORDER.includes(n)).map((n) => h('option', { value: n, selected: n === plot.field }, fieldMeta(n, app.services.postFields).label)))));
    fieldSel.addEventListener('change', () => set({ field: fieldSel.value }));
    const stageIdx = resolveStageIndex(res, plot);
    const stageSel = selectEl(res.stages.map((s, i) => ({ value: String(i), label: `${i + 1}. ${s.name || s.id}` })), String(stageIdx), (v) => set({ stageIndex: Number(v) === res.stages.length - 1 ? -1 : Number(v) }));
    const cmaps = Object.keys(app.services.render?.colormaps || { rainbow: 1, viridis: 1, jet: 1 });
    const data = plotData(app);
    body.append(group('Field',
      frow('Quantity', fieldSel), frow('Stage', stageSel), frow('Colour map', selectEl(cmaps, plot.colormap, (v) => set({ colormap: v }))),
      frow('Levels', numInput(plot.nLevels || 12, (v) => set({ nLevels: Math.max(2, Math.min(60, Math.round(v))) }), { min: 2, max: 60, width: '60px' })),
    ));
    // A manual range must stay ordered: a Min above Max (or Max below Min) swaps the two instead of producing an inverted legend.
    const setRange = (which, v) => {
      const cur = state.plot;
      let lo = Number.isFinite(cur.min) ? cur.min : data?.autoMin ?? 0, hi = Number.isFinite(cur.max) ? cur.max : data?.autoMax ?? 1;
      if (which === 'min') lo = v; else hi = v;
      if (lo === hi) { app.toast('Min and Max must differ', 'warn'); return false; }
      if (lo > hi) { [lo, hi] = [hi, lo]; app.toast('Min was above Max: the two values were swapped', 'warn'); }
      set({ min: lo, max: hi });
      return true;
    };
    const auto = !(Number.isFinite(plot.min) || Number.isFinite(plot.max));
    body.append(group('Range',
      checkEl('Automatic range', auto, (v) => { if (v) set({ min: undefined, max: undefined }); else set({ min: data?.autoMin ?? 0, max: data?.autoMax ?? 1 }); }),
      auto ? (data && !data.error ? note(`${fmtNum(data.min, 4)} … ${fmtNum(data.max, 4)} ${data.info.unit}`) : null)
        : h('div', frow('Min', numInput(plot.min ?? data?.autoMin ?? 0, (v) => setRange('min', v))), frow('Max', numInput(plot.max ?? data?.autoMax ?? 1, (v) => setRange('max', v))))));
    body.append(group('Display',
      checkEl('Deformed mesh', plot.deformed, (v) => set({ deformed: v })),
      plot.deformed ? frow('Scale ×', h('div.gf-inline', numInput(plot.deformScale ?? (data?.deformScale ?? 1), (v) => set({ deformScale: v }), { min: 0, width: '70px' }), btn('Auto', () => set({ deformScale: null }), { cls: 'small' }))) : null,
      checkEl('Show mesh', plot.showMesh, (v) => set({ showMesh: v })),
      checkEl('Plastic points', plot.showPlastic, (v) => set({ showPlastic: v })),
      checkEl('Displacement vectors', plot.showVectors, (v) => set({ showVectors: v }))));
    if (res.analysis === 'fos') {
      body.append(group('Factor of safety',
        res.fos != null ? h('div.gf-bigfos', `FOS = ${Number(res.fos).toFixed(2)}`) : note(res.message || 'FOS not determined', 'warn'),
        res.fosHistory?.length ? h('div.gf-scroll', { style: { maxHeight: '180px' } }, h('table.gf-grid.srf', h('thead', h('tr', ['SRF', 'Conv.', 'Max |u|', 'Iter.'].map((x) => h('th', x)))),
          h('tbody', res.fosHistory.map((r) => h('tr', { class: r.converged ? '' : 'bad' }, h('td', Number(r.srf).toFixed(3)), h('td', r.converged ? 'yes' : 'no'), h('td', fmtNum(r.maxDisp, 3)), h('td', String(r.iterations ?? '')))))) ) : null));
    } else if (res.message) body.append(note(res.message, res.ok ? 'ok' : 'warn'));
    if (res.warnings?.length) body.append(warningNotes(res));
    body.append(h('div.gf-btnrow', btn('Export image', () => A.exportPNG(), { ic: 'png' })));
  },
};

function fixTxt(b) {
  const t = b.target;
  const d = [b.fixX && 'x', b.fixY && 'y'].filter(Boolean).join(',');
  return t.kind === 'segment' ? `(${fmtCoord(t.p1[0])},${fmtCoord(t.p1[1])})–(${fmtCoord(t.p2[0])},${fmtCoord(t.p2[1])}) [${d}]` : `(${fmtCoord(t.p?.[0])},${fmtCoord(t.p?.[1])}) [${d}]`;
}
