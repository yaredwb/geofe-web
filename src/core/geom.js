// Shared 2D geometry helpers (DOM-free). Points are [x, y] arrays.

export function polygonArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

export function pointInPolygon(p, pts) {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function projectOnSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const point = [a[0] + t * dx, a[1] + t * dy];
  return { t, point, dist: Math.hypot(p[0] - point[0], p[1] - point[1]) };
}

export function distPointSegment(p, a, b) {
  return projectOnSegment(p, a, b).dist;
}

export function bbox(pts) {
  let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
  for (const [x, y] of pts) {
    if (x < xmin) xmin = x;
    if (y < ymin) ymin = y;
    if (x > xmax) xmax = x;
    if (y > ymax) ymax = y;
  }
  return { xmin, ymin, xmax, ymax };
}

// Proper segment intersection (including touching). Returns intersection point or null. Collinear overlap → null.
export function segIntersect(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const den = r[0] * s[1] - r[1] * s[0];
  if (Math.abs(den) < 1e-14) return null;
  const qp = [c[0] - a[0], c[1] - a[1]];
  const t = (qp[0] * s[1] - qp[1] * s[0]) / den;
  const u = (qp[0] * r[1] - qp[1] * r[0]) / den;
  const eps = 1e-12;
  if (t < -eps || t > 1 + eps || u < -eps || u > 1 + eps) return null;
  return [a[0] + t * r[0], a[1] + t * r[1]];
}

// y of a polyline (sorted by x) at abscissa x; clamps to end values beyond the ends. null for empty polyline.
export function polylineYAt(poly, x) {
  if (!poly || poly.length === 0) return null;
  if (poly.length === 1) return poly[0][1];
  const pts = [...poly].sort((p, q) => p[0] - q[0]);
  if (x <= pts[0][0]) return pts[0][1];
  if (x >= pts[pts.length - 1][0]) return pts[pts.length - 1][1];
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    if (x >= x1 && x <= x2) return x2 === x1 ? Math.max(y1, y2) : y1 + ((x - x1) / (x2 - x1)) * (y2 - y1);
  }
  return pts[pts.length - 1][1];
}

/** True when two non-adjacent edges of the closed ring properly cross each other (bowtie, figure eight). */
export function ringSelfIntersects(points) {
  const pts = [];
  for (const p of points) { const q = pts[pts.length - 1]; if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p); }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  const n = pts.length;
  const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const eps = 1e-12;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (j === i + 1 || (i === 0 && j === n - 1)) continue;
      const a = pts[i], b = pts[(i + 1) % n], c = pts[j], d = pts[(j + 1) % n];
      const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
      if (((o1 > eps && o2 < -eps) || (o1 < -eps && o2 > eps)) && ((o3 > eps && o4 < -eps) || (o3 < -eps && o4 > eps))) return true;
    }
  }
  return false;
}
