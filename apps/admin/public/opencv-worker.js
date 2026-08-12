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

  // 3b. Perspective (raccourci fronto-parallèle) : si un côté est ~2× l'opposé,
  // la page est trop inclinée → rejet (filet léger ; le niveau à bulle guide déjà).
  const wRatio = Math.max(topW, botW) / Math.max(Math.min(topW, botW), 1);
  const hRatio = Math.max(leftH, rightH) / Math.max(Math.min(leftH, rightH), 1);
  if (wRatio > 1.9 || hRatio > 1.9) {
    console.log('Worker: quad rejeté - perspective trop forte (wR=' + wRatio.toFixed(2) + ', hR=' + hRatio.toFixed(2) + ')');
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

  // Seuil ABAISSÉ (150→120) + ratio ASSOUPLI (0.5→0.34) pour tolérer une ombre
  // ou un reflet en travers de la page (cas courant sur une table) — sinon une
  // page pourtant bien cadrée est refusée « intérieur sombre ».
  let brightCount = 0;
  const brightThresh = 120;
  for (const p of checkPoints) {
    const px = Math.max(0, Math.min(gray.cols - 1, Math.round(p.x)));
    const py = Math.max(0, Math.min(gray.rows - 1, Math.round(p.y)));
    const val = gray.ucharAt(py, px);
    if (val > brightThresh) brightCount++;
  }

  const ratio = brightCount / checkPoints.length;
  if (ratio < 0.34) {
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

  // Ordonnancement TL/TR/BR/BL ROBUSTE : trier par Y (les 2 plus hauts = rangée
  // du haut), puis chaque rangée par X. Bien plus stable que la diagonale (x+y),
  // qui désignait le mauvais coin sur une page ~carrée à peine tournée → image
  // sortie tournée/miroir.
  const byY = selected.slice().sort((a, b) => a.y - b.y);
  const top = byY.slice(0, 2).sort((a, b) => a.x - b.x);     // [TL, TR]
  const bottom = byY.slice(2, 4).sort((a, b) => a.x - b.x);  // [BL, BR]
  const tl = top[0], tr = top[1];
  const bl = bottom[0], br = bottom[1];

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

/**
 * Template matching "jump" : compare 2 frames arbitraires (pas de tracking incrémental).
 * Pour chaque point source, extrait un patch (templateSize×templateSize) dans la frame source,
 * cherche la meilleure correspondance NCC dans une fenêtre de recherche autour de la même position
 * dans la frame destination.
 * Retourne les positions matchées (ou la position source si patch trop près du bord ou score < 0).
 */
function templateMatchJump(srcImageData, dstImageData, points, templateSize, searchRadius) {
  var w = srcImageData.width;
  var h = srcImageData.height;
  var half = Math.floor(templateSize / 2);

  var srcMat = new cv.Mat(h, w, cv.CV_8UC4);
  srcMat.data.set(new Uint8Array(srcImageData.data));
  var dstMat = new cv.Mat(h, w, cv.CV_8UC4);
  dstMat.data.set(new Uint8Array(dstImageData.data));

  var srcGray = new cv.Mat();
  var dstGray = new cv.Mat();
  cv.cvtColor(srcMat, srcGray, cv.COLOR_RGBA2GRAY);
  cv.cvtColor(dstMat, dstGray, cv.COLOR_RGBA2GRAY);

  var results = [];

  try {
    for (var i = 0; i < points.length; i++) {
      var p = points[i];
      var cx = Math.round(p.x);
      var cy = Math.round(p.y);

      // Extract template patch from source frame
      var tx0 = Math.max(0, cx - half);
      var ty0 = Math.max(0, cy - half);
      var tx1 = Math.min(w, cx + half + 1);
      var ty1 = Math.min(h, cy + half + 1);

      if (tx1 - tx0 < templateSize * 0.5 || ty1 - ty0 < templateSize * 0.5) {
        // Patch too small (point near edge), keep source position
        results.push({ x: p.x, y: p.y, score: 0 });
        continue;
      }

      var templateRect = new cv.Rect(tx0, ty0, tx1 - tx0, ty1 - ty0);
      var template = srcGray.roi(templateRect).clone();
      var tW = template.cols;
      var tH = template.rows;

      // Search ROI in destination frame, centered on source position
      var sx0 = Math.max(0, cx - searchRadius);
      var sy0 = Math.max(0, cy - searchRadius);
      var sx1 = Math.min(w, cx + searchRadius + 1);
      var sy1 = Math.min(h, cy + searchRadius + 1);
      var sW = sx1 - sx0;
      var sH = sy1 - sy0;

      if (sW <= tW || sH <= tH) {
        template.delete();
        results.push({ x: p.x, y: p.y, score: 0 });
        continue;
      }

      var searchRect = new cv.Rect(sx0, sy0, sW, sH);
      var searchRegion = dstGray.roi(searchRect);
      var resultMat = new cv.Mat();

      try {
        cv.matchTemplate(searchRegion, template, resultMat, cv.TM_CCOEFF_NORMED);
        var minMax = cv.minMaxLoc(resultMat);
        var bestScore = minMax.maxVal;
        var bestLoc = minMax.maxLoc;

        // Convert from result coords to image coords (top-left match → patch center)
        // Patch center offset within the template
        var matchOffsetX = cx - tx0;
        var matchOffsetY = cy - ty0;
        var matchX = sx0 + bestLoc.x + matchOffsetX;
        var matchY = sy0 + bestLoc.y + matchOffsetY;

        results.push({ x: matchX, y: matchY, score: bestScore });
      } catch (e) {
        results.push({ x: p.x, y: p.y, score: 0 });
      } finally {
        template.delete();
        searchRegion.delete();
        resultMat.delete();
      }
    }
  } finally {
    srcMat.delete();
    dstMat.delete();
    srcGray.delete();
    dstGray.delete();
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

// Segmentation par zone via flood-fill bornée par le trait Canny.
//
// Pour un coloriage N&B : la silhouette est le contour externe global (largest
// after floodFill). Chaque patte est obtenue par flood-fill depuis un seed cliqué
// par l'admin, bornée par les arêtes Canny dilatées (le trait interne entre patte
// et corps bloque la diffusion). La région remplie est ensuite dilatée du même
// rayon que la barrière → l'enveloppe finale englobe le trait noir.
//
// Args:
//   imgData     : ImageData de référence
//   low/high    : seuils Canny
//   blur        : taille du Gaussian blur (impair)
//   seeds       : Array<{ id: string, x: number, y: number }> — un par patte
//
// Returns:
//   { silhouette: Point2D[] | null, zoneContours: { [zoneId]: Point2D[] } }
// Zhang-Suen thinning : binary input (Uint8Array row-major 0/1), in-place style.
// Returns a new Uint8Array of the thinned skeleton.
function zhangSuenThin(binary, w, h) {
  var data = new Uint8Array(binary);
  // P2..P9 ordering : clockwise starting from N (Zhang-Suen)
  //   p2 = top, p3 = top-right, p4 = right, p5 = bot-right,
  //   p6 = bot, p7 = bot-left,  p8 = left,  p9 = top-left
  var DX = [0, 1, 1, 1, 0, -1, -1, -1];
  var DY = [-1, -1, 0, 1, 1, 1, 0, -1];
  var toDelete = new Uint8Array(w * h);
  var iters = 0;
  while (true) {
    iters++;
    if (iters > 200) break; // safety
    var changed = false;
    for (var step = 0; step < 2; step++) {
      var delCount = 0;
      toDelete.fill(0);
      for (var y = 1; y < h - 1; y++) {
        for (var x = 1; x < w - 1; x++) {
          var idx = y * w + x;
          if (data[idx] === 0) continue;
          // Gather neighbours p2..p9
          var p = [0,0,0,0,0,0,0,0];
          for (var i = 0; i < 8; i++) {
            p[i] = data[(y + DY[i]) * w + (x + DX[i])];
          }
          var B = p[0]+p[1]+p[2]+p[3]+p[4]+p[5]+p[6]+p[7];
          if (B < 2 || B > 6) continue;
          // A = number of 0->1 transitions in p2,p3,...,p9,p2
          var A = 0;
          for (var k = 0; k < 8; k++) {
            if (p[k] === 0 && p[(k + 1) % 8] === 1) A++;
          }
          if (A !== 1) continue;
          if (step === 0) {
            if (p[0] * p[2] * p[4] !== 0) continue;
            if (p[2] * p[4] * p[6] !== 0) continue;
          } else {
            if (p[0] * p[2] * p[6] !== 0) continue;
            if (p[0] * p[4] * p[6] !== 0) continue;
          }
          toDelete[idx] = 1;
          delCount++;
        }
      }
      if (delCount > 0) {
        changed = true;
        for (var d = 0; d < toDelete.length; d++) {
          if (toDelete[d]) data[d] = 0;
        }
      }
    }
    if (!changed) break;
  }
  return data;
}

// Build adjacency from a thinned binary mask. Each skeleton pixel becomes a node;
// edges are 8-neighbour with weight 1 (axial) or sqrt(2) (diagonal).
// Returns: { skelPts: [{x,y}], adj: number[][2] flattened pairs (to, w*1000) per node }
// We use compact flat arrays for speed.
function buildSkeletonGraph(binary, w, h) {
  var skelPts = [];
  var pixToNode = new Int32Array(w * h);
  for (var i = 0; i < pixToNode.length; i++) pixToNode[i] = -1;
  for (var y = 0; y < h; y++) {
    for (var x = 0; x < w; x++) {
      if (binary[y * w + x]) {
        pixToNode[y * w + x] = skelPts.length;
        skelPts.push({ x: x, y: y });
      }
    }
  }
  var n = skelPts.length;
  // adj[i] = array of [neighborNodeIdx, weight]
  var adj = new Array(n);
  for (var i = 0; i < n; i++) adj[i] = [];
  var DX = [-1, 0, 1, -1, 1, -1, 0, 1];
  var DY = [-1, -1, -1, 0, 0, 1, 1, 1];
  var DW = [1.41421356, 1, 1.41421356, 1, 1, 1.41421356, 1, 1.41421356];
  for (var i = 0; i < n; i++) {
    var sp = skelPts[i];
    for (var k = 0; k < 8; k++) {
      var nx = sp.x + DX[k], ny = sp.y + DY[k];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      var nidx = pixToNode[ny * w + nx];
      if (nidx < 0) continue;
      adj[i].push([nidx, DW[k]]);
    }
  }
  return { skelPts: skelPts, adj: adj, pixToNode: pixToNode };
}

// Snap an arbitrary (x,y) image-space point to the nearest skeleton node.
// Linear scan — n is typically 10k-100k, acceptable for a handful of calls.
function snapToSkeleton(skelPts, x, y) {
  var best = -1, bestD = Infinity;
  for (var i = 0; i < skelPts.length; i++) {
    var dx = skelPts[i].x - x, dy = skelPts[i].y - y;
    var d = dx * dx + dy * dy;
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

// Standard Dijkstra with binary min-heap, returns { dist: Float64Array, prev: Int32Array }.
function dijkstra(adj, source) {
  var n = adj.length;
  var dist = new Float64Array(n);
  for (var i = 0; i < n; i++) dist[i] = Infinity;
  dist[source] = 0;
  var prev = new Int32Array(n);
  for (var i = 0; i < n; i++) prev[i] = -1;
  // Heap of [dist, node]
  var heap = [[0, source]];
  function siftUp(i) {
    while (i > 0) {
      var par = (i - 1) >> 1;
      if (heap[par][0] > heap[i][0]) {
        var t = heap[par]; heap[par] = heap[i]; heap[i] = t;
        i = par;
      } else return;
    }
  }
  function siftDown(i) {
    var L = heap.length;
    while (true) {
      var l = 2*i+1, r = 2*i+2, m = i;
      if (l < L && heap[l][0] < heap[m][0]) m = l;
      if (r < L && heap[r][0] < heap[m][0]) m = r;
      if (m === i) return;
      var t = heap[m]; heap[m] = heap[i]; heap[i] = t;
      i = m;
    }
  }
  while (heap.length > 0) {
    var top = heap[0];
    var last = heap.pop();
    if (heap.length > 0) { heap[0] = last; siftDown(0); }
    var d = top[0], u = top[1];
    if (d > dist[u]) continue;
    var ua = adj[u];
    for (var j = 0; j < ua.length; j++) {
      var v = ua[j][0], nd = d + ua[j][1];
      if (nd < dist[v]) {
        dist[v] = nd;
        prev[v] = u;
        heap.push([nd, v]);
        siftUp(heap.length - 1);
      }
    }
  }
  return { dist: dist, prev: prev };
}

// Reconstruct path (array of node indices) from prev[] array, source → target.
// Returns null if unreachable.
function reconstructPath(prev, source, target) {
  if (target === source) return [source];
  if (prev[target] === -1) return null;
  var path = [target];
  var cur = prev[target];
  while (cur !== -1) {
    path.push(cur);
    if (cur === source) break;
    cur = prev[cur];
  }
  path.reverse();
  return path[0] === source ? path : null;
}

// Find the shortest closed cycle through all waypoints (node indices in adj).
// Brute-force TSP : (k-1)!/2 distinct cycles, cap waypoint count.
// Returns array of node indices forming the cycle (first not repeated at end).
function findShortestCycle(adj, waypoints) {
  var k = waypoints.length;
  if (k < 2) return null;
  if (k > 8) { console.warn('[skeleton] > 8 waypoints, truncating'); waypoints = waypoints.slice(0, 8); k = 8; }

  // Build distance matrix + paths between all waypoint pairs
  var distMat = new Array(k);
  var paths = new Array(k);
  for (var i = 0; i < k; i++) {
    var d = dijkstra(adj, waypoints[i]);
    distMat[i] = new Float64Array(k);
    paths[i] = new Array(k);
    for (var j = 0; j < k; j++) {
      distMat[i][j] = d.dist[waypoints[j]];
      paths[i][j] = reconstructPath(d.prev, waypoints[i], waypoints[j]);
    }
  }
  // Check connectivity
  for (var i = 0; i < k; i++) {
    for (var j = 0; j < k; j++) {
      if (i !== j && !isFinite(distMat[i][j])) {
        console.warn('[skeleton] waypoints not connected through skeleton');
        return null;
      }
    }
  }

  // Brute-force permutations of indices 1..k-1 with fixed start = 0
  var rest = [];
  for (var i = 1; i < k; i++) rest.push(i);
  var bestPerm = rest.slice(), bestCost = Infinity;
  function permute(arr, start) {
    if (start === arr.length) {
      var c = distMat[0][arr[0]];
      for (var i = 0; i < arr.length - 1; i++) c += distMat[arr[i]][arr[i+1]];
      c += distMat[arr[arr.length - 1]][0];
      if (c < bestCost) { bestCost = c; bestPerm = arr.slice(); }
      return;
    }
    for (var i = start; i < arr.length; i++) {
      var t = arr[start]; arr[start] = arr[i]; arr[i] = t;
      permute(arr, start + 1);
      t = arr[start]; arr[start] = arr[i]; arr[i] = t;
    }
  }
  permute(rest, 0);
  if (!isFinite(bestCost)) return null;

  // Reconstruct cycle as concatenated paths
  var order = [0].concat(bestPerm);
  var cycle = [];
  for (var i = 0; i < order.length; i++) {
    var from = order[i], to = order[(i + 1) % order.length];
    var seg = paths[from][to];
    if (!seg) return null;
    var startIdx = cycle.length === 0 ? 0 : 1; // avoid duplicating waypoint node
    for (var s = startIdx; s < seg.length; s++) cycle.push(seg[s]);
  }
  return cycle;
}

/** Polygon offset (Minkowski sum with a disc of radius `dist`).
 *  Each vertex is moved along its bisector normal — preserves vertex count and
 *  curvature details. Outward direction inferred from signed area. */
function offsetPolygon(points, dist) {
  var n = points.length;
  if (n < 3 || dist === 0) return points.slice();
  var area2 = 0;
  for (var i = 0; i < n; i++) {
    var j = (i + 1) % n;
    area2 += points[i].x * points[j].y - points[j].x * points[i].y;
  }
  var sign = area2 > 0 ? 1 : -1;
  var out = new Array(n);
  for (var k = 0; k < n; k++) {
    var prev = points[(k - 1 + n) % n];
    var cur = points[k];
    var next = points[(k + 1) % n];
    var e1x = cur.x - prev.x, e1y = cur.y - prev.y;
    var e2x = next.x - cur.x, e2y = next.y - cur.y;
    var l1 = Math.hypot(e1x, e1y) || 1e-6;
    var l2 = Math.hypot(e2x, e2y) || 1e-6;
    var n1x = (e1y / l1) * sign, n1y = (-e1x / l1) * sign;
    var n2x = (e2y / l2) * sign, n2y = (-e2x / l2) * sign;
    var bx = n1x + n2x, by = n1y + n2y;
    var bl = Math.hypot(bx, by) || 1e-6;
    var dot = (bx * n1x + by * n1y) / bl;
    if (Math.abs(dot) < 0.2) dot = dot < 0 ? -0.2 : 0.2;
    var scale = dist / dot;
    out[k] = { x: cur.x + (bx / bl) * scale, y: cur.y + (by / bl) * scale };
  }
  return out;
}

function segmentZonesCanny(imgData, lowThreshold, highThreshold, blurSize, seeds, inflate, closingKernel) {
  if (inflate == null) inflate = 12;
  if (closingKernel == null) closingKernel = 0;
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  var edges = new cv.Mat();
  var barrier = new cv.Mat();     // heavy dilate: watertight walls between zones
  var lightBarrier = new cv.Mat();// light dilate: tight outline for silhouette
  var silMask = new cv.Mat();     // mask used to FIND the silhouette contour
  var silClamp = new cv.Mat();    // looser silhouette mask used to clamp legs
  var silFilled = new cv.Mat();
  var silFilled2 = new cv.Mat();
  var walkable = new cv.Mat();
  var dilateKernel = null;
  var closeKernel = null;
  var lightKernel = null;
  var legDilateKernel = null;
  var ffMask = null;
  var ffMask2 = null;
  var silContours = new cv.MatVector();
  var silHier = new cv.Mat();
  var allContours = new cv.MatVector();
  var allHier = new cv.Mat();


  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    var kSize = blurSize % 2 === 1 ? blurSize : blurSize + 1;
    cv.GaussianBlur(gray, blurred, new cv.Size(kSize, kSize), 0);
    cv.Canny(blurred, edges, lowThreshold, highThreshold);

    // EXPERIMENT: no barrier at all — raw Canny edges, no dilation, no close.
    // Most permissive setting; expect flood-fill leaks across zones wherever
    // the Canny trace has micro-gaps.
    dilateKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    edges.copyTo(barrier);

    // Light barrier (3×3 × 1 iter ≈ 1 px) — used for the silhouette outer
    // contour so it sits on the real black trace, not the inflated barrier.
    lightKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(3, 3));
    cv.dilate(edges, lightBarrier, lightKernel, new cv.Point(-1, -1), 1);

    // Optional morphological closing — fills micro-gaps in the Canny trace
    // before flood-fill so the silhouette doesn't leak through hair-thin breaks.
    if (closingKernel > 0) {
      var ck = closingKernel % 2 === 1 ? closingKernel : closingKernel + 1;
      var closingK = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(ck, ck));
      cv.morphologyEx(barrier, barrier, cv.MORPH_CLOSE, closingK);
      cv.morphologyEx(lightBarrier, lightBarrier, cv.MORPH_CLOSE, closingK);
      closingK.delete();
    }

    // Silhouette contour (tight) : floodFill on light barrier.
    lightBarrier.copyTo(silFilled);
    ffMask = new cv.Mat(h + 2, w + 2, cv.CV_8UC1, new cv.Scalar(0));
    cv.floodFill(silFilled, ffMask, new cv.Point(0, 0), new cv.Scalar(255));
    cv.bitwise_not(silFilled, silMask);
    cv.bitwise_or(lightBarrier, silMask, silMask);

    // Looser silhouette (heavy) : used to clamp leg masks so they never spill
    // outside the figure (must use the same dilation as the barrier so the
    // dilated leg can reach the outer side of the heavy barrier).
    barrier.copyTo(silFilled2);
    ffMask2 = new cv.Mat(h + 2, w + 2, cv.CV_8UC1, new cv.Scalar(0));
    cv.floodFill(silFilled2, ffMask2, new cv.Point(0, 0), new cv.Scalar(255));
    cv.bitwise_not(silFilled2, silClamp);
    cv.bitwise_or(barrier, silClamp, silClamp);

    cv.findContours(silMask, silContours, silHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
    var silhouette = null;
    if (silContours.size() > 0) {
      var maxA = 0, maxI = 0;
      for (var i = 0; i < silContours.size(); i++) {
        var ar = cv.contourArea(silContours.get(i));
        if (ar > maxA) { maxA = ar; maxI = i; }
      }
      var largest = silContours.get(maxI);
      silhouette = [];
      for (var j = 0; j < largest.rows; j++) {
        silhouette.push({ x: largest.data32S[j * 2], y: largest.data32S[j * 2 + 1] });
      }
    }

    // ---- All closed black-loop contours ----
    // Strategy: every closed black loop in the trace encloses a white region.
    // We extract all white regions (silhouette ∧ ¬barrier) and their boundaries
    // via RETR_LIST. Each boundary is the closed black-loop contour we want
    // (sans the trace thickness — which we add back via post-dilation).
    cv.subtract(silClamp, barrier, walkable);
    cv.findContours(walkable, allContours, allHier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

    // Collect candidate polygons with their area.
    var candidates = [];   // { points: [{x,y}], area }
    var minArea = (w * h) * 0.00005;  // 0.005% of image area — keep small regions like hooves
    for (var c = 0; c < allContours.size(); c++) {
      var cnt = allContours.get(c);
      if (cnt.rows < 3) continue;
      var a = cv.contourArea(cnt);
      if (a < minArea) continue;
      var pts = [];
      for (var p = 0; p < cnt.rows; p++) {
        pts.push({ x: cnt.data32S[p * 2], y: cnt.data32S[p * 2 + 1] });
      }
      candidates.push({ points: pts, area: a });
    }

    // ---- Fine candidates (light barrier) ----
    // The heavy barrier eats ~8 px of white on each side of every black trace,
    // so very thin features (claws, hooves narrower than ~16 px) disappear
    // from `walkable` entirely. We compute a second set of candidates from a
    // light-barrier walkable so a click on a small claw still finds *something*
    // to pick. Used only as a fallback when no heavy candidate contains the click.
    var fineWalkable = new cv.Mat();
    var fineContours = new cv.MatVector();
    var fineHier = new cv.Mat();
    var fineCandidates = [];
    try {
      cv.subtract(silMask, lightBarrier, fineWalkable);
      cv.findContours(fineWalkable, fineContours, fineHier, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);
      for (var fc = 0; fc < fineContours.size(); fc++) {
        var fcnt = fineContours.get(fc);
        if (fcnt.rows < 3) continue;
        var fa = cv.contourArea(fcnt);
        if (fa < minArea) continue;
        var fpts = [];
        for (var fp = 0; fp < fcnt.rows; fp++) {
          fpts.push({ x: fcnt.data32S[fp * 2], y: fcnt.data32S[fp * 2 + 1] });
        }
        fineCandidates.push({ points: fpts, area: fa });
      }
    } finally {
      fineWalkable.delete();
      fineContours.delete();
      fineHier.delete();
    }

    // For each seed click, pick the candidate whose boundary the click sits on
    // (smallest min-distance), then polygon-offset its boundary by `inflate` px.
    // Overlapping offsets merge naturally when rasterized into the union mask.

    function distPtSegSq(px, py, ax, ay, bx, by) {
      var dx = bx - ax, dy = by - ay;
      var lenSq = dx * dx + dy * dy;
      var t = lenSq > 1e-9 ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
      if (t < 0) t = 0; else if (t > 1) t = 1;
      var cx = ax + t * dx, cy = ay + t * dy;
      return (px - cx) * (px - cx) + (py - cy) * (py - cy);
    }
    function minDistToPolygonSq(px, py, poly) {
      var best = Infinity;
      for (var i = 0, jj = poly.length - 1; i < poly.length; jj = i++) {
        var d = distPtSegSq(px, py, poly[jj].x, poly[jj].y, poly[i].x, poly[i].y);
        if (d < best) best = d;
      }
      return best;
    }
    function polygonCentroid(poly) {
      // Mean of vertices (cheap, good enough for "inside test")
      var cx = 0, cy = 0;
      for (var i = 0; i < poly.length; i++) { cx += poly[i].x; cy += poly[i].y; }
      return { x: cx / poly.length, y: cy / poly.length };
    }
    function fillContourInto(targetMask, poly) {
      var pv = new cv.MatVector();
      var pm = cv.matFromArray(poly.length, 1, cv.CV_32SC2,
        (function () { var arr = []; for (var qi = 0; qi < poly.length; qi++) { arr.push(poly[qi].x, poly[qi].y); } return arr; })());
      pv.push_back(pm);
      cv.fillPoly(targetMask, pv, new cv.Scalar(255));
      pm.delete();
      pv.delete();
    }

    // Each click picks INDEPENDENTLY the candidate that CONTAINS it (bounded
    // by black edges). In case of nesting, the smallest containing candidate
    // wins (= the actual local region you clicked in). All picked candidates
    // are unioned into the final zone mask — so clicking once on the leg + once
    // on the hoof yields leg ∪ hoof, and a large `inflate` bridges them.
    // Clicks landing on a trace / outside any white region are ignored.
    function pointInPoly(px, py, poly) {
      var inside = false;
      for (var i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        var xi = poly[i].x, yi = poly[i].y;
        var xj = poly[j].x, yj = poly[j].y;
        var denom = (yj - yi) || 1e-12;
        var intersect = ((yi > py) !== (yj > py)) &&
          (px < (xj - xi) * (py - yi) / denom + xi);
        if (intersect) inside = !inside;
      }
      return inside;
    }
    function pickContainingCandidateIdx(wp) {
      var bestIdx = -1, bestA = Infinity;
      for (var ci = 0; ci < candidates.length; ci++) {
        if (!pointInPoly(wp.x, wp.y, candidates[ci].points)) continue;
        if (candidates[ci].area < bestA) { bestA = candidates[ci].area; bestIdx = ci; }
      }
      if (bestIdx >= 0) return bestIdx;
      // Fallback: try the fine (light-barrier) candidate set so a click landing
      // on a thin feature (claw, hoof) still gets a region. Append the picked
      // fine candidate to the main `candidates` array so the downstream code
      // (offsetPolygon / fillContourInto) treats it like any other.
      var fineBest = -1, fineBestA = Infinity;
      for (var fi = 0; fi < fineCandidates.length; fi++) {
        if (!pointInPoly(wp.x, wp.y, fineCandidates[fi].points)) continue;
        if (fineCandidates[fi].area < fineBestA) { fineBestA = fineCandidates[fi].area; fineBest = fi; }
      }
      if (fineBest < 0) return -1;
      candidates.push(fineCandidates[fineBest]);
      return candidates.length - 1;
    }

    // Per-seed mask + per-seed contour
    var polyMask = new cv.Mat();
    var legContours = new cv.MatVector();
    var legHier = new cv.Mat();
    var zoneContours = {};
    try {
      for (var s = 0; s < seeds.length; s++) {
        var seed = seeds[s];
        var waypoints = seed.waypoints || [];
        if (waypoints.length === 0) continue;

        // Each waypoint picks its own closest candidate; union them.
        var pickedIdxs = {};
        for (var wpi = 0; wpi < waypoints.length; wpi++) {
          var pi = pickContainingCandidateIdx(waypoints[wpi]);
          if (pi >= 0) pickedIdxs[pi] = 1;
        }
        var pickedList = Object.keys(pickedIdxs).map(function (k) { return parseInt(k, 10); });
        if (pickedList.length === 0) continue;

        {
          // Rasterize all picked candidates into one mask. Dilating each by
          // `inflate` then unioning means two clicks whose inflated polygons
          // overlap merge naturally — including sabot + leg if `inflate` is
          // large enough to bridge them.
          // Polygon-offset each picked candidate (preserves shape/curvature)
          // and rasterize into a union mask. Overlapping offsets merge naturally.
          var dilated = cv.Mat.zeros(h, w, cv.CV_8UC1);
          for (var pli = 0; pli < pickedList.length; pli++) {
            var offsetPts = offsetPolygon(candidates[pickedList[pli]].points, inflate);
            fillContourInto(dilated, offsetPts);
          }
          cv.bitwise_and(dilated, silMask, dilated);
          polyMask = cv.Mat.zeros(h, w, cv.CV_8UC1); // unused placeholder for cleanup symmetry

          cv.findContours(dilated, legContours, legHier, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);
          // Return ALL union components, not just the largest. The user adds
          // independent contours by clicking different regions; only by tuning
          // `inflate` large enough do they merge. We send them all back and let
          // the UI display them (and warn at save time if still disconnected).
          var loops = [];
          for (var kk = 0; kk < legContours.size(); kk++) {
            var lc = legContours.get(kk);
            if (lc.rows < 3) continue;
            var lpts = [];
            for (var nn = 0; nn < lc.rows; nn++) {
              lpts.push({ x: lc.data32S[nn * 2], y: lc.data32S[nn * 2 + 1] });
            }
            loops.push(lpts);
          }
          if (loops.length > 0) zoneContours[seed.id] = loops;

          dilated.delete();
          polyMask.delete();
          polyMask = new cv.Mat();
          legContours.delete();
          legHier.delete();
          legContours = new cv.MatVector();
          legHier = new cv.Mat();
        }
      }
    } finally {
      polyMask.delete();
      legContours.delete();
      legHier.delete();
    }

    return { silhouette: silhouette, zoneContours: zoneContours };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    barrier.delete(); lightBarrier.delete();
    silMask.delete(); silClamp.delete();
    silFilled.delete(); silFilled2.delete();
    walkable.delete();
    if (dilateKernel) dilateKernel.delete();
    if (closeKernel) closeKernel.delete();
    if (lightKernel) lightKernel.delete();
    if (legDilateKernel) legDilateKernel.delete();
    silContours.delete(); silHier.delete();
    allContours.delete(); allHier.delete();
    if (ffMask) ffMask.delete();
    if (ffMask2) ffMask2.delete();
  }
}

// Détection silhouette globale + régions intérieures fermées
// - silhouette : largest external contour après floodFill (= comportement extractCannyContour)
// - regions : toutes les régions blanches (zones intérieures bornées par le trait) NON adjacentes au bord
// Usage : segmentation de coloriage N&B où chaque patte est dessinée comme une boucle fermée.
function extractAllCannyContours(imgData, lowThreshold, highThreshold, blurSize) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var blurred = new cv.Mat();
  var edges = new cv.Mat();
  var closed = new cv.Mat();
  var filled = new cv.Mat();
  var inverted = new cv.Mat();
  var dilateKernel = null;
  var closeKernel = null;
  var contours = new cv.MatVector();
  var hierarchy = new cv.Mat();
  var contoursR = new cv.MatVector();
  var hierarchyR = new cv.Mat();
  var mask = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    var kSize = blurSize % 2 === 1 ? blurSize : blurSize + 1;
    cv.GaussianBlur(gray, blurred, new cv.Size(kSize, kSize), 0);
    cv.Canny(blurred, edges, lowThreshold, highThreshold);

    dilateKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(5, 5));
    cv.dilate(edges, closed, dilateKernel, new cv.Point(-1, -1), 3);
    closeKernel = cv.getStructuringElement(cv.MORPH_ELLIPSE, new cv.Size(7, 7));
    cv.morphologyEx(closed, closed, cv.MORPH_CLOSE, closeKernel);

    // ---- Silhouette globale (même logique que extractCannyContour) ----
    closed.copyTo(filled);
    mask = new cv.Mat(h + 2, w + 2, cv.CV_8UC1, new cv.Scalar(0));
    cv.floodFill(filled, mask, new cv.Point(0, 0), new cv.Scalar(255));
    cv.bitwise_not(filled, filled);
    cv.bitwise_or(closed, filled, filled);

    cv.findContours(filled, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

    var silhouette = null;
    if (contours.size() > 0) {
      var maxArea = 0, maxIdx = 0;
      for (var i = 0; i < contours.size(); i++) {
        var area = cv.contourArea(contours.get(i));
        if (area > maxArea) { maxArea = area; maxIdx = i; }
      }
      var largest = contours.get(maxIdx);
      silhouette = [];
      for (var j = 0; j < largest.rows; j++) {
        silhouette.push({ x: largest.data32S[j * 2], y: largest.data32S[j * 2 + 1] });
      }
    }

    // ---- Régions intérieures : inverser `closed` (= trait noir bouché) ----
    // Les zones blanches deviennent foreground. RETR_LIST + filtrage des régions
    // touchant le bord → chaque boucle fermée du dessin (corps, pattes...) ressort.
    cv.bitwise_not(closed, inverted);
    cv.findContours(inverted, contoursR, hierarchyR, cv.RETR_LIST, cv.CHAIN_APPROX_NONE);

    var regions = [];
    var minArea = (w * h) * 0.001; // 0.1% de l'image
    var maxRegArea = (w * h) * 0.95; // exclure la région englobant tout
    for (var k = 0; k < contoursR.size(); k++) {
      var cnt = contoursR.get(k);
      var ar = cv.contourArea(cnt);
      if (ar < minArea || ar > maxRegArea) continue;
      // Reject regions touching the image border (= background outside the figure)
      var touchesBorder = false;
      for (var m = 0; m < cnt.rows; m++) {
        var px = cnt.data32S[m * 2], py = cnt.data32S[m * 2 + 1];
        if (px <= 0 || py <= 0 || px >= w - 1 || py >= h - 1) { touchesBorder = true; break; }
      }
      if (touchesBorder) continue;
      var pts = [];
      for (var n = 0; n < cnt.rows; n++) {
        pts.push({ x: cnt.data32S[n * 2], y: cnt.data32S[n * 2 + 1] });
      }
      regions.push(pts);
    }

    return { silhouette: silhouette, regions: regions };
  } finally {
    src.delete(); gray.delete(); blurred.delete(); edges.delete();
    closed.delete(); filled.delete(); inverted.delete();
    if (dilateKernel) dilateKernel.delete();
    if (closeKernel) closeKernel.delete();
    contours.delete(); hierarchy.delete();
    contoursR.delete(); hierarchyR.delete();
    if (mask) mask.delete();
  }
}

// Détection bbox du dessin via composantes connexes
// Robuste aux résidus, ombres, traits parasites par construction
// Retourne l'union des bounding rects de tous les contours dont l'aire > 5% du plus gros
function detectDrawingBBoxCV(imgData) {
  var w = imgData.width, h = imgData.height;
  var src = new cv.Mat(h, w, cv.CV_8UC4);
  src.data.set(new Uint8Array(imgData.data));

  var gray = new cv.Mat();
  var binary = new cv.Mat();
  var dilated = new cv.Mat();
  var contours = new cv.MatVector();
  var hierarchy = new cv.Mat();
  var kernel = null;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    // Otsu : seuil adaptatif au contraste réel du scan
    cv.threshold(gray, binary, 0, 255, cv.THRESH_BINARY_INV | cv.THRESH_OTSU);

    // Petite dilatation : fusionne les composantes très proches (anti-aliasing,
    // gaps de 1-2 px dans les traits) sans coller aux ombres distantes
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
    cv.dilate(binary, dilated, kernel);

    cv.findContours(dilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    if (contours.size() === 0) {
      return { bbox: null };
    }

    // Trouver l'aire max
    var maxArea = 0;
    for (var i = 0; i < contours.size(); i++) {
      var a = cv.contourArea(contours.get(i));
      if (a > maxArea) maxArea = a;
    }

    // Garde-fou page blanche : aucun contour significatif
    if (maxArea < w * h * 0.001) {
      return { bbox: null };
    }

    // Union des boundingRect de tous les contours significatifs (≥ 5% du max)
    // → conserve les parties détachées du dessin (antennes, yeux, points isolés)
    // → ignore le bruit (poussière, résidus de marqueurs L)
    var threshold = maxArea * 0.05;
    var minX = w, minY = h, maxX = 0, maxY = 0;
    var kept = 0;
    for (var j = 0; j < contours.size(); j++) {
      var c = contours.get(j);
      if (cv.contourArea(c) < threshold) continue;
      var r = cv.boundingRect(c);
      if (r.x < minX) minX = r.x;
      if (r.y < minY) minY = r.y;
      if (r.x + r.width > maxX) maxX = r.x + r.width;
      if (r.y + r.height > maxY) maxY = r.y + r.height;
      kept++;
    }

    if (kept === 0) {
      return { bbox: null };
    }

    return { bbox: { minX: minX, minY: minY, maxX: maxX, maxY: maxY } };
  } finally {
    src.delete();
    gray.delete();
    binary.delete();
    dilated.delete();
    contours.delete();
    hierarchy.delete();
    if (kernel) kernel.delete();
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

  if (type === 'template-match-jump') {
    try {
      var srcImg = e.data.srcImageData;
      var dstImg = e.data.dstImageData;
      var pts = e.data.points || [];
      var tplSize = e.data.templateSize || 31;
      var searchR = e.data.searchRadius || 200;
      var matched = templateMatchJump(srcImg, dstImg, pts, tplSize, searchR);
      self.postMessage({ type: 'template-match-jump-result', points: matched });
    } catch (err) {
      console.error('Worker template-match-jump error:', err);
      self.postMessage({ type: 'template-match-jump-result', points: null, error: err.message });
    }
    return;
  }

  // mask-to-contour: takes a binary mask (Uint8Array, row-major, 0/1) + dimensions
  // and returns the largest external contour as an ordered array of {x, y} points.
  // Used by sam2Contour.ts to extract polygon contours from SAM 2 RLE masks.
  if (type === 'mask-to-contour') {
    var mask = e.data.mask;          // Uint8Array length = w*h
    var w = e.data.width;
    var h = e.data.height;
    var src = null;
    var contours = null;
    var hierarchy = null;
    try {
      src = cv.matFromArray(h, w, cv.CV_8UC1, mask);
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      // RETR_EXTERNAL = only outer contour, CHAIN_APPROX_NONE = keep every pixel
      cv.findContours(src, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_NONE);

      // Pick the largest contour by area
      var bestIdx = -1;
      var bestArea = 0;
      for (var i = 0; i < contours.size(); i++) {
        var c = contours.get(i);
        var area = cv.contourArea(c, false);
        if (area > bestArea) {
          bestArea = area;
          bestIdx = i;
        }
      }

      var points = [];
      if (bestIdx >= 0) {
        var best = contours.get(bestIdx);
        var data = best.data32S; // [x0, y0, x1, y1, ...]
        for (var k = 0; k < data.length; k += 2) {
          points.push({ x: data[k], y: data[k + 1] });
        }
      }

      self.postMessage({ type: 'mask-to-contour-result', points: points });
    } catch (err) {
      console.error('Worker mask-to-contour error:', err);
      self.postMessage({ type: 'mask-to-contour-result', points: null, error: err.message });
    } finally {
      if (src) src.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
    }
    return;
  }

  if (type === 'eye-floodfill') {
    // Eye detection by connected-component around the click :
    //   1) Threshold Otsu inverse → ink = foreground 255.
    //   2) Snap seed to nearest ink pixel within a radius.
    //   3) floodFill that pixel with marker 128 → marks the whole connected ink component.
    //   4) Extract mask of pixels == 128.
    //   5) findContours RETR_EXTERNAL → outer silhouette polygon. This polygon encloses
    //      the whole shape (eye outline ring + interior : sclera, pupil, highlight, …).
    var src = null, gray = null, binv = null, marked = null, ffMask = null;
    var compMask = null, contours = null, hierarchy = null, approx = null;
    try {
      var seedX = e.data.seedX | 0;
      var seedY = e.data.seedY | 0;
      var tol = e.data.tolerance != null ? e.data.tolerance : 30;
      var snapRadius = Math.max(20, tol * 2);
      src = cv.matFromImageData(imageData);
      gray = new cv.Mat();
      cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
      var w = gray.cols, h = gray.rows;
      binv = new cv.Mat();
      cv.threshold(gray, binv, 0, 255, cv.THRESH_BINARY_INV + cv.THRESH_OTSU);

      // Snap seed to nearest ink pixel (binv == 255) within snapRadius.
      var atSeed = binv.ucharPtr(Math.min(h - 1, Math.max(0, seedY)),
                                 Math.min(w - 1, Math.max(0, seedX)))[0];
      if (atSeed !== 255) {
        var bestD = Infinity, bestX = -1, bestY = -1;
        var x0 = Math.max(0, seedX - snapRadius), x1 = Math.min(w - 1, seedX + snapRadius);
        var y0 = Math.max(0, seedY - snapRadius), y1 = Math.min(h - 1, seedY + snapRadius);
        for (var yy = y0; yy <= y1; yy++) {
          for (var xx = x0; xx <= x1; xx++) {
            if (binv.ucharPtr(yy, xx)[0] === 255) {
              var dx = xx - seedX, dy = yy - seedY;
              var d2 = dx * dx + dy * dy;
              if (d2 < bestD) { bestD = d2; bestX = xx; bestY = yy; }
            }
          }
        }
        if (bestX < 0) {
          self.postMessage({ type: 'eye-floodfill-result', contourPoints: null, error: 'no ink near click' });
          return;
        }
        seedX = bestX; seedY = bestY;
      }

      // floodFill from seed on binv : marks the component with value 128.
      marked = binv.clone();
      ffMask = new cv.Mat.zeros(h + 2, w + 2, cv.CV_8UC1);
      cv.floodFill(marked, ffMask, new cv.Point(seedX, seedY), new cv.Scalar(128),
                   new cv.Rect(0, 0, 0, 0), new cv.Scalar(0), new cv.Scalar(0), 8);

      // Extract pixels == 128 → the connected ink component containing the seed.
      compMask = new cv.Mat();
      cv.inRange(marked, new cv.Scalar(128), new cv.Scalar(128), compMask);

      // Outer silhouette of that component.
      contours = new cv.MatVector();
      hierarchy = new cv.Mat();
      cv.findContours(compMask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

      // Pick the largest external contour (in case of micro-disconnections).
      var bestIdx = -1, bestArea = 0;
      for (var i = 0; i < contours.size(); i++) {
        var a = cv.contourArea(contours.get(i), false);
        if (a > bestArea) { bestArea = a; bestIdx = i; }
      }

      var points = [];
      if (bestIdx >= 0 && bestArea > 30) {
        var best = contours.get(bestIdx);
        approx = new cv.Mat();
        cv.approxPolyDP(best, approx, 1.0, true);
        var data = approx.data32S;
        for (var k = 0; k < data.length; k += 2) {
          points.push({ x: data[k], y: data[k + 1] });
        }
      }
      self.postMessage({
        type: 'eye-floodfill-result',
        contourPoints: points.length >= 3 ? points : null,
        area: bestArea
      });
    } catch (err) {
      console.error('Worker eye-floodfill error:', err);
      self.postMessage({ type: 'eye-floodfill-result', contourPoints: null, error: err.message });
    } finally {
      if (src) src.delete();
      if (gray) gray.delete();
      if (binv) binv.delete();
      if (marked) marked.delete();
      if (ffMask) ffMask.delete();
      if (compMask) compMask.delete();
      if (contours) contours.delete();
      if (hierarchy) hierarchy.delete();
      if (approx) approx.delete();
    }
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

  if (type === 'canny-all-contours') {
    try {
      var low = e.data.lowThreshold || 50;
      var high = e.data.highThreshold || 150;
      var blur = e.data.blurSize || 5;
      var result = extractAllCannyContours(imageData, low, high, blur);
      self.postMessage({
        type: 'canny-all-contours-result',
        silhouette: result.silhouette,
        regions: result.regions,
      });
    } catch (err) {
      console.error('Worker canny-all-contours error:', err);
      self.postMessage({
        type: 'canny-all-contours-result',
        silhouette: null, regions: null, error: err.message,
      });
    }
    return;
  }

  if (type === 'canny-segment-zones') {
    try {
      var low = e.data.lowThreshold || 50;
      var high = e.data.highThreshold || 150;
      var blur = e.data.blurSize || 5;
      var seeds = e.data.seeds || [];
      var inflate = e.data.inflate;
      var closingKernel = e.data.closingKernel;
      var result = segmentZonesCanny(imageData, low, high, blur, seeds, inflate, closingKernel);
      self.postMessage({
        type: 'canny-segment-zones-result',
        silhouette: result.silhouette,
        zoneContours: result.zoneContours,
      });
    } catch (err) {
      console.error('Worker canny-segment-zones error:', err);
      self.postMessage({
        type: 'canny-segment-zones-result',
        silhouette: null, zoneContours: null, error: err.message,
      });
    }
    return;
  }

  if (type === 'detect-drawing-bbox') {
    try {
      var result = detectDrawingBBoxCV(imageData);
      self.postMessage({ type: 'detect-drawing-bbox-result', bbox: result.bbox });
    } catch (err) {
      console.error('Worker detect-drawing-bbox error:', err);
      self.postMessage({ type: 'detect-drawing-bbox-result', bbox: null, error: err.message });
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

  if (type === 'canny-binary-mask') {
    try {
      var low = e.data.lowThreshold || 50;
      var high = e.data.highThreshold || 150;
      var blur = e.data.blurSize || 5;
      var dilateIter = e.data.dilateIter != null ? e.data.dilateIter : 1;
      var w = imageData.width, h = imageData.height;
      var src = new cv.Mat(h, w, cv.CV_8UC4);
      src.data.set(new Uint8Array(imageData.data));
      var gray = new cv.Mat();
      var blurred = new cv.Mat();
      var edges = new cv.Mat();
      var dilated = new cv.Mat();
      try {
        cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
        var kSize = blur % 2 === 1 ? blur : blur + 1;
        cv.GaussianBlur(gray, blurred, new cv.Size(kSize, kSize), 0);
        cv.Canny(blurred, edges, low, high);
        if (dilateIter > 0) {
          var kernel = cv.Mat.ones(3, 3, cv.CV_8U);
          cv.dilate(edges, dilated, kernel, new cv.Point(-1, -1), dilateIter);
          kernel.delete();
        } else {
          dilated = edges.clone();
        }
        // Distance transform: each pixel inside the band gets its distance to the
        // nearest pixel outside the band. The centerline has the highest values.
        var distMat = new cv.Mat();
        cv.distanceTransform(dilated, distMat, cv.DIST_L2, cv.DIST_MASK_3);
        var mask = new Uint8Array(w * h);
        var distArr = new Float32Array(w * h);
        var data = dilated.data;
        var distData = distMat.data32F;
        var maxDist = 0;
        for (var i = 0; i < mask.length; i++) {
          mask[i] = data[i] > 0 ? 1 : 0;
          distArr[i] = distData[i];
          if (distData[i] > maxDist) maxDist = distData[i];
        }
        distMat.delete();
        self.postMessage({
          type: 'canny-binary-mask-result',
          mask: mask, dist: distArr, maxDist: maxDist, width: w, height: h
        }, [mask.buffer, distArr.buffer]);
      } finally {
        src.delete(); gray.delete(); blurred.delete(); edges.delete(); dilated.delete();
      }
    } catch (err) {
      console.error('Worker canny-binary-mask error:', err);
      self.postMessage({ type: 'canny-binary-mask-result', mask: null, error: err.message });
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
