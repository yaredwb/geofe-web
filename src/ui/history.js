// Undo / redo by model snapshots. DOM-free. Hooks state.modelChanged so edits made by tools, dialogs and the
// scripting API are all recorded without those callers knowing.
import { replaceInPlace } from './edit.js';

export function createHistory(state, { limit = 100, coalesceMs = 400, now = () => Date.now() } = {}) {
  const undoStack = [], redoStack = [];
  let current = JSON.stringify(state.model);
  let modelRef = state.model;
  let lastTime = 0;
  let holding = false, heldPushed = false;
  const orig = state.modelChanged.bind(state);

  function reset() {
    undoStack.length = 0; redoStack.length = 0;
    current = JSON.stringify(state.model); modelRef = state.model; lastTime = 0;
  }

  function record() {
    if (state.model !== modelRef) { reset(); return; }
    const s = JSON.stringify(state.model);
    if (s === current) return;
    const t = now();
    const needPush = holding ? !heldPushed : t - lastTime > coalesceMs || undoStack.length === 0;
    if (needPush) {
      undoStack.push(current);
      if (undoStack.length > limit) undoStack.shift();
      redoStack.length = 0;
      if (holding) heldPushed = true;
    }
    current = s; lastTime = t;
  }

  state.modelChanged = (opts) => { record(); orig(opts); };
  const unsub = state.subscribe(() => { if (state.model !== modelRef) reset(); });

  function apply(snapshot) {
    replaceInPlace(state.model, JSON.parse(snapshot));
    current = snapshot; lastTime = 0;
    state.selection = null;
    orig();
  }

  return {
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    undo() {
      if (!undoStack.length) return false;
      // make sure unrecorded in-place edits are not lost
      const s = JSON.stringify(state.model);
      if (s !== current) { current = s; }
      redoStack.push(current);
      apply(undoStack.pop());
      return true;
    },
    redo() {
      if (!redoStack.length) return false;
      undoStack.push(current);
      apply(redoStack.pop());
      return true;
    },
    /** Group a burst of changes (e.g. a drag) into one undo step. */
    hold(on) { holding = on; heldPushed = false; },
    reset,
    destroy() { unsub(); state.modelChanged = orig; },
    _sizes: () => [undoStack.length, redoStack.length],
  };
}
