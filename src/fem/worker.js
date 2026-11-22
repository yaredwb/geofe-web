// Web Worker wrapper around the FE solver.
//
// Messages to the worker:
//   { cmd: 'solve', model, mesh, cancelBuffer? }   run the analysis. `cancelBuffer` is an optional SharedArrayBuffer
//                                                  (Int32Array[1]); setting element 0 to 1 cancels the run while the
//                                                  solver is busy (a plain postMessage cannot interrupt synchronous work).
//   { cmd: 'cancel' }                              sets the cancel flag (only observed between messages when no
//                                                  SharedArrayBuffer is used — to abort a running solve without
//                                                  cross-origin isolation simply call worker.terminate()).
// Messages from the worker:
//   { type: 'progress', stage, step, iter, residual, fos, text }
//   { type: 'done', results }     typed-array buffers are transferred, not copied
//   { type: 'error', message }
//
// `handleMessage(msg, post)` contains the logic and is exported so it can be unit-tested in Node.
import { solve } from './solver.js';

let cancelFlag = false;
let cancelArray = null;

/** Collect every ArrayBuffer referenced (through typed arrays) by a results object, for zero-copy transfer. */
export function collectTransferables(obj) {
  const bufs = new Set();
  const seen = new Set();
  const visit = (o) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (ArrayBuffer.isView(o)) { if (o.buffer instanceof ArrayBuffer) bufs.add(o.buffer); return; }
    if (Array.isArray(o)) { for (const v of o) visit(v); return; }
    for (const k of Object.keys(o)) visit(o[k]);
  };
  visit(obj);
  return [...bufs];
}

/**
 * @param {object} msg  message received by the worker
 * @param {(data: object, transfer?: ArrayBuffer[]) => void} post  function that posts a message to the main thread
 */
export function handleMessage(msg, post) {
  if (!msg || typeof msg !== 'object') return;
  if (msg.cmd === 'cancel') {
    cancelFlag = true;
    if (cancelArray) Atomics.store(cancelArray, 0, 1);
    return;
  }
  if (msg.cmd !== 'solve') return;
  cancelFlag = false;
  cancelArray = null;
  if (msg.cancelBuffer && typeof SharedArrayBuffer !== 'undefined' && msg.cancelBuffer instanceof SharedArrayBuffer) {
    cancelArray = new Int32Array(msg.cancelBuffer);
  }
  try {
    const results = solve(msg.model, msg.mesh, {
      onProgress: (p) => post({ type: 'progress', ...p }),
      shouldCancel: () => cancelFlag || (cancelArray !== null && Atomics.load(cancelArray, 0) === 1),
    });
    post({ type: 'done', results }, collectTransferables(results));
  } catch (err) {
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }
}

// Register as a worker entry point (no-op when imported in Node / main thread).
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.onmessage = (e) => handleMessage(e.data, (data, transfer) => self.postMessage(data, transfer || []));
}
