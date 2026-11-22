// Original inline SVG icon set (24x24 viewBox, stroke-based, uses currentColor). Drawn for this app.
const S = (body, extra = '') => `<svg class="gf-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${body}</svg>`;

const raw = {
  new: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/>',
  open: '<path d="M3 7h6l2 2h10v10H3z"/><path d="M3 11h18"/>',
  save: '<path d="M5 3h12l3 3v15H5z"/><path d="M8 3v6h8V3"/><rect x="8" y="14" width="8" height="7"/>',
  png: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="9" cy="10" r="1.6"/><path d="M4 18l5-5 4 4 3-3 4 4"/>',
  undo: '<path d="M9 7L4 12l5 5"/><path d="M4 12h10a6 6 0 010 8"/>',
  redo: '<path d="M15 7l5 5-5 5"/><path d="M20 12H10a6 6 0 000 8"/>',
  select: '<path d="M6 3l12 9-5.5 1.2L15 19l-2.5 1-2.5-5.8L6 18z" fill="currentColor" fill-opacity=".15"/>',
  hand: '<path d="M8 12V6a1.5 1.5 0 013 0v5V4.5a1.5 1.5 0 013 0V11V6a1.5 1.5 0 013 0v8a6 6 0 01-6 6h-1a6 6 0 01-4.5-2L4 14.5a1.6 1.6 0 012.4-2L8 14z"/>',
  zoomin: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M10.5 7.5v6M7.5 10.5h6"/>',
  zoomout: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21M7.5 10.5h6"/>',
  extents: '<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
  polygon: '<path d="M5 17l3-11 9 2 3 9z" fill="currentColor" fill-opacity=".12"/><rect x="3.5" y="15.5" width="3" height="3" fill="currentColor"/><rect x="6.5" y="4.5" width="3" height="3" fill="currentColor"/><rect x="15.5" y="6.5" width="3" height="3" fill="currentColor"/><rect x="18.5" y="15.5" width="3" height="3" fill="currentColor"/>',
  rect: '<rect x="4" y="6" width="16" height="12" fill="currentColor" fill-opacity=".12"/><rect x="2.5" y="4.5" width="3" height="3" fill="currentColor"/><rect x="18.5" y="16.5" width="3" height="3" fill="currentColor"/>',
  line: '<path d="M4 19L20 5" stroke-dasharray="3 2.5"/><rect x="2.5" y="17.5" width="3" height="3" fill="currentColor"/><rect x="18.5" y="3.5" width="3" height="3" fill="currentColor"/>',
  vertex: '<rect x="9" y="9" width="6" height="6" fill="currentColor" fill-opacity=".3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  delete: '<path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13M10 11v6M14 11v6"/>',
  table: '<rect x="3" y="4" width="18" height="16" rx="1"/><path d="M3 9h18M3 14h18M9 4v16"/>',
  mesh: '<path d="M3 20L12 4l9 16z"/><path d="M7.5 12h9M5.2 16h13.6M12 4v16M7.5 12l4.5 8M16.5 12L12 20" stroke-width="1.1"/>',
  generate: '<path d="M4 20L12 5l8 15z"/><path d="M8 12.5h8M12 5v15" stroke-width="1.1"/><path d="M19 3v4M17 5h4" />',
  material: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" fill="currentColor" fill-opacity=".15"/><path d="M4 7.5L12 12l8-4.5M12 12v9"/>',
  assign: '<path d="M4 20l1-4 10-10 3 3-10 10z"/><path d="M14 7l3 3"/><path d="M4 20h6" />',
  boundary: '<path d="M3 11h18"/><path d="M6 11l-2 4h4zM12 11l-2 4h4zM18 11l-2 4h4z"/><path d="M3 18h18M5 18l-1.5 2M9 18l-1.5 2M13 18l-1.5 2M17 18l-1.5 2"/>',
  pin: '<path d="M12 5l-5 8h10z" fill="currentColor" fill-opacity=".15"/><path d="M4 17h16M6 17l-1.5 2.5M10 17l-1.5 2.5M14 17l-1.5 2.5M18 17l-1.5 2.5"/><path d="M12 13v0"/>',
  roller: '<path d="M12 4l-5 8h10z" fill="currentColor" fill-opacity=".15"/><circle cx="9" cy="14.5" r="1.7"/><circle cx="15" cy="14.5" r="1.7"/><path d="M4 18h16"/>',
  auto: '<path d="M4 4v16h16"/><path d="M4 8h-1.5M4 12h-1.5M4 16h-1.5"/><path d="M8 20v1.5M12 20v1.5M16 20v1.5"/><path d="M12 13l-3 -5 6 0z" fill="currentColor" fill-opacity=".2" transform="translate(0 0)"/>',
  load: '<path d="M12 3v14"/><path d="M7 12l5 6 5-6" /><path d="M5 20.5h14"/>',
  pointload: '<path d="M12 3v14"/><path d="M7 12l5 6 5-6"/><path d="M5 20.5h14"/>',
  distload: '<path d="M5 6h14"/><path d="M6 6v9M10 6v9M14 6v9M18 6v9"/><path d="M4 15l2 3 2-3M8 15l2 3 2-3M12 15l2 3 2-3M16 15l2 3 2-3" stroke-width="1.2"/><path d="M3 20.5h18"/>',
  water: '<path d="M3 9c3-2 4-2 6 0s4 2 6 0 4-2 6 0"/><path d="M3 14c3-2 4-2 6 0s4 2 6 0 4-2 6 0" opacity=".6"/><path d="M12 4l-3 -0 3 3 3-3z" fill="currentColor"/>',
  phreatic: '<path d="M3 14l6-3 5 2 7-4" stroke-dasharray="0"/><rect x="2" y="13" width="2.6" height="2.6" fill="currentColor"/><rect x="8" y="9.7" width="2.6" height="2.6" fill="currentColor"/><path d="M12 19l-3-4h6z" fill="currentColor" fill-opacity=".25"/>',
  settings: '<circle cx="12" cy="12" r="3.2"/><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M18.7 5.3l-2.1 2.1M7.4 16.6l-2.1 2.1"/>',
  solve: '<path d="M7 4l13 8-13 8z" fill="currentColor" fill-opacity=".2"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" fill-opacity=".2"/>',
  plot: '<path d="M3 20h18M3 20V4"/><path d="M5 17c3-1 4-9 8-9s4 5 8 3" /><path d="M5 17c3 0 5-5 8-5s5 2 8 1" opacity=".5"/>',
  probe: '<circle cx="12" cy="12" r="5"/><path d="M12 2v5M12 17v5M2 12h5M17 12h5"/><circle cx="12" cy="12" r="1" fill="currentColor"/>',
  section: '<path d="M4 19L20 5"/><path d="M4 16v6M20 2v6" /><path d="M9 20l1.5-2.2M13 16l1.5-2.2" stroke-width="1.2"/>',
  stage: '<path d="M12 3l9 4.5-9 4.5-9-4.5z"/><path d="M3 12l9 4.5 9-4.5M3 16.5l9 4.5 9-4.5" opacity=".7"/>',
  geometry: '<path d="M4 18l4-12 11 3 1 9z" fill="currentColor" fill-opacity=".12"/><rect x="2.8" y="16.8" width="2.8" height="2.8" fill="currentColor"/><rect x="6.6" y="4.6" width="2.8" height="2.8" fill="currentColor"/><rect x="17.6" y="7.6" width="2.8" height="2.8" fill="currentColor"/><rect x="18.6" y="16.6" width="2.8" height="2.8" fill="currentColor"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 115 .6c0 1.8-2.5 2-2.5 3.9M12 17v.5"/>',
  grid: '<path d="M4 4h16v16H4zM4 9.3h16M4 14.7h16M9.3 4v16M14.7 4v16"/>',
  snap: '<path d="M7 4v8a5 5 0 0010 0V4"/><path d="M7 8h3M14 8h3"/><path d="M5 20h14" stroke-dasharray="2 2.5"/>',
  console: '<rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M7 9l3 3-3 3M12 16h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/>',
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>',
  close: '<path d="M6 6l12 12M18 6L6 18"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  edit: '<path d="M4 20l1-4L16 5l3 3L8 19z"/><path d="M14 7l3 3"/>',
  chevron: '<path d="M8 10l4 4 4-4"/>',
  clear: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M16 8V4H4v12h4"/>',
  download: '<path d="M12 4v11M7 11l5 5 5-5M4 20h16"/>',
  fos: '<path d="M4 20h16"/><path d="M5 20c2-8 6-11 14-12"/><path d="M13 13l4 4M17 13l-4 4" stroke-width="1.3"/>',
  warning: '<path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/>',
};

/** Icon markup (string) for name; unknown names give an empty box. */
export function icon(name, size = 20) {
  const body = raw[name] ?? '<rect x="5" y="5" width="14" height="14"/>';
  return S(body).replace('width="20" height="20"', `width="${size}" height="${size}"`);
}

export const iconNames = Object.keys(raw);
