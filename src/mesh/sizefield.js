// Mesh size field: target edge length as a function of position (DOM-free).
//
// h(p) = min( meshSize, min_i ( size_i + grading * max(0, dist(p, feature_i) - radius_i) ) )
// Features are points {p:[x,y]} or segments {p1:[x,y], p2:[x,y]} with a target size inside `radius`.
// Outside the radius the size grows linearly with slope `grading` (< 1 keeps the transition smooth).
// Queries are accelerated with a uniform bucket grid: a feature only matters within the distance at which
// its size reaches meshSize, so each query inspects just the features whose influence box covers its cell.

export function makeSizeField(meshSize, refine = [], grading = 0.4) {
  const ent = [];
  let hmin = meshSize;
  let grid = null;
  let globalList = [];
  const cell = Math.max(meshSize, 1e-12);
  const cellKey = (ix, iy) => (ix + 1048576) * 2097152 + (iy + 1048576);

  function add(x1, y1, x2, y2, size, radius) {
    if (!(size > 0) || !(size < meshSize)) return;
    ent.push({ x1, y1, dx: x2 - x1, dy: y2 - y1, l2: (x2 - x1) ** 2 + (y2 - y1) ** 2, size, radius: Math.max(0, radius || 0) });
    if (size < hmin) hmin = size;
    grid = null;
  }

  function build() {
    grid = new Map();
    globalList = [];
    for (let i = 0; i < ent.length; i++) {
      const e = ent[i];
      if (!(grading > 0)) { globalList.push(i); continue; }
      const R = e.radius + (meshSize - e.size) / grading;
      const x0 = Math.min(e.x1, e.x1 + e.dx) - R, x1 = Math.max(e.x1, e.x1 + e.dx) + R;
      const y0 = Math.min(e.y1, e.y1 + e.dy) - R, y1 = Math.max(e.y1, e.y1 + e.dy) + R;
      const ix0 = Math.floor(x0 / cell), ix1 = Math.floor(x1 / cell);
      const iy0 = Math.floor(y0 / cell), iy1 = Math.floor(y1 / cell);
      if ((ix1 - ix0 + 1) * (iy1 - iy0 + 1) > 4096) { globalList.push(i); continue; }
      for (let ix = ix0; ix <= ix1; ix++) {
        for (let iy = iy0; iy <= iy1; iy++) {
          const k = cellKey(ix, iy);
          const l = grid.get(k);
          if (l) l.push(i); else grid.set(k, [i]);
        }
      }
    }
  }

  function evalEntry(e, x, y, h) {
    let d;
    if (e.l2 === 0) d = Math.hypot(x - e.x1, y - e.y1);
    else {
      let t = ((x - e.x1) * e.dx + (y - e.y1) * e.dy) / e.l2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      d = Math.hypot(x - e.x1 - t * e.dx, y - e.y1 - t * e.dy);
    }
    const hh = e.size + grading * (d > e.radius ? d - e.radius : 0);
    return hh < h ? hh : h;
  }

  for (const r of refine || []) {
    if (!r) continue;
    if (Array.isArray(r.p) && r.p.length === 2) add(r.p[0], r.p[1], r.p[0], r.p[1], r.size, r.radius);
    else if (Array.isArray(r.p1) && Array.isArray(r.p2)) add(r.p1[0], r.p1[1], r.p2[0], r.p2[1], r.size, r.radius);
  }

  return {
    meshSize,
    grading,
    get hmin() { return hmin; },
    get constant() { return ent.length === 0; },
    addPoint(x, y, size, radius) { add(x, y, x, y, size, radius); },
    addSegment(x1, y1, x2, y2, size, radius) { add(x1, y1, x2, y2, size, radius); },
    at(x, y) {
      let h = meshSize;
      if (ent.length === 0) return h;
      if (!grid) build();
      const list = grid.get(cellKey(Math.floor(x / cell), Math.floor(y / cell)));
      if (list) for (let i = 0; i < list.length; i++) h = evalEntry(ent[list[i]], x, y, h);
      for (let i = 0; i < globalList.length; i++) h = evalEntry(ent[globalList[i]], x, y, h);
      return h;
    },
  };
}
