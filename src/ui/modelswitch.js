// DOM-free: reacts when a different model object is installed (New, Open, Load example, geo.example/newModel/load).
// Drops per-model UI state (stale pre-check list, section cut, plot cache) and the plot settings that only make sense
// for the previous model's results (manual colour range, deformation scale, stage index). Display preferences such as
// field, colormap, levels and the toggles are kept.
export function watchModelSwitch(state, app) {
  let lastModel = state.model;
  return function check() {
    if (state.model === lastModel) return false;
    lastModel = state.model;
    app.validation = null;
    app.section = null;
    app.plotCache = null;
    app._fittedFor = null;
    const p = state.plot;
    if (p) {
      p.min = undefined; p.max = undefined;
      p.deformScale = null;
      p.stageIndex = -1;
    }
    return true;
  };
}
