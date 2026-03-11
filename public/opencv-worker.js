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

// --- Optical flow tracking ---

// State for incremental optical flow
let flowPrevGray = null;
let flowPrevPts = null;
let flowWinSize = null;
let flowMaxLevel = 3;
let flowCriteria = null;
let flowInitialPoints = null;

// State for contour anchor template matching
let flowTemplates = null;              // Array of cv.Mat patches per contour anchor
let flowContourAnchorIndices = null;   // Which point indices are contour anchors
let flowTemplateSize = 31;             // Patch size for template matching
let flowTemplateSearchRadius = 30;     // Search radius around LK position

function flowInit(initialPoints) {
  flowInitialPoints = initialPoints;
  flowPrevGray = null;
  flowPrevPts = null;
  flowWinSize = new cv.Size(21, 21);
  flowMaxLevel = 3;
  flowCriteria = new cv.TermCriteria(
    cv.TERM_CRITERIA_EPS | cv.TERM_CRITERIA_COUNT, 30, 0.01
  );
}

function flowProcessFrame(imgData) {
  const w = imgData.width, h = imgData.height;
  const src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));
  const gray = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  src.delete();

  // First frame: just store grayscale and return initial points
  if (!flowPrevGray) {
    flowPrevGray = gray;
    flowPrevPts = cv.matFromArray(
      flowInitialPoints.length, 1, cv.CV_32FC2,
      flowInitialPoints.flatMap(function(p) { return [p.x, p.y]; })
    );
    return { points: flowInitialPoints };
  }

  // Optical flow
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
  var points = [];

  for (var j = 0; j < flowInitialPoints.length; j++) {
    if (statusData[j] === 1) {
      points.push({ x: nextData[j * 2], y: nextData[j * 2 + 1] });
    } else {
      points.push({ x: prevData[j * 2], y: prevData[j * 2 + 1] });
    }
  }

  // Update state for next frame
  flowPrevGray.delete();
  flowPrevGray = gray;
  flowPrevPts.delete();
  flowPrevPts = cv.matFromArray(
    points.length, 1, cv.CV_32FC2,
    points.flatMap(function(p) { return [p.x, p.y]; })
  );
  status.delete();
  err.delete();
  nextPts.delete();

  // Run template matching for contour anchors if templates are initialized
  var contourMatches = flowMatchTemplates(gray, points);

  return { points: points, contourMatches: contourMatches };
}

/**
 * Extract dense contour from a frame for snap-to-contour.
 * Returns all contour pixels (not simplified) of the largest external contour.
 */
function extractFrameContourDense(imgData) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  var binary = new cv.Mat();
  var closed = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);

    // Otsu thresholding (auto-adapts to frame brightness)
    cv.threshold(blurred, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

    // Morphological close to bridge small gaps
    var kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.morphologyEx(binary, closed, cv.MORPH_CLOSE, kernel);

    // Optional: dilate 1px to thicken contour for better snap surface
    var dilateKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    var dilated = new cv.Mat();
    cv.dilate(closed, dilated, dilateKernel, new cv.Point(-1, -1), 1);

    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    if (contours.size() === 0) {
      contours.delete(); hierarchy.delete();
      kernel.delete(); dilateKernel.delete(); dilated.delete();
      return { contourPoints: null };
    }

    // Find largest contour by area
    var maxArea = 0, maxIdx = 0;
    for (var i = 0; i < contours.size(); i++) {
      var area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    var largest = contours.get(maxIdx);
    var points = [];
    for (var j = 0; j < largest.rows; j++) {
      points.push({ x: largest.data32S[j * 2], y: largest.data32S[j * 2 + 1] });
    }

    contours.delete(); hierarchy.delete();
    kernel.delete(); dilateKernel.delete(); dilated.delete();

    return { contourPoints: points };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); binary.delete(); closed.delete();
  }
}

/**
 * Initialize templates for contour anchor points.
 * Must be called after flow-init + first flow-frame (so flowPrevGray is available).
 */
function flowInitTemplates(contourAnchorIndices, templateSize) {
  flowContourAnchorIndices = contourAnchorIndices;
  flowTemplateSize = templateSize || 31;

  // Free previous templates
  if (flowTemplates) {
    for (var i = 0; i < flowTemplates.length; i++) {
      if (flowTemplates[i]) flowTemplates[i].delete();
    }
  }

  if (!flowPrevGray || !flowPrevPts) {
    flowTemplates = null;
    return;
  }

  flowTemplates = [];
  var half = Math.floor(flowTemplateSize / 2);
  var h = flowPrevGray.rows;
  var w = flowPrevGray.cols;
  var ptsData = flowPrevPts.data32F;

  for (var i = 0; i < contourAnchorIndices.length; i++) {
    var idx = contourAnchorIndices[i];
    var cx = Math.round(ptsData[idx * 2]);
    var cy = Math.round(ptsData[idx * 2 + 1]);

    // Clamp ROI to image bounds
    var x0 = Math.max(0, cx - half);
    var y0 = Math.max(0, cy - half);
    var x1 = Math.min(w, cx + half + 1);
    var y1 = Math.min(h, cy + half + 1);

    if (x1 - x0 < flowTemplateSize * 0.5 || y1 - y0 < flowTemplateSize * 0.5) {
      // Template too small (near edge), skip
      flowTemplates.push(null);
      continue;
    }

    var roi = new cv.Rect(x0, y0, x1 - x0, y1 - y0);
    var patch = flowPrevGray.roi(roi).clone();
    flowTemplates.push(patch);
  }
}

/**
 * Run template matching for contour anchors on the current gray frame.
 * Returns match results for each contour anchor.
 */
function flowMatchTemplates(gray, lkPoints) {
  if (!flowTemplates || !flowContourAnchorIndices) return null;

  var h = gray.rows;
  var w = gray.cols;
  var results = [];
  var searchR = flowTemplateSearchRadius;

  for (var i = 0; i < flowContourAnchorIndices.length; i++) {
    var template = flowTemplates[i];
    var idx = flowContourAnchorIndices[i];
    var lkPos = lkPoints[idx];

    if (!template) {
      results.push({ lkPos: lkPos, tmPos: lkPos, tmScore: 0 });
      continue;
    }

    var tW = template.cols;
    var tH = template.rows;

    // Search ROI around LK position
    var cx = Math.round(lkPos.x);
    var cy = Math.round(lkPos.y);
    var roiX = Math.max(0, cx - searchR);
    var roiY = Math.max(0, cy - searchR);
    var roiW = Math.min(w, cx + searchR + 1) - roiX;
    var roiH = Math.min(h, cy + searchR + 1) - roiY;

    // ROI must be bigger than template
    if (roiW <= tW || roiH <= tH) {
      results.push({ lkPos: lkPos, tmPos: lkPos, tmScore: 0 });
      continue;
    }

    var roiRect = new cv.Rect(roiX, roiY, roiW, roiH);
    var searchRegion = gray.roi(roiRect);
    var resultMat = new cv.Mat();

    try {
      cv.matchTemplate(searchRegion, template, resultMat, cv.TM_CCOEFF_NORMED);
      var minMax = cv.minMaxLoc(resultMat);
      var bestScore = minMax.maxVal;
      var bestLoc = minMax.maxLoc;

      // Convert from result coords to image coords (top-left of template match)
      var matchX = roiX + bestLoc.x + tW / 2;
      var matchY = roiY + bestLoc.y + tH / 2;

      results.push({
        lkPos: lkPos,
        tmPos: { x: matchX, y: matchY },
        tmScore: bestScore
      });
    } catch (e) {
      results.push({ lkPos: lkPos, tmPos: lkPos, tmScore: 0 });
    } finally {
      searchRegion.delete();
      resultMat.delete();
    }
  }

  return results;
}

function flowCleanup() {
  if (flowPrevGray) { flowPrevGray.delete(); flowPrevGray = null; }
  if (flowPrevPts) { flowPrevPts.delete(); flowPrevPts = null; }
  flowInitialPoints = null;

  // Clean up templates
  if (flowTemplates) {
    for (var i = 0; i < flowTemplates.length; i++) {
      if (flowTemplates[i]) flowTemplates[i].delete();
    }
    flowTemplates = null;
  }
  flowContourAnchorIndices = null;
}

// Détecter le contour principal d'un dessin (pour la triangulation)
function detectContour(imgData, density) {
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
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

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
    var perimeter = cv.arcLength(largestContour, true);
    var epsilon = perimeter * (0.008 / density);
    var approx = new cv.Mat();
    cv.approxPolyDP(largestContour, approx, epsilon, true);

    var points = [];
    for (var j = 0; j < approx.rows; j++) {
      points.push({ x: approx.data32S[j * 2], y: approx.data32S[j * 2 + 1] });
    }

    approx.delete();
    contours.delete();
    hierarchy.delete();

    return { points: points.length >= 3 ? points : null };
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    closed.delete();
  }
}

// Détection Canny + findContours — retourne uniquement le plus grand contour externe
// Stratégie : Canny → dilate+close pour fermer les gaps → floodFill depuis les bords (fond)
// → inverser → findContours sur la silhouette remplie
function extractCannyContour(imgData, lowThreshold, highThreshold, blurSize) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  var edges = new cv.Mat();
  var closed = new cv.Mat();
  var filled = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    var kSize = blurSize % 2 === 1 ? blurSize : blurSize + 1;
    cv.GaussianBlur(gray, blurred, new cv.Size(kSize, kSize), 0);
    cv.Canny(blurred, edges, lowThreshold, highThreshold);

    // Dilate then close to bridge gaps in the edge contour
    var dilateKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.dilate(edges, closed, dilateKernel, new cv.Point(-1, -1), 3);
    var closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.morphologyEx(closed, closed, cv.MORPH_CLOSE, closeKernel);

    // FloodFill from top-left corner to mark the background
    // We work on a copy since floodFill modifies in-place
    closed.copyTo(filled);
    var mask = new cv.Mat(h + 2, w + 2, cv.CV_8UC1, new cv.Scalar(0));
    cv.floodFill(filled, mask, new cv.Point(0, 0), new cv.Scalar(255));

    // Invert: now the object interior is white, background is black
    cv.bitwise_not(filled, filled);
    // Combine with original edges to keep the silhouette shape
    cv.bitwise_or(closed, filled, filled);

    var contours = new cv.MatVector();
    var hierarchy = new cv.Mat();
    cv.findContours(filled, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    mask.delete();

    if (contours.size() === 0) {
      contours.delete(); hierarchy.delete();
      dilateKernel.delete(); closeKernel.delete();
      return { contourPoints: null };
    }

    // Find largest contour by area
    var maxArea = 0, maxIdx = 0;
    for (var i = 0; i < contours.size(); i++) {
      var area = cv.contourArea(contours.get(i));
      if (area > maxArea) { maxArea = area; maxIdx = i; }
    }

    var largest = contours.get(maxIdx);
    var points = [];
    for (var j = 0; j < largest.rows; j++) {
      points.push({ x: largest.data32S[j * 2], y: largest.data32S[j * 2 + 1] });
    }

    contours.delete(); hierarchy.delete();
    dilateKernel.delete(); closeKernel.delete();
    return { contourPoints: points };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete(); closed.delete(); filled.delete();
  }
}

// Détection Canny edges — retourne les pixels de bords
function extractCannyEdges(imgData, lowThreshold, highThreshold, blurSize) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  var edges = new cv.Mat();

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    var kSize = blurSize % 2 === 1 ? blurSize : blurSize + 1;
    cv.GaussianBlur(gray, blurred, new cv.Size(kSize, kSize), 0);
    cv.Canny(blurred, edges, lowThreshold, highThreshold);

    // Extract non-zero pixel coordinates
    var edgePoints = [];
    var data = edges.data;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        if (data[y * w + x] > 0) {
          edgePoints.push({ x: x, y: y });
        }
      }
    }

    return { edgePoints: edgePoints };
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
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
      flowInit(e.data.points);
      self.postMessage({ type: 'flow-init-done' });
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-frame') {
    try {
      const result = flowProcessFrame(imageData);
      const msg = { type: 'flow-frame-result', points: result.points };
      if (result.contourMatches) {
        msg.contourMatches = result.contourMatches;
      }
      // Optional: extract Canny contour from current frame for snap-to-contour
      if (e.data.extractContour && e.data.cannyParams) {
        try {
          var cp = e.data.cannyParams;
          var contourResult = extractCannyContour(imageData, cp.low || 50, cp.high || 150, cp.blur || 5);
          msg.detectedContour = contourResult.contourPoints || null;
        } catch (contourErr) {
          console.error('Contour extraction during flow-frame failed:', contourErr);
          msg.detectedContour = null;
        }
      }
      self.postMessage(msg);
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-init-templates') {
    try {
      flowInitTemplates(e.data.contourAnchorIndices, e.data.templateSize);
      self.postMessage({ type: 'flow-init-templates-done' });
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-contour-dense') {
    try {
      const result = extractFrameContourDense(imageData);
      self.postMessage({ type: 'flow-contour-dense-result', contourPoints: result.contourPoints });
    } catch (err) {
      self.postMessage({ type: 'flow-error', error: err.message });
    }
    return;
  }

  if (type === 'flow-update-points') {
    if (flowPrevPts) {
      flowPrevPts.delete();
      flowPrevPts = cv.matFromArray(
        e.data.points.length, 1, cv.CV_32FC2,
        e.data.points.flatMap(function(p) { return [p.x, p.y]; })
      );
    }
    self.postMessage({ type: 'flow-update-points-done' });
    return;
  }

  if (type === 'flow-cleanup') {
    flowCleanup();
    self.postMessage({ type: 'flow-cleanup-done' });
    return;
  }

  if (type === 'canny-contour') {
    try {
      var low = e.data.lowThreshold || 50;
      var high = e.data.highThreshold || 150;
      var blur = e.data.blurSize || 5;
      var result = extractCannyContour(imageData, low, high, blur);
      self.postMessage({ type: 'canny-contour-result', contourPoints: result.contourPoints });
    } catch (err) {
      console.error('Worker canny-contour error:', err);
      self.postMessage({ type: 'canny-contour-result', contourPoints: null, error: err.message });
    }
    return;
  }

  if (type === 'canny-edges') {
    try {
      var low = e.data.lowThreshold || 50;
      var high = e.data.highThreshold || 150;
      var blur = e.data.blurSize || 5;
      var result = extractCannyEdges(imageData, low, high, blur);
      self.postMessage({ type: 'canny-edges-result', edgePoints: result.edgePoints });
    } catch (err) {
      console.error('Worker canny-edges error:', err);
      self.postMessage({ type: 'canny-edges-result', edgePoints: null, error: err.message });
    }
    return;
  }

  if (type === 'contour') {
    try {
      const result = detectContour(imageData, e.data.density || 1);
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
