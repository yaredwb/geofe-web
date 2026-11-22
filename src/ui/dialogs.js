// Generic modal dialog infrastructure: openModal, alert/confirm, and a declarative formDialog().
import { h, clear } from './dom.js';
import { icon } from './icons.js';

let zCounter = 1000;

/**
 * Open a (movable) dialog.
 * opts: { title, body: Node, buttons: [{label, primary?, onClick?() => false to keep open, value}], width, modal=true,
 *         onClose?(value), closeValue=null, container }
 * Returns { el, body, close(value), setTitle(text), promise } where promise resolves with the closing value
 * (the clicked button's `value`, or closeValue when dismissed with Esc / the X button).
 */
export function openModal(opts) {
  const { title = '', body, buttons = [], width = 420, modal = true, closeValue = null, container = document.body, onClose = null, className = '' } = opts;
  let resolveFn;
  const promise = new Promise((res) => { resolveFn = res; });
  let closed = false;
  const titleEl = h('span.gf-modal-title', title);
  const closeBtn = h('button.gf-modal-x', { title: 'Close', type: 'button', html: icon('close', 14) });
  const head = h('div.gf-modal-head', titleEl, closeBtn);
  const bodyEl = h('div.gf-modal-body', body);
  const foot = h('div.gf-modal-foot');
  const win = h('div.gf-modal' + (className ? '.' + className : ''), { style: { width: typeof width === 'number' ? width + 'px' : width }, role: 'dialog', tabIndex: -1 }, head, bodyEl, foot);
  const overlay = h('div.gf-modal-overlay' + (modal ? '' : '.gf-nonmodal'), { style: { zIndex: ++zCounter } }, win);
  const prevFocus = document.activeElement;

  function close(value = closeValue) {
    if (closed) return;
    closed = true;
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    try { if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus({ preventScroll: true }); } catch { /* ignore */ }
    if (onClose) onClose(value);
    resolveFn(value);
  }

  let primaryBtn = null;
  for (const b of buttons) {
    const el = h('button.gf-btn' + (b.primary ? '.primary' : ''), { type: 'button', disabled: !!b.disabled }, b.label);
    el.addEventListener('click', async () => {
      if (b.onClick) {
        const r = await b.onClick(close);
        if (r === false) return;
      }
      close(b.value !== undefined ? b.value : b.primary ? true : closeValue);
    });
    if (b.primary) primaryBtn = el;
    foot.appendChild(el);
  }
  if (!buttons.length) foot.style.display = 'none';

  function onKey(e) {
    // Only the topmost dialog reacts.
    const all = document.querySelectorAll('.gf-modal-overlay');
    if (all[all.length - 1] !== overlay) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(closeValue); }
    else if (e.key === 'Enter' && primaryBtn && !e.shiftKey) {
      const t = e.target;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.tagName === 'SELECT' || !overlay.contains(t)) return;
      e.preventDefault(); e.stopPropagation(); primaryBtn.click();
    }
  }
  document.addEventListener('keydown', onKey, true);
  closeBtn.addEventListener('click', () => close(closeValue));
  if (modal) overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) { win.classList.add('flash'); setTimeout(() => win.classList.remove('flash'), 200); } });

  // drag by title bar
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = win.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    win.style.position = 'fixed'; win.style.left = r.left + 'px'; win.style.top = r.top + 'px'; win.style.margin = '0';
    head.setPointerCapture(e.pointerId);
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    win.style.left = Math.max(0, Math.min(window.innerWidth - 60, e.clientX - drag.dx)) + 'px';
    win.style.top = Math.max(0, Math.min(window.innerHeight - 30, e.clientY - drag.dy)) + 'px';
  });
  head.addEventListener('pointerup', () => { drag = null; });

  container.appendChild(overlay);
  const firstInput = bodyEl.querySelector('input:not([type=checkbox]):not([type=hidden]), select, textarea');
  (firstInput || primaryBtn || win).focus?.({ preventScroll: true });
  if (firstInput && firstInput.select && firstInput.tagName === 'INPUT') { try { firstInput.select(); } catch { /* ignore */ } }
  return { el: win, overlay, body: bodyEl, foot, close, setTitle: (t) => { titleEl.textContent = t; }, promise };
}

/** Simple message dialog. Message may be a string (newlines preserved) or a Node. */
export function alertDialog(title, message, { kind = 'info' } = {}) {
  const body = h('div.gf-msg', kind === 'error' || kind === 'warning' ? h('span.gf-msg-icon.' + kind, { html: icon('warning', 28) }) : null,
    message instanceof Node ? message : h('div.gf-msg-text', String(message)));
  return openModal({ title, body, width: 440, buttons: [{ label: 'OK', primary: true }] }).promise;
}

export function confirmDialog(title, message, { okLabel = 'OK', cancelLabel = 'Cancel' } = {}) {
  const body = h('div.gf-msg', message instanceof Node ? message : h('div.gf-msg-text', String(message)));
  return openModal({ title, body, width: 420, closeValue: false, buttons: [{ label: cancelLabel, value: false }, { label: okLabel, primary: true, value: true }] }).promise;
}

/** Parse a number from user text; returns NaN if invalid. */
export function parseNum(s) {
  const t = String(s).trim().replace(',', '.');
  if (t === '') return NaN;
  return Number(t);
}

let formFieldSeq = 0;

/**
 * Declarative form dialog. Field spec:
 *  { section: 'Heading' } | { note: 'text' }
 *  { key, label, type: 'number'|'text'|'select'|'checkbox'|'color'|'readonly', value, unit?, hint?, min?, max?,
 *    minExclusive?, maxExclusive?, integer?, nullable?, options: [{value,label}|string] (select), showIf?(values) }
 * opts: { title, fields, okLabel, cancelLabel, width, validate?(values) → string|null, extraButtons?, onChange?(values, setValue) }
 * Resolves with the values object or null on cancel.
 */
export function formDialog({ title, fields, okLabel = 'OK', cancelLabel = 'Cancel', width = 400, validate = null, onChange = null, extraButtons = [] }) {
  const inputs = new Map(); // key -> {field, el, row, get(), set()}
  const errorEl = h('div.gf-form-error');
  const grid = h('div.gf-form');
  for (const f of fields) {
    if (f.section || f.note) {
      const row = h(f.section ? 'div.gf-form-section' : 'div.gf-form-note', f.section || f.note);
      grid.appendChild(row);
      if (f.showIf) inputs.set('__static' + inputs.size, { field: { showIf: f.showIf, type: 'static' }, row, get: () => undefined, set() {} });
      continue;
    }
    let el, get, set;
    const init = f.value;
    if (f.type === 'select') {
      el = h('select');
      for (const o of f.options || []) {
        const ov = typeof o === 'object' ? o.value : o, ol = typeof o === 'object' ? o.label : o;
        el.appendChild(h('option', { value: String(ov) }, ol));
      }
      set = (v) => { el.value = String(v); };
      get = () => {
        const o = (f.options || []).find((x) => String(typeof x === 'object' ? x.value : x) === el.value);
        return o === undefined ? el.value : typeof o === 'object' ? o.value : o;
      };
    } else if (f.type === 'checkbox') {
      el = h('input', { type: 'checkbox' });
      set = (v) => { el.checked = !!v; };
      get = () => el.checked;
    } else if (f.type === 'color') {
      el = h('input', { type: 'color' });
      set = (v) => { el.value = /^#[0-9a-f]{6}$/i.test(v) ? v : '#c8a26b'; };
      get = () => el.value;
    } else if (f.type === 'readonly') {
      el = h('span.gf-readonly');
      set = (v) => { el.textContent = v ?? ''; };
      get = () => init;
    } else if (f.type === 'number') {
      el = h('input', { type: 'text', inputMode: 'decimal', spellcheck: false });
      set = (v) => { el.value = v === null || v === undefined ? '' : String(v); };
      get = () => {
        if (el.value.trim() === '' && f.nullable) return null;
        return parseNum(el.value);
      };
    } else {
      el = h('input', { type: 'text', spellcheck: false });
      set = (v) => { el.value = v ?? ''; };
      get = () => el.value;
    }
    set(init);
    const label = h('label', { title: f.hint || '' }, f.label);
    if (f.type !== 'readonly') { const id = `gf-f-${++formFieldSeq}-${f.key}`; el.id = id; label.htmlFor = id; }
    const right = h('div.gf-form-ctl', el, f.unit ? h('span.gf-unit', f.unit) : null);
    const row = h('div.gf-form-row' + (f.type === 'checkbox' ? '.check' : ''), label, right);
    if (f.hint) row.title = f.hint;
    grid.appendChild(row);
    inputs.set(f.key, { field: f, el, row, get, set });
    const fire = () => { refresh(); if (onChange) onChange(values(), (k, v) => inputs.get(k)?.set(v)); };
    el.addEventListener(f.type === 'select' || f.type === 'checkbox' || f.type === 'color' ? 'change' : 'input', fire);
  }
  function values() {
    const v = {};
    for (const [k, inp] of inputs) if (inp.field.type !== 'static') v[k] = inp.get();
    return v;
  }
  function refresh() {
    const v = values();
    for (const inp of inputs.values()) if (inp.field.showIf) inp.row.style.display = inp.field.showIf(v) ? '' : 'none';
  }
  function check() {
    const v = values();
    for (const [k, inp] of inputs) {
      const f = inp.field;
      if (f.showIf && !f.showIf(v)) continue;
      if (f.type === 'number') {
        const x = v[k];
        if (x === null && f.nullable) continue;
        if (!Number.isFinite(x)) return { error: `${f.label}: enter a valid number`, el: inp.el };
        if (f.integer && !Number.isInteger(x)) return { error: `${f.label}: must be an integer`, el: inp.el };
        if (f.min !== undefined && x < f.min) return { error: `${f.label}: must be ≥ ${f.min}`, el: inp.el };
        if (f.max !== undefined && x > f.max) return { error: `${f.label}: must be ≤ ${f.max}`, el: inp.el };
        if (f.minExclusive !== undefined && !(x > f.minExclusive)) return { error: `${f.label}: must be > ${f.minExclusive}`, el: inp.el };
        if (f.maxExclusive !== undefined && !(x < f.maxExclusive)) return { error: `${f.label}: must be < ${f.maxExclusive}`, el: inp.el };
      } else if (f.type === 'text' && f.required && !String(v[k]).trim()) return { error: `${f.label} is required`, el: inp.el };
    }
    if (validate) { const msg = validate(v); if (msg) return { error: msg, el: null }; }
    return null;
  }
  refresh();
  const body = h('div', grid, errorEl);
  const dlg = openModal({
    title, body, width, closeValue: null,
    buttons: [
      ...extraButtons,
      { label: cancelLabel, value: null },
      {
        label: okLabel, primary: true,
        onClick: () => {
          const err = check();
          if (err) { errorEl.textContent = err.error; err.el?.focus?.(); return false; }
          errorEl.textContent = '';
          dlg.result = values();
        },
      },
    ],
  });
  return dlg.promise.then((r) => (r === true || r === undefined ? dlg.result ?? null : null));
}

/** Build a labelled table of rows into a node (small helper for dialogs). */
export function simpleTable(headers, rows) {
  const t = h('table.gf-table');
  t.appendChild(h('thead', h('tr', headers.map((x) => h('th', x)))));
  const tb = h('tbody');
  for (const r of rows) tb.appendChild(h('tr', r.map((c) => h('td', c))));
  t.appendChild(tb);
  return t;
}

export { clear };
