// Solve flow: validate → mesh (if needed) → services.solve() with a live progress dialog and Cancel.
import { validateModel } from '../core/model.js';
import { h } from './dom.js';
import { openModal, alertDialog } from './dialogs.js';
import { fmtNum } from './format.js';

/** Format a solver progress message {stage, step, iter, residual, fos, text}. */
export function formatProgress(msg) {
  if (!msg) return '';
  if (typeof msg === 'string') return msg;
  const parts = [];
  if (msg.stage !== undefined && msg.stage !== null) parts.push(`stage ${msg.stage}`);
  if (msg.step !== undefined && msg.step !== null) parts.push(`step ${msg.step}`);
  if (msg.iter !== undefined && msg.iter !== null) parts.push(`it ${msg.iter}`);
  if (Number.isFinite(msg.residual)) parts.push(`res ${msg.residual.toExponential(2)}`);
  if (Number.isFinite(msg.fos)) parts.push(`SRF ${fmtNum(msg.fos, 4)}`);
  const head = parts.join(' · ');
  return msg.text ? (head ? `${head} — ${msg.text}` : msg.text) : head;
}

/**
 * Run the analysis. Returns a promise resolving to the results (or null if aborted before start).
 * Progress is received through the `onProgress` option passed to services.solve(); if the integration instead logs
 * through state.logMsg(), those entries are displayed.
 */
export async function runSolve(app) {
  const { state, services } = app;
  if (state.busy) return null;
  const v = validateModel(state.model);
  app.validation = v;
  if (!v.ok) {
    app.setMode('solve');
    state.notify();
    await alertDialog('Model is not ready to solve', h('div', h('p', 'Please fix the following problems:'), h('ul.gf-errlist', v.errors.map((e) => h('li', e)))), { kind: 'warning' });
    return null;
  }
  const lines = h('div.gf-progress-log');
  const bar = h('div.gf-progressbar', h('div.fill'));
  const status = h('div.gf-progress-status', 'Starting…');
  const t0 = performance.now();
  const timer = setInterval(() => { elapsed.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} s`; }, 200);
  const elapsed = h('span.gf-progress-time', '0.0 s');
  let gotCallback = false;
  let cancelled = false;
  const log = (text, cls = '') => {
    const atBottom = lines.scrollTop + lines.clientHeight >= lines.scrollHeight - 20;
    lines.appendChild(h('div' + (cls ? '.' + cls : ''), text));
    while (lines.childElementCount > 400) lines.firstChild.remove();
    if (atBottom) lines.scrollTop = lines.scrollHeight;
  };
  let logSeen = state.log.length;
  const unsub = state.subscribe(() => {
    while (logSeen < state.log.length) {
      const e = state.log[logSeen++];
      if (!gotCallback) { log(e.text, e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : ''); status.textContent = e.text; }
    }
  });

  const dlg = openModal({
    title: 'Solving…', width: 560, closeValue: 'cancel',
    body: h('div.gf-progress', status, bar, h('div.gf-progress-meta', elapsed), lines),
    buttons: [{ label: 'Cancel', value: 'cancel', onClick: () => { cancelled = true; status.textContent = 'Cancelling…'; try { services.cancelSolve?.(); } catch { /* ignore */ } return false; } }],
  });
  // closing via Esc / X also cancels
  dlg.promise.then((r) => { if (r === 'cancel') { cancelled = true; try { services.cancelSolve?.(); } catch { /* ignore */ } } });

  state.set({ busy: true });
  let results = null, error = null;
  try {
    if (!state.mesh) {
      status.textContent = 'Generating mesh…'; log('Generating mesh…');
      await new Promise((r) => setTimeout(r, 20));
      await app.actions.generateMesh({ silent: true });
      if (!state.mesh) throw new Error('Mesh generation failed');
      log(`Mesh: ${state.mesh.stats?.nNodes ?? state.mesh.nodes.length / 2} nodes, ${state.mesh.stats?.nElements ?? state.mesh.elements.length / state.mesh.nen} elements`);
    }
    status.textContent = 'Solving…';
    const onProgress = (msg) => {
      gotCallback = true;
      const text = formatProgress(msg);
      if (text) { log(text); status.textContent = text; }
      if (msg && typeof msg === 'object' && Number.isFinite(msg.fos) && state.model.settings.fos) {
        const { min, max } = state.model.settings.fos;
        bar.firstChild.style.width = `${Math.max(2, Math.min(100, ((msg.fos - min) / (max - min)) * 100))}%`;
      }
    };
    results = await services.solve({ onProgress, shouldCancel: () => cancelled });
    if (results && !state.results) state.results = results;
    if (!results) results = state.results;
  } catch (e) {
    error = e;
  } finally {
    clearInterval(timer);
    unsub();
    state.set({ busy: false });
  }
  dlg.close('done');
  if (error) {
    app.toast(`Solve failed: ${error.message || error}`, 'error');
    state.logMsg(`Solve failed: ${error.message || error}`, 'error');
    await alertDialog('Solve failed', String(error.message || error), { kind: 'error' });
    return null;
  }
  if (cancelled) { app.toast('Analysis cancelled', 'warn', { quiet: true }); return results; } // services.solve already logged it
  if (results) {
    if (state.results !== results) state.set({ results });
    if (results.ok === false) {
      app.toast(`Analysis did not converge: ${results.message || ''}`, 'warn');
    } else app.toast(results.analysis === 'fos' && results.fos != null ? `Done. FOS = ${Number(results.fos).toFixed(2)}` : 'Analysis complete', 'info');
    if (results.stages?.length) {
      app.setMode('plot');
      if (results.analysis === 'fos' && state.plot.field === 'umag') { /* keep default */ }
    }
  }
  return results;
}
