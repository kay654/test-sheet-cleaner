const DEFAULT_OPTIONS = {
  strength: 3,
  removeColor: true,
  removePencil: true,
  reference: null,
};
const COLOR_INK_MIN_SATURATION = 56;
const COLOR_INK_GROWTH_SATURATION = 10;
const COLOR_INK_GROWTH_SEED_RATIO = 0.0005;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

export function isRedInkPixel(red, green, blue, minimumSaturation = COLOR_INK_MIN_SATURATION) {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const saturation = maximum ? ((maximum - minimum) / maximum) * 255 : 0;
  const redDominance = red - (green + blue) / 2;
  const threshold = Math.max(6, 22 - (maximum - 120) * 0.1);
  return redDominance > threshold && saturation >= minimumSaturation;
}

function validateImage(image) {
  return Boolean(
    image &&
      image.data &&
      Number.isInteger(image.width) &&
      Number.isInteger(image.height) &&
      image.width > 0 &&
      image.height > 0 &&
      image.data.length === image.width * image.height * 4,
  );
}

function createMat(cv, rows, columns, type, values) {
  const mat = new cv.Mat(rows, columns, type);
  if (values) mat.data.set(values);
  return mat;
}

function deleteMats(...mats) {
  for (const mat of mats) {
    try {
      mat?.delete?.();
    } catch {
      // Best-effort cleanup after a processing error.
    }
  }
}

function openAndDilateMask(cv, mask, width, height, openSize = 2) {
  const source = createMat(cv, height, width, cv.CV_8UC1, mask);
  const opened = new cv.Mat();
  const dilated = new cv.Mat();
  const openKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(openSize, openSize),
  );
  const dilateKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(3, 3),
  );
  try {
    cv.morphologyEx(source, opened, cv.MORPH_OPEN, openKernel);
    cv.dilate(opened, dilated, dilateKernel);
    return new Uint8Array(dilated.data);
  } finally {
    deleteMats(source, opened, dilated, openKernel, dilateKernel);
  }
}

function dilateMask(cv, mask, width, height, size = 3) {
  const source = createMat(cv, height, width, cv.CV_8UC1, mask);
  const dilated = new cv.Mat();
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(size, size));
  try {
    cv.dilate(source, dilated, kernel);
    return new Uint8Array(dilated.data);
  } finally {
    deleteMats(source, dilated, kernel);
  }
}

export function growMaskThroughCandidates(seedMask, candidateMask, width, height) {
  if (
    seedMask.length !== candidateMask.length ||
    seedMask.length !== width * height
  ) {
    throw new Error("INVALID_CONNECTED_MASK");
  }
  const result = seedMask.slice();
  const queue = new Int32Array(result.length);
  let head = 0;
  let tail = 0;
  for (let pixel = 0; pixel < result.length; pixel += 1) {
    if (result[pixel]) queue[tail++] = pixel;
  }
  while (head < tail) {
    const pixel = queue[head++];
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
      const neighborY = y + deltaY;
      if (neighborY < 0 || neighborY >= height) continue;
      for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
        if (deltaX === 0 && deltaY === 0) continue;
        const neighborX = x + deltaX;
        if (neighborX < 0 || neighborX >= width) continue;
        const neighbor = neighborY * width + neighborX;
        if (!candidateMask[neighbor] || result[neighbor]) continue;
        result[neighbor] = 255;
        queue[tail++] = neighbor;
      }
    }
  }
  return result;
}

function createLongLineMask(cv, gray) {
  const width = gray.cols;
  const height = gray.rows;
  const dark = new cv.Mat();
  const horizontal = new cv.Mat();
  const vertical = new cv.Mat();
  const combined = new cv.Mat();
  const protectedLines = new cv.Mat();
  const horizontalKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(Math.max(35, Math.floor(width / 32)), 1),
  );
  const verticalKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(1, Math.max(35, Math.floor(height / 45))),
  );
  const expandKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));
  try {
    cv.threshold(gray, dark, 145, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(dark, horizontal, cv.MORPH_OPEN, horizontalKernel);
    cv.morphologyEx(dark, vertical, cv.MORPH_OPEN, verticalKernel);
    cv.bitwise_or(horizontal, vertical, combined);
    cv.dilate(combined, protectedLines, expandKernel);
    return new Uint8Array(protectedLines.data);
  } finally {
    deleteMats(
      dark,
      horizontal,
      vertical,
      combined,
      protectedLines,
      horizontalKernel,
      verticalKernel,
      expandKernel,
    );
  }
}

function overlapRatio(first, second) {
  const left = Math.max(first.x, second.x);
  const top = Math.max(first.y, second.y);
  const right = Math.min(first.x + first.width, second.x + second.width);
  const bottom = Math.min(first.y + first.height, second.y + second.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union =
    first.width * first.height + second.width * second.height - intersection;
  return intersection / Math.max(1, union);
}

export function findGuideRow(grayData, width, box) {
  const start = box.y + Math.round(box.height * 0.3);
  const end = box.y + Math.round(box.height * 0.7);
  const requiredSpan = box.width * 0.72;
  const candidates = [];

  for (let y = start; y < end; y += 1) {
    let first = -1;
    let last = -1;
    let previous = -100;
    let longest = 0;
    let currentStart = -1;
    let darkCount = 0;
    let solidRunCount = 0;
    let solidRunLength = 0;
    let longestSolidRun = 0;
    for (let x = box.x; x < box.x + box.width; x += 1) {
      if (grayData[y * width + x] >= 178) {
        solidRunLength = 0;
        continue;
      }
      darkCount += 1;
      if (solidRunLength === 0) solidRunCount += 1;
      solidRunLength += 1;
      longestSolidRun = Math.max(longestSolidRun, solidRunLength);
      if (currentStart < 0 || x - previous > 7) currentStart = x;
      previous = x;
      longest = Math.max(longest, x - currentStart + 1);
      if (first < 0) first = x;
      last = x;
    }
    const span = first < 0 ? 0 : last - first + 1;
    const density = darkCount / Math.max(1, span);
    if (
      longest >= requiredSpan &&
      span >= requiredSpan &&
      darkCount >= box.width * 0.1 &&
      solidRunCount >= 4 &&
      longestSolidRun <= box.width * 0.34 &&
      density <= 0.72
    ) {
      candidates.push(y);
    }
  }
  if (!candidates.length) return null;
  return candidates[Math.floor(candidates.length / 2)];
}

function refineEdgePosition(
  grayData,
  imageWidth,
  imageHeight,
  expected,
  spanStart,
  spanEnd,
  vertical,
) {
  const limit = vertical ? imageWidth : imageHeight;
  let best = clamp(expected, 0, limit - 1);
  let bestScore = -1;
  for (
    let coordinate = Math.max(0, expected - 5);
    coordinate <= Math.min(limit - 1, expected + 5);
    coordinate += 1
  ) {
    let score = 0;
    for (let along = spanStart; along < spanEnd; along += 1) {
      const pixel = vertical
        ? along * imageWidth + coordinate
        : coordinate * imageWidth + along;
      if (grayData[pixel] < 175) score += 1;
    }
    if (score > bestScore) {
      best = coordinate;
      bestScore = score;
    }
  }
  return best;
}

function findTypicalBoxWidth(candidates) {
  if (candidates.length < 3) return null;
  let bestWidth = null;
  let bestSupport = 0;
  for (const candidate of candidates) {
    const support = candidates.filter(
      (other) =>
        other.width >= candidate.width * 0.82 &&
        other.width <= candidate.width * 1.22,
    ).length;
    if (
      support > bestSupport ||
      (support === bestSupport && (bestWidth === null || candidate.width < bestWidth))
    ) {
      bestSupport = support;
      bestWidth = candidate.width;
    }
  }
  return bestSupport >= 3 ? bestWidth : null;
}

function collectHorizontalSegments(data, width, height, typicalWidth) {
  const minimum = typicalWidth * 0.72;
  const maximum = typicalWidth * 1.4;
  const raw = [];
  for (let y = 0; y < height; y += 1) {
    let start = -1;
    for (let x = 0; x <= width; x += 1) {
      const active = x < width && data[y * width + x] > 0;
      if (active && start < 0) start = x;
      if (active || start < 0) continue;
      const runWidth = x - start;
      if (runWidth >= minimum && runWidth <= maximum) {
        raw.push({ x: start, y, width: runWidth, firstY: y, lastY: y });
      }
      start = -1;
    }
  }

  const merged = [];
  for (const segment of raw) {
    const center = segment.x + segment.width / 2;
    let match = null;
    for (let index = merged.length - 1; index >= 0; index -= 1) {
      const existing = merged[index];
      if (segment.y - existing.lastY > 2) break;
      const existingCenter = existing.x + existing.width / 2;
      if (Math.abs(center - existingCenter) <= typicalWidth * 0.15) {
        match = existing;
        break;
      }
    }
    if (!match) {
      merged.push({ ...segment });
      continue;
    }
    const right = Math.max(match.x + match.width, segment.x + segment.width);
    match.x = Math.min(match.x, segment.x);
    match.width = right - match.x;
    match.lastY = segment.y;
  }
  return merged.map((segment) => ({
    x: segment.x,
    y: Math.round((segment.firstY + segment.lastY) / 2),
    width: segment.width,
  }));
}

function verticalLineSupport(data, width, height, x, start, end) {
  let supported = 0;
  let total = 0;
  for (let y = Math.max(0, start); y <= Math.min(height - 1, end); y += 1) {
    total += 1;
    let found = false;
    for (
      let candidateX = Math.max(0, x - 5);
      candidateX <= Math.min(width - 1, x + 5);
      candidateX += 1
    ) {
      if (data[y * width + candidateX]) {
        found = true;
        break;
      }
    }
    if (found) supported += 1;
  }
  return supported / Math.max(1, total);
}

export function findOpenBoxCandidates(
  horizontal,
  vertical,
  width,
  height,
  typicalWidth,
) {
  if (!typicalWidth || typicalWidth < 8) return [];
  const segments = collectHorizontalSegments(horizontal, width, height, typicalWidth);
  const candidates = [];
  for (let topIndex = 0; topIndex < segments.length; topIndex += 1) {
    const top = segments[topIndex];
    for (let bottomIndex = topIndex + 1; bottomIndex < segments.length; bottomIndex += 1) {
      const bottom = segments[bottomIndex];
      const boxHeight = bottom.y - top.y + 1;
      if (boxHeight < typicalWidth * 0.72) continue;
      if (boxHeight > typicalWidth * 2.35) break;
      const aspect = boxHeight / typicalWidth;
      if (aspect > 1.38 && aspect < 1.65) continue;

      const topCenter = top.x + top.width / 2;
      const bottomCenter = bottom.x + bottom.width / 2;
      if (Math.abs(topCenter - bottomCenter) > typicalWidth * 0.18) continue;
      const left = Math.round((top.x + bottom.x) / 2);
      const right = Math.round(
        (top.x + top.width - 1 + bottom.x + bottom.width - 1) / 2,
      );
      const boxWidth = right - left + 1;
      if (boxWidth < typicalWidth * 0.78 || boxWidth > typicalWidth * 1.32) continue;

      const leftSupport = verticalLineSupport(
        vertical,
        width,
        height,
        left,
        top.y,
        bottom.y,
      );
      const rightSupport = verticalLineSupport(
        vertical,
        width,
        height,
        right,
        top.y,
        bottom.y,
      );
      if (Math.max(leftSupport, rightSupport) < 0.65) continue;
      if (leftSupport + rightSupport < 0.75) continue;
      candidates.push({ x: left, y: top.y, width: boxWidth, height: boxHeight });
    }
  }
  return candidates;
}

function createAnswerBoxMask(cv, gray, saturation, source) {
  const width = gray.cols;
  const height = gray.rows;
  const dark = new cv.Mat();
  const vertical = new cv.Mat();
  const horizontal = new cv.Mat();
  const rectangleLines = new cv.Mat();
  const expanded = new cv.Mat();
  const contours = new cv.MatVector();
  const hierarchy = new cv.Mat();
  const verticalKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(1, Math.max(22, Math.floor(height / 55))),
  );
  const horizontalKernel = cv.getStructuringElement(
    cv.MORPH_RECT,
    new cv.Size(Math.max(22, Math.floor(width / 35)), 1),
  );
  const expandKernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(3, 3));

  try {
    cv.threshold(gray, dark, 220, 255, cv.THRESH_BINARY_INV);
    cv.morphologyEx(dark, vertical, cv.MORPH_OPEN, verticalKernel);
    cv.morphologyEx(dark, horizontal, cv.MORPH_OPEN, horizontalKernel);
    cv.bitwise_or(vertical, horizontal, rectangleLines);
    cv.dilate(rectangleLines, expanded, expandKernel);
    cv.findContours(
      expanded,
      contours,
      hierarchy,
      cv.RETR_LIST,
      cv.CHAIN_APPROX_SIMPLE,
    );

    const candidates = [];
    for (let index = 0; index < contours.size(); index += 1) {
      const contour = contours.get(index);
      try {
        const box = cv.boundingRect(contour);
        const area = cv.contourArea(contour, false);
        if (
          // Perspective correction can make the answer boxes nearest a page
          // edge a little smaller than the boxes in the centre.
          box.width >= width * 0.025 &&
          box.width <= width * 0.16 &&
          box.height >= height * 0.02 &&
          box.height <= height * 0.17 &&
          area > box.width * box.height * 0.7
        ) {
          candidates.push(box);
        }
      } finally {
        contour.delete();
      }
    }

    const typicalWidth = findTypicalBoxWidth(candidates);
    if (typicalWidth !== null) {
      const repeatedCandidates = candidates.filter(
        (candidate) =>
          candidate.width >= typicalWidth * 0.78 &&
          candidate.width <= typicalWidth * 1.32,
      );
      candidates.length = 0;
      candidates.push(
        ...repeatedCandidates,
        ...findOpenBoxCandidates(
          horizontal.data,
          vertical.data,
          width,
          height,
          typicalWidth,
        ),
      );
    }
    candidates.sort((first, second) => {
      if (typicalWidth !== null) {
        const widthDelta =
          Math.abs(first.width - typicalWidth) - Math.abs(second.width - typicalWidth);
        if (widthDelta !== 0) return widthDelta;
      }
      return first.width * first.height - second.width * second.height;
    });
    const boxes = [];
    for (const candidate of candidates) {
      if (boxes.every((existing) => overlapRatio(candidate, existing) < 0.5)) {
        boxes.push(candidate);
      }
    }

    const result = new Uint8Array(width * height);
    const structures = [];
    const grayData = gray.data;
    for (const box of boxes) {
      const inset = Math.max(2, Math.round(Math.min(box.width, box.height) * 0.018));
      const interior = {
        x: box.x + inset,
        y: box.y + inset,
        width: box.width - inset * 2,
        height: box.height - inset * 2,
      };
      if (interior.width <= 0 || interior.height <= 0) continue;
      const guideRow = findGuideRow(grayData, width, interior);
      const left = refineEdgePosition(
        grayData,
        width,
        height,
        box.x + 1,
        box.y + 6,
        box.y + box.height - 6,
        true,
      );
      const right = refineEdgePosition(
        grayData,
        width,
        height,
        box.x + box.width - 2,
        box.y + 6,
        box.y + box.height - 6,
        true,
      );
      const top = refineEdgePosition(
        grayData,
        width,
        height,
        box.y + 1,
        box.x + 6,
        box.x + box.width - 6,
        false,
      );
      const bottom = refineEdgePosition(
        grayData,
        width,
        height,
        box.y + box.height - 2,
        box.x + 6,
        box.x + box.width - 6,
        false,
      );
      if (right - left >= 20 && bottom - top >= 20) {
        structures.push({ left, right, top, bottom, guideRow });
      }
      for (let y = interior.y; y < interior.y + interior.height; y += 1) {
        for (let x = interior.x; x < interior.x + interior.width; x += 1) {
          if (guideRow !== null && Math.abs(y - guideRow) <= 3) continue;
          const pixel = y * width + x;
          const offset = pixel * 4;
          const red = source[offset];
          const green = source[offset + 1];
          const blue = source[offset + 2];
          const blueDominance = blue - (red + green) / 2;
          const isBlueInk = saturation[pixel] >= 20 && blueDominance > 12;
          if (!isBlueInk && (grayData[pixel] < 242 || saturation[pixel] > 10)) {
            result[pixel] = 255;
          }
        }
      }
    }
    return { mask: result, structures };
  } finally {
    deleteMats(
      dark,
      vertical,
      horizontal,
      rectangleLines,
      expanded,
      contours,
      hierarchy,
      verticalKernel,
      horizontalKernel,
      expandKernel,
    );
  }
}

function pixelSpread(data, pixel) {
  const offset = pixel * 4;
  const red = data[offset];
  const green = data[offset + 1];
  const blue = data[offset + 2];
  return Math.max(red, green, blue) - Math.min(red, green, blue);
}

function median(values, fallback) {
  if (!values.length) return fallback;
  values.sort((first, second) => first - second);
  return values[Math.floor(values.length / 2)];
}

function estimateStructureColors(
  source,
  gray,
  width,
  height,
  linePoints,
  paperPoints,
) {
  const lineChannels = [[], [], []];
  const paperChannels = [[], [], []];
  for (const [x, y] of linePoints) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const pixel = y * width + x;
    if (gray[pixel] >= 195 || pixelSpread(source, pixel) >= 28) continue;
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      lineChannels[channel].push(source[offset + channel]);
    }
  }
  for (const [x, y] of paperPoints) {
    if (x < 0 || x >= width || y < 0 || y >= height) continue;
    const pixel = y * width + x;
    if (gray[pixel] <= 210 || pixelSpread(source, pixel) >= 24) continue;
    const offset = pixel * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      paperChannels[channel].push(source[offset + channel]);
    }
  }
  return {
    line: lineChannels.map((channel) => median(channel, 105)),
    paper: paperChannels.map((channel) => median(channel, 250)),
  };
}

function blendColor(first, second, firstWeight) {
  return first.map((value, channel) =>
    Math.round(value * firstWeight + second[channel] * (1 - firstWeight)),
  );
}

function writeColor(output, pixel, color) {
  const offset = pixel * 4;
  output[offset] = color[0];
  output[offset + 1] = color[1];
  output[offset + 2] = color[2];
}

function isNeutralLinePixel(source, gray, pixel) {
  return gray[pixel] < 205 && pixelSpread(source, pixel) < 32;
}

export function restoreDetectedStructures(
  output,
  source,
  mask,
  gray,
  width,
  height,
  structures,
) {
  let addedPixels = 0;
  const markRepaired = (pixel) => {
    if (!mask[pixel]) addedPixels += 1;
    mask[pixel] = 255;
  };
  const repairAnomaly = (pixel, expected, expectedSpread) => {
    const offset = pixel * 4;
    const actualSpread = pixelSpread(source, pixel);
    const colorDelta = Math.max(
      Math.abs(source[offset] - expected[0]),
      Math.abs(source[offset + 1] - expected[1]),
      Math.abs(source[offset + 2] - expected[2]),
    );
    const redDominanceDelta =
      source[offset] - (source[offset + 1] + source[offset + 2]) / 2 -
      (expected[0] - (expected[1] + expected[2]) / 2);
    const isStrongAnomaly =
      actualSpread > expectedSpread + 38 && colorDelta > 62;
    const isLocalizedRedSpeck =
      actualSpread > 50 &&
      redDominanceDelta > 20 &&
      colorDelta > 38;
    if (!isStrongAnomaly && !isLocalizedRedSpeck) return;
    writeColor(output, pixel, expected);
    markRepaired(pixel);
  };
  const repairEdge = (vertical, coordinate, start, end) => {
    const linePoints = [];
    const paperPoints = [];
    for (let along = start + 6; along < end - 6; along += 1) {
      linePoints.push(vertical ? [coordinate, along] : [along, coordinate]);
      for (const side of [-1, 1]) {
        paperPoints.push(
          vertical
            ? [coordinate + side * 5, along]
            : [along, coordinate + side * 5],
        );
      }
    }
    const { line, paper } = estimateStructureColors(
      source,
      gray,
      width,
      height,
      linePoints,
      paperPoints,
    );
    const lineSpread = Math.max(...line) - Math.min(...line);
    const paperSpread = Math.max(...paper) - Math.min(...paper);
    for (let along = start; along < end; along += 1) {
      for (let distance = -4; distance <= 4; distance += 1) {
        const x = vertical ? coordinate + distance : along;
        const y = vertical ? along : coordinate + distance;
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const pixel = y * width + x;
        if (distance === 0 && mask[pixel] && isNeutralLinePixel(source, gray, pixel)) {
          const offset = pixel * 4;
          output.set(source.subarray(offset, offset + 4), offset);
          continue;
        }
        if (Math.abs(distance) <= 1) {
          const expected = distance === 0 ? line : blendColor(line, paper, 0.5);
          repairAnomaly(pixel, expected, lineSpread);
        } else {
          repairAnomaly(pixel, paper, paperSpread);
        }
      }
    }
  };

  for (const structure of structures) {
    const { left, right, top, bottom, guideRow } = structure;
    repairEdge(true, left, top, bottom + 1);
    repairEdge(true, right, top, bottom + 1);
    repairEdge(false, top, left, right + 1);
    repairEdge(false, bottom, left, right + 1);
    if (guideRow === null) continue;

    const x0 = Math.max(0, left + 2);
    const x1 = Math.min(width, right - 1);
    const linePoints = [];
    const paperPoints = [];
    for (let x = x0; x < x1; x += 1) {
      linePoints.push([x, guideRow]);
      paperPoints.push([x, guideRow - 5], [x, guideRow + 5]);
    }
    const { line, paper } = estimateStructureColors(
      source,
      gray,
      width,
      height,
      linePoints,
      paperPoints,
    );
    const lineSpread = Math.max(...line) - Math.min(...line);
    const paperSpread = Math.max(...paper) - Math.min(...paper);
    for (
      let y = Math.max(0, guideRow - 4);
      y <= Math.min(height - 1, guideRow + 4);
      y += 1
    ) {
      for (let x = x0; x < x1; x += 1) {
        const pixel = y * width + x;
        let horizontalSupport = 0;
        for (let neighbor = Math.max(x0, x - 5); neighbor < Math.min(x1, x + 6); neighbor += 1) {
          if (isNeutralLinePixel(source, gray, guideRow * width + neighbor)) {
            horizontalSupport += 1;
          }
        }
        if (
          y === guideRow &&
          mask[pixel] &&
          isNeutralLinePixel(source, gray, pixel) &&
          horizontalSupport >= 3
        ) {
          const offset = pixel * 4;
          output.set(source.subarray(offset, offset + 4), offset);
          continue;
        }
        const onGuide = Math.abs(y - guideRow) <= 1 && horizontalSupport >= 3;
        repairAnomaly(pixel, onGuide ? line : paper, onGuide ? lineSpread : paperSpread);
      }
    }
  }
  return addedPixels;
}

export function normalizeRemovedColorBackground(
  output,
  source,
  colorMask,
  width,
  height,
  preserveRepairedMask = null,
) {
  let normalizedPixels = 0;
  for (let pixel = 0; pixel < colorMask.length; pixel += 1) {
    if (!colorMask[pixel]) continue;
    const offset = pixel * 4;
    if (preserveRepairedMask?.[pixel]) {
      const repairedLuminance =
        output[offset] * 0.299 +
        output[offset + 1] * 0.587 +
        output[offset + 2] * 0.114;
      // Telea can reconstruct a dark printed stroke under red ink. Keep that
      // reconstruction; only paper-like repaired pixels need pure-white output.
      if (repairedLuminance < 220) continue;
    }
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = 255;
    normalizedPixels += 1;
  }
  return normalizedPixels;
}

export function whitenFinalPaperBackground(output, width, height) {
  const luminance = new Uint8Array(width * height);
  for (let pixel = 0; pixel < luminance.length; pixel += 1) {
    const offset = pixel * 4;
    luminance[pixel] = Math.round(
      output[offset] * 0.299 + output[offset + 1] * 0.587 + output[offset + 2] * 0.114,
    );
  }
  const smoothstep = (low, high, value) => {
    const t = clamp((value - low) / (high - low), 0, 1);
    return t * t * (3 - 2 * t);
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const offset = pixel * 4;
      const red = output[offset];
      const green = output[offset + 1];
      const blue = output[offset + 2];
      const brightness = luminance[pixel];
      const chroma = Math.max(red, green, blue) - Math.min(red, green, blue);
      // Pale cyan printing can have almost no chroma after a phone photo, but
      // is still cooler than the paper. Keep it out of paper whitening.
      const isCoolPrintedColor = green >= red + 2 && blue >= red + 2;
      if (isCoolPrintedColor) continue;
      let edge = 0;
      if (x > 0) edge = Math.max(edge, Math.abs(brightness - luminance[pixel - 1]));
      if (x + 1 < width) edge = Math.max(edge, Math.abs(brightness - luminance[pixel + 1]));
      if (y > 0) edge = Math.max(edge, Math.abs(brightness - luminance[pixel - width]));
      if (y + 1 < height) edge = Math.max(edge, Math.abs(brightness - luminance[pixel + width]));
      const paperProbability =
        smoothstep(182, 229, brightness) *
        (1 - smoothstep(12, 38, chroma)) *
        (1 - smoothstep(5, 24, edge));
      if (paperProbability < 0.48) continue;
      output[offset] = 255;
      output[offset + 1] = 255;
      output[offset + 2] = 255;
      output[offset + 3] = 255;
    }
  }
  return output;
}

function fallbackInpaint(data, mask, width, height) {
  const output = new Uint8ClampedArray(data);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const offset = pixel * 4;
    output[offset] = 255;
    output[offset + 1] = 255;
    output[offset + 2] = 255;
    output[offset + 3] = 255;
  }
  return output;
}

function inpaint(cv, sourceRgba, sourceData, mask, width, height) {
  if (typeof cv.inpaint !== "function") {
    return fallbackInpaint(sourceData, mask, width, height);
  }
  const sourceRgb = new cv.Mat();
  const cleanedRgb = new cv.Mat();
  const cleanedRgba = new cv.Mat();
  const maskMat = createMat(cv, height, width, cv.CV_8UC1, mask);
  try {
    cv.cvtColor(sourceRgba, sourceRgb, cv.COLOR_RGBA2RGB);
    cv.inpaint(sourceRgb, maskMat, cleanedRgb, 2, cv.INPAINT_TELEA);
    cv.cvtColor(cleanedRgb, cleanedRgba, cv.COLOR_RGB2RGBA);
    return new Uint8ClampedArray(cleanedRgba.data);
  } finally {
    deleteMats(sourceRgb, cleanedRgb, cleanedRgba, maskMat);
  }
}

function assertOpenCvCapabilities(cv) {
  const required = [
    "Mat",
    "cvtColor",
    "GaussianBlur",
    "threshold",
    "morphologyEx",
    "dilate",
    "bitwise_or",
    "getStructuringElement",
    "findContours",
    "boundingRect",
    "contourArea",
  ];
  const missing = required.filter((name) => typeof cv[name] !== "function");
  if (missing.length) throw new Error(`OPENCV_JS_INCOMPLETE:${missing.join(",")}`);
}

export function processWithOpenCv(cv, core, image, userOptions = {}) {
  assertOpenCvCapabilities(cv);
  if (!validateImage(image)) throw new Error("INVALID_IMAGE_DATA");
  const options = { ...DEFAULT_OPTIONS, ...userOptions };
  const { width, height, data } = image;
  const pixelCount = width * height;

  if (options.reference) {
    const reference = options.reference;
    if (!validateImage(reference)) throw new Error("INVALID_REFERENCE_DATA");
    if (reference.width !== width || reference.height !== height) {
      throw new Error("REFERENCE_SIZE_MISMATCH");
    }
    const compatibility = core.compareReference(image, reference);
    if (compatibility < 0.68) {
      throw new Error(`REFERENCE_MISMATCH:${compatibility.toFixed(3)}`);
    }
    const mask = core.detectReferenceMask(image, reference, options.strength);
    return {
      data: core.compositeMaskedPixels(data, reference.data, mask),
      width,
      height,
    };
  }

  const sourceRgba = createMat(cv, height, width, cv.CV_8UC4, data);
  const gray = new cv.Mat();
  const localBackground = new cv.Mat();
  try {
    cv.cvtColor(sourceRgba, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(
      gray,
      localBackground,
      new cv.Size(31, 31),
      11,
      11,
      cv.BORDER_DEFAULT,
    );
    const grayData = gray.data;
    const backgroundData = localBackground.data;
    const saturation = new Uint8Array(pixelCount);
    const value = new Uint8Array(pixelCount);
    const colorRaw = new Uint8Array(pixelCount);
    const faintColorRaw = new Uint8Array(pixelCount);
    const pencilRaw = new Uint8Array(pixelCount);
    const darkCoreRaw = new Uint8Array(pixelCount);
    let confidentColorPixels = 0;
    const strength = clamp(Number(options.strength) || 3, 1, 5);

    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      const offset = pixel * 4;
      const red = data[offset];
      const green = data[offset + 1];
      const blue = data[offset + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const sat = maximum ? Math.round(((maximum - minimum) / maximum) * 255) : 0;
      saturation[pixel] = sat;
      value[pixel] = maximum;
      // Protect only neutral printed cores. Saturated red pen can be just as
      // dark in grayscale and must not be mistaken for black print.
      if (grayData[pixel] < 78 && sat < 32) darkCoreRaw[pixel] = 255;

      if (options.removeColor) {
        if (isRedInkPixel(red, green, blue)) {
          colorRaw[pixel] = 255;
          confidentColorPixels += 1;
        }
        if (isRedInkPixel(red, green, blue, COLOR_INK_GROWTH_SATURATION)) {
          faintColorRaw[pixel] = 255;
        }
      }
    }

    const longLines = createLongLineMask(cv, gray);
    const printGuard = dilateMask(cv, darkCoreRaw, width, height);
    let colorMask = openAndDilateMask(cv, colorRaw, width, height);
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (
        (saturation[pixel] < 14 && value[pixel] < 135) ||
        (longLines[pixel] && !colorRaw[pixel])
      ) {
        colorMask[pixel] = 0;
      }
    }

    if (confidentColorPixels / pixelCount > COLOR_INK_GROWTH_SEED_RATIO) {
      colorMask = growMaskThroughCandidates(
        colorMask,
        faintColorRaw,
        width,
        height,
      );
      // Cover the last JPEG/anti-aliased fringe around a confirmed red stroke.
      // Printed dark cores inside this two-pixel expansion are
      // retained by preserveRepairedMask after inpainting.
      colorMask = dilateMask(cv, colorMask, width, height, 5);
    }

    if (options.removePencil) {
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        const grayValue = grayData[pixel];
        if (
          backgroundData[pixel] - grayValue > 27 - strength * 2 &&
          grayValue > 102 - strength * 5 &&
          grayValue < 224 &&
          saturation[pixel] < 32 &&
          !printGuard[pixel] &&
          !longLines[pixel]
        ) {
          pencilRaw[pixel] = 255;
        }
      }
    }

    let pencilMask = openAndDilateMask(cv, pencilRaw, width, height);
    let structures = [];
    if (options.removePencil || options.removeColor) {
      const boxAnalysis = createAnswerBoxMask(cv, gray, saturation, data);
      structures = boxAnalysis.structures;
      const expandedBoxes = dilateMask(cv, boxAnalysis.mask, width, height);
      for (let pixel = 0; pixel < pixelCount; pixel += 1) {
        if (options.removePencil && expandedBoxes[pixel]) pencilMask[pixel] = 255;
      }
    }

    const mask = new Uint8Array(pixelCount);
    const preserveRepairedMask = new Uint8Array(pixelCount);
    let removedPixels = 0;
    for (let pixel = 0; pixel < pixelCount; pixel += 1) {
      if (colorMask[pixel] || pencilMask[pixel]) {
        mask[pixel] = 255;
        removedPixels += 1;
      }
      if (
        colorMask[pixel] &&
        !pencilMask[pixel] &&
        (printGuard[pixel] || longLines[pixel])
      ) {
        preserveRepairedMask[pixel] = 255;
      }
    }

    const repaired = removedPixels
      ? inpaint(cv, sourceRgba, data, mask, width, height)
      : data;
    const output = core.compositeMaskedPixels(data, repaired, mask);
    // Removed handwriting must become true white.  Inpainting can retain a
    // photographed paper tint, which would otherwise be printed as ink.
    normalizeRemovedColorBackground(
      output,
      data,
      mask,
      width,
      height,
      preserveRepairedMask,
    );
    restoreDetectedStructures(
      output,
      data,
      mask,
      grayData,
      width,
      height,
      structures,
    );
    // Run after detection, removal, and structure restoration so background
    // whitening cannot change the input used to decide what should be erased.
    whitenFinalPaperBackground(output, width, height);

    return {
      data: output,
      width,
      height,
    };
  } finally {
    deleteMats(sourceRgba, gray, localBackground);
  }
}
