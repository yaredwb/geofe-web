# GeoFE UI (`src/ui/`)

`createUI(rootEl, state, services)` from `ui.js` builds the whole interface (menu bar, toolbar, Info panel, model canvas,
Command Panel, Command Line, status bar). Include `src/ui/style.css`; give `rootEl` a height (e.g. `100vh`).

`services = { generateMesh(), solve(opts?) → Promise, cancelSolve(), postFields, render, api, io: { save, load(file), exportPNG(canvas?), newModel, loadExample(name) } }`.
`solve` receives `{ onProgress(msg), shouldCancel() }`; if it ignores them and logs through `state.logMsg`, those lines are shown instead.
Returned object: `{ app, redraw, getCanvas, snapshotCanvas, toast, setMode, print, destroy }`.

Layout: DOM-free logic lives in `viewmath.js` (view/snap/hit-test/mesh sampling), `edit.js` (model edits), `glyphs.js` (BC/load/water symbols),
`format.js`, `history.js` (undo/redo); the rest is DOM (`canvas.js`, `draw.js`, `dialogs.js`, `modeldialogs.js`, `plotdialogs.js`, `solve.js`,
`console.js`, `menus.js`, `panels/*`, `tools/*`). `dev/` is a stub-service harness (`npx vite`, open `/src/ui/dev/index.html`; add `?stub` to force stubs).

## Keyboard shortcuts
| Key | Action |
|---|---|
| 1 … 9 | Mode: Geometry, Mesh, Material, Boundary, Loads, Water, Settings, Solve, Plot |
| V / P / R / L | Geometry: select-move vertex / polygon / rectangle / internal line |
| H, Space + drag, middle-drag | Pan |
| Mouse wheel | Zoom about cursor |
| F or Home | Zoom extents |
| + / - | Zoom in / out |
| G | Toggle grid |
| Shift (held) | Disable snapping |
| Enter, double-click, right-click | Finish polygon / internal line / phreatic line |
| Backspace | Remove last point while drawing |
| Esc | Cancel operation, then clear selection, then back to the default tool |
| Delete | Delete selection |
| Ctrl+Z, Ctrl+Y / Ctrl+Shift+Z | Undo / redo |
| Ctrl+S, Ctrl+O | Save / open |
| F9 | Generate mesh |
| Ctrl+Enter | Run analysis |
| Ctrl+` | Show / hide Command Line |
| F1 or ? | Shortcut list |
| Command Line: Enter / Shift+Enter / ↑↓ / Tab / Ctrl+L | Run / newline / history / complete `geo.` / clear |
