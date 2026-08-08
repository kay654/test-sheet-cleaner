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

function findPaperQuadrilateral(cv, rgba) {
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
      maskData[pixel] = hsvData[offset + 1] <= 92 && hsvData[offset + 2] >= 55
        ? 255
        : 0;
    }

    let closeSize = Math.max(9, Math.round(Math.min(rgba.cols, rgba.rows) * 0.035));
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

export function detectDocument(cv, image) {
  validateImage(image);
  const input = cv.matFromImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
  );
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
    const candidate = findPaperQuadrilateral(cv, resized);
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
  const input = cv.matFromImageData(
    new ImageData(new Uint8ClampedArray(image.data), image.width, image.height),
  );
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
