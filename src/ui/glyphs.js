// DOM-free generators for boundary-condition, load and water symbols (screen-space geometry), plus hit-testing on them.
import { pointInPolygon, polylineYAt, bbox, distPointSegment } from '../core/geom.js';

/** Bounding box of region geometry, or null. */
function domainBox(model) {
  const pts = [];
  for (const r of model.regions || []) pts.push(...r.points);
  return pts.length ? bbox(pts) : null;
}

function insideDomain(model, p) {
  for (const r of model.regions || []) if (pointInPolygon(p, r.points)) return true;
  return false;
}

/**
 * Outward unit direction (model space) at point/segment mid `m`. If `axis` ('x'|'y') given, the result is axis
 * aligned (sign chosen so the probe point lies outside the domain); otherwise the segment normal `n`.
 */
export function outwardDir(model, m, { axis = null, normal = [0, -1], probe = 1e-3 } = {}) {
  const box = domainBox(model);
  const size = box ? Math.max(box.xmax - box.xmin, box.ymax - box.ymin, 1e-6) : 1;
  const d = size * probe;
  let cand;
  if (axis === 'x') cand = [[1, 0], [-1, 0]];
  else if (axis === 'y') cand = [[0, 1], [0, -1]];
  else cand = [normal, [-normal[0], -normal[1]]];
  const in0 = insideDomain(model, [m[0] + cand[0][0] * d, m[1] + cand[0][1] * d]);
  const in1 = insideDomain(model, [m[0] + cand[1][0] * d, m[1] + cand[1][1] * d]);
  if (in0 && !in1) return cand[1];
  if (!in0 && in1) return cand[0];
  // ambiguous (both outside e.g. on a thin line, or both inside): fall back to away from domain centre
  if (box) {
    const c = [(box.xmin + box.xmax) / 2, (box.ymin + box.ymax) / 2];
    const dot0 = (m[0] - c[0]) * cand[0][0] + (m[1] - c[1]) * cand[0][1];
    return dot0 >= 0 ? cand[0] : cand[1];
  }
  return cand[0];
}

/** Resolve a boundary entry into drawable pieces: [{a,b|null, fixX, fixY}] in model space. */
export function boundaryPieces(model, bnd) {
  const t = bnd.target || {};
  if (t.kind === 'auto') {
    const bx = domainBox(model);
    if (!bx) return [];
    return [
      { a: [bx.xmin, bx.ymin], b: [bx.xmax, bx.ymin], fixX: true, fixY: true },
      { a: [bx.xmin, bx.ymin], b: [bx.xmin, bx.ymax], fixX: true, fixY: false },
      { a: [bx.xmax, bx.ymin], b: [bx.xmax, bx.ymax], fixX: true, fixY: false },
    ];
  }
  if (t.kind === 'segment') return [{ a: t.p1, b: t.p2, fixX: !!bnd.fixX, fixY: !!bnd.fixY }];
  if (t.kind === 'point') return [{ a: t.p, b: null, fixX: !!bnd.fixX, fixY: !!bnd.fixY }];
  return [];
}

/**
 * Support symbols in screen space. Each: { id, x, y (support point), dx, dy (outward unit, screen), type: 'pin'|'rollerX'|'rollerY' }.
 * 'rollerX' = x fixed (moves freely in y), 'rollerY' = y fixed (moves freely in x).
 */
export function bcGlyphs(model, view, spacingPx = 26) {
  const out = [];
  for (const bnd of model.boundaries || []) {
    if (bnd.type !== 'fixity') continue;
    for (const pc of boundaryPieces(model, bnd)) {
      const type = pc.fixX && pc.fixY ? 'pin' : pc.fixX ? 'rollerX' : pc.fixY ? 'rollerY' : null;
      if (!type) continue;
      const pa = pc.a, pb = pc.b || pc.a;
      const len = Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
      const sa = view.toScreen(pa), sb = view.toScreen(pb);
      const lenPx = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
      const n = pc.b ? Math.max(1, Math.round(lenPx / spacingPx)) : 0;
      const mid = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2];
      let dir;
      if (type === 'pin') {
        const tan = len > 0 ? [(pb[0] - pa[0]) / len, (pb[1] - pa[1]) / len] : [1, 0];
        dir = outwardDir(model, mid, { normal: [-tan[1], tan[0]] });
        if (!pc.b) dir = [0, -1];
      } else dir = outwardDir(model, mid, { axis: type === 'rollerX' ? 'x' : 'y' });
      const sdir = [dir[0], -dir[1]]; // flip y for screen
      for (let i = 0; i <= n; i++) {
        const t = n === 0 ? 0 : i / n;
        const sx = sa[0] + (sb[0] - sa[0]) * t, sy = sa[1] + (sb[1] - sa[1]) * t;
        out.push({ id: bnd.id, x: sx, y: sy, dx: sdir[0], dy: sdir[1], type });
      }
    }
  }
  return out;
}

/** Hit test boundary entries at model point p (tolerance model units). Returns boundary id or null. */
export function hitBoundary(model, p, tol) {
  let best = null, bd = tol;
  for (const bnd of model.boundaries || []) {
    for (const pc of boundaryPieces(model, bnd)) {
      const d = pc.b ? distPointSegment(p, pc.a, pc.b) : Math.hypot(p[0] - pc.a[0], p[1] - pc.a[1]);
      if (d <= bd) { bd = d; best = bnd.id; }
    }
  }
  return best;
}

/**
 * Load arrows in screen space. Point load: {id, kind:'point', tip:[x,y], tail:[x,y], label}.
 * Distributed: {id, kind:'dist', arrows:[{tip,tail}], tailLine:[[x,y]...], labels:[{x,y,text}]}.
 * Arrow length scales with magnitude relative to the largest load of the same kind.
 */
export function loadGlyphs(model, view, { minLen = 22, maxLen = 56, spacing = 24, fmt = (v) => String(+v.toPrecision(4)) } = {}) {
  const loads = model.loads || [];
  let maxP = 0, maxQ = 0;
  for (const l of loads) {
    if (l.type === 'point') maxP = Math.max(maxP, Math.hypot(l.fx, l.fy));
    else if (l.type === 'distributed') maxQ = Math.max(maxQ, Math.hypot(l.qx1, l.qy1), Math.hypot(l.qx2, l.qy2));
  }
  const lenFor = (mag, max) => (max > 0 ? minLen + (maxLen - minLen) * (mag / max) : minLen);
  const out = [];
  for (const l of loads) {
    if (l.type === 'point') {
      const mag = Math.hypot(l.fx, l.fy);
      if (!(mag > 0)) continue;
      const tip = view.toScreen(l.p);
      const u = [l.fx / mag, -l.fy / mag];
      const len = lenFor(mag, maxP);
      out.push({ id: l.id, kind: 'point', tip, tail: [tip[0] - u[0] * len, tip[1] - u[1] * len], label: `${fmt(mag)} kN/m` });
    } else if (l.type === 'distributed') {
      const sa = view.toScreen(l.p1), sb = view.toScreen(l.p2);
      const lenPx = Math.hypot(sb[0] - sa[0], sb[1] - sa[1]);
      const n = Math.max(1, Math.round(lenPx / spacing));
      const arrows = [], tailLine = [];
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        const qx = l.qx1 + (l.qx2 - l.qx1) * t, qy = l.qy1 + (l.qy2 - l.qy1) * t;
        const mag = Math.hypot(qx, qy);
        const tip = [sa[0] + (sb[0] - sa[0]) * t, sa[1] + (sb[1] - sa[1]) * t];
        if (!(mag > 1e-12)) { tailLine.push(tip); continue; }
        const len = lenFor(mag, maxQ);
        const u = [qx / mag, -qy / mag];
        const tail = [tip[0] - u[0] * len, tip[1] - u[1] * len];
        arrows.push({ tip, tail });
        tailLine.push(tail);
      }
      const m1 = Math.hypot(l.qx1, l.qy1), m2 = Math.hypot(l.qx2, l.qy2);
      const labels = [];
      if (arrows.length) {
        const a0 = tailLine[0], a1 = tailLine[tailLine.length - 1];
        if (Math.abs(m1 - m2) < 1e-9 * Math.max(1, m1)) labels.push({ x: (a0[0] + a1[0]) / 2, y: (a0[1] + a1[1]) / 2, text: `${fmt(m1)} kPa` });
        else { labels.push({ x: a0[0], y: a0[1], text: fmt(m1) }); labels.push({ x: a1[0], y: a1[1], text: `${fmt(m2)} kPa` }); }
      }
      out.push({ id: l.id, kind: 'dist', arrows, tailLine, labels, base: [sa, sb] });
    }
  }
  return out;
}

/** Hit-test loads using their screen glyphs; (sx,sy) screen point, tolPx pixels. Returns load id or null. */
export function hitLoad(model, view, sx, sy, tolPx = 7) {
  const p = [sx, sy];
  let best = null, bd = tolPx;
  for (const g of loadGlyphs(model, view)) {
    if (g.kind === 'point') {
      const d = distPointSegment(p, g.tail, g.tip);
      if (d <= bd) { bd = d; best = g.id; }
    } else {
      for (const a of g.arrows) {
        const d = distPointSegment(p, a.tail, a.tip);
        if (d <= bd) { bd = d; best = g.id; }
      }
      for (let i = 0; i < g.tailLine.length - 1; i++) {
        const d = distPointSegment(p, g.tailLine[i], g.tailLine[i + 1]);
        if (d <= bd) { bd = d; best = g.id; }
      }
      const d = distPointSegment(p, g.base[0], g.base[1]);
      if (d <= bd) { bd = d; best = g.id; }
    }
  }
  return best;
}

/** Water table in screen space: {pts:[[x,y]...], symbol:{x,y}|null}. Symbol sits near the right end of the line. */
export function waterGlyph(model, view) {
  const ph = model.water?.phreatic || [];
  const pts = ph.map((p) => view.toScreen(p));
  let symbol = null;
  if (ph.length >= 1) {
    const xr = Math.max(...ph.map((p) => p[0]));
    const x = xr - 28 / view.scale;
    const y = ph.length >= 2 ? polylineYAt(ph, x) : ph[0][1];
    const s = view.toScreen([x, y]);
    symbol = { x: s[0], y: s[1] };
  }
  return { pts, symbol };
}
