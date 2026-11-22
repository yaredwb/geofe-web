// Helpers shared by the scripting API and the file loader: model normalisation and path access.
import { createEmptyModel, defaultSettings, defaultMaterial, validateModel } from '../core/model.js';

/**
 * Turn an arbitrary parsed JSON object into a complete model: missing top-level sections and settings get defaults,
 * materials get default parameters. Throws a descriptive Error when the object cannot be a model at all.
 * (Deeper problems — e.g. a region without a material — are reported by validateModel, not here.)
 */
export function normalizeModel(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('File does not contain a model object');
  if (!Array.isArray(raw.regions)) throw new Error('Not a GeoFE model: "regions" array is missing');
  const base = createEmptyModel();
  const m = { ...base, ...raw };
  m.units = { ...base.units, ...(raw.units || {}) };
  const s = defaultSettings();
  m.settings = { ...s, ...(raw.settings || {}), fos: { ...s.fos, ...(raw.settings?.fos || {}) } };
  m.materials = (raw.materials || []).map((x) => defaultMaterial(x));
  for (const k of ['lines', 'boundaries', 'loads', 'stages']) m[k] = Array.isArray(raw[k]) ? raw[k] : [];
  m.water = { ...base.water, ...(raw.water || {}) };
  return m;
}

/** Throw an Error listing validation problems (used before meshing / solving). */
export function assertValid(model) {
  const v = validateModel(model);
  if (!v.ok) throw new Error('Model is not valid:\n - ' + v.errors.join('\n - '));
}

/**
 * Split a dotted path ("settings.fos.min", "materials.M1.E", "materials[0].E", "model.title") into steps.
 * Array steps accept an index or an element id.
 */
function steps(path) {
  return String(path).replace(/^model\./, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
}

function child(obj, key) {
  if (Array.isArray(obj)) {
    if (/^\d+$/.test(key)) return { holder: obj, key: Number(key) };
    const i = obj.findIndex((o) => o && o.id === key);
    if (i < 0) throw new Error(`No element with id "${key}"`);
    return { holder: obj, key: i };
  }
  if (obj === null || typeof obj !== 'object') throw new Error(`Cannot descend into "${key}"`);
  return { holder: obj, key };
}

/** Read a value by path. */
export function getPath(model, path) {
  let o = model;
  for (const k of steps(path)) { const c = child(o, k); o = c.holder[c.key]; }
  return o;
}

/** Write a value by path; every parent along the way must already exist. Returns the value. */
export function setPath(model, path, value) {
  const st = steps(path);
  if (!st.length) throw new Error('Empty path');
  let o = model;
  for (const k of st.slice(0, -1)) {
    const c = child(o, k);
    o = c.holder[c.key];
    if (o === undefined || o === null) throw new Error(`Path "${path}" does not exist`);
  }
  const c = child(o, st[st.length - 1]);
  c.holder[c.key] = value;
  return value;
}
