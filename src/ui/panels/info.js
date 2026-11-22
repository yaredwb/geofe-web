// Left Info panel: live model / mesh / materials / BC / loads / water / stages / results summary.
import { h } from '../dom.js';
import { esc, fmtNum, fmtCoord } from '../format.js';
import { polygonArea } from '../../core/geom.js';

const umaxCache = new WeakMap();
function maxDisplacement(results) {
  if (!results?.stages?.length) return null;
  if (umaxCache.has(results)) return umaxCache.get(results);
  let m = 0;
  for (const st of results.stages) {
    const d = st.displacement;
    if (!d) continue;
    for (let i = 0; i < d.length; i += 2) { const u = Math.hypot(d[i], d[i + 1]); if (u > m) m = u; }
  }
  umaxCache.set(results, m);
  return m;
}

const row = (k, v) => `<tr><th>${esc(k)}</th><td>${v}</td></tr>`;
const sw = (c) => `<span class="gf-swatch" style="background:${esc(c || '#ddd')}"></span>`;

function section(app, id, title, body, count = null) {
  const open = app.infoOpen[id] !== false;
  return `<details class="gf-sec" data-sec="${id}" ${open ? 'open' : ''}><summary>${esc(title)}${count !== null ? `<span class="n">${count}</span>` : ''}</summary><div class="gf-sec-body">${body}</div></details>`;
}

/** Build the panel HTML for the current state. */
export function infoHTML(app) {
  const { model, mesh, results } = app.state;
  const s = model.settings;
  const sel = app.state.selection;
  const out = [];

  out.push(section(app, 'model', 'Model', `<table class="gf-kv">
    ${row('Title', esc(model.title))}
    ${row('Analysis', s.analysis === 'fos' ? 'Factor of safety (strength reduction)' : 'Static, staged')}
    ${row('Formulation', s.planeStrain ? 'Plane strain' : 'Axisymmetric')}
    ${row('Units', `${esc(model.units?.length || 'm')}, ${esc(model.units?.force || 'kN')}, ${esc(model.units?.stress || 'kPa')}`)}
    ${row('Gravity', `${fmtNum(s.gravity)} m/s²`)}
    ${row('Elements', s.elementType === 'T6' ? 'T6 (quadratic)' : 'T3 (linear)')}
    ${row('Mesh size', `${fmtNum(s.meshSize)} m`)}
    ${row('Load steps', `${s.loadSteps}`)}
  </table>`));

  if (mesh) {
    const st = mesh.stats || {};
    out.push(section(app, 'mesh', 'Mesh', `<table class="gf-kv">
      ${row('Type', esc(mesh.type))}
      ${row('Nodes', String(st.nNodes ?? mesh.nodes.length / 2))}
      ${row('Elements', String(st.nElements ?? mesh.elements.length / mesh.nen))}
      ${st.minAngle !== undefined ? row('Min. angle', `${fmtNum(st.minAngle, 3)}°`) : ''}
      ${st.maxAspect !== undefined ? row('Max. aspect', fmtNum(st.maxAspect, 3)) : ''}
    </table>`));
  } else out.push(section(app, 'mesh', 'Mesh', '<div class="gf-dim">Not generated (Mesh → Generate)</div>'));

  const mats = model.materials.map((m) => `<tr class="${app.activeMaterialId() === m.id ? 'act' : ''}" data-act="material" data-id="${esc(m.id)}"><td>${sw(m.color)}</td><td>${esc(m.name)}</td><td>${m.model === 'mohr-coulomb' ? `c ${fmtNum(m.c)} φ ${fmtNum(m.phi)}°` : 'elastic'}</td><td>${fmtNum(m.gammaUnsat)}</td></tr>`).join('');
  out.push(section(app, 'mats', 'Materials', model.materials.length ? `<table class="gf-grid"><thead><tr><th></th><th>Name</th><th>Strength</th><th>γ</th></tr></thead><tbody>${mats}</tbody></table>` : '<div class="gf-dim">None defined</div>', model.materials.length));

  const regs = model.regions.map((r) => {
    const m = model.materials.find((x) => x.id === r.materialId);
    const on = sel?.kind === 'region' && sel.id === r.id;
    return `<tr class="${on ? 'act' : ''}" data-act="region" data-id="${esc(r.id)}"><td>${sw(m?.color)}</td><td>${esc(r.name || r.id)}</td><td>${m ? esc(m.name) : '<span class="gf-bad">no material</span>'}</td><td>${fmtNum(Math.abs(polygonArea(r.points)), 4)} m²</td></tr>`;
  }).join('');
  out.push(section(app, 'regions', 'Regions', model.regions.length ? `<table class="gf-grid"><tbody>${regs}</tbody></table>` : '<div class="gf-dim">None (draw a region)</div>', model.regions.length));

  const bcs = model.boundaries.map((b) => {
    const t = b.target || {};
    let d;
    if (t.kind === 'auto') d = 'Automatic: base fixed (x,y), sides fixed (x)';
    else if (t.kind === 'segment') d = `Segment (${fmtCoord(t.p1[0])},${fmtCoord(t.p1[1])})–(${fmtCoord(t.p2[0])},${fmtCoord(t.p2[1])}): ${[b.fixX && 'x', b.fixY && 'y'].filter(Boolean).join(',')}`;
    else d = `Point (${fmtCoord(t.p?.[0])},${fmtCoord(t.p?.[1])}): ${[b.fixX && 'x', b.fixY && 'y'].filter(Boolean).join(',')}`;
    return `<tr class="${sel?.kind === 'boundary' && sel.id === b.id ? 'act' : ''}" data-act="boundary" data-id="${esc(b.id)}"><td>${esc(b.id)}</td><td>${esc(d)}</td></tr>`;
  }).join('');
  out.push(section(app, 'bcs', 'Boundary conditions', model.boundaries.length ? `<table class="gf-grid"><tbody>${bcs}</tbody></table>` : '<div class="gf-dim gf-bad">None (Boundary → Auto fixity)</div>', model.boundaries.length));

  const loads = model.loads.map((l) => {
    const d = l.type === 'point' ? `Point (${fmtCoord(l.p[0])},${fmtCoord(l.p[1])}) F=(${fmtNum(l.fx)}, ${fmtNum(l.fy)}) kN/m`
      : `Dist. q1=(${fmtNum(l.qx1)}, ${fmtNum(l.qy1)}) q2=(${fmtNum(l.qx2)}, ${fmtNum(l.qy2)}) kPa`;
    return `<tr class="${sel?.kind === 'load' && sel.id === l.id ? 'act' : ''}" data-act="load" data-id="${esc(l.id)}"><td>${esc(l.id)}</td><td>${esc(d)}</td></tr>`;
  }).join('');
  out.push(section(app, 'loads', 'Loads', model.loads.length ? `<table class="gf-grid"><tbody>${loads}</tbody></table>` : '<div class="gf-dim">None</div>', model.loads.length));

  const w = model.water;
  out.push(section(app, 'water', 'Water', `<table class="gf-kv">
    ${row('Phreatic line', w.enabled ? 'On' : 'Off')}
    ${row('γw', `${fmtNum(w.gammaW)} kN/m³`)}
    ${row('Points', String(w.phreatic?.length || 0) + (w.phreatic?.length ? ` (y ${fmtCoord(Math.min(...w.phreatic.map((p) => p[1])))}…${fmtCoord(Math.max(...w.phreatic.map((p) => p[1])))})` : ''))}
  </table>`));

  const stg = model.stages || [];
  out.push(section(app, 'stages', 'Stages', stg.length ? `<table class="gf-grid"><tbody>${stg.map((x, i) => `<tr><td>${i + 1}</td><td>${esc(x.name)}</td><td>${esc(x.initial)}${x.resetDisplacements ? ', reset u' : ''}</td></tr>`).join('')}</tbody></table>` : '<div class="gf-dim">Single default stage</div>', stg.length || null));

  // results
  if (results) {
    const umax = maxDisplacement(results);
    const fosTxt = results.analysis === 'fos' ? (results.fos != null ? `<span class="gf-fos ${results.fos < 1 ? 'bad' : results.fos < 1.3 ? 'warn' : 'good'}">${Number(results.fos).toFixed(3)}</span>` : '-') : null;
    out.push(section(app, 'results', 'Results', `<table class="gf-kv">
      ${row('Status', results.ok ? '<span class="gf-good">Converged</span>' : `<span class="gf-bad">${esc(results.message || 'Failed')}</span>`)}
      ${fosTxt !== null ? row('FOS', fosTxt) : ''}
      ${umax !== null ? row('Max |u|', `${fmtNum(umax, 4)} m`) : ''}
      ${row('Stages', String(results.stages?.length || 0))}
      ${results.fosHistory?.length ? row('SRF trials', String(results.fosHistory.length)) : ''}
    </table>${(results.warnings || []).map((w) => `<div class="gf-note warn">⚠ ${esc(w)}</div>`).join('')}`));
  } else out.push(section(app, 'results', 'Results', '<div class="gf-dim">No results (Solve → Run)</div>'));
  return out.join('');
}

export function createInfoPanel(app, host) {
  const body = h('div.gf-info-body');
  host.append(h('div.gf-panel-head', 'Info'), body);
  let last = '';
  function update() {
    const html = infoHTML(app);
    if (html === last) return;
    last = html;
    const sc = body.scrollTop;
    body.innerHTML = html;
    body.scrollTop = sc;
  }
  body.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.dataset && d.dataset.sec) app.infoOpen[d.dataset.sec] = d.open;
  }, true);
  body.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-act]');
    if (!tr) return;
    const { act, id } = tr.dataset;
    if (act === 'material') app.setActiveMaterial(id);
    else if (act === 'region') app.select({ kind: 'region', id });
    else if (act === 'boundary') app.select({ kind: 'boundary', id });
    else if (act === 'load') app.select({ kind: 'load', id });
  });
  body.addEventListener('dblclick', (e) => {
    const tr = e.target.closest('tr[data-act]');
    if (!tr) return;
    if (tr.dataset.act === 'material') app.actions.editMaterial(tr.dataset.id);
    if (tr.dataset.act === 'region') app.actions.editRegion(tr.dataset.id);
    if (tr.dataset.act === 'load') app.actions.editLoad(tr.dataset.id);
  });
  update();
  return { update };
}
