// Tool registry: which tools exist in which mode.
import { geometryTools } from './geometry.js';
import * as T from './other.js';

/** Tools shown in the command panel per mode. The first entry is the default tool. */
export function buildTools() {
  return {
    geometry: geometryTools(),
    mesh: [T.regionSelectTool()],
    material: [T.assignTool(), T.regionSelectTool()],
    boundary: [T.boundarySelectTool(), T.fixSegmentTool(), T.fixPointTool()],
    loads: [T.loadSelectTool(), T.pointLoadTool(), T.distLoadTool()],
    water: [T.waterSelectTool(), T.phreaticTool()],
    settings: [T.regionSelectTool()],
    solve: [T.regionSelectTool()],
    plot: [T.probeTool(), T.sectionTool()],
  };
}

/** Built-in hand (pan) tool, available in every mode. */
export const panTool = { id: 'pan', label: 'Pan', icon: 'hand', hint: 'Drag to pan the view. (Also: middle mouse button, or hold Space.)', snap: false };
