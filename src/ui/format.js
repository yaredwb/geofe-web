// DOM-free formatting helpers: numbers, coordinates, field labels, console value printing.

/** Compact general number format with `digits` significant digits (trailing zeros stripped). */
export function fmtNum(v, digits = 4) {
  if (v === null || v === undefined) return '-';
  if (typeof v !== 'number') return String(v);
  if (Number.isNaN(v)) return 'NaN';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  if (v === 0) return '0';
  const a = Math.abs(v);
  if (a < 1e-3 || a >= 1e7) return v.toExponential(Math.max(1, digits - 1)).replace(/\.?0+e/, 'e').replace('e+', 'e');
  let s = v.toPrecision(digits);
  if (s.includes('e')) s = String(Number(s));
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  return s;
}

/** Fixed-decimals coordinate format (trailing zeros stripped). */
export function fmtCoord(v, decimals = 3) {
  if (!Number.isFinite(v)) return '-';
  let s = v.toFixed(decimals);
  if (s.includes('.')) s = s.replace(/\.?0+$/, '');
  if (s === '-0') s = '0';
  return s;
}

/** Number of decimals appropriate for a grid step, e.g. 0.2 -> 1, 0.05 -> 2, 5 -> 0. */
export function decimalsForStep(step) {
  if (!(step > 0)) return 2;
  const d = Math.ceil(-Math.log10(step) - 1e-9);
  return Math.max(0, Math.min(8, d));
}

/** Display metadata for result fields: nice labels and units (contract list in ARCHITECTURE.md). */
export const FIELD_LABELS = {
  ux: { label: 'Horizontal displacement ux', unit: 'm' },
  uy: { label: 'Vertical displacement uy', unit: 'm' },
  umag: { label: 'Total displacement |u|', unit: 'm' },
  sxx: { label: 'Effective stress σxx', unit: 'kPa' },
  syy: { label: 'Effective stress σyy', unit: 'kPa' },
  sxy: { label: 'Shear stress σxy', unit: 'kPa' },
  szz: { label: 'Effective stress σzz', unit: 'kPa' },
  s1: { label: 'Major principal stress σ1', unit: 'kPa' },
  s3: { label: 'Minor principal stress σ3', unit: 'kPa' },
  p: { label: "Mean effective stress p′", unit: 'kPa' },
  q: { label: 'Deviatoric stress q', unit: 'kPa' },
  pore: { label: 'Pore pressure u', unit: 'kPa' },
  eps_xx: { label: 'Normal strain εxx', unit: '-' },
  eps_yy: { label: 'Normal strain εyy', unit: '-' },
  gamma_xy: { label: 'Shear strain γxy', unit: '-' },
  eps_shear: { label: 'Max shear strain γmax', unit: '-' },
  eps_vol: { label: 'Volumetric strain εv', unit: '-' },
  plastic: { label: 'Plastic state', unit: '' },
};
export const FIELD_ORDER = Object.keys(FIELD_LABELS);

/** {label, unit} for a field name; prefers own table, falls back to postFields.fieldInfo. */
export function fieldMeta(name, postFields) {
  if (FIELD_LABELS[name]) return FIELD_LABELS[name];
  try {
    const info = postFields?.fieldInfo?.(name);
    if (info) return { label: info.label || name, unit: info.unit || '' };
  } catch { /* ignore */ }
  return { label: name, unit: '' };
}

/** Pretty-print any JS value for the command-line console. Never throws. */
export function formatValue(v, depth = 0, seen = new WeakSet()) {
  try {
    if (v === undefined) return 'undefined';
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return depth === 0 ? v : JSON.stringify(v);
    if (t === 'number') return Number.isInteger(v) ? String(v) : fmtNum(v, 8);
    if (t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'function') return `[Function${v.name ? ' ' + v.name : ''}]`;
    if (t === 'symbol') return v.toString();
    if (v instanceof Error) return `${v.name}: ${v.message}`;
    if (ArrayBuffer.isView(v) && !(v instanceof DataView)) {
      const n = v.length;
      const head = Array.from(v.subarray(0, 6), (x) => fmtNum(Number(x), 5)).join(', ');
      return `${v.constructor.name}(${n}) [${head}${n > 6 ? ', …' : ''}]`;
    }
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      if (depth >= 3) return `Array(${v.length})`;
      const items = v.slice(0, 20).map((x) => formatValue(x, depth + 1, seen));
      const more = v.length > 20 ? `, … ${v.length - 20} more` : '';
      const body = items.join(', ');
      if (body.length > 90 && depth === 0) return `[\n  ${items.join(',\n  ')}${more}\n]`;
      return `[${body}${more}]`;
    }
    if (t === 'object') {
      if (depth >= 3) return '{…}';
      const keys = Object.keys(v);
      if (!keys.length) return '{}';
      const shown = keys.slice(0, 30);
      const items = shown.map((k) => `${k}: ${formatValue(v[k], depth + 1, seen)}`);
      const more = keys.length > 30 ? `, … ${keys.length - 30} more` : '';
      const body = items.join(', ');
      if (depth === 0 && body.length > 80) return `{\n  ${items.join(',\n  ')}${more}\n}`;
      return `{ ${body}${more} }`;
    }
    return String(v);
  } catch (e) {
    return `[unprintable: ${e.message}]`;
  }
}

/** Escape text for innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
