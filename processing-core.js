function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function luminance(red, green, blue) {
  return Math.round(red * 0.299 + green * 0.587 + blue * 0.114);
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

function createDarkGrid(image, columns = 72) {
  const rows = Math.max(32, Math.round((columns * image.height) / image.width));
  const grid = new Uint8Array(columns * rows);
  const { data, width, height } = image;
  for (let gridY = 0; gridY < rows; gridY += 1) {
    const startY = Math.floor((gridY * height) / rows);
    const endY = Math.max(startY + 1, Math.floor(((gridY + 1) * height) / rows));
    for (let gridX = 0; gridX < columns; gridX += 1) {
      const startX = Math.floor((gridX * width) / columns);
      const endX = Math.max(startX + 1, Math.floor(((gridX + 1) * width) / columns));
      let darkest = 255;
      for (let y = startY; y < endY; y += 1) {
        for (let x = startX; x < endX; x += 1) {
          const offset = (y * width + x) * 4;
          darkest = Math.min(
            darkest,
            luminance(data[offset], data[offset + 1], data[offset + 2]),
          );
        }
      }
      grid[gridY * columns + gridX] = darkest < 176 ? 1 : 0;
    }
  }
  return { grid, columns, rows };
}

function calculateCoverage(source, candidate, columns, rows) {
  let sourceCount = 0;
  let matched = 0;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < columns; x += 1) {
      const pixel = y * columns + x;
      if (!source[pixel]) continue;
      sourceCount += 1;
      let found = false;
      for (let deltaY = -1; deltaY <= 1 && !found; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          const neighborX = x + deltaX;
          const neighborY = y + deltaY;
          if (
            neighborX >= 0 &&
            neighborX < columns &&
            neighborY >= 0 &&
            neighborY < rows &&
            candidate[neighborY * columns + neighborX]
          ) {
            found = true;
            break;
          }
        }
      }
      if (found) matched += 1;
    }
  }
  return sourceCount ? matched / sourceCount : 0;
}

function dilateMask(mask, width, height) {
  const expanded = mask.slice();
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const pixel = y * width + x;
      if (!mask[pixel]) continue;
      for (let deltaY = -1; deltaY <= 1; deltaY += 1) {
        for (let deltaX = -1; deltaX <= 1; deltaX += 1) {
          expanded[(y + deltaY) * width + x + deltaX] = 1;
        }
      }
    }
  }
  return expanded;
}

export function compareReference(image, reference) {
  if (!validateImage(image) || !validateImage(reference)) {
    throw new Error("INVALID_REFERENCE_DATA");
  }
  const imageGrid = createDarkGrid(image);
  const referenceGrid = createDarkGrid(reference, imageGrid.columns);
  if (imageGrid.rows !== referenceGrid.rows) return 0;
  const printedCoverage = calculateCoverage(
    referenceGrid.grid,
    imageGrid.grid,
    imageGrid.columns,
    imageGrid.rows,
  );
  const reverseCoverage = calculateCoverage(
    imageGrid.grid,
    referenceGrid.grid,
    imageGrid.columns,
    imageGrid.rows,
  );
  return printedCoverage * 0.78 + reverseCoverage * 0.22;
}

export function detectReferenceMask(image, reference, strength = 3) {
  if (!validateImage(image) || !validateImage(reference)) {
    throw new Error("INVALID_REFERENCE_DATA");
  }
  const { width, height, data } = image;
  if (reference.width !== width || reference.height !== height) {
    throw new Error("REFERENCE_SIZE_MISMATCH");
  }
  const mask = new Uint8Array(width * height);
  // Keep the low end deliberately conservative, while making level 5 pick up
  // faint writing that differs from the blank sheet by only a few levels.
  const normalizedStrength = clamp(Number(strength) || 3, 1, 5);
  const threshold = 22 - normalizedStrength * 4;
  const chromaThreshold = 31 - normalizedStrength * 4;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const referenceRed = reference.data[offset];
    const referenceGreen = reference.data[offset + 1];
    const referenceBlue = reference.data[offset + 2];
    const darkDelta =
      luminance(referenceRed, referenceGreen, referenceBlue) -
      luminance(red, green, blue);
    const chromaDelta =
      Math.abs((red - green) - (referenceRed - referenceGreen)) +
      Math.abs((green - blue) - (referenceGreen - referenceBlue));
    if (darkDelta > threshold || chromaDelta > chromaThreshold) mask[pixel] = 1;
  }
  return dilateMask(mask, width, height);
}

export function compositeMaskedPixels(source, replacement, mask) {
  if (
    !source ||
    !replacement ||
    !mask ||
    source.length !== replacement.length ||
    source.length !== mask.length * 4
  ) {
    throw new Error("INVALID_MASKED_COMPOSITE");
  }
  const output = new Uint8ClampedArray(source);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const offset = pixel * 4;
    output[offset] = replacement[offset];
    output[offset + 1] = replacement[offset + 1];
    output[offset + 2] = replacement[offset + 2];
    output[offset + 3] = replacement[offset + 3];
  }
  return output;
}
