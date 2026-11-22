// DOM-free compiler for the command line. Turns user input into an async function of one context object.
// - single expression -> its value is returned
// - statements -> the value of the last statement (when it is an expression) is returned
// - the context object is searched with `with`, so `model` is a getter that always yields the current model.
const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;

/** Index where the last top-level statement of `code` starts (after the last top-level ';' or newline), or 0. */
export function lastStatementStart(code) {
  let depth = 0, start = 0, i = 0;
  const n = code.length;
  // ignore trailing whitespace / semicolons so "a; b;" yields "b"
  let end = n;
  while (end > 0 && /[\s;]/.test(code[end - 1])) end--;
  while (i < end) {
    const c = code[i], d = code[i + 1];
    if (c === '/' && d === '/') { while (i < end && code[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { const j = code.indexOf('*/', i + 2); i = j < 0 ? end : j + 2; continue; }
    if (c === '"' || c === "'") {
      i++;
      while (i < end && code[i] !== c) { if (code[i] === '\\') i++; i++; }
      i++; continue;
    }
    if (c === '`') { i = skipTemplate(code, i + 1, end); continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0 && (c === ';' || c === '\n')) start = i + 1;
    i++;
  }
  return { start, end };
}

function skipTemplate(code, i, end) {
  while (i < end && code[i] !== '`') {
    if (code[i] === '\\') { i += 2; continue; }
    if (code[i] === '$' && code[i + 1] === '{') {
      i += 2; let depth = 1;
      while (i < end && depth > 0) {
        const c = code[i];
        if (c === '`') { i = skipTemplate(code, i + 1, end); continue; }
        if (c === '"' || c === "'") { i++; while (i < end && code[i] !== c) { if (code[i] === '\\') i++; i++; } i++; continue; }
        if (c === '{') depth++; else if (c === '}') depth--;
        i++;
      }
      continue;
    }
    i++;
  }
  return i + 1;
}

/**
 * Compile `code`. Returns an async function (ctx) => value. Throws SyntaxError when nothing compiles.
 * The first attempt wraps the whole input as one expression; then the last top-level statement is returned;
 * finally the plain body is used (no result value).
 */
export function compileCommand(code) {
  const wrap = (body) => new AsyncFunction('__ctx', `with (__ctx) {\n${body}\n}`);
  try { return wrap(`return (\n${code}\n);`); } catch { /* not a single expression */ }
  try {
    const { start, end } = lastStatementStart(code);
    if (start > 0 && start < end) {
      const head = code.slice(0, start), last = code.slice(start, end);
      if (last.trim()) return wrap(`${head}\nreturn (\n${last}\n);`);
    }
  } catch { /* fall through */ }
  return wrap(code);
}

/** Build the context object: `model` is always the live state.model. */
export function makeContext({ geo, state, services, print, help, console: cons }) {
  return { geo, state, services, print, help, console: cons, get model() { return state.model; } };
}
