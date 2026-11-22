// Line-plot dialog: field value vs distance along a user-drawn section.
import { h, downloadBlob } from './dom.js';
import { openModal } from './dialogs.js';
import { chartPath, niceStep, ticks } from './viewmath.js';
import { fmtNum, fmtCoord, FIELD_ORDER, fieldMeta } from './format.js';
import { resolveStageIndex } from './draw.js';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = (name, attrs = {}, text = null) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (text !== null) e.textContent = text;
  return e;
};

/**
 * Build the SVG chart for samples [{s,v}]. Returns {svg, hover(i)}.
 * Pure DOM; no app dependencies.
 */
export function buildChart(samples, { width = 540, height = 300, xLabel = 'Distance [m]', yLabel = '' } = {}) {
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'gf-chart' });
  svg.appendChild(svgEl('rect', { x: 0, y: 0, width, height, fill: '#fff' }));
  const c = chartPath(samples, width, height, { l: 64, r: 14, t: 14, b: 38 });
  const { pad } = c;
  // grid + ticks
  const xs = ticks(c.xs[0], c.xs[1], niceStep((c.xs[1] - c.xs[0]) / 6));
  const ys = ticks(c.ys[0], c.ys[1], niceStep((c.ys[1] - c.ys[0]) / 5));
  for (const x of xs) {
    svg.appendChild(svgEl('line', { x1: c.px(x), x2: c.px(x), y1: pad.t, y2: height - pad.b, stroke: '#e3e6ec' }));
    svg.appendChild(svgEl('text', { x: c.px(x), y: height - pad.b + 14, 'text-anchor': 'middle', 'font-size': 11, fill: '#444' }, fmtNum(x, 4)));
  }
  for (const y of ys) {
    svg.appendChild(svgEl('line', { x1: pad.l, x2: width - pad.r, y1: c.py(y), y2: c.py(y), stroke: '#e3e6ec' }));
    svg.appendChild(svgEl('text', { x: pad.l - 6, y: c.py(y) + 4, 'text-anchor': 'end', 'font-size': 11, fill: '#444' }, fmtNum(y, 4)));
  }
  svg.appendChild(svgEl('rect', { x: pad.l, y: pad.t, width: width - pad.l - pad.r, height: height - pad.t - pad.b, fill: 'none', stroke: '#9aa3b2' }));
  svg.appendChild(svgEl('path', { d: c.d, fill: 'none', stroke: '#1565c0', 'stroke-width': 1.8, 'stroke-linejoin': 'round' }));
  svg.appendChild(svgEl('text', { x: (pad.l + width - pad.r) / 2, y: height - 6, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#333' }, xLabel));
  const yl = svgEl('text', { x: 14, y: (pad.t + height - pad.b) / 2, 'text-anchor': 'middle', 'font-size': 11.5, fill: '#333', transform: `rotate(-90 14 ${(pad.t + height - pad.b) / 2})` }, yLabel);
  svg.appendChild(yl);
  const cursor = svgEl('line', { y1: pad.t, y2: height - pad.b, stroke: '#e53935', 'stroke-width': 1, visibility: 'hidden' });
  const dot = svgEl('circle', { r: 3.5, fill: '#e53935', visibility: 'hidden' });
  svg.append(cursor, dot);
  function hover(i) {
    const q = samples[i];
    if (!q || !Number.isFinite(q.v)) { cursor.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); return null; }
    cursor.setAttribute('x1', c.px(q.s)); cursor.setAttribute('x2', c.px(q.s)); cursor.setAttribute('visibility', 'visible');
    dot.setAttribute('cx', c.px(q.s)); dot.setAttribute('cy', c.py(q.v)); dot.setAttribute('visibility', 'visible');
    return q;
  }
  svg.addEventListener('mousemove', (e) => {
    const b = svg.getBoundingClientRect();
    const x = ((e.clientX - b.left) / b.width) * width;
    const s = c.xs[0] + ((x - pad.l) / (width - pad.l - pad.r)) * (c.xs[1] - c.xs[0]);
    let best = 0, bd = Infinity;
    samples.forEach((q, i) => { const d = Math.abs(q.s - s); if (d < bd) { bd = d; best = i; } });
    svg.dispatchEvent(new CustomEvent('sample', { detail: hover(best) }));
  });
  svg.addEventListener('mouseleave', () => { hover(-1); svg.dispatchEvent(new CustomEvent('sample', { detail: null })); });
  return { svg, hover };
}

export function samplesToCSV(samples, fieldName) {
  return ['s,x,y,' + fieldName, ...samples.map((q) => [q.s, q.x, q.y, q.v].map((v) => (Number.isFinite(v) ? v : '')).join(','))].join('\n');
}

/** Open the (non-modal) line plot dialog for section p1 → p2. */
export function openLinePlotDialog(app, p1, p2) {
  const { state, services } = app;
  const { mesh, results, plot } = state;
  if (!mesh || !results) { app.toast('No results to plot', 'warn'); return null; }
  const stage = results.stages[resolveStageIndex(results, plot)];
  let field = plot.field;
  let nSamples = 120;
  const chartHost = h('div.gf-chart-host');
  const readout = h('div.gf-chart-readout', 'Move the cursor over the chart');
  const sel = h('select', FIELD_ORDER.map((n) => h('option', { value: n, selected: n === field }, fieldMeta(n, services.postFields).label)));
  const nInp = h('input', { type: 'number', value: String(nSamples), min: 10, max: 2000, step: 10, style: { width: '64px' } });
  let samples = [];
  const length = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);

  function render() {
    const meta = fieldMeta(field, services.postFields);
    try {
      const values = services.postFields.nodalField(mesh, stage, field);
      samples = services.postFields.sampleAlongLine(mesh, values, p1, p2, nSamples, stage.activeElements);
    } catch (e) { chartHost.textContent = `Cannot sample field: ${e.message}`; return; }
    const finite = samples.filter((q) => Number.isFinite(q.v));
    chartHost.textContent = '';
    if (!finite.length) { chartHost.appendChild(h('div.gf-note.warn', 'The section does not intersect the (active) mesh.')); return; }
    const { svg } = buildChart(samples, { yLabel: `${meta.label}${meta.unit && meta.unit !== '-' ? ' [' + meta.unit + ']' : ''}`, xLabel: 'Distance along section [m]' });
    svg.addEventListener('sample', (e) => {
      const q = e.detail;
      readout.textContent = q ? `s = ${fmtNum(q.s, 4)} m   (x, y) = (${fmtCoord(q.x)}, ${fmtCoord(q.y)})   value = ${fmtNum(q.v, 5)} ${meta.unit && meta.unit !== '-' ? meta.unit : ''}` : 'Move the cursor over the chart';
    });
    chartHost.appendChild(svg);
    const vals = finite.map((q) => q.v);
    readout.dataset.stat = `min ${fmtNum(Math.min(...vals), 4)}, max ${fmtNum(Math.max(...vals), 4)}`;
  }
  sel.addEventListener('change', () => { field = sel.value; render(); });
  nInp.addEventListener('change', () => { nSamples = Math.max(10, Math.min(2000, Math.round(Number(nInp.value) || 120))); render(); });

  const body = h('div.gf-lineplot',
    h('div.gf-note', `Section (${fmtCoord(p1[0])}, ${fmtCoord(p1[1])}) → (${fmtCoord(p2[0])}, ${fmtCoord(p2[1])}), length ${fmtNum(length, 5)} m · stage: ${stage?.name || ''}`),
    h('div.gf-inline', h('label', 'Quantity'), sel, h('label', 'Samples'), nInp),
    chartHost, readout);
  render();
  return openModal({
    title: 'Line plot', body, width: 580, modal: false,
    buttons: [
      { label: 'Download CSV', onClick: () => { downloadBlob(`section_${field}.csv`, samplesToCSV(samples, field), 'text/csv'); return false; } },
      { label: 'Copy CSV', onClick: async () => { try { await navigator.clipboard.writeText(samplesToCSV(samples, field)); app.toast('CSV copied', 'info'); } catch { app.toast('Clipboard not available', 'warn'); } return false; } },
      { label: 'Close', primary: true },
    ],
  });
}
