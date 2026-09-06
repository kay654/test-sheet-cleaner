const DETECTION_MAX_DIMENSION = 1200;
const OUTPUT_MAX_PIXELS = 9_000_000;
const EDGE_INSET_RATIO = 0.012;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function smoothstep(minimum, maximum, value) {
  const normalized = clamp((value - minimum) / (maximum - minimum), 0, 1);
  return normalized * normalized * (3 - 2 * normalized);
}

function validateImage(image) {
  if (
    !image ||
    !Number.isInteger(image.width) ||
    !Number.isInteger(image.height) ||
    image.width <= 0 ||
    image.height <= 0 ||
    !image.data ||
    image.data.length !== image.width * image.height * 4
  ) {
    throw new Error("INVALID_IMAGE_DATA");
  }
}

function deleteMats(...mats) {
  for (const mat of mats) {
    if (mat && typeof mat.delete === "function") mat.delete();
  }
}

function createRgbaMat(cv, image) {
  const mat = new cv.Mat(image.height, image.width, cv.CV_8UC4);
  mat.data.set(image.data);
  return mat;
}

function distance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function polygonArea(points) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    area += points[index].x * next.y - next.x * points[index].y;
  }
  return Math.abs(area) / 2;
}

export function orderDocumentCorners(points) {
  if (!Array.isArray(points) || points.length !== 4) {
    throw new Error("INVALID_DOCUMENT_CORNERS");
  }
  const normalized = points.map((point) => ({
    x: Number(point.x),
    y: Number(point.y),
  }));
  if (normalized.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    throw new Error("INVALID_DOCUMENT_CORNERS");
  }

  const bySum = [...normalized].sort((first, second) =>
    first.x + first.y - (second.x + second.y),
  );
  const topLeft = bySum[0];
  const bottomRight = bySum[3];
  const remaining = bySum.slice(1, 3);
  const topRight = remaining[0].x - remaining[0].y > remaining[1].x - remaining[1].y
    ? remaining[0]
    : remaining[1];
  const bottomLeft = topRight === remaining[0] ? remaining[1] : remaining[0];
  return [topLeft, topRight, bottomRight, bottomLeft];
}

export function defaultDocumentCorners() {
  return [
    { x: 0.045, y: 0.045 },
    { x: 0.955, y: 0.045 },
    { x: 0.955, y: 0.955 },
    { x: 0.045, y: 0.955 },
  ];
}

export function calculateDocumentSize(points, maxPixels = OUTPUT_MAX_PIXELS) {
  const [topLeft, topRight, bottomRight, bottomLeft] = orderDocumentCorners(points);
  const measuredWidth = (
    distance(topLeft, topRight) + distance(bottomLeft, bottomRight)
  ) / 2;
  const measuredHeight = (
    distance(topLeft, bottomLeft) + distance(topRight, bottomRight)
  ) / 2;
  if (measuredWidth < 32 || measuredHeight < 32) {
    throw new Error("DOCUMENT_AREA_TOO_SMALL");
  }
  const scale = Math.min(1, Math.sqrt(maxPixels / (measuredWidth * measuredHeight)));
  return {
    width: Math.max(32, Math.round(measuredWidth * scale)),
    height: Math.max(32, Math.round(measuredHeight * scale)),
  };
}

function insetCorners(points, ratio) {
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  return points.map((point) => ({
    x: point.x + (center.x - point.x) * ratio,
    y: point.y + (center.y - point.y) * ratio,
  }));
}

function readContourPoints(contour) {
  const values = contour.data32S;
  const points = [];
  for (let index = 0; index < values.length; index += 2) {
    points.push({ x: values[index], y: values[index + 1] });
  }
  return points;
}

function findPaperQuadrilateral(cv, rgba, {
  saturationLimit = 92,
  minimumValue = 55,
  closeRatio = 0.035,
} = {}) {
  const rgb = new cv.Mat();
  const hsv = new cv.Mat();
  const mask = new cv.Mat(rgba.rows, rgba.cols, cv.CV_8UC1);
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let closeKernel = null;
  let openKernel = null;
  try {
    cv.cvtColor(rgba, rgb, cv.COLOR_RGBA2RGB);
    cv.cvtColor(rgb, hsv, cv.COLOR_RGB2HSV);
    const hsvData = hsv.data;
    const maskData = mask.data;
    for (let pixel = 0; pixel < maskData.length; pixel += 1) {
      const offset = pixel * 3;
      maskData[pixel] = hsvData[offset + 1] <= saturationLimit && hsvData[offset + 2] >= minimumValue
        ? 255
        : 0;
    }

    let closeSize = Math.max(9, Math.round(Math.min(rgba.cols, rgba.rows) * closeRatio));
    if (closeSize % 2 === 0) closeSize += 1;
    closeKernel = cv.getStructuringElement(
      cv.MORPH_RECT,
      new cv.Size(closeSize, closeSize),
    );
    openKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(7, 7));
    cv.morphologyEx(mask, mask, cv.MORPH_CLOSE, closeKernel);
    cv.morphologyEx(mask, mask, cv.MORPH_OPEN, openKernel);
    cv.findContours(mask, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

    const imageArea = rgba.cols * rgba.rows;
    let best = null;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const hull = new cv.Mat();
      try {
        const areaRatio = cv.contourArea(contour, false) / imageArea;
        if (areaRatio < 0.18) continue;
        cv.convexHull(contour, hull, false, true);
        const perimeter = cv.arcLength(hull, true);
        for (const epsilon of [0.012, 0.016, 0.02, 0.025, 0.03, 0.04, 0.05]) {
          const approximation = new cv.Mat();
          try {
            cv.approxPolyDP(hull, approximation, epsilon * perimeter, true);
            if (approximation.rows !== 4) continue;
            const points = orderDocumentCorners(readContourPoints(approximation));
            const coverage = polygonArea(points) / imageArea;
            if (coverage < 0.18) continue;
            const score = coverage + Math.min(areaRatio, coverage) * 0.2;
            if (!best || score > best.score) {
              best = { points, score, coverage };
            }
            break;
          } finally {
            approximation.delete();
          }
        }
      } finally {
        deleteMats(contour, hull);
      }
    }
    return best;
  } finally {
    deleteMats(rgb, hsv, mask, contours, hierarchy, closeKernel, openKernel);
  }
}

function findCannyQuadrilateral(cv, rgba, {
  lowThreshold = 15,
  highThreshold = 45,
  closeRatio = 0.026,
} = {}) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let kernel = null;
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Canny(blurred, edges, lowThreshold, highThreshold);
    let closeSize = Math.max(11, Math.round(Math.min(rgba.cols, rgba.rows) * closeRatio));
    if (closeSize % 2 === 0) closeSize += 1;
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeSize, closeSize));
    cv.morphologyEx(edges, edges, cv.MORPH_CLOSE, kernel);
    cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);
    const imageArea = rgba.cols * rgba.rows;
    let best = null;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const approximation = new cv.Mat();
      try {
        const area = cv.contourArea(contour, false);
        if (area / imageArea < 0.18) continue;
        cv.approxPolyDP(contour, approximation, cv.arcLength(contour, true) * 0.03, true);
        if (approximation.rows !== 4) continue;
        const points = orderDocumentCorners(readContourPoints(approximation));
        if (!best || area > best.score) best = { points, score: area, coverage: area / imageArea };
      } finally {
        deleteMats(contour, approximation);
      }
    }
    return best;
  } finally {
    deleteMats(gray, blurred, edges, contours, hierarchy, kernel);
  }
}

function findOtsuQuadrilateral(cv, rgba) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const paper = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  let kernel = null;
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.threshold(blurred, paper, 0, 255, cv.THRESH_BINARY | cv.THRESH_OTSU);
    let closeSize = Math.max(11, Math.round(Math.min(rgba.cols, rgba.rows) * 0.025));
    if (closeSize % 2 === 0) closeSize += 1;
    kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(closeSize, closeSize));
    cv.morphologyEx(paper, paper, cv.MORPH_CLOSE, kernel);
    cv.findContours(paper, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);
    const imageArea = rgba.cols * rgba.rows;
    let best = null;
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      const hull = new cv.Mat();
      try {
        const area = cv.contourArea(contour, false);
        if (area / imageArea < 0.18) continue;
        cv.convexHull(contour, hull, false, true);
        const perimeter = cv.arcLength(hull, true);
        const approximation = new cv.Mat();
        try {
          cv.approxPolyDP(hull, approximation, perimeter * 0.02, true);
          if (approximation.rows !== 4) continue;
          const points = orderDocumentCorners(readContourPoints(approximation));
          const coverage = polygonArea(points) / imageArea;
          if (coverage < 0.18) continue;
          if (!best || coverage > best.coverage) best = { points, score: coverage, coverage };
        } finally {
          approximation.delete();
        }
      } finally {
        deleteMats(contour, hull);
      }
    }
    return best;
  } finally {
    deleteMats(gray, blurred, paper, contours, hierarchy, kernel);
  }
}

function lineIntersection(first, second) {
  const denominator = first.a * second.b - second.a * first.b;
  if (Math.abs(denominator) < 1e-6) return null;
  return {
    x: (first.b * second.c - second.b * first.c) / denominator,
    y: (second.a * first.c - first.a * second.c) / denominator,
  };
}

function findHoughQuadrilateral(cv, rgba) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    // Do not close the edge map here: that joins the desk with the sheet.
    cv.Canny(blurred, edges, 18, 65);
    const shortSide = Math.min(rgba.cols, rgba.rows);
    cv.HoughLinesP(
      edges,
      lines,
      1,
      Math.PI / 180,
      Math.max(34, Math.round(shortSide * 0.035)),
      Math.max(70, Math.round(shortSide * 0.15)),
      Math.max(40, Math.round(shortSide * 0.06)),
    );

    const horizontal = [];
    const vertical = [];
    for (let index = 0; index < lines.rows; index += 1) {
      const offset = index * 4;
      const x1 = lines.data32S[offset];
      const y1 = lines.data32S[offset + 1];
      const x2 = lines.data32S[offset + 2];
      const y2 = lines.data32S[offset + 3];
      const dx = x2 - x1;
      const dy = y2 - y1;
      const length = Math.hypot(dx, dy);
      if (length === 0) continue;
      // ax + by + c = 0, normalized so line intersections stay stable.
      const a = dy / length;
      const b = -dx / length;
      const c = -(a * x1 + b * y1);
      const line = { a, b, c, length, x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      if (Math.abs(dx) / length >= 0.88) horizontal.push(line);
      if (Math.abs(dy) / length >= 0.88) vertical.push(line);
    }
    if (horizontal.length < 2 || vertical.length < 2) return null;

    const longestIn = (candidates) => candidates.reduce(
      (best, line) => (!best || line.length > best.length ? line : best),
      null,
    );
    // Each side is selected from its own half of the image. This avoids a long
    // printed rule being paired with a camera-frame edge on the opposite side.
    const top = longestIn(horizontal.filter((line) => line.y < rgba.rows * 0.45));
    const bottom = longestIn(horizontal.filter((line) => line.y > rgba.rows * 0.55));
    const left = longestIn(vertical.filter((line) => line.x < rgba.cols * 0.45));
    const right = longestIn(vertical.filter((line) => line.x > rgba.cols * 0.55));
    if (!top || !bottom || !left || !right) return null;

    const points = orderDocumentCorners([
      lineIntersection(top, left),
      lineIntersection(top, right),
      lineIntersection(bottom, right),
      lineIntersection(bottom, left),
    ]);
    if (points.some((point) => !point || point.x < 0 || point.y < 0 || point.x > rgba.cols || point.y > rgba.rows)) {
      return null;
    }
    const coverage = polygonArea(points) / (rgba.cols * rgba.rows);
    return coverage >= 0.18 ? { points, score: coverage, coverage } : null;
  } finally {
    deleteMats(gray, blurred, edges, lines);
  }
}

function fitDirectedEdge(samples, horizontal) {
  const count = samples.length;
  const meanIndependent = samples.reduce((sum, sample) => sum + sample.independent, 0) / count;
  const meanDependent = samples.reduce((sum, sample) => sum + sample.dependent, 0) / count;
  const variance = samples.reduce((sum, sample) => sum + (sample.independent - meanIndependent) ** 2, 0);
  const covariance = samples.reduce((sum, sample) =>
    sum + (sample.independent - meanIndependent) * (sample.dependent - meanDependent), 0,
  );
  const slope = variance > 0 ? covariance / variance : 0;
  const intercept = meanDependent - slope * meanIndependent;
  const residual = Math.max(...samples.map((sample) =>
    Math.abs(sample.dependent - (slope * sample.independent + intercept)),
  ));
  return horizontal
    ? { a: slope, b: -1, c: intercept, residual }
    : { a: 1, b: -slope, c: -intercept, residual };
}

function findDirectedEdgeQuadrilateral(cv, rgba, edgeThresholdRatio = 0.40) {
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const gradientX = new cv.Mat();
  const gradientY = new cv.Mat();
  const edgeX = new cv.Mat();
  const edgeY = new cv.Mat();
  try {
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0);
    cv.Sobel(blurred, gradientX, cv.CV_16S, 1, 0, 3);
    cv.Sobel(blurred, gradientY, cv.CV_16S, 0, 1, 3);
    cv.convertScaleAbs(gradientX, edgeX);
    cv.convertScaleAbs(gradientY, edgeY);
    const positions = Array.from({ length: 11 }, (_, index) => 0.14 + index * 0.072);
    const findSide = (horizontal, fromFarSide) => {
      const magnitude = horizontal ? edgeY.data : edgeX.data;
      const limit = Math.round((horizontal ? rgba.rows : rgba.cols) * 0.32);
      const profile = [];
      for (let offset = 2; offset < limit; offset += 1) {
        let total = 0;
        for (const fraction of positions) {
          const fixed = Math.round((horizontal ? rgba.cols : rgba.rows) * fraction);
          const variable = fromFarSide
            ? (horizontal ? rgba.rows - 1 - offset : rgba.cols - 1 - offset)
            : offset;
          total += magnitude[(horizontal ? variable * rgba.cols + fixed : fixed * rgba.cols + variable)];
        }
        profile.push(total / positions.length);
      }
      const strongest = Math.max(...profile);
      // Find the first page-wide strong transition while moving inward. A rule
      // printed on the sheet can be dark, but it is not the first wide edge.
      const threshold = strongest * edgeThresholdRatio;
      const centerOffset = profile.findIndex((strength) => strength >= threshold) + 2;
      if (centerOffset < 2) return null;
      const center = fromFarSide
        ? (horizontal ? rgba.rows - 1 - centerOffset : rgba.cols - 1 - centerOffset)
        : centerOffset;
      const radius = Math.max(10, Math.round((horizontal ? rgba.rows : rgba.cols) * 0.035));
      const samples = [];
      for (const fraction of positions) {
        const fixed = Math.round((horizontal ? rgba.cols : rgba.rows) * fraction);
        let best = null;
        for (let variable = Math.max(2, center - radius); variable <= Math.min((horizontal ? rgba.rows : rgba.cols) - 3, center + radius); variable += 1) {
          const x = horizontal ? fixed : variable;
          const y = horizontal ? variable : fixed;
          const strength = magnitude[y * rgba.cols + x];
          if (!best || strength > best.score) best = { variable, score: strength };
        }
        if (best) samples.push({ independent: fixed, dependent: best.variable });
      }
      return fitDirectedEdge(samples, horizontal);
    };
    const top = findSide(true, false);
    const bottom = findSide(true, true);
    const left = findSide(false, false);
    const right = findSide(false, true);
    if (!top || !bottom || !left || !right) return null;
    const maxResidual = Math.max(top.residual, bottom.residual, left.residual, right.residual);
    if (maxResidual > Math.min(rgba.cols, rgba.rows) * 0.18) return null;
    const points = [
      lineIntersection(top, left),
      lineIntersection(top, right),
      lineIntersection(bottom, right),
      lineIntersection(bottom, left),
    ];
    if (points.some((point) => !point || point.x < 0 || point.y < 0 || point.x > rgba.cols || point.y > rgba.rows)) {
      return null;
    }
    const ordered = orderDocumentCorners(points);
    const coverage = polygonArea(ordered) / (rgba.cols * rgba.rows);
    return coverage >= 0.18 ? { points: ordered, score: coverage, coverage } : null;
  } finally {
    deleteMats(gray, blurred, gradientX, gradientY, edgeX, edgeY);
  }
}

// A page can legitimately be close to one image boundary, but a candidate that
// reaches the camera frame is often the desk/floor merged into the paper mask.
// Check every edge: the old left-edge-only check missed the same failure on the
// top, right, and bottom sides.
function candidateTouchesFrame(candidate, width, height, margin = 0.025) {
  return candidate?.points.some((point) =>
    point.x <= width * margin ||
    point.y <= height * margin ||
    point.x >= width * (1 - margin) ||
    point.y >= height * (1 - margin),
  ) || false;
}

function luminanceAt(rgba, x, y) {
  const offset = (Math.round(y) * rgba.cols + Math.round(x)) * 4;
  return rgba.data[offset] * 0.299 + rgba.data[offset + 1] * 0.587 + rgba.data[offset + 2] * 0.114;
}

function candidateReliability(rgba, candidate) {
  if (!candidate) return -Infinity;
  const { points } = candidate;
  const center = points.reduce(
    (sum, point) => ({ x: sum.x + point.x / 4, y: sum.y + point.y / 4 }),
    { x: 0, y: 0 },
  );
  let edgeScore = 0;
  let measuredEdges = 0;
  for (let index = 0; index < 4; index += 1) {
    const first = points[index];
    const second = points[(index + 1) % 4];
    const dx = second.x - first.x;
    const dy = second.y - first.y;
    const length = Math.hypot(dx, dy);
    if (length < 1) continue;
    let contrast = 0;
    let samples = 0;
    for (let step = 1; step < 8; step += 1) {
      const t = step / 8;
      const x = first.x + dx * t;
      const y = first.y + dy * t;
      const inwardX = center.x - x;
      const inwardY = center.y - y;
      const inwardLength = Math.hypot(inwardX, inwardY);
      if (inwardLength < 1) continue;
      const offsetX = inwardX / inwardLength * 5;
      const offsetY = inwardY / inwardLength * 5;
      const insideX = x + offsetX;
      const insideY = y + offsetY;
      const outsideX = x - offsetX;
      const outsideY = y - offsetY;
      if (
        insideX < 0 || insideY < 0 || insideX >= rgba.cols || insideY >= rgba.rows ||
        outsideX < 0 || outsideY < 0 || outsideX >= rgba.cols || outsideY >= rgba.rows
      ) continue;
      contrast += Math.abs(luminanceAt(rgba, insideX, insideY) - luminanceAt(rgba, outsideX, outsideY));
      samples += 1;
    }
    if (samples) {
      edgeScore += clamp((contrast / samples - 10) / 38, 0, 1);
      measuredEdges += 1;
    }
  }
  edgeScore /= 4;
  let rightAngleScore = 0;
  for (let index = 0; index < 4; index += 1) {
    const previous = points[(index + 3) % 4];
    const current = points[index];
    const next = points[(index + 1) % 4];
    const firstLength = distance(current, previous);
    const secondLength = distance(current, next);
    if (firstLength < 1 || secondLength < 1) continue;
    const cosine = ((previous.x - current.x) * (next.x - current.x) + (previous.y - current.y) * (next.y - current.y)) /
      (firstLength * secondLength);
    rightAngleScore += 1 - Math.min(1, Math.abs(cosine));
  }
  rightAngleScore /= 4;
  const coverageScore = smoothstep(0.18, 0.52, candidate.coverage);
  const framePenalty = candidateTouchesFrame(candidate, rgba.cols, rgba.rows) ? 0.13 : 0;
  // No individual detector is trusted. A real page boundary has evidence on
  // several sides, while a desk merged into a mask usually lacks it at least
  // on the frame-facing side.
  return clamp(
    edgeScore * 0.58 + rightAngleScore * 0.20 + coverageScore * 0.14 + (measuredEdges / 4) * 0.08 - framePenalty,
    0,
    1,
  );
}

function candidateCornerDistance(first, second, width, height) {
  return first.points.reduce((sum, point, index) => {
    const other = second.points[index];
    return sum + Math.hypot((point.x - other.x) / width, (point.y - other.y) / height);
  }, 0) / 4;
}

function scoreCandidates(rgba, candidates) {
  for (const item of candidates) item.reliability = candidateReliability(rgba, item);
  for (const item of candidates) {
    const others = candidates.filter((other) => other !== item);
    if (!others.length) {
      item.agreement = 1;
      continue;
    }
    // A near-identical corner set from independent detectors is useful
    // corroboration. It is deliberately a small part of the total, because
    // several detectors can share the same failure on a strongly lit desk.
    item.agreement = others.reduce((sum, other) =>
      sum + Math.exp(-candidateCornerDistance(item, other, rgba.cols, rgba.rows) / 0.055),
    0) / others.length;
    item.reliability = item.reliability * 0.88 + item.agreement * 0.12;
  }
  candidates.sort((first, second) => second.reliability - first.reliability);
}

function tagCandidate(candidate, method) {
  return candidate ? { ...candidate, method } : null;
}

function selectCandidateForStrategy(candidates, strategy) {
  const preferredMethods = {
    // The first detection uses the most reliable result from every method.
    balanced: [],
    // Retries deliberately choose independent evidence rather than repeating
    // the same overall ranking.
    edges: ["directed-edge-strict", "canny-fine", "hough", "directed-edge", "directed-edge-relaxed", "canny"],
    contrast: ["otsu", "hsv-bright", "hsv"],
    contours: ["canny-coarse", "canny", "hough", "directed-edge"],
  }[strategy] || [];
  if (!preferredMethods.length) return candidates[0] || null;
  for (const method of preferredMethods) {
    const candidate = candidates.find((item) => item.method === method);
    if (candidate) return candidate;
  }
  return candidates[0] || null;
}

function describeCandidate(candidate, width, height) {
  if (!candidate) return null;
  return {
    method: candidate.method,
    coverage: candidate.coverage,
    reliability: candidate.reliability,
    agreement: candidate.agreement,
    touchesFrame: candidateTouchesFrame(candidate, width, height),
    corners: candidate.points.map((point) => ({ x: point.x / width, y: point.y / height })),
  };
}

export function detectDocument(cv, image, { attempt = 0 } = {}) {
  validateImage(image);
  const input = createRgbaMat(cv, image);
  const resized = new cv.Mat();
  try {
    const scale = Math.min(1, DETECTION_MAX_DIMENSION / Math.max(image.width, image.height));
    if (scale < 1) {
      cv.resize(
        input,
        resized,
        new cv.Size(Math.max(1, Math.round(image.width * scale)), Math.max(1, Math.round(image.height * scale))),
        0,
        0,
        cv.INTER_AREA,
      );
    } else {
      input.copyTo(resized);
    }
    // Use independent evidence. HSV is resilient to shadows, while Otsu is
    // much better when a wood desk has a similar low-saturation colour to the
    // sheet. Running both on the small detection image is inexpensive and
    // avoids trusting the first large contour blindly.
    // Start retries with the paper/desk separation that most often corrects a
    // false edge selection, then try edge and contour evidence on later taps.
    const strategy = ["balanced", "contrast", "edges", "contours"][Math.abs(Math.trunc(attempt)) % 4];
    const colorCandidate = tagCandidate(findPaperQuadrilateral(cv, resized), "hsv");
    const otsuCandidate = tagCandidate(findOtsuQuadrilateral(cv, resized), "otsu");
    const cannyCandidate = tagCandidate(findCannyQuadrilateral(cv, resized), "canny");
    const houghCandidate = tagCandidate(findHoughQuadrilateral(cv, resized), "hough");
    const directedCandidate = tagCandidate(findDirectedEdgeQuadrilateral(cv, resized), "directed-edge");
    let candidates = [colorCandidate, otsuCandidate, cannyCandidate, houghCandidate, directedCandidate]
      .filter(Boolean);

    // Every retry also changes detector parameters. This matters when the
    // image contains printed rules or coloured handwriting near a page edge:
    // a different method alone can still recreate the same contour.
    if (strategy === "edges") {
      candidates.push(
        tagCandidate(findDirectedEdgeQuadrilateral(cv, resized, 0.34), "directed-edge-relaxed"),
        tagCandidate(findDirectedEdgeQuadrilateral(cv, resized, 0.50), "directed-edge-strict"),
        tagCandidate(findCannyQuadrilateral(cv, resized, { lowThreshold: 9, highThreshold: 32, closeRatio: 0.018 }), "canny-fine"),
      );
    } else if (strategy === "contrast") {
      candidates.push(
        tagCandidate(findPaperQuadrilateral(cv, resized, { saturationLimit: 118, minimumValue: 80, closeRatio: 0.022 }), "hsv-bright"),
      );
    } else if (strategy === "contours") {
      candidates.push(
        tagCandidate(findCannyQuadrilateral(cv, resized, { lowThreshold: 30, highThreshold: 90, closeRatio: 0.042 }), "canny-coarse"),
      );
    }
    candidates = candidates.filter(Boolean);
    scoreCandidates(resized, candidates);

    // Re-run only when the evidence is weak or ambiguous. Different outward
    // scan thresholds are genuinely independent observations; merely swapping
    // a fixed detector priority would repeat the same mistake.
    const firstPass = candidates[0];
    const secondPass = candidates[1];
    if (
      firstPass &&
      (firstPass.reliability < 0.62 || firstPass.reliability - (secondPass?.reliability ?? 0) < 0.075)
    ) {
      const relaxedDirected = tagCandidate(findDirectedEdgeQuadrilateral(cv, resized, 0.34), "directed-edge-relaxed");
      const strictDirected = tagCandidate(findDirectedEdgeQuadrilateral(cv, resized, 0.48), "directed-edge-strict");
      for (const item of [relaxedDirected, strictDirected]) if (item) candidates.push(item);
      scoreCandidates(resized, candidates);
    }
    const candidate = selectCandidateForStrategy(candidates, strategy);
    if (!candidate) {
      return { corners: defaultDocumentCorners(), confidence: 0, detected: false };
    }
    return {
      corners: candidate.points.map((point) => ({
        x: clamp(point.x / resized.cols, 0.005, 0.995),
        y: clamp(point.y / resized.rows, 0.005, 0.995),
      })),
      confidence: clamp((candidate.coverage - 0.18) / 0.62, 0.2, 1),
      detected: true,
      method: candidate.method,
      diagnostics: {
        candidates: candidates.map((item) => describeCandidate(item, resized.cols, resized.rows)),
      },
    };
  } finally {
    deleteMats(input, resized);
  }
}

function normalizeIllumination(cv, warped) {
  const shortSide = Math.min(warped.cols, warped.rows);
  const scale = Math.min(1, 320 / shortSide);
  const small = new cv.Mat();
  const background = new cv.Mat();
  let kernel = null;
  try {
    cv.resize(
      warped,
      small,
      new cv.Size(
        Math.max(1, Math.round(warped.cols * scale)),
        Math.max(1, Math.round(warped.rows * scale)),
      ),
      0,
      0,
      cv.INTER_AREA,
    );
    let kernelSize = Math.max(15, Math.round(Math.min(small.cols, small.rows) * 0.12));
    if (kernelSize % 2 === 0) kernelSize += 1;
    kernel = cv.getStructuringElement(
      cv.MORPH_ELLIPSE,
      new cv.Size(kernelSize, kernelSize),
    );
    cv.morphologyEx(small, background, cv.MORPH_CLOSE, kernel);
    cv.GaussianBlur(
      background,
      background,
      new cv.Size(0, 0),
      Math.max(2, kernelSize / 7),
    );

    const source = warped.data;
    const backgroundData = background.data;
    const output = new Uint8ClampedArray(source.length);
    for (let y = 0; y < warped.rows; y += 1) {
      const backgroundY = Math.min(
        background.rows - 1,
        Math.floor((y / warped.rows) * background.rows),
      );
      for (let x = 0; x < warped.cols; x += 1) {
        const backgroundX = Math.min(
          background.cols - 1,
          Math.floor((x / warped.cols) * background.cols),
        );
        const pixel = (y * warped.cols + x) * 4;
        const backgroundPixel = (backgroundY * background.cols + backgroundX) * 4;
        for (let channel = 0; channel < 3; channel += 1) {
          const normalized = (source[pixel + channel] * 246) /
            Math.max(32, backgroundData[backgroundPixel + channel]);
          output[pixel + channel] = clamp((normalized - 8) * 1.035 + 8, 0, 255);
        }
        output[pixel + 3] = 255;
      }
    }
    // Keep the extracted pixels intact for handwriting detection.  Pure-white
    // conversion is deliberately deferred until all cleanup has finished.
    return output;
  } finally {
    deleteMats(small, background, kernel);
  }
}

export function suppressPaperBackground(data, width, height) {
  if (
    !data ||
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    data.length !== width * height * 4
  ) {
    throw new Error("INVALID_IMAGE_DATA");
  }

  // The extraction buffer is no longer needed after this step, so update it in
  // place to avoid another full-resolution RGBA allocation on mobile devices.
  const output = data instanceof Uint8ClampedArray
    ? data
    : new Uint8ClampedArray(data);
  const luminance = new Uint8Array(width * height);
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const offset = pixel * 4;
    luminance[pixel] = Math.round(
      (output[offset] + output[offset + 1] + output[offset + 2]) / 3,
    );
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const red = output[offset];
      const green = output[offset + 1];
      const blue = output[offset + 2];
      const brightness = luminance[pixel];
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      let edge = 0;
      if (x > 0) edge = Math.max(edge, Math.abs(brightness - luminance[pixel - 1]));
      if (x + 1 < width) {
        edge = Math.max(edge, Math.abs(brightness - luminance[pixel + 1]));
      }
      if (y > 0) edge = Math.max(edge, Math.abs(brightness - luminance[pixel - width]));
      if (y + 1 < height) {
        edge = Math.max(edge, Math.abs(brightness - luminance[pixel + width]));
      }

      const paperProbability =
        smoothstep(182, 229, brightness) *
        (1 - smoothstep(12, 38, chroma)) *
        (1 - smoothstep(5, 24, edge));
      // This canvas is intended for reprinting.  Paper must be actual white,
      // not merely a brighter copy of the photographed paper, so it does not
      // consume toner/ink on otherwise blank areas.
      if (paperProbability >= 0.48) {
        output[offset] = 255;
        output[offset + 1] = 255;
        output[offset + 2] = 255;
      }
    }
  }
  return output;
}

export function extractDocument(cv, image, userOptions = {}) {
  validateImage(image);
  const normalizedCorners = orderDocumentCorners(
    userOptions.corners || defaultDocumentCorners(),
  );
  if (polygonArea(normalizedCorners) < 0.08) {
    throw new Error("DOCUMENT_AREA_TOO_SMALL");
  }
  const pixelCorners = normalizedCorners.map((point) => ({
    x: clamp(point.x, 0, 1) * (image.width - 1),
    y: clamp(point.y, 0, 1) * (image.height - 1),
  }));
  const sourceCorners = insetCorners(pixelCorners, EDGE_INSET_RATIO);
  const size = calculateDocumentSize(sourceCorners, OUTPUT_MAX_PIXELS);
  const input = createRgbaMat(cv, image);
  const warped = new cv.Mat();
  const sourcePoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    sourceCorners.flatMap((point) => [point.x, point.y]),
  );
  const targetPoints = cv.matFromArray(
    4,
    1,
    cv.CV_32FC2,
    [0, 0, size.width - 1, 0, size.width - 1, size.height - 1, 0, size.height - 1],
  );
  const transform = cv.getPerspectiveTransform(sourcePoints, targetPoints);
  try {
    cv.warpPerspective(
      input,
      warped,
      transform,
      new cv.Size(size.width, size.height),
      cv.INTER_CUBIC,
      cv.BORDER_REPLICATE,
      new cv.Scalar(),
    );
    return {
      data: userOptions.normalizeLighting === false
        ? new Uint8ClampedArray(warped.data)
        : normalizeIllumination(cv, warped),
      width: size.width,
      height: size.height,
    };
  } finally {
    deleteMats(input, warped, sourcePoints, targetPoints, transform);
  }
}
