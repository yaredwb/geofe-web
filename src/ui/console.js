// Bottom dock: JavaScript command line with `geo` (services.api) in scope. Supports await, history and Tab completion.
import { h } from './dom.js';
import { icon } from './icons.js';
import { formatValue } from './format.js';
import { compileCommand, makeContext } from './cmdcompile.js';

const HELP = [
  'GeoFE command line - JavaScript with the scripting API as `geo`.',
  'Examples:  geo.example("slope")   await geo.solve()   geo.fos()   geo.set("settings.meshSize", 1.5)',
  'Also in scope: state, model (always the current model), services, print(...). The value of the last statement is printed. Enter runs; Shift+Enter inserts a newline; ↑/↓ history; Tab completes geo.xxx; help() repeats this text.',
].join('\n');

/** Create the console panel inside `host`. Returns { print(text, kind), run(code), focus(), clear() }. */
export function createConsole(app, host) {
  const { state, services } = app;
  const out = h('div.gf-console-out', { tabIndex: -1 });
  const input = h('textarea.gf-console-in', { rows: 1, spellcheck: false, placeholder: 'geo.example("slope")   // Enter to run', autocapitalize: 'off', autocomplete: 'off' });
  const prompt = h('span.gf-console-prompt', '>');
  const inputRow = h('div.gf-console-inrow', prompt, input);
  host.append(out, inputRow);

  const history = [];
  let hIdx = 0, draft = '';
  let logSeen = state.log.length;

  function print(text, kind = 'out') {
    const line = h('div.gf-console-line.' + kind, String(text));
    const atBottom = out.scrollTop + out.clientHeight >= out.scrollHeight - 30;
    out.appendChild(line);
    while (out.childElementCount > 1500) out.firstChild.remove();
    if (atBottom || kind === 'in') out.scrollTop = out.scrollHeight;
  }

  async function run(code) {
    code = code.trim();
    if (!code) return;
    history.push(code); hIdx = history.length; draft = '';
    print(code, 'in');
    const cons = { log: (...a) => print(a.map((x) => formatValue(x)).join(' ')), warn: (...a) => print(a.map((x) => formatValue(x)).join(' '), 'warn'), error: (...a) => print(a.map((x) => formatValue(x)).join(' '), 'err'), info: (...a) => print(a.map((x) => formatValue(x)).join(' ')) };
    const ctx = makeContext({ geo: services.api, state, services, print: (...a) => cons.log(...a), help: () => { print(HELP, 'sys'); }, console: cons });
    let fn;
    try { fn = compileCommand(code); } catch (e) { print(`${e.name}: ${e.message}`, 'err'); return; }
    try {
      const r = await fn(ctx);
      if (r !== undefined) print(formatValue(r), 'res');
    } catch (e) {
      print(`${e && e.name ? e.name : 'Error'}: ${e && e.message ? e.message : e}`, 'err');
      if (e && e.stack && !(e instanceof SyntaxError)) console.debug(e);
    }
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(120, input.scrollHeight) + 'px';
  }

  function complete() {
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\.([A-Za-z_$][\w$]*)?$/.exec(before);
    let candidates = [], prefix = '', replaceFrom = pos;
    if (m) {
      const path = m[1].split('.');
      const root = { geo: services.api, state, services }[path[0]];
      let obj = root;
      for (const k of path.slice(1)) obj = obj?.[k];
      if (obj && (typeof obj === 'object' || typeof obj === 'function')) {
        prefix = m[2] || '';
        replaceFrom = pos - prefix.length;
        const keys = new Set();
        for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) Object.getOwnPropertyNames(o).forEach((k) => { if (k !== 'constructor' && !k.startsWith('_')) keys.add(k); });
        candidates = [...keys].filter((k) => k.startsWith(prefix)).sort();
      }
    } else {
      const w = /([A-Za-z_$][\w$]*)$/.exec(before);
      if (w) { prefix = w[1]; replaceFrom = pos - prefix.length; candidates = ['geo', 'state', 'model', 'services', 'print', 'help'].filter((k) => k.startsWith(prefix)); }
    }
    if (!candidates.length) return;
    let common = candidates[0];
    for (const c of candidates) { let i = 0; while (i < common.length && c[i] === common[i]) i++; common = common.slice(0, i); }
    if (common.length > prefix.length) {
      input.setRangeText(common, replaceFrom, pos, 'end');
    } else if (candidates.length > 1) print(candidates.join('   '), 'sys');
    else if (candidates.length === 1) input.setRangeText(candidates[0], replaceFrom, pos, 'end');
    autosize();
  }

  input.addEventListener('keydown', (e) => {
    e.stopPropagation(); // keep global shortcuts away from typing
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const code = input.value;
      input.value = ''; autosize();
      run(code);
    } else if (e.key === 'ArrowUp' && (input.selectionStart === 0 || !input.value.includes('\n'))) {
      if (hIdx > 0) { e.preventDefault(); if (hIdx === history.length) draft = input.value; hIdx--; input.value = history[hIdx]; autosize(); }
    } else if (e.key === 'ArrowDown' && !input.value.slice(input.selectionStart).includes('\n')) {
      if (hIdx < history.length) { e.preventDefault(); hIdx++; input.value = hIdx === history.length ? draft : history[hIdx]; autosize(); }
    } else if (e.key === 'Tab') { e.preventDefault(); complete(); }
    else if (e.key === 'Escape') { input.blur(); }
    else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); out.textContent = ''; }
  });
  input.addEventListener('input', autosize);
  host.addEventListener('mousedown', (e) => { if (e.target === out || e.target === host) setTimeout(() => input.focus(), 0); });

  // Mirror state.log (solver / API messages) into the console.
  const unsub = state.subscribe(() => {
    while (logSeen < state.log.length) {
      const e = state.log[logSeen++];
      print(e.text, e.level === 'error' ? 'err' : e.level === 'warn' ? 'warn' : 'sys');
    }
    if (state.log.length < logSeen) logSeen = state.log.length;
  });

  print(HELP, 'sys');
  return { print, run, focus: () => input.focus(), clear: () => { out.textContent = ''; }, destroy: unsub, input };
}

export function consoleHeader(app, { onToggle, onClear }) {
  return h('div.gf-dock-head',
    h('span.gf-dock-title', { html: icon('console', 14) + ' Command Line' }),
    h('span.gf-dock-spacer'),
    h('button.gf-iconbtn', { title: 'Clear (Ctrl+L)', type: 'button', onclick: onClear, html: icon('clear', 14) }),
    h('button.gf-iconbtn', { title: 'Hide (Ctrl+`)', type: 'button', onclick: onToggle, html: icon('chevron', 14) }));
}
