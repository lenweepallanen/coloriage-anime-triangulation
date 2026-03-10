// Web Worker pour OpenCV - tourne dans un thread séparé, ne gèle pas l'UI

// Charger OpenCV dans le worker depuis CDN
const OPENCV_URLS = [
  'https://docs.opencv.org/4.9.0/opencv.js',
  'https://cdn.jsdelivr.net/npm/opencv.js@1.2.1/opencv.js'
];

function loadCV() {
  return new Promise((resolve, reject) => {
    let loaded = false;
    for (const url of OPENCV_URLS) {
      try {
        console.log('Worker: chargement OpenCV depuis ' + url);
        importScripts(url);
        loaded = true;
        console.log('Worker: importScripts OK depuis ' + url);
        break;
      } catch (e) {
        console.warn('Worker: echec chargement depuis ' + url + ': ' + e.message);
      }
    }
    if (!loaded) {
      reject(new Error('Echec chargement OpenCV'));
      return;
    }

    if (typeof cv !== 'undefined') {
      if (typeof cv.Mat !== 'undefined') {
        resolve();
        return;
      }
      if (typeof cv === 'function') {
        cv().then(resolve).catch(reject);
        return;
      }
      if (cv.onRuntimeInitialized !== undefined || cv.then) {
        const onReady = () => resolve();
        if (typeof cv.then === 'function') {
          cv.then(onReady);
        } else {
          cv.onRuntimeInitialized = onReady;
        }
        return;
      }
    }

    // Polling fallback
    let attempts = 0;
    const check = setInterval(() => {
      attempts++;
      if (typeof cv !== 'undefined' && cv.Mat) {
        clearInterval(check);
        resolve();
      } else if (attempts > 100) {
        clearInterval(check);
        reject(new Error('Timeout initialisation OpenCV'));
      }
    }, 100);
  });
}

// Valider que 4 coins forment un quadrilatère convexe raisonnable
function validateQuadrilateral(corners, w, h) {
  const [tl, tr, br, bl] = corners;

  // 1. Vérifier la convexité (produits vectoriels de même signe)
  const pts = [tl, tr, br, bl];
  let allPos = true, allNeg = true;
  for (let i = 0; i < 4; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % 4];
    const c = pts[(i + 2) % 4];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (cross > 0) allNeg = false;
    if (cross < 0) allPos = false;
  }
  if (!allPos && !allNeg) {
    console.log('Worker: quad rejeté - pas convexe');
    return false;
  }

  // 2. Aire du quadrilatère (Shoelace) > 8% de l'image
  const quadArea = 0.5 * Math.abs(
    (tl.x * tr.y - tr.x * tl.y) +
    (tr.x * br.y - br.x * tr.y) +
    (br.x * bl.y - bl.x * br.y) +
    (bl.x * tl.y - tl.x * bl.y)
  );
  const imgArea = w * h;
  if (quadArea < imgArea * 0.08) {
    console.log('Worker: quad rejeté - trop petit (' + Math.round(quadArea / imgArea * 100) + '% de l\'image)');
    return false;
  }

  // 3. Ratio d'aspect du quad (template carré, donc < 3 même en perspective)
  const topW = Math.sqrt((tr.x - tl.x) ** 2 + (tr.y - tl.y) ** 2);
  const botW = Math.sqrt((br.x - bl.x) ** 2 + (br.y - bl.y) ** 2);
  const leftH = Math.sqrt((bl.x - tl.x) ** 2 + (bl.y - tl.y) ** 2);
  const rightH = Math.sqrt((br.x - tr.x) ** 2 + (br.y - tr.y) ** 2);
  const avgW = (topW + botW) / 2;
  const avgH = (leftH + rightH) / 2;
  const aspect = Math.max(avgW, avgH) / Math.max(Math.min(avgW, avgH), 1);
  if (aspect > 3) {
    console.log('Worker: quad rejeté - trop allongé (aspect=' + aspect.toFixed(1) + ')');
    return false;
  }

  // 4. Les 4 coins doivent être dispersés (pas regroupés dans un coin de l'image)
  const centerX = (tl.x + tr.x + br.x + bl.x) / 4;
  const centerY = (tl.y + tr.y + br.y + bl.y) / 4;
  const maxDistFromCenter = Math.max(
    ...pts.map(p => Math.sqrt((p.x - centerX) ** 2 + (p.y - centerY) ** 2))
  );
  const minDistFromCenter = Math.min(
    ...pts.map(p => Math.sqrt((p.x - centerX) ** 2 + (p.y - centerY) ** 2))
  );
  if (minDistFromCenter < maxDistFromCenter * 0.15) {
    console.log('Worker: quad rejeté - coins trop regroupés');
    return false;
  }

  console.log('Worker: quad géométrie OK (area=' + Math.round(quadArea / imgArea * 100) + '%, aspect=' + aspect.toFixed(1) + ')');
  return true;
}

// Vérifier que l'intérieur du quadrilatère est blanc (= papier)
function validateBrightInterior(gray, corners) {
  const [tl, tr, br, bl] = corners;

  const checkPoints = [
    { x: (tl.x + tr.x + br.x + bl.x) / 4, y: (tl.y + tr.y + br.y + bl.y) / 4 },
    { x: (tl.x + tr.x) / 2, y: (tl.y + tr.y) / 2 },
    { x: (tr.x + br.x) / 2, y: (tr.y + br.y) / 2 },
    { x: (br.x + bl.x) / 2, y: (br.y + bl.y) / 2 },
    { x: (bl.x + tl.x) / 2, y: (bl.y + tl.y) / 2 },
    { x: (tl.x * 3 + br.x) / 4, y: (tl.y * 3 + br.y) / 4 },
    { x: (tl.x + br.x * 3) / 4, y: (tl.y + br.y * 3) / 4 },
    { x: (tr.x * 3 + bl.x) / 4, y: (tr.y * 3 + bl.y) / 4 },
    { x: (tr.x + bl.x * 3) / 4, y: (tr.y + bl.y * 3) / 4 },
  ];

  let brightCount = 0;
  const brightThresh = 150;
  for (const p of checkPoints) {
    const px = Math.max(0, Math.min(gray.cols - 1, Math.round(p.x)));
    const py = Math.max(0, Math.min(gray.rows - 1, Math.round(p.y)));
    const val = gray.ucharAt(py, px);
    if (val > brightThresh) brightCount++;
  }

  const ratio = brightCount / checkPoints.length;
  if (ratio < 0.5) {
    console.log('Worker: quad rejeté - intérieur sombre (' + brightCount + '/' + checkPoints.length + ' points clairs)');
    return false;
  }

  console.log('Worker: quad intérieur blanc OK (' + brightCount + '/' + checkPoints.length + ')');
  return true;
}

// Valider que le contour a une forme en L (5-8 sommets approximés)
function validateLShape(contour) {
  const peri = cv.arcLength(contour, true);
  const approx = new cv.Mat();
  cv.approxPolyDP(contour, approx, 0.04 * peri, true);
  const nVertices = approx.rows;
  approx.delete();
  return nVertices >= 5 && nVertices <= 8;
}

// Valider que le marqueur est sombre (encre noire, pas un doigt/ombre)
function validateMarkerIsDark(grayMat, contour) {
  let mask = null;
  let tempContours = null;
  try {
    mask = new cv.Mat.zeros(grayMat.rows, grayMat.cols, cv.CV_8UC1);
    tempContours = new cv.MatVector();
    tempContours.push_back(contour);
    cv.drawContours(mask, tempContours, 0, new cv.Scalar(255), cv.FILLED);
    const mean = cv.mean(grayMat, mask);
    return mean[0] < 80;
  } finally {
    if (mask) mask.delete();
    if (tempContours) tempContours.delete();
  }
}

// Chercher les coins en L dans une image binaire + vérifier sur l'image grise
function findCornersInBinary(binary, gray, w, h) {
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();

  // Fermeture morphologique pour combler les petits trous
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  const cleaned = new cv.Mat();
  cv.morphologyEx(binary, cleaned, cv.MORPH_CLOSE, kernel);

  cv.findContours(cleaned, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

  const imgArea = w * h;
  const minArea = imgArea * 0.0002;
  const maxArea = imgArea * 0.03;

  const candidates = [];
  const debugContours = [];

  for (let i = 0; i < contours.size(); i++) {
    const contour = contours.get(i);
    const area = cv.contourArea(contour);

    if (area > imgArea * 0.00005) {
      const rect = cv.boundingRect(contour);
      const moments = cv.moments(contour);
      const cx = moments.m00 !== 0 ? moments.m10 / moments.m00 : 0;
      const cy = moments.m00 !== 0 ? moments.m01 / moments.m00 : 0;
      const rectArea = rect.width * rect.height;
      const solidity = rectArea > 0 ? area / rectArea : 0;
      const aspectRatio = Math.min(rect.width, rect.height) > 0
        ? Math.max(rect.width, rect.height) / Math.min(rect.width, rect.height)
        : 99;

      const info = {
        a: Math.round(area),
        cx: Math.round(cx),
        cy: Math.round(cy),
        sol: Math.round(solidity * 100) / 100,
        ar: Math.round(aspectRatio * 10) / 10,
        bw: rect.width,
        bh: rect.height,
        ok: false
      };

      if (area >= minArea && area <= maxArea &&
          aspectRatio < 2.5 &&
          solidity >= 0.25 && solidity <= 0.50 &&
          validateLShape(contour) &&
          validateMarkerIsDark(gray, contour)) {
        candidates.push({ x: cx, y: cy });
        info.ok = true;
      }

      debugContours.push(info);
    }
    contour.delete();
  }

  kernel.delete();
  cleaned.delete();
  contours.delete();
  hierarchy.delete();

  debugContours.sort((a, b) => b.a - a.a);

  const debug = {
    nContours: debugContours.length,
    nCandidates: candidates.length,
    areaRange: [Math.round(minArea), Math.round(maxArea)],
    top: debugContours.slice(0, 12)
  };

  if (candidates.length < 4) {
    return { corners: null, debug };
  }

  // Si plus de 4 candidats, prendre les 4 plus proches des coins de l'image
  let selected;
  if (candidates.length === 4) {
    selected = candidates;
  } else {
    const targets = [
      { x: 0, y: 0 },
      { x: w, y: 0 },
      { x: w, y: h },
      { x: 0, y: h }
    ];
    selected = [];
    const used = new Set();
    for (const t of targets) {
      let bestIdx = -1, bestDist = Infinity;
      for (let i = 0; i < candidates.length; i++) {
        if (used.has(i)) continue;
        const dx = candidates[i].x - t.x;
        const dy = candidates[i].y - t.y;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          bestIdx = i;
        }
      }
      if (bestIdx >= 0) {
        selected.push(candidates[bestIdx]);
        used.add(bestIdx);
      }
    }
  }

  if (selected.length !== 4) {
    return { corners: null, debug };
  }

  // Trier: TL, TR, BR, BL
  selected.sort((a, b) => (a.x + a.y) - (b.x + b.y));
  const tl = selected[0];
  const br = selected[3];
  const rem = [selected[1], selected[2]];
  const tr = rem[0].x > rem[1].x ? rem[0] : rem[1];
  const bl = rem[0].x > rem[1].x ? rem[1] : rem[0];

  const sorted = [tl, tr, br, bl];

  if (!validateQuadrilateral(sorted, w, h)) {
    debug.rejected = 'quadrilateral_invalid';
    return { corners: null, debug };
  }

  if (gray && !validateBrightInterior(gray, sorted)) {
    debug.rejected = 'interior_not_bright';
    return { corners: null, debug };
  }

  return { corners: sorted, debug };
}

// Détecter les 4 coins en L avec plusieurs stratégies de seuillage
function detectCorners(imgData) {
  const w = imgData.width;
  const h = imgData.height;

  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  src.delete();

  const allDebug = {};

  // Stratégie 1: Seuils fixes du plus sélectif au plus permissif
  for (const t of [50, 70, 90]) {
    const name = 'fixed-' + t;
    const binary = new cv.Mat();
    cv.threshold(blurred, binary, t, 255, cv.THRESH_BINARY_INV);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    allDebug[name] = { threshold: t, ...result.debug };
    if (result.corners) {
      console.log('Worker: coins trouvés avec seuil fixe ' + t);
      gray.delete(); blurred.delete();
      return { corners: result.corners, debug: allDebug, strategy: name };
    }
  }

  // Stratégie 2: Otsu (seuil automatique)
  {
    const binary = new cv.Mat();
    const thresh = cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    allDebug.otsu = { threshold: Math.round(thresh), ...result.debug };
    if (result.corners) {
      console.log('Worker: coins trouvés avec Otsu (thresh=' + Math.round(thresh) + ')');
      gray.delete(); blurred.delete();
      return { corners: result.corners, debug: allDebug, strategy: 'otsu' };
    }
  }

  // Stratégie 3: Seuil adaptatif gaussien (gère les ombres/éclairage inégal)
  {
    const binary = new cv.Mat();
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 51, 10);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    allDebug.adaptive = { threshold: 'adaptive', ...result.debug };
    if (result.corners) {
      console.log('Worker: coins trouvés avec adaptatif');
      gray.delete(); blurred.delete();
      return { corners: result.corners, debug: allDebug, strategy: 'adaptive' };
    }
  }

  // Stratégie 4: Seuils fixes plus permissifs (en dernier recours)
  for (const t of [110, 130, 150]) {
    const name = 'fixed-' + t;
    const binary = new cv.Mat();
    cv.threshold(blurred, binary, t, 255, cv.THRESH_BINARY_INV);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    allDebug[name] = { threshold: t, ...result.debug };
    if (result.corners) {
      console.log('Worker: coins trouvés avec seuil fixe ' + t);
      gray.delete(); blurred.delete();
      return { corners: result.corners, debug: allDebug, strategy: name };
    }
  }

  gray.delete();
  blurred.delete();
  console.log('Worker: aucun coin trouvé avec aucune stratégie');
  return { corners: null, debug: allDebug };
}

// Corriger la perspective
function correctPerspective(imgData, corners) {
  const src = new cv.Mat(imgData.height, imgData.width, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  const w = 2048, h = 2048;
  const dst = new cv.Mat();

  // Les coins en L font 100x100px avec des bras de 20px
  // Leur centroïde est à ~32px de chaque bord du template
  const margin = 64;

  const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    corners[0].x, corners[0].y,
    corners[1].x, corners[1].y,
    corners[2].x, corners[2].y,
    corners[3].x, corners[3].y,
  ]);
  const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [
    margin, margin,
    w - margin, margin,
    w - margin, h - margin,
    margin, h - margin,
  ]);

  const M = cv.getPerspectiveTransform(srcPts, dstPts);
  cv.warpPerspective(src, dst, M, new cv.Size(w, h), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(255, 255, 255, 255));

  const result = new Uint8ClampedArray(dst.data);

  src.delete(); dst.delete(); srcPts.delete(); dstPts.delete(); M.delete();
  return { data: result, width: w, height: h };
}

// Détection rapide pour le preview temps réel
function detectCornersLightweight(imgData) {
  const w = imgData.width, h = imgData.height;

  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
  src.delete();

  for (const t of [50, 70, 90]) {
    const binary = new cv.Mat();
    cv.threshold(blurred, binary, t, 255, cv.THRESH_BINARY_INV);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    if (result.corners) {
      gray.delete(); blurred.delete();
      return { corners: result.corners };
    }
  }

  {
    const binary = new cv.Mat();
    cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    if (result.corners) {
      gray.delete(); blurred.delete();
      return { corners: result.corners };
    }
  }

  {
    const binary = new cv.Mat();
    cv.adaptiveThreshold(gray, binary, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 51, 10);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    if (result.corners) {
      gray.delete(); blurred.delete();
      return { corners: result.corners };
    }
  }

  for (const t of [110, 130, 150]) {
    const binary = new cv.Mat();
    cv.threshold(blurred, binary, t, 255, cv.THRESH_BINARY_INV);
    const result = findCornersInBinary(binary, gray, w, h);
    binary.delete();
    if (result.corners) {
      gray.delete(); blurred.delete();
      return { corners: result.corners };
    }
  }

  gray.delete(); blurred.delete();
  return { corners: null };
}

// --- Optical flow tracking with robust filtering pipeline ---

// State for incremental optical flow
let flowPrevGray = null;
let flowPrevPts = null;
let flowWinSize = null;
let flowMaxLevel = 3;
let flowCriteria = null;
let flowInitialPoints = null;

// Robust filtering state
let flowTriangles = null;        // [[a,b,c], ...] triangle indices
let flowNeighborMap = null;      // Map<number, number[]> adjacency from triangles
let flowRefEdgeLengths = null;   // Map<string, number> "i-j" -> reference distance
let flowMaxDisplacement = 0;     // max pixels per frame
let flowPointClassifications = null; // boolean[] : true = dark, false = light
let flowRefTriangleData = null;  // [{area, minAngle, verts:[{x,y},{x,y},{x,y}]}] per triangle
let flowAnchorPoints = null;     // Point2D[] anchor positions for drift correction
let flowFrameCounter = 0;        // current frame number

// Pipeline parameters
var FLOW_ERROR_THRESHOLD = 12.0;
var FLOW_FB_THRESHOLD = 1.0;
var FLOW_MAX_DISP_RATIO = 0.08;     // safety net only (8% of frame), real outlier detection is MAD-based (S4)
var FLOW_MAD_K = 2.5;               // MAD multiplier for outlier detection (Hampel standard)
var FLOW_MAD_EPSILON = 0.5;          // floor to prevent zero-MAD collapse when neighbors are static
var FLOW_MIN_EDGE_RATIO = 0.5;
var FLOW_MAX_EDGE_RATIO = 2.0;
var FLOW_COLOR_THRESHOLD = 128;    // grayscale dark/light boundary
var FLOW_COLOR_BLUR_SIZE = 5;      // Gaussian blur kernel for sampling
var FLOW_COLOR_TOLERANCE = 50;     // tolerance band around threshold (widened for H.264 antialiasing)
var FLOW_LAPLACIAN_ALPHA = 0.15;   // Laplacian smoothing strength (0=off, 1=snap to centroid)
var FLOW_MIN_AREA_RATIO = 0.3;     // triangle area must be >= 30% of reference
var FLOW_MAX_AREA_RATIO = 3.0;     // triangle area must be <= 300% of reference
var FLOW_MIN_ANGLE_DEG = 10;       // minimum angle in degrees
var FLOW_SHAPE_CORRECTION_MIN = 0.2; // min correction for mild violations
var FLOW_SHAPE_CORRECTION_MAX = 0.8; // max correction for severe violations
var FLOW_AFFINE_COND_MAX = 1e6;      // max condition number for affine fit (above → fallback to median translation)
var FLOW_ANCHOR_INTERVAL = 15;       // save anchor every N frames
var FLOW_ANCHOR_MAX_DRIFT = 5.0;     // average drift in px before triggering correction
var FLOW_ANCHOR_CORRECTION_ALPHA = 0.1; // soft pull strength toward anchor (10%)
var FLOW_LK_WIN_SIZE = 31;           // Lucas-Kanade search window size (must be odd)

// --- Helper functions ---

function triangleArea(a, b, c) {
  return Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
}

function triangleMinAngle(a, b, c) {
  // Returns minimum angle in degrees
  var sides = [
    { dx: b.x - a.x, dy: b.y - a.y },  // AB
    { dx: c.x - b.x, dy: c.y - b.y },  // BC
    { dx: a.x - c.x, dy: a.y - c.y }   // CA
  ];
  var lens = sides.map(function(s) { return Math.sqrt(s.dx * s.dx + s.dy * s.dy); });
  if (lens[0] < 1e-6 || lens[1] < 1e-6 || lens[2] < 1e-6) return 0;

  // Law of cosines for each angle
  var ab2 = lens[0] * lens[0], bc2 = lens[1] * lens[1], ca2 = lens[2] * lens[2];
  var cosA = (ab2 + ca2 - bc2) / (2 * lens[0] * lens[2]);
  var cosB = (ab2 + bc2 - ca2) / (2 * lens[0] * lens[1]);
  var cosC = (bc2 + ca2 - ab2) / (2 * lens[1] * lens[2]);
  // Clamp to [-1,1] for numerical safety
  cosA = Math.max(-1, Math.min(1, cosA));
  cosB = Math.max(-1, Math.min(1, cosB));
  cosC = Math.max(-1, Math.min(1, cosC));
  var angA = Math.acos(cosA) * 180 / Math.PI;
  var angB = Math.acos(cosB) * 180 / Math.PI;
  var angC = Math.acos(cosC) * 180 / Math.PI;
  return Math.min(angA, angB, angC);
}

function computeRefTriangleData(points, triangles) {
  var data = [];
  for (var t = 0; t < triangles.length; t++) {
    var tri = triangles[t];
    var a = points[tri[0]], b = points[tri[1]], c = points[tri[2]];
    data.push({
      area: triangleArea(a, b, c),
      minAngle: triangleMinAngle(a, b, c),
      verts: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }, { x: c.x, y: c.y }]
    });
  }
  return data;
}

function buildNeighborMap(triangles, nPoints) {
  var neighbors = {};
  for (var i = 0; i < nPoints; i++) {
    neighbors[i] = [];
  }
  var edgeSet = {};
  for (var t = 0; t < triangles.length; t++) {
    var tri = triangles[t];
    var edges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[0], tri[2]]];
    for (var e = 0; e < edges.length; e++) {
      var a = Math.min(edges[e][0], edges[e][1]);
      var b = Math.max(edges[e][0], edges[e][1]);
      var key = a + '-' + b;
      if (!edgeSet[key]) {
        edgeSet[key] = true;
        neighbors[a].push(b);
        neighbors[b].push(a);
      }
    }
  }
  return neighbors;
}

function computeEdgeLengths(points, triangles) {
  var lengths = {};
  var edgeSet = {};
  for (var t = 0; t < triangles.length; t++) {
    var tri = triangles[t];
    var edges = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[0], tri[2]]];
    for (var e = 0; e < edges.length; e++) {
      var a = Math.min(edges[e][0], edges[e][1]);
      var b = Math.max(edges[e][0], edges[e][1]);
      var key = a + '-' + b;
      if (!edgeSet[key]) {
        edgeSet[key] = true;
        var dx = points[a].x - points[b].x;
        var dy = points[a].y - points[b].y;
        lengths[key] = Math.sqrt(dx * dx + dy * dy);
      }
    }
  }
  return lengths;
}

function median(arr) {
  if (arr.length === 0) return 0;
  var sorted = arr.slice().sort(function(a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function fitAffine2D(srcPts, dstPts) {
  // Least-squares affine: [x'] = [a b c] * [x y 1]^T
  //                        [y']   [d e f]
  // Build normal equations: A^T A x = A^T b
  var n = srcPts.length;
  // A is n×3, we solve two systems (one for x', one for y')
  // AtA is 3×3, Atb is 3×1
  var s00 = 0, s01 = 0, s02 = 0, s11 = 0, s12 = 0, s22 = 0;
  var bx0 = 0, bx1 = 0, bx2 = 0;
  var by0 = 0, by1 = 0, by2 = 0;
  for (var i = 0; i < n; i++) {
    var sx = srcPts[i].x, sy = srcPts[i].y;
    var dx = dstPts[i].x, dy = dstPts[i].y;
    s00 += sx * sx; s01 += sx * sy; s02 += sx;
    s11 += sy * sy; s12 += sy; s22 += 1;
    bx0 += sx * dx; bx1 += sy * dx; bx2 += dx;
    by0 += sx * dy; by1 += sy * dy; by2 += dy;
  }
  // Solve 3×3 system via Cramer's rule
  // Matrix: [[s00, s01, s02], [s01, s11, s12], [s02, s12, s22]]
  var det = s00 * (s11 * s22 - s12 * s12) - s01 * (s01 * s22 - s12 * s02) + s02 * (s01 * s12 - s11 * s02);
  if (Math.abs(det) < 1e-10) return null;
  var invDet = 1.0 / det;
  // Cofactor matrix (symmetric)
  var c00 = (s11 * s22 - s12 * s12) * invDet;
  var c01 = (s02 * s12 - s01 * s22) * invDet;
  var c02 = (s01 * s12 - s02 * s11) * invDet;
  var c11 = (s00 * s22 - s02 * s02) * invDet;
  var c12 = (s01 * s02 - s00 * s12) * invDet;
  var c22 = (s00 * s11 - s01 * s01) * invDet;
  // Condition number check: Frobenius norm of A * Frobenius norm of A^-1
  var frobSq = s00*s00 + 2*s01*s01 + 2*s02*s02 + s11*s11 + 2*s12*s12 + s22*s22;
  var invFrobSq = c00*c00 + 2*c01*c01 + 2*c02*c02 + c11*c11 + 2*c12*c12 + c22*c22;
  if (Math.sqrt(frobSq * invFrobSq) > FLOW_AFFINE_COND_MAX) return null;
  // Solve for x coefficients
  var a = c00 * bx0 + c01 * bx1 + c02 * bx2;
  var b = c01 * bx0 + c11 * bx1 + c12 * bx2;
  var c = c02 * bx0 + c12 * bx1 + c22 * bx2;
  // Solve for y coefficients
  var d = c00 * by0 + c01 * by1 + c02 * by2;
  var e = c01 * by0 + c11 * by1 + c12 * by2;
  var f = c02 * by0 + c12 * by1 + c22 * by2;
  return { a: a, b: b, c: c, d: d, e: e, f: f };
}

function applyAffine(affine, pt) {
  return {
    x: affine.a * pt.x + affine.b * pt.y + affine.c,
    y: affine.d * pt.x + affine.e * pt.y + affine.f
  };
}

function flowInit(initialPoints, triangles) {
  flowInitialPoints = initialPoints;
  flowPrevGray = null;
  flowPrevPts = null;
  flowWinSize = new cv.Size(FLOW_LK_WIN_SIZE, FLOW_LK_WIN_SIZE);
  flowMaxLevel = 3;
  flowCriteria = new cv.TermCriteria(
    cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01
  );

  // Precompute mesh topology for robust filtering
  flowTriangles = triangles || [];
  flowNeighborMap = buildNeighborMap(flowTriangles, initialPoints.length);
  flowRefEdgeLengths = null; // computed on first frame when we have positions
  flowRefTriangleData = null; // computed on first frame
  flowMaxDisplacement = 0;   // set on first frame when we know video dimensions
  flowPointClassifications = null; // computed on first frame

  // Temporal anchoring state
  flowAnchorPoints = null;
  flowFrameCounter = 0;
}

function flowProcessFrame(imgData) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));
  var gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();

  // First frame: store grayscale, compute reference edge lengths, return initial points
  if (!flowPrevGray) {
    flowPrevGray = gray;
    flowPrevPts = cv.matFromArray(
      flowInitialPoints.length, 1, cv.CV_32FC2,
      flowInitialPoints.flatMap(function(p) { return [p.x, p.y]; })
    );
    flowRefEdgeLengths = computeEdgeLengths(flowInitialPoints, flowTriangles);
    flowRefTriangleData = computeRefTriangleData(flowInitialPoints, flowTriangles);
    flowMaxDisplacement = w * FLOW_MAX_DISP_RATIO;

    // Classify each point as dark (on lines) or light (on paper)
    var blurredInit = new cv.Mat();
    cv.GaussianBlur(gray, blurredInit, new cv.Size(FLOW_COLOR_BLUR_SIZE, FLOW_COLOR_BLUR_SIZE), 0);
    flowPointClassifications = [];
    for (var j = 0; j < flowInitialPoints.length; j++) {
      var px = Math.max(0, Math.min(w - 1, Math.round(flowInitialPoints[j].x)));
      var py = Math.max(0, Math.min(h - 1, Math.round(flowInitialPoints[j].y)));
      var val = blurredInit.ucharAt(py, px);
      flowPointClassifications.push(val < FLOW_COLOR_THRESHOLD); // true = dark
    }
    blurredInit.delete();

    // Store frame 0 as first anchor
    flowAnchorPoints = flowInitialPoints.map(function(p) { return { x: p.x, y: p.y }; });
    flowFrameCounter = 0;

    return { points: flowInitialPoints };
  }

  var nPts = flowInitialPoints.length;

  // --- Per-frame metrics ---
  var metrics = {
    rejectedS1: 0, rejectedS2: 0, rejectedS2_5: 0,
    rejectedS3: 0, rejectedS4: 0, rejectedS5: 0,
    reconstructedS6: 0, correctedS6_5: 0, snappedS7: 0, frozenS7: 0,
    totalPoints: nPts,
    avgDisplacement: 0, maxDisplacement: 0
  };

  // --- Forward LK ---
  var nextPts = new cv.Mat();
  var status = new cv.Mat();
  var err = new cv.Mat();

  cv.calcOpticalFlowPyrLK(
    flowPrevGray, gray,
    flowPrevPts, nextPts,
    status, err,
    flowWinSize, flowMaxLevel, flowCriteria
  );

  var prevData = flowPrevPts.data32F;
  var nextData = nextPts.data32F;
  var statusData = status.data;
  var errData = err.data32F;

  // Build prev/next point arrays
  var prevPoints = [];
  var rawNextPoints = [];
  for (var j = 0; j < nPts; j++) {
    prevPoints.push({ x: prevData[j * 2], y: prevData[j * 2 + 1] });
    rawNextPoints.push({ x: nextData[j * 2], y: nextData[j * 2 + 1] });
  }

  // --- Displacement stats ---
  var totalDisp = 0, maxDisp = 0;
  for (var j = 0; j < nPts; j++) {
    var ddx = rawNextPoints[j].x - prevPoints[j].x;
    var ddy = rawNextPoints[j].y - prevPoints[j].y;
    var dd = Math.sqrt(ddx * ddx + ddy * ddy);
    totalDisp += dd;
    if (dd > maxDisp) maxDisp = dd;
  }
  metrics.avgDisplacement = totalDisp / nPts;
  metrics.maxDisplacement = maxDisp;

  // rejected[j] = true means point j failed quality checks
  var rejected = new Array(nPts);
  for (var j = 0; j < nPts; j++) rejected[j] = false;

  // ========== Stage 1: Status + Error Threshold ==========
  for (var j = 0; j < nPts; j++) {
    if (statusData[j] !== 1 || errData[j] > FLOW_ERROR_THRESHOLD) {
      rejected[j] = true;
      metrics.rejectedS1++;
    }
  }

  status.delete();
  err.delete();

  // ========== Stage 2: Forward-Backward Consistency (Kalal et al. 2010) ==========
  var backPts = new cv.Mat();
  var statusBack = new cv.Mat();
  var errBack = new cv.Mat();

  cv.calcOpticalFlowPyrLK(
    gray, flowPrevGray,
    nextPts, backPts,
    statusBack, errBack,
    flowWinSize, flowMaxLevel, flowCriteria
  );

  var backData = backPts.data32F;
  for (var j = 0; j < nPts; j++) {
    if (!rejected[j]) {
      var dx = prevData[j * 2] - backData[j * 2];
      var dy = prevData[j * 2 + 1] - backData[j * 2 + 1];
      var fbError = Math.sqrt(dx * dx + dy * dy);
      if (fbError > FLOW_FB_THRESHOLD) {
        rejected[j] = true;
        metrics.rejectedS2++;
      }
    }
  }

  statusBack.delete();
  errBack.delete();
  backPts.delete();
  nextPts.delete();

  // Stage 2.5 supprimé — la vérification couleur est reportée dans Stage 7 (Color Snap)
  // qui corrige au lieu de rejeter, avec une tolérance élargie (±50)

  // ========== Stage 3: Maximum Displacement Cap ==========
  for (var j = 0; j < nPts; j++) {
    if (!rejected[j]) {
      var dx = rawNextPoints[j].x - prevPoints[j].x;
      var dy = rawNextPoints[j].y - prevPoints[j].y;
      var disp = Math.sqrt(dx * dx + dy * dy);
      if (disp > flowMaxDisplacement) {
        rejected[j] = true;
        metrics.rejectedS3++;
      }
    }
  }

  // ========== Stage 4: MAD-based Outlier Rejection ==========
  // Per-neighborhood: compare each point's displacement to its neighbors' median,
  // reject if deviation exceeds k * (MAD + epsilon). Robust to outliers by construction.
  // Also precompute per-point deviation scores for use in Stage 5.
  var pointDeviationScores = new Array(nPts);
  for (var j = 0; j < nPts; j++) pointDeviationScores[j] = 0;

  for (var j = 0; j < nPts; j++) {
    if (rejected[j]) continue;
    var neighbors = flowNeighborMap[j];
    if (!neighbors || neighbors.length === 0) continue;

    var neighborDxs = [];
    var neighborDys = [];
    for (var k = 0; k < neighbors.length; k++) {
      var ni = neighbors[k];
      if (!rejected[ni]) {
        neighborDxs.push(rawNextPoints[ni].x - prevPoints[ni].x);
        neighborDys.push(rawNextPoints[ni].y - prevPoints[ni].y);
      }
    }
    if (neighborDxs.length === 0) continue;

    var medDx = median(neighborDxs);
    var medDy = median(neighborDys);
    var myDx = rawNextPoints[j].x - prevPoints[j].x;
    var myDy = rawNextPoints[j].y - prevPoints[j].y;
    var deviation = Math.sqrt((myDx - medDx) * (myDx - medDx) + (myDy - medDy) * (myDy - medDy));

    // Compute MAD of neighbor deviations from their median
    var neighborDevs = [];
    for (var k = 0; k < neighborDxs.length; k++) {
      var devX = neighborDxs[k] - medDx;
      var devY = neighborDys[k] - medDy;
      neighborDevs.push(Math.sqrt(devX * devX + devY * devY));
    }
    var mad = median(neighborDevs);
    var threshold = FLOW_MAD_K * (mad + FLOW_MAD_EPSILON);

    pointDeviationScores[j] = deviation;

    if (deviation > threshold) {
      rejected[j] = true;
      metrics.rejectedS4++;
    }
  }

  // ========== Stage 5: Mesh Edge Length Preservation ==========
  if (flowRefEdgeLengths && flowTriangles) {
    for (var t = 0; t < flowTriangles.length; t++) {
      var tri = flowTriangles[t];
      var ia = tri[0], ib = tri[1], ic = tri[2];
      // Only check triangles where all 3 points are still accepted
      if (rejected[ia] || rejected[ib] || rejected[ic]) continue;

      var edges = [[ia, ib], [ib, ic], [ia, ic]];
      var worstRatio = 0;
      var worstPoint = -1;

      for (var e = 0; e < edges.length; e++) {
        var ea = Math.min(edges[e][0], edges[e][1]);
        var eb = Math.max(edges[e][0], edges[e][1]);
        var key = ea + '-' + eb;
        var refLen = flowRefEdgeLengths[key];
        if (!refLen || refLen < 1) continue;

        var dx = rawNextPoints[edges[e][0]].x - rawNextPoints[edges[e][1]].x;
        var dy = rawNextPoints[edges[e][0]].y - rawNextPoints[edges[e][1]].y;
        var curLen = Math.sqrt(dx * dx + dy * dy);
        var ratio = curLen / refLen;

        if (ratio < FLOW_MIN_EDGE_RATIO || ratio > FLOW_MAX_EDGE_RATIO) {
          // Reject the endpoint with the higher neighborhood deviation score (from S4).
          // This identifies which vertex is more inconsistent with its local neighborhood,
          // rather than blindly picking the one that moved most.
          var scoreA = pointDeviationScores[edges[e][0]];
          var scoreB = pointDeviationScores[edges[e][1]];
          var badRatio = Math.abs(ratio - 1.0);
          if (badRatio > worstRatio) {
            worstRatio = badRatio;
            worstPoint = scoreA > scoreB ? edges[e][0] : edges[e][1];
          }
        }
      }

      if (worstPoint >= 0) {
        rejected[worstPoint] = true;
        metrics.rejectedS5++;
      }
    }
  }

  // ========== Build regulated points (accepted only, null for rejected) ==========
  // Regularize accepted points first (S6.5, S6.6), then reconstruct rejected (S6).
  // This ensures reconstruction uses already-regularized neighbor positions.
  var regulatedPoints = [];
  for (var j = 0; j < nPts; j++) {
    if (!rejected[j]) {
      regulatedPoints.push({ x: rawNextPoints[j].x, y: rawNextPoints[j].y });
    } else {
      regulatedPoints.push(null);
    }
  }

  // ========== Stage 6.5: Triangle Quality Constraints ==========
  // For each triangle, check area ratio and minimum angle against reference.
  // If violated, correct the worst vertex by blending toward its ideal position.
  // Only applies to triangles where all 3 vertices are accepted (non-null).
  if (flowRefTriangleData && flowTriangles) {
    var corrections = [];
    for (var j = 0; j < nPts; j++) corrections.push({ dx: 0, dy: 0, count: 0, maxSeverity: 0 });

    for (var t = 0; t < flowTriangles.length; t++) {
      var tri = flowTriangles[t];
      var ia = tri[0], ib = tri[1], ic = tri[2];
      // Skip triangles with any rejected vertex
      if (!regulatedPoints[ia] || !regulatedPoints[ib] || !regulatedPoints[ic]) continue;
      var ca = regulatedPoints[ia], cb = regulatedPoints[ib], cc = regulatedPoints[ic];
      var ref = flowRefTriangleData[t];

      var curArea = triangleArea(ca, cb, cc);
      var areaRatio = (ref.area > 1e-6) ? curArea / ref.area : 1;
      var areaViolation = (areaRatio < FLOW_MIN_AREA_RATIO || areaRatio > FLOW_MAX_AREA_RATIO);

      var curMinAngle = triangleMinAngle(ca, cb, cc);
      var angleViolation = (curMinAngle < FLOW_MIN_ANGLE_DEG);

      if (!areaViolation && !angleViolation) continue;

      var centX = (ca.x + cb.x + cc.x) / 3;
      var centY = (ca.y + cb.y + cc.y) / 3;
      var refCentX = (ref.verts[0].x + ref.verts[1].x + ref.verts[2].x) / 3;
      var refCentY = (ref.verts[0].y + ref.verts[1].y + ref.verts[2].y) / 3;

      var curEdges = [
        Math.sqrt((cb.x - ca.x) * (cb.x - ca.x) + (cb.y - ca.y) * (cb.y - ca.y)),
        Math.sqrt((cc.x - cb.x) * (cc.x - cb.x) + (cc.y - cb.y) * (cc.y - cb.y)),
        Math.sqrt((ca.x - cc.x) * (ca.x - cc.x) + (ca.y - cc.y) * (ca.y - cc.y))
      ];
      var refEdges = [
        Math.sqrt((ref.verts[1].x - ref.verts[0].x) ** 2 + (ref.verts[1].y - ref.verts[0].y) ** 2),
        Math.sqrt((ref.verts[2].x - ref.verts[1].x) ** 2 + (ref.verts[2].y - ref.verts[1].y) ** 2),
        Math.sqrt((ref.verts[0].x - ref.verts[2].x) ** 2 + (ref.verts[0].y - ref.verts[2].y) ** 2)
      ];
      var curAvgEdge = (curEdges[0] + curEdges[1] + curEdges[2]) / 3;
      var refAvgEdge = (refEdges[0] + refEdges[1] + refEdges[2]) / 3;
      var scale = (refAvgEdge > 1e-6) ? curAvgEdge / refAvgEdge : 1;

      var idealVerts = [];
      for (var v = 0; v < 3; v++) {
        idealVerts.push({
          x: centX + (ref.verts[v].x - refCentX) * scale,
          y: centY + (ref.verts[v].y - refCentY) * scale
        });
      }

      var indices = [ia, ib, ic];
      var curVerts = [ca, cb, cc];
      var worstIdx = -1;
      var worstDist = 0;
      for (var v = 0; v < 3; v++) {
        var ddx = curVerts[v].x - idealVerts[v].x;
        var ddy = curVerts[v].y - idealVerts[v].y;
        var dd = ddx * ddx + ddy * ddy;
        if (dd > worstDist) {
          worstDist = dd;
          worstIdx = v;
        }
      }

      if (worstIdx >= 0) {
        // Compute severity of violation (0 to 1)
        var severity = 0;
        if (areaViolation) {
          severity = Math.max(severity, Math.abs(Math.log(areaRatio)) / Math.log(FLOW_MAX_AREA_RATIO));
        }
        if (angleViolation) {
          severity = Math.max(severity, (FLOW_MIN_ANGLE_DEG - curMinAngle) / FLOW_MIN_ANGLE_DEG);
        }
        severity = Math.max(0, Math.min(1, severity));

        var ptIdx = indices[worstIdx];
        corrections[ptIdx].dx += (idealVerts[worstIdx].x - curVerts[worstIdx].x);
        corrections[ptIdx].dy += (idealVerts[worstIdx].y - curVerts[worstIdx].y);
        corrections[ptIdx].count += 1;
        corrections[ptIdx].maxSeverity = Math.max(corrections[ptIdx].maxSeverity, severity);
      }
    }

    // Apply corrections with severity-proportional blending
    for (var j = 0; j < nPts; j++) {
      if (corrections[j].count > 0 && regulatedPoints[j]) {
        var avgDx = corrections[j].dx / corrections[j].count;
        var avgDy = corrections[j].dy / corrections[j].count;
        var alpha = FLOW_SHAPE_CORRECTION_MIN + (FLOW_SHAPE_CORRECTION_MAX - FLOW_SHAPE_CORRECTION_MIN) * corrections[j].maxSeverity;
        regulatedPoints[j] = {
          x: regulatedPoints[j].x + alpha * avgDx,
          y: regulatedPoints[j].y + alpha * avgDy
        };
        metrics.correctedS6_5++;
      }
    }
  }

  // ========== Stage 6.6: Laplacian Smoothing ==========
  // Light smoothing on accepted points only (skip null/rejected).
  if (FLOW_LAPLACIAN_ALPHA > 0 && flowNeighborMap) {
    var snapshot = regulatedPoints.map(function(p) { return p ? { x: p.x, y: p.y } : null; });

    for (var j = 0; j < nPts; j++) {
      if (!snapshot[j]) continue; // skip rejected points
      var neighbors = flowNeighborMap[j];
      if (!neighbors || neighbors.length < 2) continue;

      var cx = 0, cy = 0, validCount = 0;
      for (var k = 0; k < neighbors.length; k++) {
        if (snapshot[neighbors[k]]) {
          cx += snapshot[neighbors[k]].x;
          cy += snapshot[neighbors[k]].y;
          validCount++;
        }
      }
      if (validCount < 2) continue;
      cx /= validCount;
      cy /= validCount;

      regulatedPoints[j] = {
        x: snapshot[j].x + FLOW_LAPLACIAN_ALPHA * (cx - snapshot[j].x),
        y: snapshot[j].y + FLOW_LAPLACIAN_ALPHA * (cy - snapshot[j].y)
      };
    }
  }

  // ========== Stage 6: Affine Interpolation of Rejected Points ==========
  // Reconstruct rejected points from their now-regularized neighbors.
  var finalPoints = [];
  for (var j = 0; j < nPts; j++) {
    if (regulatedPoints[j]) {
      finalPoints.push(regulatedPoints[j]);
    } else {
      // Reconstruct from regularized neighbors
      metrics.reconstructedS6++;
      var neighbors = flowNeighborMap[j];
      var goodNeighbors = [];
      if (neighbors) {
        for (var k = 0; k < neighbors.length; k++) {
          if (regulatedPoints[neighbors[k]]) {
            goodNeighbors.push(neighbors[k]);
          }
        }
      }

      if (goodNeighbors.length >= 3) {
        var srcPts = goodNeighbors.map(function(ni) { return prevPoints[ni]; });
        var dstPts = goodNeighbors.map(function(ni) { return regulatedPoints[ni]; });
        var affine = fitAffine2D(srcPts, dstPts);
        if (affine) {
          finalPoints.push(applyAffine(affine, prevPoints[j]));
        } else {
          var dxs = goodNeighbors.map(function(ni) { return regulatedPoints[ni].x - prevPoints[ni].x; });
          var dys = goodNeighbors.map(function(ni) { return regulatedPoints[ni].y - prevPoints[ni].y; });
          finalPoints.push({
            x: prevPoints[j].x + median(dxs),
            y: prevPoints[j].y + median(dys)
          });
        }
      } else if (goodNeighbors.length >= 1) {
        var dxs = goodNeighbors.map(function(ni) { return regulatedPoints[ni].x - prevPoints[ni].x; });
        var dys = goodNeighbors.map(function(ni) { return regulatedPoints[ni].y - prevPoints[ni].y; });
        finalPoints.push({
          x: prevPoints[j].x + median(dxs),
          y: prevPoints[j].y + median(dys)
        });
      } else {
        finalPoints.push({ x: prevPoints[j].x, y: prevPoints[j].y });
      }
    }
  }

  // ========== Stage 7: Post-interpolation Color Snap ==========
  // If a final point (tracked or interpolated) lands on the wrong color,
  // search for the nearest pixel of the correct color and snap to it.
  var FLOW_COLOR_SEARCH_RADIUS = 20; // max search radius in pixels
  if (flowPointClassifications) {
    var postBlurred = new cv.Mat();
    cv.GaussianBlur(gray, postBlurred, new cv.Size(FLOW_COLOR_BLUR_SIZE, FLOW_COLOR_BLUR_SIZE), 0);

    for (var j = 0; j < nPts; j++) {
      var fpx = Math.round(finalPoints[j].x);
      var fpy = Math.round(finalPoints[j].y);
      var cpx = Math.max(0, Math.min(w - 1, fpx));
      var cpy = Math.max(0, Math.min(h - 1, fpy));
      var val = postBlurred.ucharAt(cpy, cpx);

      var colorOk = true;
      if (flowPointClassifications[j]) {
        if (val > FLOW_COLOR_THRESHOLD + FLOW_COLOR_TOLERANCE) colorOk = false;
      } else {
        if (val < FLOW_COLOR_THRESHOLD - FLOW_COLOR_TOLERANCE) colorOk = false;
      }

      if (!colorOk) {
        // Search nearest pixel of correct color in expanding radius
        var found = false;
        var bestDist = Infinity;
        var bestX = fpx, bestY = fpy;
        var isDark = flowPointClassifications[j];

        for (var r = 1; r <= FLOW_COLOR_SEARCH_RADIUS && !found; r++) {
          // Scan the perimeter of the square at radius r
          for (var dx = -r; dx <= r; dx++) {
            for (var dy = -r; dy <= r; dy++) {
              // Only check pixels on the perimeter of this ring
              if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;

              var sx = fpx + dx, sy = fpy + dy;
              if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;

              var sv = postBlurred.ucharAt(sy, sx);
              var match = isDark
                ? (sv < FLOW_COLOR_THRESHOLD)
                : (sv >= FLOW_COLOR_THRESHOLD);

              if (match) {
                var dist = dx * dx + dy * dy;
                if (dist < bestDist) {
                  bestDist = dist;
                  bestX = sx;
                  bestY = sy;
                  found = true; // found at this radius, finish this ring then stop
                }
              }
            }
          }
        }

        if (found) {
          finalPoints[j] = { x: bestX, y: bestY };
          metrics.snappedS7++;
        } else {
          // No correct color found nearby: freeze at previous position
          finalPoints[j] = { x: prevPoints[j].x, y: prevPoints[j].y };
          metrics.frozenS7++;
        }
      }
    }

    postBlurred.delete();
  }

  // ========== Stage 8: Temporal Anchor Correction ==========
  // Periodically check drift from anchor and apply soft correction.
  flowFrameCounter++;
  if (flowAnchorPoints && flowFrameCounter % FLOW_ANCHOR_INTERVAL === 0) {
    var totalDrift = 0;
    for (var j = 0; j < nPts; j++) {
      var adx = finalPoints[j].x - flowAnchorPoints[j].x;
      var ady = finalPoints[j].y - flowAnchorPoints[j].y;
      totalDrift += Math.sqrt(adx * adx + ady * ady);
    }
    var avgDrift = totalDrift / nPts;

    if (avgDrift > FLOW_ANCHOR_MAX_DRIFT) {
      for (var j = 0; j < nPts; j++) {
        finalPoints[j] = {
          x: finalPoints[j].x + FLOW_ANCHOR_CORRECTION_ALPHA * (flowAnchorPoints[j].x - finalPoints[j].x),
          y: finalPoints[j].y + FLOW_ANCHOR_CORRECTION_ALPHA * (flowAnchorPoints[j].y - finalPoints[j].y)
        };
      }
    }

    // Update anchor to current positions
    flowAnchorPoints = finalPoints.map(function(p) { return { x: p.x, y: p.y }; });
  }

  // Update state for next frame
  flowPrevGray.delete();
  flowPrevGray = gray;
  flowPrevPts.delete();
  flowPrevPts = cv.matFromArray(
    finalPoints.length, 1, cv.CV_32FC2,
    finalPoints.flatMap(function(p) { return [p.x, p.y]; })
  );

  return { points: finalPoints, metrics: metrics };
}

function flowCleanup() {
  if (flowPrevGray) { flowPrevGray.delete(); flowPrevGray = null; }
  if (flowPrevPts) { flowPrevPts.delete(); flowPrevPts = null; }
  flowInitialPoints = null;
  flowTriangles = null;
  flowNeighborMap = null;
  flowRefEdgeLengths = null;
  flowRefTriangleData = null;
  flowMaxDisplacement = 0;
  flowPointClassifications = null;
  flowAnchorPoints = null;
  flowFrameCounter = 0;
}

// Rééchantillonner un contour fermé à N points équidistants par arc-length
function resampleContourArcLength(rawPoints, targetCount) {
  var n = rawPoints.length;
  if (n < 3 || targetCount < 3) return rawPoints;

  // Cumulative arc lengths (closed loop)
  var cumLen = [0];
  for (var i = 1; i <= n; i++) {
    var a = rawPoints[i - 1];
    var b = rawPoints[i % n];
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    cumLen.push(cumLen[i - 1] + Math.sqrt(dx * dx + dy * dy));
  }
  var totalLen = cumLen[n];
  if (totalLen === 0) return rawPoints;

  var step = totalLen / targetCount;
  var result = [];
  var segIdx = 0;

  for (var i = 0; i < targetCount; i++) {
    var targetDist = i * step;
    while (segIdx < n - 1 && cumLen[segIdx + 1] < targetDist) {
      segIdx++;
    }
    var segStart = cumLen[segIdx];
    var segEnd = cumLen[segIdx + 1];
    var t = segEnd > segStart ? (targetDist - segStart) / (segEnd - segStart) : 0;
    var a = rawPoints[segIdx];
    var b = rawPoints[(segIdx + 1) % n];
    result.push({
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y)
    });
  }

  return result;
}

// Détecter le contour principal d'un dessin (pour la triangulation)
// Retourne un contour dense (~500 points) fidèle au vrai bord
function detectContour(imgData) {
  const w = imgData.width;
  const h = imgData.height;

  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  const gray = new cv.Mat();
  const binary = new cv.Mat();
  const closed = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.threshold(gray, binary, 128, 255, cv.THRESH_BINARY_INV);

    var kernelSize = Math.max(5, Math.round(Math.max(w, h) * 0.03));
    if (kernelSize % 2 === 0) kernelSize++;
    var kernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(kernelSize, kernelSize));
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);
    kernel.delete();

    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    // CHAIN_APPROX_NONE: get every pixel on the contour for maximum fidelity
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    if (contours.size() === 0) {
      contours.delete();
      hierarchy.delete();
      return { points: null };
    }

    var maxArea = 0, maxIdx = 0;
    for (var i = 0; i < contours.size(); i++) {
      var area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    var largestContour = contours.get(maxIdx);

    // Extract all raw contour points
    var rawPoints = [];
    for (var j = 0; j < largestContour.rows; j++) {
      rawPoints.push({ x: largestContour.data32S[j * 2], y: largestContour.data32S[j * 2 + 1] });
    }

    contours.delete();
    hierarchy.delete();

    if (rawPoints.length < 3) return { points: null };

    // Resample to a dense but manageable reference (~500 points)
    var densePoints = resampleContourArcLength(rawPoints, 500);

    return { points: densePoints };
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    closed.delete();
  }
}

// Écouter les messages du thread principal
self.onmessage = async function(e) {
  const { type, imageData } = e.data;

  if (type === 'init') {
    try {
      await loadCV();
      console.log('Worker: OpenCV prêt');
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'error', error: err.message });
    }
    return;
  }

  if (type === 'flow-init') {
    try {
      flowInit(e.data.points, e.data.triangles || []);
      self.postMessage({ type: 'flow-init-done' });
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-frame') {
    try {
      const result = flowProcessFrame(imageData);
      self.postMessage({ type: 'flow-frame-result', points: result.points, metrics: result.metrics });
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-cleanup') {
    flowCleanup();
    self.postMessage({ type: 'flow-cleanup-done' });
    return;
  }

  if (type === 'contour') {
    try {
      const result = detectContour(imageData);
      self.postMessage({ type: 'contour-result', points: result.points });
    } catch (err) {
      console.error('Worker contour error:', err);
      self.postMessage({ type: 'contour-result', points: null, error: err.message });
    }
    return;
  }

  if (type === 'detect') {
    try {
      const result = detectCornersLightweight(imageData);
      self.postMessage({
        type: 'detect-result',
        corners: result.corners
          ? result.corners.map(c => ({ x: Math.round(c.x), y: Math.round(c.y) }))
          : null
      });
    } catch (err) {
      console.error('Worker detect error:', err);
      self.postMessage({ type: 'detect-result', corners: null, error: err.message });
    }
    return;
  }

  if (type === 'process') {
    try {
      const predetectedCorners = e.data.predetectedCorners || null;
      let corners = null;
      let strategy = null;
      let debug = {};

      if (predetectedCorners && predetectedCorners.length === 4) {
        const sorted4 = [...predetectedCorners].sort((a, b) => (a.x + a.y) - (b.x + b.y));
        const tl = sorted4[0];
        const br = sorted4[3];
        const rem = [sorted4[1], sorted4[2]];
        const tr = rem[0].x > rem[1].x ? rem[0] : rem[1];
        const bl = rem[0].x > rem[1].x ? rem[1] : rem[0];
        const candidate = [tl, tr, br, bl];

        if (validateQuadrilateral(candidate, imageData.width, imageData.height)) {
          corners = candidate;
          strategy = 'predetected';
          debug = { source: 'predetected_from_preview', corners: candidate };
        } else {
          console.warn('Worker: corners pre-detectes invalides, fallback detection complete');
          const detection = detectCorners(imageData);
          corners = detection.corners;
          strategy = detection.strategy;
          debug = detection.debug;
        }
      } else {
        const detection = detectCorners(imageData);
        corners = detection.corners;
        strategy = detection.strategy;
        debug = detection.debug;
      }

      if (corners) {
        const result = correctPerspective(imageData, corners);
        self.postMessage({
          type: 'result',
          imageData: result,
          corrected: true,
          strategy: strategy,
          detectedCorners: corners.map(c => ({ x: Math.round(c.x), y: Math.round(c.y) })),
          debug: debug
        });
      } else {
        self.postMessage({
          type: 'result',
          imageData: { data: imageData.data, width: imageData.width, height: imageData.height },
          corrected: false,
          debug: debug
        });
      }
    } catch (err) {
      console.error('Worker error:', err);
      self.postMessage({ type: 'error', error: err.message });
    }
  }
};
