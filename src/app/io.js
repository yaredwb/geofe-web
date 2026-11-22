// File I/O: save / load model JSON, export the canvas as PNG, new model, bundled examples.
import { createEmptyModel } from '../core/model.js';
import { getExample } from './examples.js';
import { normalizeModel } from './model-utils.js';

/** Trigger a browser download. */
export function download(name, data, type) {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const slug = (s) => String(s || 'model').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'model';

/** Replace the active model (results, mesh and selection are dropped). */
export function installModel(state, model) {
  state.set({ model, mesh: null, results: null, selection: null });
}

export function createIO(state) {
  return {
    /** Download the model as pretty-printed JSON. */
    save() {
      const name = `${slug(state.model.title)}.json`;
      download(name, JSON.stringify(state.model, null, 2), 'application/json');
      state.logMsg(`Saved ${name}`);
      return name;
    },
    /** Load a model from a File (or any object with .text()). */
    async load(file) {
      let raw;
      try { raw = JSON.parse(await file.text()); } catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
      installModel(state, normalizeModel(raw));
      state.logMsg(`Loaded ${file.name || 'model'}`);
    },
    /** Download the given canvas as PNG. */
    async exportPNG(canvas) {
      if (!canvas) throw new Error('No canvas to export');
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      if (!blob) throw new Error('Canvas export failed');
      const name = `${slug(state.model.title)}.png`;
      download(name, blob);
      return name;
    },
    newModel() { installModel(state, createEmptyModel()); },
    loadExample(name) { installModel(state, getExample(name)); state.logMsg(`Loaded example "${name}"`); },
  };
}
