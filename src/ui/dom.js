// Tiny DOM helpers.

/**
 * h('div.cls#id', {attr: v, onclick: fn, style: {...}, dataset:{}}, ...children)
 * Children may be strings, nodes, arrays or null/false (skipped).
 */
export function h(tag, props, ...children) {
  let cls = '';
  let id = '';
  const m = /^([a-zA-Z0-9-]*)((?:[.#][\w-]+)*)$/.exec(tag);
  let name = tag;
  if (m) {
    name = m[1] || 'div';
    for (const part of m[2].match(/[.#][\w-]+/g) || []) {
      if (part[0] === '.') cls += (cls ? ' ' : '') + part.slice(1);
      else id = part.slice(1);
    }
  }
  const el = document.createElement(name);
  if (cls) el.className = cls;
  if (id) el.id = id;
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props) || typeof props === 'string')) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className += (el.className ? ' ' : '') + v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k in el && k !== 'list' && k !== 'type' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, children);
  return el;
}

export function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Parse an SVG/HTML string into a single element. */
export function fromHTML(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Trigger a download of text/blob content. */
export function downloadBlob(name, data, type = 'text/plain') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/** True if keyboard focus is in a text-entry control (global shortcuts must not fire then). */
export function isTyping(target = document.activeElement) {
  if (!target) return false;
  const t = target.tagName;
  if (t === 'TEXTAREA' || t === 'SELECT') return true;
  if (t === 'INPUT') return !['checkbox', 'radio', 'button', 'range', 'color'].includes(target.type);
  return !!target.isContentEditable;
}
