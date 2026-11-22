// Robust geometric predicates for the mesher (DOM-free).
//
// orient2d / incircle use a fast floating-point filter (Shewchuk-style static error
// bounds). When the filter cannot certify the sign, the determinant is evaluated exactly
// with BigInt arithmetic (every double is a dyadic rational, so scaling all inputs by a
// common power of two yields exact integers). The exact path is rare and only taken for
// (nearly) degenerate configurations such as collinear or cocircular lattice points.

const EPS = 1.1102230246251565e-16; // 2^-53
const CCW_ERRBOUND_A = (3 + 16 * EPS) * EPS;
const ICC_ERRBOUND_A = (10 + 96 * EPS) * EPS;
const SPLITTER = 134217729; // 2^27 + 1 (Dekker split)

const dv = new DataView(new ArrayBuffer(8));

// Decompose a finite double into (BigInt mantissa, integer exponent): x = m * 2^e.
function decompose(x, out, k) {
  if (x === 0) { out.m[k] = 0n; out.e[k] = 0; return; }
  dv.setFloat64(0, x);
  const hi = dv.getUint32(0);
  const lo = dv.getUint32(4);
  const be = (hi >>> 20) & 0x7ff;
  let m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let e;
  if (be === 0) e = -1074;
  else { m |= 1n << 52n; e = be - 1075; }
  out.m[k] = (hi >>> 31) ? -m : m;
  out.e[k] = e;
}

const scratch = { m: new Array(8), e: new Array(8) };

// Convert up to 8 doubles to exact BigInt integers sharing a common scale.
function toBig(vals) {
  const n = vals.length;
  let emin = Infinity;
  for (let i = 0; i < n; i++) {
    decompose(vals[i], scratch, i);
    if (scratch.m[i] !== 0n && scratch.e[i] < emin) emin = scratch.e[i];
  }
  if (emin === Infinity) emin = 0;
  const res = new Array(n);
  for (let i = 0; i < n; i++) {
    res[i] = scratch.m[i] === 0n ? 0n : scratch.m[i] << BigInt(scratch.e[i] - emin);
  }
  return res;
}

function twoDiffTail(a, b, x) {
  const bvirt = a - x;
  const avirt = x + bvirt;
  return (a - avirt) + (bvirt - b);
}

function twoProductTail(a, b, x) {
  let c = SPLITTER * a;
  const ahi = c - (c - a);
  const alo = a - ahi;
  c = SPLITTER * b;
  const bhi = c - (c - b);
  const blo = b - bhi;
  return alo * blo - (((x - ahi * bhi) - alo * bhi) - ahi * blo);
}

export function orient2dExact(ax, ay, bx, by, cx, cy) {
  const v = toBig([ax, ay, bx, by, cx, cy]);
  const det = (v[0] - v[4]) * (v[3] - v[5]) - (v[1] - v[5]) * (v[2] - v[4]);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

/** > 0 if a,b,c are counter-clockwise, < 0 if clockwise, 0 if collinear (sign is exact). */
export function orient2d(ax, ay, bx, by, cx, cy) {
  const detleft = (ax - cx) * (by - cy);
  const detright = (ay - cy) * (bx - cx);
  const det = detleft - detright;
  let detsum;
  if (detleft > 0) {
    if (detright <= 0) return det;
    detsum = detleft + detright;
  } else if (detleft < 0) {
    if (detright >= 0) return det;
    detsum = -detleft - detright;
  } else {
    return det;
  }
  const errbound = CCW_ERRBOUND_A * detsum;
  if (det >= errbound || -det >= errbound) return det;
  // Stage B: if every elementary operation was exact the floating result is exact.
  const acx = ax - cx, acy = ay - cy, bcx = bx - cx, bcy = by - cy;
  if (twoDiffTail(ax, cx, acx) === 0 && twoDiffTail(ay, cy, acy) === 0 &&
      twoDiffTail(bx, cx, bcx) === 0 && twoDiffTail(by, cy, bcy) === 0 &&
      twoProductTail(acx, bcy, detleft) === 0 && twoProductTail(acy, bcx, detright) === 0 &&
      twoDiffTail(detleft, detright, det) === 0) {
    return det;
  }
  return orient2dExact(ax, ay, bx, by, cx, cy);
}

export function incircleExact(ax, ay, bx, by, cx, cy, dx, dy) {
  const v = toBig([ax, ay, bx, by, cx, cy, dx, dy]);
  const adx = v[0] - v[6], ady = v[1] - v[7];
  const bdx = v[2] - v[6], bdy = v[3] - v[7];
  const cdx = v[4] - v[6], cdy = v[5] - v[7];
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  const det = alift * (bdx * cdy - cdx * bdy) + blift * (cdx * ady - adx * cdy) + clift * (adx * bdy - bdx * ady);
  return det > 0n ? 1 : det < 0n ? -1 : 0;
}

/** > 0 if d lies strictly inside the circumcircle of the CCW triangle a,b,c; < 0 outside; 0 on the circle. */
export function incircle(ax, ay, bx, by, cx, cy, dx, dy) {
  const adx = ax - dx, ady = ay - dy;
  const bdx = bx - dx, bdy = by - dy;
  const cdx = cx - dx, cdy = cy - dy;
  const bdxcdy = bdx * cdy, cdxbdy = cdx * bdy;
  const cdxady = cdx * ady, adxcdy = adx * cdy;
  const adxbdy = adx * bdy, bdxady = bdx * ady;
  const alift = adx * adx + ady * ady;
  const blift = bdx * bdx + bdy * bdy;
  const clift = cdx * cdx + cdy * cdy;
  const det = alift * (bdxcdy - cdxbdy) + blift * (cdxady - adxcdy) + clift * (adxbdy - bdxady);
  const permanent =
    (Math.abs(bdxcdy) + Math.abs(cdxbdy)) * alift +
    (Math.abs(cdxady) + Math.abs(adxcdy)) * blift +
    (Math.abs(adxbdy) + Math.abs(bdxady)) * clift;
  const errbound = ICC_ERRBOUND_A * permanent;
  if (det > errbound || -det > errbound) return det;
  return incircleExact(ax, ay, bx, by, cx, cy, dx, dy);
}
