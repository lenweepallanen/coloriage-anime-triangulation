// docs/triangulation/auto_triang_geom.ts
import { readFileSync } from "node:fs";

// apps/admin/src/utils/pdfLayout.ts
var FINDER_MM = 12;
var FINDER_QUIET_MM = 2;
var FINDER_KNOCKOUT_MM = FINDER_MM + 2 * FINDER_QUIET_MM;
var SCAN_TOTAL = 2048;
var SCAN_IMAGE_FRAME = 1920;
var SCAN_IMAGE_OFFSET = (SCAN_TOTAL - SCAN_IMAGE_FRAME) / 2;

// apps/admin/src/utils/curvilinearContour.ts
function computeArcLengths(path) {
  const lengths = [0];
  for (let i = 1; i < path.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(
      path[i].x - path[i - 1].x,
      path[i].y - path[i - 1].y
    ));
  }
  return lengths;
}
function interpolateAtArcLength(path, arcLengths, t) {
  if (path.length === 0) return { x: 0, y: 0 };
  if (path.length === 1 || t <= 0) return { ...path[0] };
  if (t >= 1) return { ...path[path.length - 1] };
  const totalLength = arcLengths[arcLengths.length - 1];
  const targetLength = t * totalLength;
  let lo = 0, hi = arcLengths.length - 1;
  while (lo < hi - 1) {
    const mid = lo + hi >> 1;
    if (arcLengths[mid] <= targetLength) lo = mid;
    else hi = mid;
  }
  const segLength = arcLengths[hi] - arcLengths[lo];
  if (segLength < 1e-10) return { ...path[lo] };
  const segT = (targetLength - arcLengths[lo]) / segLength;
  return {
    x: path[lo].x + segT * (path[hi].x - path[lo].x),
    y: path[lo].y + segT * (path[hi].y - path[lo].y)
  };
}
function reorderContourFromOrigin(orderedContour, originPoint) {
  if (orderedContour.length === 0) return orderedContour;
  const originIdx = findClosestOnPath(orderedContour, originPoint);
  if (originIdx === 0) return orderedContour;
  return [...orderedContour.slice(originIdx), ...orderedContour.slice(0, originIdx)];
}
function findClosestOnPath(path, target) {
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = Math.hypot(path[i].x - target.x, path[i].y - target.y);
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return bestIdx;
}
function extractPathBetweenAnchors(orderedContour, anchorA, anchorB) {
  const n = orderedContour.length;
  if (n === 0) return [];
  const idxA = findClosestOnPath(orderedContour, anchorA);
  const idxB = findClosestOnPath(orderedContour, anchorB);
  const forward = [];
  let i = idxA;
  while (true) {
    forward.push(orderedContour[i]);
    if (i === idxB) break;
    i = (i + 1) % n;
    if (forward.length > n) break;
  }
  const backward = [];
  i = idxA;
  while (true) {
    backward.push(orderedContour[i]);
    if (i === idxB) break;
    i = (i - 1 + n) % n;
    if (backward.length > n) break;
  }
  return forward.length <= backward.length ? forward : backward;
}
function subdivideSegment(path, count, segmentIndex) {
  if (count <= 0 || path.length < 2) return { points: [], params: [] };
  const arcLengths = computeArcLengths(path);
  const points = [];
  const params2 = [];
  for (let i = 1; i <= count; i++) {
    const t = i / (count + 1);
    points.push(interpolateAtArcLength(path, arcLengths, t));
    params2.push({ segmentIndex, t });
  }
  return { points, params: params2 };
}
function subdivideContour(orderedContour, anchors, pointsPerSegment) {
  const allPoints = [];
  const allParams = [];
  const n = anchors.length;
  for (let i = 0; i < n; i++) {
    const count = Array.isArray(pointsPerSegment) ? pointsPerSegment[i] ?? 0 : pointsPerSegment;
    const j = (i + 1) % n;
    const path = extractPathBetweenAnchors(orderedContour, anchors[i], anchors[j]);
    const { points, params: params2 } = subdivideSegment(path, count, i);
    allPoints.push(...points);
    allParams.push(...params2);
  }
  return { points: allPoints, params: allParams };
}

// apps/admin/src/utils/sam2Contour.ts
function smoothPolygonGaussian(polygon, sigma) {
  const n = polygon.length;
  if (n < 3 || sigma <= 0) return polygon;
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Array(2 * radius + 1);
  let sum2 = 0;
  for (let i = -radius; i <= radius; i++) {
    const w2 = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = w2;
    sum2 += w2;
  }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum2;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let sx = 0;
    let sy = 0;
    for (let k = -radius; k <= radius; k++) {
      const idx = ((i + k) % n + n) % n;
      const w2 = kernel[k + radius];
      sx += polygon[idx].x * w2;
      sy += polygon[idx].y * w2;
    }
    out[i] = { x: sx, y: sy };
  }
  return out;
}

// apps/admin/src/utils/curvatureScaleSpace.ts
function gaussianDerivativeKernel(sigma, order) {
  const halfK = Math.ceil(4 * sigma);
  const size = halfK * 2 + 1;
  const kernel = new Array(size);
  const sigma2 = sigma * sigma;
  const sigma4 = sigma2 * sigma2;
  let sum2 = 0;
  for (let i = 0; i < size; i++) {
    const x = i - halfK;
    const g = Math.exp(-(x * x) / (2 * sigma2));
    if (order === 0) {
      kernel[i] = g;
      sum2 += g;
    } else if (order === 1) {
      kernel[i] = -x / sigma2 * g;
    } else {
      kernel[i] = (x * x - sigma2) / sigma4 * g;
    }
  }
  if (order === 0) {
    for (let i = 0; i < size; i++) kernel[i] /= sum2;
  }
  return kernel;
}
function convolveWrapped(signal, kernel) {
  const N = signal.length;
  const halfK = (kernel.length - 1) / 2;
  const result = new Array(N);
  for (let i = 0; i < N; i++) {
    let val = 0;
    for (let j = 0; j < kernel.length; j++) {
      const idx = ((i - halfK + j) % N + N) % N;
      val += signal[idx] * kernel[j];
    }
    result[i] = val;
  }
  return result;
}
function reparameterizeByArcLength(path, numSamples) {
  const arcLengths = computeArcLengths(path);
  const totalLength = arcLengths[arcLengths.length - 1];
  if (totalLength < 1e-6) {
    return {
      points: new Array(numSamples).fill({ ...path[0] }),
      totalLength: 0
    };
  }
  const points = [];
  for (let i = 0; i < numSamples; i++) {
    const t = i / numSamples;
    points.push(interpolateAtArcLength(path, arcLengths, t));
  }
  return { points, totalLength };
}
function computeCurvature(xs, ys, sigma) {
  const g1 = gaussianDerivativeKernel(sigma, 1);
  const g2 = gaussianDerivativeKernel(sigma, 2);
  const xPrime = convolveWrapped(xs, g1);
  const yPrime = convolveWrapped(ys, g1);
  const xDoublePrime = convolveWrapped(xs, g2);
  const yDoublePrime = convolveWrapped(ys, g2);
  const N = xs.length;
  const kappa = new Array(N);
  const EPS = 1e-10;
  for (let i = 0; i < N; i++) {
    const xp = xPrime[i];
    const yp = yPrime[i];
    const xpp = xDoublePrime[i];
    const ypp = yDoublePrime[i];
    const denom = Math.pow(xp * xp + yp * yp, 1.5);
    kappa[i] = denom > EPS ? (xp * ypp - yp * xpp) / denom : 0;
  }
  return kappa;
}
function contourOrientation(xs, ys) {
  const N = xs.length;
  let signedArea = 0;
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    signedArea += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return signedArea >= 0 ? 1 : -1;
}
function findCurvatureExtrema(kappa, minProminence, orientation) {
  const N = kappa.length;
  if (N < 3) return [];
  const absK = kappa.map(Math.abs);
  const peaks = [];
  for (let i = 0; i < N; i++) {
    const prev = absK[(i - 1 + N) % N];
    const curr = absK[i];
    const next = absK[(i + 1) % N];
    if (curr > prev && curr > next) {
      peaks.push({ index: i, value: curr });
    }
  }
  if (peaks.length === 0) return [];
  const result = [];
  for (const peak of peaks) {
    let leftMin = peak.value;
    let rightMin = peak.value;
    for (let steps = 1; steps < N; steps++) {
      const idx = (peak.index - steps + N) % N;
      leftMin = Math.min(leftMin, absK[idx]);
      if (absK[idx] > peak.value) break;
    }
    for (let steps = 1; steps < N; steps++) {
      const idx = (peak.index + steps) % N;
      rightMin = Math.min(rightMin, absK[idx]);
      if (absK[idx] > peak.value) break;
    }
    const prominence = peak.value - Math.max(leftMin, rightMin);
    if (prominence >= minProminence) {
      const isConvex = kappa[peak.index] * orientation > 0;
      result.push({
        index: peak.index,
        arcLengthNorm: peak.index / N,
        absKappa: peak.value,
        prominence,
        isConvex
      });
    }
  }
  result.sort((a, b) => b.absKappa - a.absKappa);
  return result;
}
function detectCurvatureExtrema(path, numPoints, sigma = 4) {
  if (path.length < 10) return [];
  const N = Math.min(path.length, 1024);
  const { points } = reparameterizeByArcLength(path, N);
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const orientation = contourOrientation(xs, ys);
  const kappa = computeCurvature(xs, ys, sigma);
  const peaks = findCurvatureExtrema(kappa, 0, orientation);
  if (peaks.length === 0) return [];
  const minArcSpacing = 1 / (numPoints * 2);
  const accepted = [];
  for (const peak of peaks) {
    if (accepted.length >= numPoints) break;
    let tooClose = false;
    for (const acc of accepted) {
      let d = Math.abs(peak.arcLengthNorm - acc.arcLengthNorm);
      if (d > 0.5) d = 1 - d;
      if (d < minArcSpacing) {
        tooClose = true;
        break;
      }
    }
    if (!tooClose) {
      accepted.push({
        arcLengthNorm: peak.arcLengthNorm,
        position: points[peak.index],
        score: peak.absKappa
      });
    }
  }
  return accepted;
}

// node_modules/robust-predicates/esm/util.js
var epsilon = 11102230246251565e-32;
var splitter = 134217729;
var resulterrbound = (3 + 8 * epsilon) * epsilon;
function sum(elen, e, flen, f, h2) {
  let Q, Qnew, hh, bvirt;
  let enow = e[0];
  let fnow = f[0];
  let eindex = 0;
  let findex = 0;
  if (fnow > enow === fnow > -enow) {
    Q = enow;
    enow = e[++eindex];
  } else {
    Q = fnow;
    fnow = f[++findex];
  }
  let hindex = 0;
  if (eindex < elen && findex < flen) {
    if (fnow > enow === fnow > -enow) {
      Qnew = enow + Q;
      hh = Q - (Qnew - enow);
      enow = e[++eindex];
    } else {
      Qnew = fnow + Q;
      hh = Q - (Qnew - fnow);
      fnow = f[++findex];
    }
    Q = Qnew;
    if (hh !== 0) {
      h2[hindex++] = hh;
    }
    while (eindex < elen && findex < flen) {
      if (fnow > enow === fnow > -enow) {
        Qnew = Q + enow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (enow - bvirt);
        enow = e[++eindex];
      } else {
        Qnew = Q + fnow;
        bvirt = Qnew - Q;
        hh = Q - (Qnew - bvirt) + (fnow - bvirt);
        fnow = f[++findex];
      }
      Q = Qnew;
      if (hh !== 0) {
        h2[hindex++] = hh;
      }
    }
  }
  while (eindex < elen) {
    Qnew = Q + enow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (enow - bvirt);
    enow = e[++eindex];
    Q = Qnew;
    if (hh !== 0) {
      h2[hindex++] = hh;
    }
  }
  while (findex < flen) {
    Qnew = Q + fnow;
    bvirt = Qnew - Q;
    hh = Q - (Qnew - bvirt) + (fnow - bvirt);
    fnow = f[++findex];
    Q = Qnew;
    if (hh !== 0) {
      h2[hindex++] = hh;
    }
  }
  if (Q !== 0 || hindex === 0) {
    h2[hindex++] = Q;
  }
  return hindex;
}
function estimate(elen, e) {
  let Q = e[0];
  for (let i = 1; i < elen; i++) Q += e[i];
  return Q;
}
function vec(n) {
  return new Float64Array(n);
}

// node_modules/robust-predicates/esm/orient2d.js
var ccwerrboundA = (3 + 16 * epsilon) * epsilon;
var ccwerrboundB = (2 + 12 * epsilon) * epsilon;
var ccwerrboundC = (9 + 64 * epsilon) * epsilon * epsilon;
var B = vec(4);
var C1 = vec(8);
var C2 = vec(12);
var D = vec(16);
var u = vec(4);
function orient2dadapt(ax, ay, bx, by, cx, cy, detsum) {
  let acxtail, acytail, bcxtail, bcytail;
  let bvirt, c, ahi, alo, bhi, blo, _i, _j, _0, s1, s0, t1, t0, u32;
  const acx = ax - cx;
  const bcx = bx - cx;
  const acy = ay - cy;
  const bcy = by - cy;
  s1 = acx * bcy;
  c = splitter * acx;
  ahi = c - (c - acx);
  alo = acx - ahi;
  c = splitter * bcy;
  bhi = c - (c - bcy);
  blo = bcy - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acy * bcx;
  c = splitter * acy;
  ahi = c - (c - acy);
  alo = acy - ahi;
  c = splitter * bcx;
  bhi = c - (c - bcx);
  blo = bcx - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  B[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  B[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  B[2] = _j - (u32 - bvirt) + (_i - bvirt);
  B[3] = u32;
  let det = estimate(4, B);
  let errbound = ccwerrboundB * detsum;
  if (det >= errbound || -det >= errbound) {
    return det;
  }
  bvirt = ax - acx;
  acxtail = ax - (acx + bvirt) + (bvirt - cx);
  bvirt = bx - bcx;
  bcxtail = bx - (bcx + bvirt) + (bvirt - cx);
  bvirt = ay - acy;
  acytail = ay - (acy + bvirt) + (bvirt - cy);
  bvirt = by - bcy;
  bcytail = by - (bcy + bvirt) + (bvirt - cy);
  if (acxtail === 0 && acytail === 0 && bcxtail === 0 && bcytail === 0) {
    return det;
  }
  errbound = ccwerrboundC * detsum + resulterrbound * Math.abs(det);
  det += acx * bcytail + bcy * acxtail - (acy * bcxtail + bcx * acytail);
  if (det >= errbound || -det >= errbound) return det;
  s1 = acxtail * bcy;
  c = splitter * acxtail;
  ahi = c - (c - acxtail);
  alo = acxtail - ahi;
  c = splitter * bcy;
  bhi = c - (c - bcy);
  blo = bcy - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acytail * bcx;
  c = splitter * acytail;
  ahi = c - (c - acytail);
  alo = acytail - ahi;
  c = splitter * bcx;
  bhi = c - (c - bcx);
  blo = bcx - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const C1len = sum(4, B, 4, u, C1);
  s1 = acx * bcytail;
  c = splitter * acx;
  ahi = c - (c - acx);
  alo = acx - ahi;
  c = splitter * bcytail;
  bhi = c - (c - bcytail);
  blo = bcytail - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acy * bcxtail;
  c = splitter * acy;
  ahi = c - (c - acy);
  alo = acy - ahi;
  c = splitter * bcxtail;
  bhi = c - (c - bcxtail);
  blo = bcxtail - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const C2len = sum(C1len, C1, 4, u, C2);
  s1 = acxtail * bcytail;
  c = splitter * acxtail;
  ahi = c - (c - acxtail);
  alo = acxtail - ahi;
  c = splitter * bcytail;
  bhi = c - (c - bcytail);
  blo = bcytail - bhi;
  s0 = alo * blo - (s1 - ahi * bhi - alo * bhi - ahi * blo);
  t1 = acytail * bcxtail;
  c = splitter * acytail;
  ahi = c - (c - acytail);
  alo = acytail - ahi;
  c = splitter * bcxtail;
  bhi = c - (c - bcxtail);
  blo = bcxtail - bhi;
  t0 = alo * blo - (t1 - ahi * bhi - alo * bhi - ahi * blo);
  _i = s0 - t0;
  bvirt = s0 - _i;
  u[0] = s0 - (_i + bvirt) + (bvirt - t0);
  _j = s1 + _i;
  bvirt = _j - s1;
  _0 = s1 - (_j - bvirt) + (_i - bvirt);
  _i = _0 - t1;
  bvirt = _0 - _i;
  u[1] = _0 - (_i + bvirt) + (bvirt - t1);
  u32 = _j + _i;
  bvirt = u32 - _j;
  u[2] = _j - (u32 - bvirt) + (_i - bvirt);
  u[3] = u32;
  const Dlen = sum(C2len, C2, 4, u, D);
  return D[Dlen - 1];
}
function orient2d(ax, ay, bx, by, cx, cy) {
  const detleft = (ay - cy) * (bx - cx);
  const detright = (ax - cx) * (by - cy);
  const det = detleft - detright;
  const detsum = Math.abs(detleft + detright);
  if (Math.abs(det) >= ccwerrboundA * detsum) return det;
  return -orient2dadapt(ax, ay, bx, by, cx, cy, detsum);
}

// node_modules/robust-predicates/esm/orient3d.js
var o3derrboundA = (7 + 56 * epsilon) * epsilon;
var o3derrboundB = (3 + 28 * epsilon) * epsilon;
var o3derrboundC = (26 + 288 * epsilon) * epsilon * epsilon;
var bc = vec(4);
var ca = vec(4);
var ab = vec(4);
var at_b = vec(4);
var at_c = vec(4);
var bt_c = vec(4);
var bt_a = vec(4);
var ct_a = vec(4);
var ct_b = vec(4);
var bct = vec(8);
var cat = vec(8);
var abt = vec(8);
var u2 = vec(4);
var _8 = vec(8);
var _8b = vec(8);
var _16 = vec(8);
var _12 = vec(12);
var fin = vec(192);
var fin2 = vec(192);

// node_modules/robust-predicates/esm/incircle.js
var iccerrboundA = (10 + 96 * epsilon) * epsilon;
var iccerrboundB = (4 + 48 * epsilon) * epsilon;
var iccerrboundC = (44 + 576 * epsilon) * epsilon * epsilon;
var bc2 = vec(4);
var ca2 = vec(4);
var ab2 = vec(4);
var aa = vec(4);
var bb = vec(4);
var cc = vec(4);
var u3 = vec(4);
var v = vec(4);
var axtbc = vec(8);
var aytbc = vec(8);
var bxtca = vec(8);
var bytca = vec(8);
var cxtab = vec(8);
var cytab = vec(8);
var abt2 = vec(8);
var bct2 = vec(8);
var cat2 = vec(8);
var abtt = vec(4);
var bctt = vec(4);
var catt = vec(4);
var _82 = vec(8);
var _162 = vec(16);
var _16b = vec(16);
var _16c = vec(16);
var _32 = vec(32);
var _32b = vec(32);
var _48 = vec(48);
var _64 = vec(64);
var fin3 = vec(1152);
var fin22 = vec(1152);

// node_modules/robust-predicates/esm/insphere.js
var isperrboundA = (16 + 224 * epsilon) * epsilon;
var isperrboundB = (5 + 72 * epsilon) * epsilon;
var isperrboundC = (71 + 1408 * epsilon) * epsilon * epsilon;
var ab3 = vec(4);
var bc3 = vec(4);
var cd = vec(4);
var de = vec(4);
var ea = vec(4);
var ac = vec(4);
var bd = vec(4);
var ce = vec(4);
var da = vec(4);
var eb = vec(4);
var abc = vec(24);
var bcd = vec(24);
var cde = vec(24);
var dea = vec(24);
var eab = vec(24);
var abd = vec(24);
var bce = vec(24);
var cda = vec(24);
var deb = vec(24);
var eac = vec(24);
var adet = vec(1152);
var bdet = vec(1152);
var cdet = vec(1152);
var ddet = vec(1152);
var edet = vec(1152);
var abdet = vec(2304);
var cddet = vec(2304);
var cdedet = vec(3456);
var deter = vec(5760);
var _83 = vec(8);
var _8b2 = vec(8);
var _8c = vec(8);
var _163 = vec(16);
var _24 = vec(24);
var _482 = vec(48);
var _48b = vec(48);
var _96 = vec(96);
var _192 = vec(192);
var _384x = vec(384);
var _384y = vec(384);
var _384z = vec(384);
var _768 = vec(768);
var xdet = vec(96);
var ydet = vec(96);
var zdet = vec(96);
var fin4 = vec(1152);

// node_modules/delaunator/index.js
var EPSILON = Math.pow(2, -52);
var EDGE_STACK = new Uint32Array(512);
var Delaunator = class _Delaunator {
  static from(points, getX = defaultGetX, getY = defaultGetY) {
    const n = points.length;
    const coords = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const p = points[i];
      coords[2 * i] = getX(p);
      coords[2 * i + 1] = getY(p);
    }
    return new _Delaunator(coords);
  }
  constructor(coords) {
    const n = coords.length >> 1;
    if (n > 0 && typeof coords[0] !== "number") throw new Error("Expected coords to contain numbers.");
    this.coords = coords;
    const maxTriangles = Math.max(2 * n - 5, 0);
    this._triangles = new Uint32Array(maxTriangles * 3);
    this._halfedges = new Int32Array(maxTriangles * 3);
    this._hashSize = Math.ceil(Math.sqrt(n));
    this._hullPrev = new Uint32Array(n);
    this._hullNext = new Uint32Array(n);
    this._hullTri = new Uint32Array(n);
    this._hullHash = new Int32Array(this._hashSize);
    this._ids = new Uint32Array(n);
    this._dists = new Float64Array(n);
    this.update();
  }
  update() {
    const { coords, _hullPrev: hullPrev, _hullNext: hullNext, _hullTri: hullTri, _hullHash: hullHash } = this;
    const n = coords.length >> 1;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i++) {
      const x = coords[2 * i];
      const y = coords[2 * i + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      this._ids[i] = i;
    }
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let i0, i1, i2;
    for (let i = 0, minDist = Infinity; i < n; i++) {
      const d = dist(cx, cy, coords[2 * i], coords[2 * i + 1]);
      if (d < minDist) {
        i0 = i;
        minDist = d;
      }
    }
    const i0x = coords[2 * i0];
    const i0y = coords[2 * i0 + 1];
    for (let i = 0, minDist = Infinity; i < n; i++) {
      if (i === i0) continue;
      const d = dist(i0x, i0y, coords[2 * i], coords[2 * i + 1]);
      if (d < minDist && d > 0) {
        i1 = i;
        minDist = d;
      }
    }
    let i1x = coords[2 * i1];
    let i1y = coords[2 * i1 + 1];
    let minRadius = Infinity;
    for (let i = 0; i < n; i++) {
      if (i === i0 || i === i1) continue;
      const r = circumradius(i0x, i0y, i1x, i1y, coords[2 * i], coords[2 * i + 1]);
      if (r < minRadius) {
        i2 = i;
        minRadius = r;
      }
    }
    let i2x = coords[2 * i2];
    let i2y = coords[2 * i2 + 1];
    if (minRadius === Infinity) {
      for (let i = 0; i < n; i++) {
        this._dists[i] = coords[2 * i] - coords[0] || coords[2 * i + 1] - coords[1];
      }
      quicksort(this._ids, this._dists, 0, n - 1);
      const hull = new Uint32Array(n);
      let j = 0;
      for (let i = 0, d0 = -Infinity; i < n; i++) {
        const id = this._ids[i];
        const d = this._dists[id];
        if (d > d0) {
          hull[j++] = id;
          d0 = d;
        }
      }
      this.hull = hull.subarray(0, j);
      this.triangles = new Uint32Array(0);
      this.halfedges = new Uint32Array(0);
      return;
    }
    if (orient2d(i0x, i0y, i1x, i1y, i2x, i2y) < 0) {
      const i = i1;
      const x = i1x;
      const y = i1y;
      i1 = i2;
      i1x = i2x;
      i1y = i2y;
      i2 = i;
      i2x = x;
      i2y = y;
    }
    const center = circumcenter(i0x, i0y, i1x, i1y, i2x, i2y);
    this._cx = center.x;
    this._cy = center.y;
    for (let i = 0; i < n; i++) {
      this._dists[i] = dist(coords[2 * i], coords[2 * i + 1], center.x, center.y);
    }
    quicksort(this._ids, this._dists, 0, n - 1);
    this._hullStart = i0;
    let hullSize = 3;
    hullNext[i0] = hullPrev[i2] = i1;
    hullNext[i1] = hullPrev[i0] = i2;
    hullNext[i2] = hullPrev[i1] = i0;
    hullTri[i0] = 0;
    hullTri[i1] = 1;
    hullTri[i2] = 2;
    hullHash.fill(-1);
    hullHash[this._hashKey(i0x, i0y)] = i0;
    hullHash[this._hashKey(i1x, i1y)] = i1;
    hullHash[this._hashKey(i2x, i2y)] = i2;
    this.trianglesLen = 0;
    this._addTriangle(i0, i1, i2, -1, -1, -1);
    for (let k = 0, xp, yp; k < this._ids.length; k++) {
      const i = this._ids[k];
      const x = coords[2 * i];
      const y = coords[2 * i + 1];
      if (k > 0 && Math.abs(x - xp) <= EPSILON && Math.abs(y - yp) <= EPSILON) continue;
      xp = x;
      yp = y;
      if (i === i0 || i === i1 || i === i2) continue;
      let start = 0;
      for (let j = 0, key = this._hashKey(x, y); j < this._hashSize; j++) {
        start = hullHash[(key + j) % this._hashSize];
        if (start !== -1 && start !== hullNext[start]) break;
      }
      start = hullPrev[start];
      let e = start, q;
      while (q = hullNext[e], orient2d(x, y, coords[2 * e], coords[2 * e + 1], coords[2 * q], coords[2 * q + 1]) >= 0) {
        e = q;
        if (e === start) {
          e = -1;
          break;
        }
      }
      if (e === -1) continue;
      let t = this._addTriangle(e, i, hullNext[e], -1, -1, hullTri[e]);
      hullTri[i] = this._legalize(t + 2);
      hullTri[e] = t;
      hullSize++;
      let n2 = hullNext[e];
      while (q = hullNext[n2], orient2d(x, y, coords[2 * n2], coords[2 * n2 + 1], coords[2 * q], coords[2 * q + 1]) < 0) {
        t = this._addTriangle(n2, i, q, hullTri[i], -1, hullTri[n2]);
        hullTri[i] = this._legalize(t + 2);
        hullNext[n2] = n2;
        hullSize--;
        n2 = q;
      }
      if (e === start) {
        while (q = hullPrev[e], orient2d(x, y, coords[2 * q], coords[2 * q + 1], coords[2 * e], coords[2 * e + 1]) < 0) {
          t = this._addTriangle(q, i, e, -1, hullTri[e], hullTri[q]);
          this._legalize(t + 2);
          hullTri[q] = t;
          hullNext[e] = e;
          hullSize--;
          e = q;
        }
      }
      this._hullStart = hullPrev[i] = e;
      hullNext[e] = hullPrev[n2] = i;
      hullNext[i] = n2;
      hullHash[this._hashKey(x, y)] = i;
      hullHash[this._hashKey(coords[2 * e], coords[2 * e + 1])] = e;
    }
    this.hull = new Uint32Array(hullSize);
    for (let i = 0, e = this._hullStart; i < hullSize; i++) {
      this.hull[i] = e;
      e = hullNext[e];
    }
    this.triangles = this._triangles.subarray(0, this.trianglesLen);
    this.halfedges = this._halfedges.subarray(0, this.trianglesLen);
  }
  _hashKey(x, y) {
    return Math.floor(pseudoAngle(x - this._cx, y - this._cy) * this._hashSize) % this._hashSize;
  }
  _legalize(a) {
    const { _triangles: triangles, _halfedges: halfedges, coords } = this;
    let i = 0;
    let ar = 0;
    while (true) {
      const b = halfedges[a];
      const a0 = a - a % 3;
      ar = a0 + (a + 2) % 3;
      if (b === -1) {
        if (i === 0) break;
        a = EDGE_STACK[--i];
        continue;
      }
      const b0 = b - b % 3;
      const al = a0 + (a + 1) % 3;
      const bl = b0 + (b + 2) % 3;
      const p0 = triangles[ar];
      const pr = triangles[a];
      const pl = triangles[al];
      const p1 = triangles[bl];
      const illegal = inCircle(
        coords[2 * p0],
        coords[2 * p0 + 1],
        coords[2 * pr],
        coords[2 * pr + 1],
        coords[2 * pl],
        coords[2 * pl + 1],
        coords[2 * p1],
        coords[2 * p1 + 1]
      );
      if (illegal) {
        triangles[a] = p1;
        triangles[b] = p0;
        const hbl = halfedges[bl];
        if (hbl === -1) {
          let e = this._hullStart;
          do {
            if (this._hullTri[e] === bl) {
              this._hullTri[e] = a;
              break;
            }
            e = this._hullPrev[e];
          } while (e !== this._hullStart);
        }
        this._link(a, hbl);
        this._link(b, halfedges[ar]);
        this._link(ar, bl);
        const br = b0 + (b + 1) % 3;
        if (i < EDGE_STACK.length) {
          EDGE_STACK[i++] = br;
        }
      } else {
        if (i === 0) break;
        a = EDGE_STACK[--i];
      }
    }
    return ar;
  }
  _link(a, b) {
    this._halfedges[a] = b;
    if (b !== -1) this._halfedges[b] = a;
  }
  // add a new triangle given vertex indices and adjacent half-edge ids
  _addTriangle(i0, i1, i2, a, b, c) {
    const t = this.trianglesLen;
    this._triangles[t] = i0;
    this._triangles[t + 1] = i1;
    this._triangles[t + 2] = i2;
    this._link(t, a);
    this._link(t + 1, b);
    this._link(t + 2, c);
    this.trianglesLen += 3;
    return t;
  }
};
function pseudoAngle(dx, dy) {
  const p = dx / (Math.abs(dx) + Math.abs(dy));
  return (dy > 0 ? 3 - p : 1 + p) / 4;
}
function dist(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}
function inCircle(ax, ay, bx, by, cx, cy, px, py) {
  const dx = ax - px;
  const dy = ay - py;
  const ex = bx - px;
  const ey = by - py;
  const fx = cx - px;
  const fy = cy - py;
  const ap = dx * dx + dy * dy;
  const bp = ex * ex + ey * ey;
  const cp = fx * fx + fy * fy;
  return dx * (ey * cp - bp * fy) - dy * (ex * cp - bp * fx) + ap * (ex * fy - ey * fx) < 0;
}
function circumradius(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  const x = (ey * bl - dy * cl) * d;
  const y = (dx * cl - ex * bl) * d;
  return x * x + y * y;
}
function circumcenter(ax, ay, bx, by, cx, cy) {
  const dx = bx - ax;
  const dy = by - ay;
  const ex = cx - ax;
  const ey = cy - ay;
  const bl = dx * dx + dy * dy;
  const cl = ex * ex + ey * ey;
  const d = 0.5 / (dx * ey - dy * ex);
  const x = ax + (ey * bl - dy * cl) * d;
  const y = ay + (dx * cl - ex * bl) * d;
  return { x, y };
}
function quicksort(ids, dists, left, right) {
  if (right - left <= 20) {
    for (let i = left + 1; i <= right; i++) {
      const temp = ids[i];
      const tempDist = dists[temp];
      let j = i - 1;
      while (j >= left && dists[ids[j]] > tempDist) ids[j + 1] = ids[j--];
      ids[j + 1] = temp;
    }
  } else {
    const median = left + right >> 1;
    let i = left + 1;
    let j = right;
    swap(ids, median, i);
    if (dists[ids[left]] > dists[ids[right]]) swap(ids, left, right);
    if (dists[ids[i]] > dists[ids[right]]) swap(ids, i, right);
    if (dists[ids[left]] > dists[ids[i]]) swap(ids, left, i);
    const temp = ids[i];
    const tempDist = dists[temp];
    while (true) {
      do
        i++;
      while (dists[ids[i]] < tempDist);
      do
        j--;
      while (dists[ids[j]] > tempDist);
      if (j < i) break;
      swap(ids, i, j);
    }
    ids[left + 1] = ids[j];
    ids[j] = temp;
    if (right - i + 1 >= j - left) {
      quicksort(ids, dists, i, right);
      quicksort(ids, dists, left, j - 1);
    } else {
      quicksort(ids, dists, left, j - 1);
      quicksort(ids, dists, i, right);
    }
  }
}
function swap(arr, i, j) {
  const tmp = arr[i];
  arr[i] = arr[j];
  arr[j] = tmp;
}
function defaultGetX(p) {
  return p[0];
}
function defaultGetY(p) {
  return p[1];
}

// apps/admin/src/utils/bezierUtils.ts
function polygonToBezierNodes(polygon, targetAnchors = 16) {
  if (polygon.length < 3) return [];
  const n = polygon.length;
  const arc = [0];
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = polygon[i], b = polygon[(i + 1) % n];
    total += Math.hypot(b.x - a.x, b.y - a.y);
    arc.push(total);
  }
  if (total === 0) return [];
  const anchors = [];
  for (let i = 0; i < targetAnchors; i++) {
    const t = i / targetAnchors * total;
    let j = 0;
    while (j < n && arc[j + 1] < t) j++;
    const segT = (t - arc[j]) / Math.max(1e-9, arc[j + 1] - arc[j]);
    const a = polygon[j % n], b = polygon[(j + 1) % n];
    anchors.push({ x: a.x + (b.x - a.x) * segT, y: a.y + (b.y - a.y) * segT });
  }
  const N = anchors.length;
  const out = [];
  for (let i = 0; i < N; i++) {
    const prev = anchors[(i - 1 + N) % N];
    const next = anchors[(i + 1) % N];
    const a = anchors[i];
    const dx = (next.x - prev.x) / 6;
    const dy = (next.y - prev.y) / 6;
    out.push({
      anchor: { x: a.x, y: a.y },
      handleIn: { x: a.x - dx, y: a.y - dy },
      handleOut: { x: a.x + dx, y: a.y + dy },
      smooth: true
    });
  }
  return out;
}

// apps/admin/src/utils/geometry.ts
function pointInPolygon(point, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    const intersect = yi > point.y !== yj > point.y && point.x < (xj - xi) * (point.y - yi) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function triangleCentroid(a, b, c) {
  return {
    x: (a.x + b.x + c.x) / 3,
    y: (a.y + b.y + c.y) / 3
  };
}

// apps/admin/src/utils/limbSeparation.ts
function triangulateZone(contourPts, internalPts, filterPolygon) {
  const allPts = [...contourPts, ...internalPts];
  if (allPts.length < 3) return { points: allPts, triangles: [] };
  const coords = new Float64Array(allPts.length * 2);
  allPts.forEach((p, i) => {
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
  });
  try {
    const delaunay = new Delaunator(coords);
    const triangles = [];
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      const a = delaunay.triangles[i];
      const b = delaunay.triangles[i + 1];
      const c = delaunay.triangles[i + 2];
      const cent = triangleCentroid(allPts[a], allPts[b], allPts[c]);
      if (pointInPolygon(cent, filterPolygon)) {
        triangles.push([a, b, c]);
      }
    }
    return { points: allPts, triangles };
  } catch {
    return { points: allPts, triangles: [] };
  }
}
function findBoundaryEdges(triangles) {
  const edgeCount = /* @__PURE__ */ new Map();
  for (const [a, b, c] of triangles) {
    for (const [u4, v2] of [[a, b], [b, c], [c, a]]) {
      const key = `${Math.min(u4, v2)}_${Math.max(u4, v2)}`;
      const e = edgeCount.get(key);
      if (e) e.count++;
      else edgeCount.set(key, { a: Math.min(u4, v2), b: Math.max(u4, v2), count: 1 });
    }
  }
  const result = [];
  for (const e of edgeCount.values()) {
    if (e.count === 1) result.push([e.a, e.b]);
  }
  return result;
}
function walkBoundaryPath(boundaryEdges, fromIdx, toIdx) {
  const adj = /* @__PURE__ */ new Map();
  for (const [a, b] of boundaryEdges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a).push(b);
    adj.get(b).push(a);
  }
  const visited = /* @__PURE__ */ new Set([fromIdx]);
  const parent = /* @__PURE__ */ new Map();
  const queue = [fromIdx];
  let found = false;
  while (queue.length > 0) {
    const curr = queue.shift();
    if (curr === toIdx) {
      found = true;
      break;
    }
    for (const next of adj.get(curr) ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        parent.set(next, curr);
        queue.push(next);
      }
    }
  }
  if (!found) return [fromIdx, toIdx];
  const path = [];
  let c = toIdx;
  while (c !== fromIdx) {
    path.push(c);
    c = parent.get(c);
  }
  path.push(fromIdx);
  path.reverse();
  return path;
}
function generateInternalPoints(polygon, spacing) {
  if (polygon.length < 3) return [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of polygon) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const margin = spacing * 0.4;
  const result = [];
  for (let y = minY + spacing / 2; y < maxY; y += spacing) {
    for (let x = minX + spacing / 2; x < maxX; x += spacing) {
      const p = { x, y };
      if (!pointInPolygon(p, polygon)) continue;
      let tooClose = false;
      for (let i = 0; i < polygon.length; i++) {
        const j = (i + 1) % polygon.length;
        const d = pointToSegmentDist(p, polygon[i], polygon[j]);
        if (d < margin) {
          tooClose = true;
          break;
        }
      }
      if (!tooClose) result.push(p);
    }
  }
  return result;
}
function pointToSegmentDist(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function triangulateHiddenFace(bodyPoints, bodyTriangles, vertexA, vertexB, bridgePoints, spacing) {
  const boundaryEdges = findBoundaryEdges(bodyTriangles);
  const boundaryPath = walkBoundaryPath(boundaryEdges, vertexB, vertexA);
  const polygon = [bodyPoints[vertexA]];
  for (const bp of bridgePoints) polygon.push(bp);
  polygon.push(bodyPoints[vertexB]);
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    polygon.push(bodyPoints[boundaryPath[i]]);
  }
  if (polygon.length < 3) {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] };
  }
  const sp = spacing ?? Math.max(10, Math.hypot(
    bodyPoints[vertexA].x - bodyPoints[vertexB].x,
    bodyPoints[vertexA].y - bodyPoints[vertexB].y
  ) / 5);
  const internalPts = generateInternalPoints(polygon, sp);
  const newPoints = [...bridgePoints, ...internalPts];
  const baseNewIdx = bodyPoints.length;
  const localPoints = [];
  const localToGlobal = [];
  localPoints.push(bodyPoints[vertexA]);
  localToGlobal.push(vertexA);
  for (let i = 0; i < bridgePoints.length; i++) {
    localPoints.push(bridgePoints[i]);
    localToGlobal.push(baseNewIdx + i);
  }
  localPoints.push(bodyPoints[vertexB]);
  localToGlobal.push(vertexB);
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    localPoints.push(bodyPoints[boundaryPath[i]]);
    localToGlobal.push(boundaryPath[i]);
  }
  for (let i = 0; i < internalPts.length; i++) {
    localPoints.push(internalPts[i]);
    localToGlobal.push(baseNewIdx + bridgePoints.length + i);
  }
  if (localPoints.length < 3) {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] };
  }
  const coords = new Float64Array(localPoints.length * 2);
  localPoints.forEach((p, i) => {
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
  });
  let newTriangles = [];
  try {
    const delaunay = new Delaunator(coords);
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      const a = delaunay.triangles[i];
      const b = delaunay.triangles[i + 1];
      const c = delaunay.triangles[i + 2];
      const cent = triangleCentroid(localPoints[a], localPoints[b], localPoints[c]);
      if (pointInPolygon(cent, polygon)) {
        newTriangles.push([localToGlobal[a], localToGlobal[b], localToGlobal[c]]);
      }
    }
  } catch {
    return { updatedBodyPoints: bodyPoints, updatedBodyTriangles: bodyTriangles, hiddenFaceTriangleIndices: [] };
  }
  const updatedBodyPoints = [...bodyPoints, ...newPoints];
  const triStartIdx = bodyTriangles.length;
  const updatedBodyTriangles = [...bodyTriangles, ...newTriangles];
  const hiddenFaceTriangleIndices = newTriangles.map((_, i) => triStartIdx + i);
  return { updatedBodyPoints, updatedBodyTriangles, hiddenFaceTriangleIndices };
}
function triangulateHiddenFaceLimb(zonePoints2, zoneTriangles2, vertexA, vertexB, bridgePoints, spacing) {
  const boundaryEdges = findBoundaryEdges(zoneTriangles2);
  const boundaryPath = walkBoundaryPath(boundaryEdges, vertexB, vertexA);
  const polygon = [zonePoints2[vertexA]];
  for (const bp of bridgePoints) polygon.push(bp);
  polygon.push(zonePoints2[vertexB]);
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    polygon.push(zonePoints2[boundaryPath[i]]);
  }
  if (polygon.length < 3) {
    return { updatedZonePoints: zonePoints2, updatedZoneTriangles: zoneTriangles2, hiddenFaceLimbTriangleIndices: [] };
  }
  const sp = spacing ?? Math.max(10, Math.hypot(
    zonePoints2[vertexA].x - zonePoints2[vertexB].x,
    zonePoints2[vertexA].y - zonePoints2[vertexB].y
  ) / 5);
  const internalPts = generateInternalPoints(polygon, sp);
  const newPoints = [...bridgePoints, ...internalPts];
  const baseNewIdx = zonePoints2.length;
  const localPoints = [];
  const localToGlobal = [];
  localPoints.push(zonePoints2[vertexA]);
  localToGlobal.push(vertexA);
  for (let i = 0; i < bridgePoints.length; i++) {
    localPoints.push(bridgePoints[i]);
    localToGlobal.push(baseNewIdx + i);
  }
  localPoints.push(zonePoints2[vertexB]);
  localToGlobal.push(vertexB);
  for (let i = 1; i < boundaryPath.length - 1; i++) {
    localPoints.push(zonePoints2[boundaryPath[i]]);
    localToGlobal.push(boundaryPath[i]);
  }
  for (let i = 0; i < internalPts.length; i++) {
    localPoints.push(internalPts[i]);
    localToGlobal.push(baseNewIdx + bridgePoints.length + i);
  }
  if (localPoints.length < 3) {
    return { updatedZonePoints: zonePoints2, updatedZoneTriangles: zoneTriangles2, hiddenFaceLimbTriangleIndices: [] };
  }
  const coords = new Float64Array(localPoints.length * 2);
  localPoints.forEach((p, i) => {
    coords[i * 2] = p.x;
    coords[i * 2 + 1] = p.y;
  });
  let newTriangles = [];
  try {
    const delaunay = new Delaunator(coords);
    for (let i = 0; i < delaunay.triangles.length; i += 3) {
      const a = delaunay.triangles[i];
      const b = delaunay.triangles[i + 1];
      const c = delaunay.triangles[i + 2];
      const cent = triangleCentroid(localPoints[a], localPoints[b], localPoints[c]);
      if (pointInPolygon(cent, polygon)) {
        newTriangles.push([localToGlobal[a], localToGlobal[b], localToGlobal[c]]);
      }
    }
  } catch {
    return { updatedZonePoints: zonePoints2, updatedZoneTriangles: zoneTriangles2, hiddenFaceLimbTriangleIndices: [] };
  }
  const updatedZonePoints = [...zonePoints2, ...newPoints];
  const triStartIdx = zoneTriangles2.length;
  const updatedZoneTriangles = [...zoneTriangles2, ...newTriangles];
  const hiddenFaceLimbTriangleIndices = newTriangles.map((_, i) => triStartIdx + i);
  return { updatedZonePoints, updatedZoneTriangles, hiddenFaceLimbTriangleIndices };
}

// docs/triangulation/auto_triang_geom.ts
var input = JSON.parse(readFileSync(process.argv[2], "utf8"));
var { w, h, zones, params } = input;
var maxDim = Math.max(w, h);
var log = (...a) => console.error("[geom]", ...a);
function distToPolySq(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = dx * dx + dy * dy;
    const t = l > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
    const d = (p.x - a.x - t * dx) ** 2 + (p.y - a.y - t * dy) ** 2;
    if (d < best) best = d;
  }
  return best;
}
function nearestOn(p, poly) {
  let b = poly[0], bd2 = Infinity;
  for (const q of poly) {
    const d = (q.x - p.x) ** 2 + (q.y - p.y) ** 2;
    if (d < bd2) {
      bd2 = d;
      b = q;
    }
  }
  return b;
}
var members = zones.filter((z) => z.id !== "body");
var contours = {};
for (const z of members) contours[z.id] = smoothPolygonGaussian(input.raw[z.id], params.sigma);
var bodySm = smoothPolygonGaussian(input.raw["body"], params.sigma);
var thr2 = params.bridge * params.bridge;
var label = bodySm.map((p) => {
  let best = null, bd2 = thr2;
  for (const z of members) {
    const d = distToPolySq(p, contours[z.id]);
    if (d <= bd2) {
      bd2 = d;
      best = z.id;
    }
  }
  return best;
});
var junctions = {};
{
  const n = bodySm.length;
  const start = label.indexOf(null);
  if (start < 0) throw new Error("contour body enti\xE8rement en contact avec les pattes");
  const out = [];
  const bestY = {};
  for (let k = 0; k < n; k++) {
    const i = (start + k) % n;
    const lab = label[i];
    if (lab === null) {
      out.push(bodySm[i]);
      continue;
    }
    let len = 0, sy = 0;
    while (len < n && label[(i + len) % n] === lab) {
      sy += bodySm[(i + len) % n].y;
      len++;
    }
    const a = bodySm[i], b = bodySm[(i + len - 1) % n];
    out.push(a);
    if (len > 1) out.push(b);
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    if (span >= 20 && (bestY[lab] === void 0 || sy / len < bestY[lab])) {
      bestY[lab] = sy / len;
      junctions[lab] = [a, b];
    }
    k += len - 1;
  }
  contours["body"] = out;
}
for (const z of members) {
  const j = junctions[z.id];
  if (j) log(z.id, "jonction", Math.round(j[0].x), Math.round(j[0].y), "\u2192", Math.round(j[1].x), Math.round(j[1].y), "longueur", Math.round(Math.hypot(j[1].x - j[0].x, j[1].y - j[0].y)));
  else log(z.id, "PAS de jonction avec le corps");
}
log("contours", Object.fromEntries(Object.entries(contours).map(([k, v2]) => [k, v2.length])));
var TOP_CURVATURE_CANDIDATES = 20;
function arcLengthOf(ordered, arcLens, p) {
  let bestIdx = 0, bestDist = Infinity;
  for (let i = 0; i < ordered.length; i++) {
    const d = (ordered[i].x - p.x) ** 2 + (ordered[i].y - p.y) ** 2;
    if (d < bestDist) {
      bestDist = d;
      bestIdx = i;
    }
  }
  return arcLens[bestIdx] / (arcLens[arcLens.length - 1] || 1);
}
var zoneOrigins = {};
var zoneAnchors = {};
var zoneSubdivisionPoints = {};
var zoneSubdivisionParams = {};
var closedContours = {};
for (const z of zones) {
  const ref = contours[z.id];
  const pool = detectCurvatureExtrema(ref, TOP_CURVATURE_CANDIDATES);
  const p0 = pool.length ? pool.reduce((b, c) => c.position.y > b.position.y ? c : b).position : ref[0];
  const forcedRaw = z.id === "body" ? Object.values(junctions).flat() : junctions[z.id] ? [...junctions[z.id]] : [];
  const forced = forcedRaw.map((p) => nearestOn(p, ref)).filter((p) => Math.hypot(p.x - p0.x, p.y - p0.y) > 25);
  const farFromForced = (p) => forced.every((f) => Math.hypot(f.x - p.x, f.y - p.y) > 25);
  const nExtrema = z.id === "body" ? params.anchors.body - 1 : Math.max(3, params.anchors.leg - 1 - forced.length);
  const extrema = pool.filter((c) => Math.hypot(c.position.x - p0.x, c.position.y - p0.y) > 20 && farFromForced(c.position)).slice(0, nExtrema).map((c) => c.position);
  const selected = [...forced, ...extrema];
  const ordered = reorderContourFromOrigin(ref, p0);
  const arcLens = computeArcLengths(ordered);
  const sorted = selected.map((p) => ({ p, s: arcLengthOf(ordered, arcLens, p) })).sort((a, b) => a.s - b.s).map((x) => x.p);
  const anchors = [p0, ...sorted];
  const sA = anchors.map((a) => arcLengthOf(ordered, arcLens, a) * (arcLens[arcLens.length - 1] || 1));
  const counts = anchors.map((_, i) => {
    const a = sA[i], b = sA[(i + 1) % anchors.length];
    const total = arcLens[arcLens.length - 1] || 1;
    const len = ((b - a) % total + total) % total || total;
    return Math.max(1, Math.round(len / params.subdivSpacing));
  });
  const { points, params: subParams } = subdivideContour(ordered, anchors, counts);
  zoneOrigins[z.id] = p0;
  zoneAnchors[z.id] = anchors;
  zoneSubdivisionPoints[z.id] = points;
  zoneSubdivisionParams[z.id] = subParams;
  const n = anchors.length;
  const bySeg = Array.from({ length: n }, () => []);
  subParams.forEach((p, i) => {
    if (points[i] && p.segmentIndex >= 0 && p.segmentIndex < n) bySeg[p.segmentIndex].push({ t: p.t, pt: points[i] });
  });
  for (const arr of bySeg) arr.sort((a, b) => a.t - b.t);
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(anchors[i]);
    for (const sp of bySeg[i]) out.push(sp.pt);
  }
  closedContours[z.id] = out;
  log(z.id, "anchors", anchors.length, "subdiv", points.length, "contour", out.length);
}
var spacingForDensity = (d) => maxDim / (d * 3 + 5);
var zonePoints = {};
var zoneTriangles = {};
var zoneContourLength = {};
var zoneDensity = {};
for (const z of zones) {
  const cPts = closedContours[z.id];
  const density = z.id === "body" ? params.density.body : params.density.leg;
  zoneDensity[z.id] = density;
  const internal = generateInternalPoints(cPts, spacingForDensity(density));
  const tri = triangulateZone(cPts, internal, cPts);
  const currentZ = z.zOrder ?? 0;
  const higher = zones.filter((o) => o.id !== z.id && (o.zOrder ?? 0) > currentZ).map((o) => closedContours[o.id]);
  const filtered = higher.length ? tri.triangles.filter(([a, b, c]) => !higher.some((hc) => pointInPolygon(tri.points[a], hc) || pointInPolygon(tri.points[b], hc) || pointInPolygon(tri.points[c], hc))) : tri.triangles;
  const used = /* @__PURE__ */ new Set();
  for (const [a, b, c] of filtered) {
    used.add(a);
    used.add(b);
    used.add(c);
  }
  for (let i = 0; i < cPts.length; i++) used.add(i);
  const usedArr = [...used].sort((a, b) => a - b);
  const oldToNew = /* @__PURE__ */ new Map();
  const newPts = [];
  for (const o of usedArr) {
    oldToNew.set(o, newPts.length);
    newPts.push(tri.points[o]);
  }
  zonePoints[z.id] = newPts;
  zoneTriangles[z.id] = filtered.map(([a, b, c]) => [oldToNew.get(a), oldToNew.get(b), oldToNew.get(c)]);
  zoneContourLength[z.id] = cPts.length;
  log(z.id, "points", newPts.length, "triangles", zoneTriangles[z.id].length, "(avant trous", tri.triangles.length, ")");
}
function arcPoints(A, B2, inside, depthRatio, count = 6) {
  const mx = (A.x + B2.x) / 2, my = (A.y + B2.y) / 2;
  const L = Math.hypot(B2.x - A.x, B2.y - A.y) || 1;
  let nx = -(B2.y - A.y) / L, ny = (B2.x - A.x) / L;
  const score = (sx, sy) => [15, 30, 60, 90].filter((d) => inside({ x: mx + sx * d, y: my + sy * d })).length;
  if (score(-nx, -ny) > score(nx, ny)) {
    nx = -nx;
    ny = -ny;
  }
  const pts = [];
  for (let k = 1; k <= count; k++) {
    const t = k / (count + 1);
    const bx = A.x + (B2.x - A.x) * t, by = A.y + (B2.y - A.y) * t;
    let d = L * depthRatio * Math.sin(Math.PI * t);
    while (d > 3 && !inside({ x: bx + nx * d, y: by + ny * d })) d *= 0.85;
    if (d > 3) pts.push({ x: bx + nx * d, y: by + ny * d });
  }
  return pts.length >= 3 ? pts : [];
}
var basePts = { ...zonePoints };
var baseTris = { ...zoneTriangles };
var bodyPts = [...zonePoints["body"]];
var bodyTris = [...zoneTriangles["body"]];
var bodyDense = contours["body"];
var hiddenFaceZones = [];
var hiddenFaceLimbZones = [];
var bodyZ = zones.find((z) => z.id === "body").zOrder ?? 0;
var nearestIdx = (p, pts, n) => {
  let b = 0, bd2 = Infinity;
  for (let i = 0; i < n; i++) {
    const d = (pts[i].x - p.x) ** 2 + (pts[i].y - p.y) ** 2;
    if (d < bd2) {
      bd2 = d;
      b = i;
    }
  }
  return b;
};
for (const z of members) {
  const legDense = contours[z.id];
  const j = junctions[z.id];
  if (!j) continue;
  if ((z.zOrder ?? 0) > bodyZ) {
    const A = nearestIdx(j[0], bodyPts, zoneContourLength["body"]), B2 = nearestIdx(j[1], bodyPts, zoneContourLength["body"]);
    if (A === B2) {
      log(z.id, "corde d\xE9g\xE9n\xE9r\xE9e");
      continue;
    }
    const bridge = arcPoints(bodyPts[A], bodyPts[B2], (p) => pointInPolygon(p, legDense), 0.6);
    if (!bridge.length) {
      log(z.id, "arc corps\u2192patte impossible", bodyPts[A], bodyPts[B2]);
      continue;
    }
    const r = triangulateHiddenFace(bodyPts, bodyTris, A, B2, bridge);
    bodyPts = r.updatedBodyPoints;
    bodyTris = r.updatedBodyTriangles;
    hiddenFaceZones.push({ limbZoneId: z.id, bodyVertexA: A, bodyVertexB: B2, bridgePoints: bridge, bodyTriangleIndices: r.hiddenFaceTriangleIndices });
    log(z.id, "face cach\xE9e corps", r.hiddenFaceTriangleIndices.length, "triangles");
  } else {
    const zp = zonePoints[z.id];
    const zt = zoneTriangles[z.id];
    const A = nearestIdx(j[0], zp, zoneContourLength[z.id]), B2 = nearestIdx(j[1], zp, zoneContourLength[z.id]);
    if (A === B2) {
      log(z.id, "corde d\xE9g\xE9n\xE9r\xE9e");
      continue;
    }
    const bridge = arcPoints(zp[A], zp[B2], (p) => pointInPolygon(p, bodyDense) && !pointInPolygon(p, legDense), 0.6);
    if (!bridge.length) {
      log(z.id, "arc patte\u2192corps impossible", zp[A], zp[B2]);
      continue;
    }
    const r = triangulateHiddenFaceLimb(zp, zt, A, B2, bridge);
    zonePoints[z.id] = r.updatedZonePoints;
    zoneTriangles[z.id] = r.updatedZoneTriangles;
    hiddenFaceLimbZones.push({ id: `hfl-${z.id}`, limbZoneId: z.id, zoneVertexA: A, zoneVertexB: B2, bridgePoints: bridge, zoneTriangleIndices: r.hiddenFaceLimbTriangleIndices });
    log(z.id, "prolongement patte", r.hiddenFaceLimbTriangleIndices.length, "triangles");
  }
}
var bodyPointsBaseline = basePts["body"];
var bodyTrianglesBaseline = baseTris["body"];
var finalZonePoints = { ...zonePoints, body: bodyPts };
var finalZoneTriangles = { ...zoneTriangles, body: bodyTris };
var zoneBeziers = {};
for (const z of members) if (z.kind === "far") zoneBeziers[z.id] = polygonToBezierNodes(contours[z.id], 24);
var flags = (v2) => Object.fromEntries(zones.map((z) => [z.id, v2]));
process.stdout.write(JSON.stringify({
  contours,
  zoneOrigins,
  zoneAnchors,
  zoneSubdivisionPoints,
  zoneSubdivisionParams,
  zoneContourLength,
  zoneDensity,
  zoneOriginsValidated: flags(true),
  zoneAnchorsValidated: flags(true),
  zoneSubdivisionValidated: flags(true),
  zonePoints: finalZonePoints,
  zoneTriangles: finalZoneTriangles,
  bodyPoints: bodyPts,
  bodyTriangles: bodyTris,
  bodyPointsBaseline,
  bodyTrianglesBaseline,
  zonePointsBaseline: Object.fromEntries(members.map((z) => [z.id, basePts[z.id]])),
  zoneTrianglesBaseline: Object.fromEntries(members.map((z) => [z.id, baseTris[z.id]])),
  hiddenFaceZones,
  hiddenFaceLimbZones,
  zoneBeziers
}));
