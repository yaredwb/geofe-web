// Application entry point: creates the shared store, the services and the scripting API, and mounts the UI.
import { createState } from './state.js';
import { createServices } from './services.js';
import { createIO } from './io.js';
import { createApi } from './api.js';
import { getExample } from './examples.js';
import { createUI } from '../ui/ui.js';

const state = createState(getExample('slope'));
const services = createServices(state);
const io = createIO(state);
const api = createApi(state, services, io);
services.api = api;
services.io = io;

const ui = createUI(document.getElementById('app'), state, services);

// Fit the view whenever a different model object is installed (example, file, geo.newModel(), ...).
let lastModel = state.model;
state.subscribe(() => {
  if (state.model !== lastModel) {
    lastModel = state.model;
    requestAnimationFrame(() => ui.app.canvas?.zoomExtents?.());
  }
});

// Handles for the command line, debugging and the e2e tests.
window.geo = api;
window.__geofe = { state, services, ui };
state.logMsg('Welcome to GeoFE Web. Try geo.help() in the command line.');
