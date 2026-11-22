// End-to-end smoke test (Playwright + Chromium). Starts the Vite dev server, drives the real app and writes
// screenshots to tests/e2e/screens/. Run: `npm run e2e`.
//
// Playwright is resolved from (in order): $PLAYWRIGHT_PATH, the project's node_modules, /tmp/pw, and a few sibling
// projects. Install one with e.g. `cd /tmp/pw && npm i playwright && npx playwright install chromium`.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = path.join(root, 'tests/e2e/screens');
const PORT = Number(process.env.E2E_PORT || 5192);
const URL_ = `http://localhost:${PORT}/`;
fs.mkdirSync(SHOTS, { recursive: true });

async function loadPlaywright() {
  const cands = [process.env.PLAYWRIGHT_PATH, path.join(root, 'node_modules/playwright'), '/tmp/pw/node_modules/playwright',
    path.resolve(root, '../thm_gpt56/node_modules/playwright'), path.resolve(root, '../thm_opus55/node_modules/playwright')].filter(Boolean);
  const errs = [];
  for (const c of cands) {
    if (!fs.existsSync(c)) continue;
    try {
      const pw = await import(pathToFileURL(path.join(c, 'index.mjs')).href);
      const exe = pw.chromium.executablePath();
      if (fs.existsSync(exe)) return pw;
      errs.push(`${c}: browser not installed (${exe})`);
    } catch (e) { errs.push(`${c}: ${e.message}`); }
  }
  throw new Error('Playwright with a matching Chromium not found.\n' + errs.join('\n'));
}

async function startServer() {
  const vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', ...(process.env.E2E_VITE_CONFIG ? ['--config', process.env.E2E_VITE_CONFIG] : [])],
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  vite.stdout.on('data', (d) => { log += d; });
  vite.stderr.on('data', (d) => { log += d; });
  let exited = false;
  vite.on('exit', () => { exited = true; });
  for (let i = 0; i < 100; i++) {
    if (exited) throw new Error('vite exited early:\n' + log);
    try { const r = await fetch(URL_); if (r.ok) return vite; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  vite.kill();
  throw new Error('vite did not start:\n' + log);
}

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, ok: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
}

const vite = await startServer();
let browser;
let exitCode = 0;
try {
  const { chromium } = await loadPlaywright();
  browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('dialog', (d) => d.dismiss());

  const shot = (name) => page.screenshot({ path: path.join(SHOTS, name) });
  const panel = page.locator('aside.gf-panel');
  const mode = (name) => panel.getByRole('button', { name, exact: true }).first().click();
  const S = (fn, arg) => page.evaluate(fn, arg);
  const waitResults = (timeout = 180000) => page.waitForFunction(() => window.__geofe.state.results && !window.__geofe.state.busy, null, { timeout });
  const toastOrDialogClear = async () => { await page.waitForTimeout(400); };

  // ------------------------------------------------------------------ 1. initial view
  await page.goto(URL_);
  await page.waitForFunction(() => window.__geofe && window.geo);
  await page.waitForTimeout(600);
  check('initial: slope example loaded', await S(() => window.__geofe.state.model.title.includes('slope')));
  check('initial: canvas present', await page.locator('.gf-canvashost canvas').count() === 1);
  await shot('01-initial.png');

  // ------------------------------------------------------------------ 2. generate the mesh with the UI
  await mode('Mesh');
  await panel.getByRole('button', { name: /Generate mesh/ }).click();
  await page.waitForFunction(() => window.__geofe.state.mesh, null, { timeout: 30000 });
  const ms = await S(() => window.__geofe.state.mesh.stats);
  check('mesh: generated with T6 elements', ms.nElements > 300, `${ms.nElements} elements, ${ms.nNodes} nodes, min angle ${ms.minAngle.toFixed(1)}`);
  await toastOrDialogClear();
  await shot('02-mesh.png');

  // ------------------------------------------------------------------ 3. slope FOS through the Solve panel
  await mode('Solve');
  const t0 = Date.now();
  await panel.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForTimeout(700);
  await shot('03a-solving-progress.png');
  await waitResults();
  const fos = await S(() => window.__geofe.state.results.fos);
  check('slope: FOS computed in worker', fos > 1.2 && fos < 1.6, `FOS = ${fos?.toFixed?.(3)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await page.waitForFunction(() => window.__geofe.state.mode === 'plot', null, { timeout: 10000 });
  await S(() => window.geo.plot('eps_shear', { deformed: true, mesh: false }));
  await page.waitForTimeout(700);
  await shot('03-slope-fos-shear-strain.png');

  // ------------------------------------------------------------------ 4. footing example, static, vertical stress
  await S(() => window.geo.example('footing'));
  await page.waitForTimeout(300);
  await mode('Solve');
  await panel.getByRole('button', { name: 'Run analysis' }).click();
  await waitResults();
  const foot = await S(() => { const r = window.__geofe.state.results; return { ok: r.ok, analysis: r.analysis, conv: r.stages[0].converged }; });
  check('footing: static analysis converged', foot.ok && foot.analysis === 'static' && foot.conv, JSON.stringify(foot));
  await page.waitForFunction(() => window.__geofe.state.mode === 'plot', null, { timeout: 10000 });
  await S(() => window.geo.plot('syy', { deformed: false, mesh: true }));
  await page.waitForTimeout(700);
  await shot('04-footing-syy.png');

  // ------------------------------------------------------------------ 5. material dialog
  await S(() => window.geo.example('slope'));
  await page.waitForTimeout(300);
  await mode('Material');
  await panel.getByRole('button', { name: /Edit/ }).click();
  await page.waitForSelector('.gf-modal-overlay');
  check('material dialog opens', await page.locator('.gf-modal-overlay').count() >= 1);
  await shot('05-material-dialog.png');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.gf-modal-overlay', { state: 'detached', timeout: 3000 }).catch(() => {});

  // ------------------------------------------------------------------ 6. command line
  const cmdline = page.locator('textarea.gf-console-in');
  await cmdline.click();
  await cmdline.fill("geo.example('footing'); geo.mesh({size:1}); await geo.solve(); geo.plot('syy')");
  await cmdline.press('Enter');
  await waitResults();
  await page.waitForFunction(() => window.__geofe.state.plot.field === 'syy' && window.__geofe.state.mode === 'plot' && window.__geofe.state.model.title.includes('footing'), null, { timeout: 30000 });
  await page.waitForTimeout(700);
  const cl = await S(() => ({ size: window.__geofe.state.model.settings.meshSize, n: window.__geofe.state.mesh.stats.nElements, ok: window.__geofe.state.results.stages[0].converged }));
  check('command line: footing example meshed, solved and plotted', cl.size === 1 && cl.ok, `${cl.n} elements`);
  await shot('06-command-line.png');
  // a command with output
  await cmdline.fill('geo.range("uy")');
  await cmdline.press('Enter');
  await page.waitForTimeout(300);
  const outText = await page.locator('.gf-console-out').innerText();
  check('command line: expression result printed', /min/.test(outText) && /uy|Displacement/.test(outText), outText.split('\n').slice(-2).join(' | '));

  // ------------------------------------------------------------------ 7. draw a rectangle with the mouse
  await S(() => window.geo.newModel('Mouse test'));
  await page.waitForTimeout(300);
  await mode('Geometry');
  await panel.getByRole('button', { name: /Draw rectangle/ }).click();
  const box = await page.locator('.gf-canvashost canvas').boundingBox();
  const view = await S(() => window.__geofe.state.view);
  const sx = (x) => box.x + x * view.scale + view.ox, sy = (y) => box.y - y * view.scale + view.oy;
  await page.mouse.move(sx(10), sy(5));
  await page.mouse.click(sx(10), sy(5));
  await page.mouse.move(sx(40), sy(15), { steps: 5 });
  await page.mouse.click(sx(40), sy(15));
  await page.waitForTimeout(300);
  const reg = await S(() => window.__geofe.state.model.regions.map((r) => r.points));
  check('mouse: rectangle region drawn', reg.length === 1 && reg[0].length === 4, JSON.stringify(reg));
  // draw a second rectangle on top so the lower strip becomes a neighbouring layer sharing an edge
  await page.mouse.click(sx(10), sy(5));
  await page.mouse.move(sx(40), sy(0), { steps: 3 });
  await page.mouse.click(sx(40), sy(0));
  await page.waitForTimeout(300);
  const reg2 = await S(() => window.__geofe.state.model.regions.length);
  check('mouse: second rectangle drawn', reg2 === 2);
  await shot('07-mouse-drawn-regions.png');
  // finish the model through the UI: auto fixity + mesh + solve
  await S(() => { window.geo.fixAuto(); });
  await mode('Mesh');
  await panel.getByRole('button', { name: /Generate mesh/ }).click();
  await page.waitForFunction(() => window.__geofe.state.mesh, null, { timeout: 30000 });
  const mm = await S(() => window.__geofe.state.mesh.stats.nElements);
  check('mouse-drawn model meshes', mm > 20, `${mm} elements`);

  // ------------------------------------------------------------------ 7b. staged examples through the UI
  for (const [ex, field, shotName, extra] of [['excavation', 'uy', '08-excavation-uy.png', { stage: 1, deformed: true }],
    ['embankment', 'pore', '09-embankment-pore.png', { stage: 1, deformed: true, scale: 10 }]]) {
    await S((n) => window.geo.example(n), ex);
    await page.waitForTimeout(300);
    await mode('Solve');
    await panel.getByRole('button', { name: 'Run analysis' }).click();
    await waitResults();
    const st = await S(() => window.__geofe.state.results.stages.map((s) => s.converged));
    check(`${ex}: both stages converged`, st.length === 2 && st.every(Boolean), JSON.stringify(st));
    await page.waitForFunction(() => window.__geofe.state.mode === 'plot', null, { timeout: 10000 });
    await S(([f, o]) => window.geo.plot(f, o), [field, extra]);
    await page.waitForTimeout(700);
    await shot(shotName);
  }

  // ------------------------------------------------------------------ 8. save (download) works
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), page.keyboard.press('Control+s')]);
  const saved = JSON.parse(fs.readFileSync(await dl.path(), 'utf8'));
  check('save: model JSON downloaded', saved.title === (await S(() => window.__geofe.state.model.title)) && saved.regions.length >= 2, dl.suggestedFilename());

  // ------------------------------------------------------------------ 7c. UI regression checks (real browser)
  const busyLog = () => S(() => window.__busyLog);
  const closeDialogs = async () => {
    for (let i = 0; i < 4 && await page.locator('.gf-modal-overlay').count(); i++) { await page.keyboard.press('Escape'); await page.waitForTimeout(100); }
  };
  const canvasPt = async (x, y) => {
    const b = await page.locator('.gf-canvashost canvas').boundingBox();
    const v = await S(() => window.__geofe.state.view);
    return [b.x + x * v.scale + v.ox, b.y - y * v.scale + v.oy];
  };

  // (1) clicking a checkbox LABEL toggles the checkbox in dialogs
  await S(() => window.geo.example('slope'));
  await page.waitForTimeout(300);
  {
    const dlg = page.locator('.gf-modal');
    const toggleByLabel = async (text) => {
      const lab = dlg.locator('label', { hasText: text }).first();
      const cb = dlg.locator(`#${await lab.getAttribute('for')}`);
      const before = await cb.isChecked();
      await lab.click();
      const after = await cb.isChecked();
      await lab.click();
      return before !== after && (await cb.isChecked()) === before;
    };
    // Tension cut-off (analysis settings)
    await mode('Settings');
    await page.waitForSelector('.gf-modal'); // entering Settings mode opens the analysis settings dialog
    check('label click toggles "Tension cut-off"', await toggleByLabel('Tension cut-off'));
    await shot('10a-settings-dialog.png');
    await closeDialogs();
    // Fixity x / y (Boundary > Fix segment, two clicks on the canvas)
    await mode('Boundary');
    await panel.getByRole('button', { name: /Fix segment/ }).click();
    let [px, py] = await canvasPt(5, 5); await page.mouse.click(px, py);
    [px, py] = await canvasPt(15, 5); await page.mouse.click(px, py);
    await page.waitForSelector('.gf-modal');
    check('label click toggles "Fix x displacement"', await toggleByLabel('Fix x displacement'));
    check('label click toggles "Fix y displacement"', await toggleByLabel('Fix y displacement'));
    await shot('10b-fixity-dialog.png');
    await closeDialogs();
    // 'Uniform' on the distributed load dialog also shows/hides the end-point rows
    await mode('Loads');
    await panel.getByRole('button', { name: /Distributed load/ }).click();
    [px, py] = await canvasPt(5, 5); await page.mouse.click(px, py);
    [px, py] = await canvasPt(15, 5); await page.mouse.click(px, py);
    await page.waitForSelector('.gf-modal');
    check('label click toggles "Uniform" load checkbox', await toggleByLabel('Uniform'));
    const endHidden = async () => (await dlg.locator('.gf-form-row', { hasText: 'qx' }).nth(1).isVisible()) === false;
    const hiddenBefore = await endHidden();
    await dlg.locator('label', { hasText: 'Uniform' }).click();
    const shownAfter = !(await endHidden());
    check('"Uniform" label click shows the end-point rows', hiddenBefore && shownAfter);
    await shot('10c-distload-dialog.png');
    await closeDialogs();
    await S(() => window.__geofe.ui.app.setTool?.('select'));
  }

  // (2) busy stays true / Cancel stays enabled through "Run analysis" incl. mesh generation; cancel stops FOS
  await S(() => { window.geo.example('slope'); window.geo.set('settings.meshSize', 0.5); });
  await page.waitForTimeout(300);
  await mode('Solve');
  check('busy: mesh is stale before run', await S(() => !window.__geofe.state.mesh && !window.__geofe.state.busy));
  await S(() => {
    const st = window.__geofe.state;
    window.__busyLog = [];
    st.subscribe(() => {
      const cancel = [...document.querySelectorAll('aside.gf-panel .gf-btn')].find((b) => b.textContent.trim() === 'Cancel');
      window.__busyLog.push({ busy: st.busy, mesh: !!st.mesh, results: !!st.results, cancelDisabled: cancel ? cancel.disabled : null });
    });
  });
  await panel.getByRole('button', { name: 'Run analysis' }).click();
  await page.waitForFunction(() => window.__geofe.state.mesh, null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  const afterMesh = await S(() => ({ busy: window.__geofe.state.busy, cancelDisabled: [...document.querySelectorAll('aside.gf-panel .gf-btn')].find((b) => b.textContent.trim() === 'Cancel')?.disabled, running: [...document.querySelectorAll('aside.gf-panel .gf-btn')].find((b) => /Running|Run analysis/.test(b.textContent))?.textContent.trim() }));
  check('busy: still true and Cancel enabled after the mesh is generated', afterMesh.busy === true && afterMesh.cancelDisabled === false, JSON.stringify(afterMesh));
  const log1 = await busyLog();
  const meshIdx = log1.findIndex((e) => e.mesh);
  check('busy: never false between mesh generation and solve', meshIdx >= 0 && log1.slice(0, log1.length).every((e) => e.busy), `${log1.length} notifications`);
  check('busy: Cancel enabled in every notification once busy', log1.every((e) => e.cancelDisabled === false || e.cancelDisabled === null));
  await shot('10d-busy-solving.png');
  const tc = Date.now();
  await page.locator('.gf-modal').getByRole('button', { name: 'Cancel' }).click();
  await page.waitForFunction(() => !window.__geofe.state.busy, null, { timeout: 5000 });
  const cancelMs = Date.now() - tc;
  await page.waitForTimeout(2500);
  const afterCancel = await S(() => ({ busy: window.__geofe.state.busy, results: !!window.__geofe.state.results, modal: document.querySelectorAll('.gf-modal-overlay').length, runDisabled: [...document.querySelectorAll('aside.gf-panel .gf-btn')].find((b) => /Run analysis/.test(b.textContent))?.disabled }));
  check('cancel: running FOS solve stopped (no results, not busy, dialog closed)', !afterCancel.busy && !afterCancel.results && afterCancel.modal === 0 && afterCancel.runDisabled === false, `${cancelMs} ms, ${JSON.stringify(afterCancel)}`);
  await S(() => window.geo.set('settings.meshSize', 1.5));

  // (3) Command Panel tool buttons do not break words at common viewport sizes
  for (const [w, h_] of [[1280, 720], [1440, 900], [1920, 1080]]) {
    await page.setViewportSize({ width: w, height: h_ });
    await S(() => window.geo.example('slope'));
    await page.waitForTimeout(400);
    const bad = [];
    for (const m of ['Geometry', 'Mesh', 'Material', 'Boundary', 'Loads', 'Water', 'Settings', 'Solve']) {
      await mode(m);
      await page.waitForTimeout(150);
      await closeDialogs(); // entering Settings mode opens the settings dialog
      bad.push(...await S((mm) => {
        const out = [];
        for (const el of document.querySelectorAll('aside.gf-panel .gf-toolbtn, aside.gf-panel .gf-btn, aside.gf-panel .gf-modebtn')) {
          const box = el.getBoundingClientRect();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let n;
          while ((n = walker.nextNode())) {
            const re = /\S+/g; let mt;
            while ((mt = re.exec(n.data))) {
              const r = document.createRange(); r.setStart(n, mt.index); r.setEnd(n, mt.index + mt[0].length);
              const rects = [...r.getClientRects()].filter((q) => q.width > 0);
              const tops = new Set(rects.map((q) => Math.round(q.top)));
              const left = Math.min(...rects.map((q) => q.left)), right = Math.max(...rects.map((q) => q.right));
              if (tops.size > 1 || left < box.left - 1 || right > box.right + 1) out.push(`${mm}: "${mt[0]}" in "${el.textContent.trim()}" (${tops.size} lines, ${Math.round(right - box.right)}px over)`);
            }
          }
        }
        return out;
      }, m));
    }
    check(`no broken words in Command Panel at ${w}x${h_}`, bad.length === 0, bad.slice(0, 4).join(' | '));
    await mode('Geometry');
    await page.waitForTimeout(150);
    await shot(`11-panel-${w}x${h_}.png`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

  // (4) reversed manual contour range behaves sensibly
  await S(() => window.geo.example('footing'));
  await page.waitForTimeout(200);
  await S(async () => { await window.geo.solve(); window.geo.plot('syy'); });
  await page.waitForTimeout(600);
  await mode('Plot');
  await panel.locator('label.gf-check', { hasText: 'Automatic range' }).click();
  const rangeRows = panel.locator('.gf-frow', { hasText: /^(Min|Max)/ });
  const minIn = panel.locator('.gf-frow', { hasText: /^Min/ }).locator('input');
  const maxIn = panel.locator('.gf-frow', { hasText: /^Max/ }).locator('input');
  const auto = await S(() => ({ min: window.__geofe.state.plot.min, max: window.__geofe.state.plot.max }));
  const lo = Math.round(auto.min), hi = Math.round(auto.max);
  await minIn.fill(String(hi + 10)); await minIn.press('Enter');   // Min above the current Max
  await page.waitForTimeout(300);
  const rev = await S(() => ({ min: window.__geofe.state.plot.min, max: window.__geofe.state.plot.max }));
  const fieldVals = [await panel.locator('.gf-frow', { hasText: /^Min/ }).locator('input').inputValue(), await panel.locator('.gf-frow', { hasText: /^Max/ }).locator('input').inputValue()].map(Number);
  check('reversed Min>Max is normalised in state and panel fields', rev.min <= rev.max && fieldVals[0] <= fieldVals[1], `state ${JSON.stringify(rev)} fields ${fieldVals}`);
  await shot('12a-reversed-range.png');
  await maxIn.fill(String(lo - 100)); await maxIn.press('Enter'); // Max below the current Min
  await page.waitForTimeout(300);
  const rev2 = await S(() => ({ min: window.__geofe.state.plot.min, max: window.__geofe.state.plot.max }));
  check('Max below Min is normalised too', rev2.min <= rev2.max, JSON.stringify(rev2));
  check('swap raised no spurious "must differ" toast', !(await S(() => [...document.querySelectorAll('.gf-toast')].some((t) => /must differ/.test(t.textContent)))));
  // Min == Max is rejected (field reverts) instead of giving a zero-width legend
  const before = await S(() => ({ min: window.__geofe.state.plot.min, max: window.__geofe.state.plot.max }));
  await panel.locator('.gf-frow', { hasText: /^Min/ }).locator('input').fill(String(before.max)); await panel.locator('.gf-frow', { hasText: /^Min/ }).locator('input').press('Enter');
  await page.waitForTimeout(300);
  const after = await S(() => ({ min: window.__geofe.state.plot.min, max: window.__geofe.state.plot.max, field: [...document.querySelectorAll('aside.gf-panel .gf-frow')].find((r) => /^Min/.test(r.textContent))?.querySelector('input').value }));
  check('Min == Max is rejected and the field reverts', after.min === before.min && after.max === before.max && Number(after.field) === before.min, JSON.stringify(after));
  // a zero-width range set from the console still plots (legend is widened)
  await S(() => { window.__geofe.state.set({ plot: { ...window.__geofe.state.plot, min: 5, max: 5 } }); });
  await page.waitForTimeout(300);
  await shot('12b-equal-range.png');

  // (5) loading another example clears stale validation errors, toasts and plot settings
  await S(() => { window.geo.example('slope'); window.geo.set('boundaries', []); });
  await mode('Solve');
  await panel.getByRole('button', { name: 'Validate model' }).click();
  await page.waitForTimeout(300);
  const staleBefore = await S(() => ({ errs: document.querySelectorAll('aside.gf-panel .gf-errlist li').length, toasts: document.querySelectorAll('.gf-toast').length }));
  check('stale: validation errors + toast visible before switching', staleBefore.errs > 0 && staleBefore.toasts > 0, JSON.stringify(staleBefore));
  await S(() => { const st = window.__geofe.state; st.set({ plot: { ...st.plot, min: 1, max: 2, deformScale: 77, stageIndex: 0 } }); });
  await page.locator('.gf-menubar').getByText('File', { exact: true }).click();
  await page.locator('.gf-menupop').getByText('Load example').hover();
  await page.locator('.gf-menupop').getByText('Strip footing on layered soil').click();
  await page.waitForTimeout(500);
  await mode('Solve');
  const staleAfter = await S(() => { const st = window.__geofe.state; return { errs: document.querySelectorAll('aside.gf-panel .gf-errlist li').length, toasts: document.querySelectorAll('.gf-toast').length, plot: { min: st.plot.min, max: st.plot.max, ds: st.plot.deformScale, si: st.plot.stageIndex }, title: st.model.title }; });
  check('example switch clears validation errors, toasts and plot settings', staleAfter.errs === 0 && staleAfter.toasts === 0 && staleAfter.plot.min === undefined && staleAfter.plot.max === undefined && staleAfter.plot.ds === null && staleAfter.plot.si === -1, JSON.stringify(staleAfter));

  // (6) solver warnings are visible: T3 + Mohr-Coulomb
  await S(() => { window.geo.example('slope'); window.geo.set('settings.elementType', 'T3'); window.geo.set('settings.meshSize', 2); });
  await page.waitForTimeout(300);
  await mode('Solve');
  await panel.getByRole('button', { name: 'Run analysis' }).click();
  await waitResults();
  await page.waitForTimeout(500);
  const warn = await S(() => ({ res: window.__geofe.state.results.warnings || [], log: window.__geofe.state.log.filter((e) => e.level === 'warn' && /T3/.test(e.text)).length,
    toast: [...document.querySelectorAll('.gf-toast.warn')].map((t) => t.textContent), consoleTxt: /T3 elements/.test(document.querySelector('.gf-console-out')?.innerText || ''), panelNote: [...document.querySelectorAll('aside.gf-panel .gf-note.warn')].map((n) => n.textContent) }));
  check('solver warning present in results and in the log', warn.res.some((w) => /T3/.test(w)) && warn.log >= 1, JSON.stringify(warn.res).slice(0, 80));
  check('solver warning visible: toast', warn.toast.length > 0, warn.toast.join(' | ').slice(0, 120));
  check('solver warning visible: persistent panel note', warn.panelNote.some((t) => /T3/.test(t)), warn.panelNote.join(' | ').slice(0, 120));
  check('solver warning visible: console', warn.consoleTxt);
  await shot('13-solver-warning.png');
  await S(() => { window.geo.set('settings.elementType', 'T6'); });

  // ------------------------------------------------------------------ verdict
  check('no console errors / page errors', errors.length === 0, errors.join(' || '));
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed. Screenshots in ${SHOTS}`);
  if (failed.length) exitCode = 1;
} catch (e) {
  console.error('E2E ERROR:', e);
  exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  vite.kill('SIGTERM');
}
process.exit(exitCode);
