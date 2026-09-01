(function attachPixelMatcher(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PixelMatcher = api;
}(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : null), () => {
  'use strict';

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function normalize(values) {
    let sum = 0;
    for (const value of values) sum += value;
    const mean = sum / values.length;
    let variance = 0;
    for (const value of values) variance += (value - mean) ** 2;
    const deviation = Math.sqrt(variance / values.length) || 1;
    return Float32Array.from(values, (value) => (value - mean) / deviation);
  }

  function normalizeSoft(values) {
    let sum = 0;
    for (const value of values) sum += value;
    const mean = sum / values.length;
    let variance = 0;
    for (const value of values) variance += (value - mean) ** 2;
    const deviation = Math.max(.08, Math.sqrt(variance / values.length));
    return Float32Array.from(values, (value) => (value - mean) / deviation);
  }

  function normalizeSelected(values, indices, minimumDeviation = 0) {
    let sum = 0;
    for (const index of indices) sum += values[index];
    const mean = sum / indices.length;
    let variance = 0;
    for (const index of indices) variance += (values[index] - mean) ** 2;
    const deviation = Math.max(minimumDeviation, Math.sqrt(variance / indices.length)) || 1;
    return Float32Array.from(indices, (index) => (values[index] - mean) / deviation);
  }

  function focusSampleIndices(luminance, chromaA, chromaB, rawEdges, columns, rows) {
    const count = columns * rows;
    const border = [];
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        if (x === 0 || y === 0 || x === columns - 1 || y === rows - 1) border.push(y * columns + x);
      }
    }
    const borderMean = (values) => border.reduce((sum, index) => sum + values[index], 0) / border.length;
    const backgroundLight = borderMean(luminance);
    const backgroundA = borderMean(chromaA);
    const backgroundB = borderMean(chromaB);
    const saliency = Array.from({ length: count }, (_, index) => {
      const backgroundDistance = Math.abs(luminance[index] - backgroundLight)
        + Math.hypot(chromaA[index] - backgroundA, chromaB[index] - backgroundB) * .8;
      const saturation = Math.hypot(chromaA[index], chromaB[index]);
      return backgroundDistance * 2.2 + rawEdges[index] * 3.2 + saturation * .7;
    });
    const keySaliency = Array.from({ length: count }, (_, index) => {
      const lightDistance = Math.abs(luminance[index] - backgroundLight);
      const colorDistance = Math.hypot(chromaA[index] - backgroundA, chromaB[index] - backgroundB);
      return Math.max(lightDistance * .8, colorDistance * 2.8 + lightDistance * .35);
    });

    // Reserve one point per spatial block before filling by saliency. This avoids
    // collapsing the descriptor onto a single high-contrast feature.
    const desired = Math.min(count, Math.max(36, Math.round(count * .36)));
    const selected = new Set();
    const blocks = Math.min(4, columns, rows);
    for (let blockY = 0; blockY < blocks; blockY += 1) {
      for (let blockX = 0; blockX < blocks; blockX += 1) {
        const startX = Math.floor((blockX * columns) / blocks);
        const endX = Math.floor(((blockX + 1) * columns) / blocks);
        const startY = Math.floor((blockY * rows) / blocks);
        const endY = Math.floor(((blockY + 1) * rows) / blocks);
        let best = startY * columns + startX;
        for (let y = startY; y < endY; y += 1) {
          for (let x = startX; x < endX; x += 1) {
            const index = y * columns + x;
            if (saliency[index] > saliency[best]) best = index;
          }
        }
        selected.add(best);
      }
    }
    const ranked = Array.from({ length: count }, (_, index) => index).sort((a, b) => saliency[b] - saliency[a]);
    const keyRanked = Array.from({ length: count }, (_, index) => index)
      .sort((a, b) => keySaliency[b] - keySaliency[a]);
    for (const index of ranked) {
      selected.add(index);
      if (selected.size >= desired) break;
    }
    const indices = Int16Array.from(selected);
    const keyDesired = Math.min(count, 72);
    const keyIndices = Int16Array.from(keyRanked.slice(0, keyDesired));
    const peak = Math.max(...saliency, 1e-6);
    const normalizedWeights = (sampleIndices, scores, scorePeak) => {
      const raw = Float32Array.from(sampleIndices, (index) => .08 + scores[index] / scorePeak);
      const mean = raw.reduce((sum, weight) => sum + weight, 0) / raw.length;
      return Float32Array.from(raw, (weight) => weight / mean);
    };
    const focusWeights = normalizedWeights(indices, saliency, peak);
    const keyWeights = normalizedWeights(keyIndices, keySaliency, Math.max(...keySaliency, 1e-6));
    const rawWeights = Float32Array.from(saliency, (value) => .12 + value / peak);
    const weightMean = rawWeights.reduce((sum, weight) => sum + weight, 0) / rawWeights.length;
    const weights = Float32Array.from(rawWeights, (weight) => weight / weightMean);
    return { indices, focusWeights, keyIndices, keyWeights, weights };
  }

  function buildDescriptor(luminance, chromaA, chromaB, columns, rows) {
    const rawLuminance = Float32Array.from(luminance);
    const rawChromaA = Float32Array.from(chromaA);
    const rawChromaB = Float32Array.from(chromaB);
    const normalizedLuminance = normalize(rawLuminance);
    const edges = new Float32Array(columns * rows);
    for (let y = 0; y < rows; y += 1) {
      for (let x = 0; x < columns; x += 1) {
        const index = y * columns + x;
        const left = normalizedLuminance[y * columns + Math.max(0, x - 1)];
        const right = normalizedLuminance[y * columns + Math.min(columns - 1, x + 1)];
        const top = normalizedLuminance[Math.max(0, y - 1) * columns + x];
        const bottom = normalizedLuminance[Math.min(rows - 1, y + 1) * columns + x];
        edges[index] = Math.hypot(right - left, bottom - top);
      }
    }
    const focus = focusSampleIndices(rawLuminance, rawChromaA, rawChromaB, edges, columns, rows);
    const focusIndices = focus.indices;
    const focusPositionByIndex = new Int16Array(columns * rows);
    focusPositionByIndex.fill(-1);
    focusIndices.forEach((index, position) => { focusPositionByIndex[index] = position; });
    const keyWeightByIndex = new Float32Array(columns * rows);
    focus.keyIndices.forEach((index, position) => { keyWeightByIndex[index] = focus.keyWeights[position]; });
    return {
      columns,
      rows,
      rawLuminance,
      rawChromaA,
      rawChromaB,
      luminance: normalizedLuminance,
      edges: normalize(edges),
      chromaA: normalizeSoft(rawChromaA),
      chromaB: normalizeSoft(rawChromaB),
      focusIndices,
      focusWeights: focus.focusWeights,
      focusPositionByIndex,
      keyIndices: focus.keyIndices,
      keyWeights: focus.keyWeights,
      keyWeightByIndex,
      saliencyWeights: focus.weights,
      focusLuminance: normalizeSelected(rawLuminance, focusIndices),
      focusChromaA: normalizeSelected(rawChromaA, focusIndices, .08),
      focusChromaB: normalizeSelected(rawChromaB, focusIndices, .08),
    };
  }

  function pixelsFromRgba(rgba, width, height, matte = { red: 1, green: 1, blue: 1 }) {
    const length = width * height;
    const result = {
      width,
      height,
      luminance: new Float32Array(length),
      chromaA: new Float32Array(length),
      chromaB: new Float32Array(length),
    };
    for (let index = 0, pixel = 0; pixel < length; pixel += 1, index += 4) {
      const alpha = rgba[index + 3] / 255;
      const red = (rgba[index] / 255) * alpha + matte.red * (1 - alpha);
      const green = (rgba[index + 1] / 255) * alpha + matte.green * (1 - alpha);
      const blue = (rgba[index + 2] / 255) * alpha + matte.blue * (1 - alpha);
      result.luminance[pixel] = red * .299 + green * .587 + blue * .114;
      result.chromaA[pixel] = red - green;
      result.chromaB[pixel] = blue - green;
    }
    return result;
  }

  function correlation(first, second) {
    let total = 0;
    for (let index = 0; index < first.length; index += 1) total += first[index] * second[index];
    return clamp(total / first.length, -1, 1);
  }

  function correlationFromStats(sum, squareSum, dot, count) {
    const centeredEnergy = Math.max(1e-8, squareSum - (sum * sum) / count);
    return clamp(dot / Math.sqrt(centeredEnergy * count), -1, 1);
  }

  function appearanceScore(target, luminance, chromaA, chromaB) {
    let error = 0;
    for (let index = 0; index < luminance.length; index += 1) {
      error += Math.abs(target.rawLuminance[index] - luminance[index]) * .52;
      error += Math.abs(target.rawChromaA[index] - chromaA[index]) * .24;
      error += Math.abs(target.rawChromaB[index] - chromaB[index]) * .24;
    }
    return 1 - clamp((error / luminance.length) / .62, 0, 1);
  }

  function compareRegion(source, target, startX, startY, width, height) {
    const count = target.columns * target.rows;
    const luminance = new Float32Array(count);
    let lightSum = 0;
    let lightSquare = 0;
    let lightDot = 0;
    let chromaASum = 0;
    let chromaASquare = 0;
    let chromaADot = 0;
    let chromaBSum = 0;
    let chromaBSquare = 0;
    let chromaBDot = 0;
    let appearanceError = 0;
    let keyAppearanceError = 0;
    let pointer = 0;
    for (let row = 0; row < target.rows; row += 1) {
      const sourceY = clamp(Math.round(startY + ((row + .5) / target.rows) * height), 0, source.height - 1);
      for (let column = 0; column < target.columns; column += 1) {
        const sourceX = clamp(Math.round(startX + ((column + .5) / target.columns) * width), 0, source.width - 1);
        const index = sourceY * source.width + sourceX;
        const light = source.luminance[index];
        const chromaA = source.chromaA[index];
        const chromaB = source.chromaB[index];
        luminance[pointer] = light;
        lightSum += light;
        lightSquare += light * light;
        lightDot += light * target.luminance[pointer];
        chromaASum += chromaA;
        chromaASquare += chromaA * chromaA;
        chromaADot += chromaA * target.chromaA[pointer];
        chromaBSum += chromaB;
        chromaBSquare += chromaB * chromaB;
        chromaBDot += chromaB * target.chromaB[pointer];
        const appearanceWeight = target.saliencyWeights?.[pointer] || 1;
        appearanceError += Math.abs(target.rawLuminance[pointer] - light) * .52 * appearanceWeight;
        appearanceError += Math.abs(target.rawChromaA[pointer] - chromaA) * .24 * appearanceWeight;
        appearanceError += Math.abs(target.rawChromaB[pointer] - chromaB) * .24 * appearanceWeight;
        const keyWeight = target.keyWeightByIndex?.[pointer] || 0;
        if (keyWeight) {
          keyAppearanceError += Math.abs(target.rawLuminance[pointer] - light) * .52 * keyWeight;
          keyAppearanceError += Math.abs(target.rawChromaA[pointer] - chromaA) * .24 * keyWeight;
          keyAppearanceError += Math.abs(target.rawChromaB[pointer] - chromaB) * .24 * keyWeight;
        }
        pointer += 1;
      }
    }

    let edgeSum = 0;
    let edgeSquare = 0;
    let edgeDot = 0;
    for (let row = 0; row < target.rows; row += 1) {
      for (let column = 0; column < target.columns; column += 1) {
        const index = row * target.columns + column;
        const left = luminance[row * target.columns + Math.max(0, column - 1)];
        const right = luminance[row * target.columns + Math.min(target.columns - 1, column + 1)];
        const top = luminance[Math.max(0, row - 1) * target.columns + column];
        const bottom = luminance[Math.min(target.rows - 1, row + 1) * target.columns + column];
        const edge = Math.hypot(right - left, bottom - top);
        edgeSum += edge;
        edgeSquare += edge * edge;
        edgeDot += edge * target.edges[index];
      }
    }

    const lightScore = correlationFromStats(lightSum, lightSquare, lightDot, count);
    const edgeScore = correlationFromStats(edgeSum, edgeSquare, edgeDot, count);
    const colorScore = (
      correlationFromStats(chromaASum, chromaASquare, chromaADot, count)
      + correlationFromStats(chromaBSum, chromaBSquare, chromaBDot, count)
    ) / 2;
    const absoluteAppearance = 1 - clamp((appearanceError / count) / .62, 0, 1);
    const keyCount = target.keyIndices?.length || count;
    const keyAppearance = 1 - clamp((keyAppearanceError / keyCount) / .45, 0, 1);
    return lightScore * .22 + edgeScore * .16 + colorScore * .08
      + absoluteAppearance * .18 + keyAppearance * .36;
  }

  function compareRegionFast(source, target, startX, startY, width, height) {
    const count = target.columns * target.rows;
    let lightSum = 0;
    let lightSquare = 0;
    let lightDot = 0;
    let chromaASum = 0;
    let chromaASquare = 0;
    let chromaADot = 0;
    let chromaBSum = 0;
    let chromaBSquare = 0;
    let chromaBDot = 0;
    let appearanceError = 0;
    let pointer = 0;

    for (let row = 0; row < target.rows; row += 1) {
      const sourceY = clamp(Math.round(startY + ((row + .5) / target.rows) * height), 0, source.height - 1);
      for (let column = 0; column < target.columns; column += 1) {
        const sourceX = clamp(Math.round(startX + ((column + .5) / target.columns) * width), 0, source.width - 1);
        const index = sourceY * source.width + sourceX;
        const light = source.luminance[index];
        const chromaA = source.chromaA[index];
        const chromaB = source.chromaB[index];
        lightSum += light;
        lightSquare += light * light;
        lightDot += light * target.luminance[pointer];
        chromaASum += chromaA;
        chromaASquare += chromaA * chromaA;
        chromaADot += chromaA * target.chromaA[pointer];
        chromaBSum += chromaB;
        chromaBSquare += chromaB * chromaB;
        chromaBDot += chromaB * target.chromaB[pointer];
        appearanceError += Math.abs(target.rawLuminance[pointer] - light) * .52;
        appearanceError += Math.abs(target.rawChromaA[pointer] - chromaA) * .24;
        appearanceError += Math.abs(target.rawChromaB[pointer] - chromaB) * .24;
        pointer += 1;
      }
    }

    const lightScore = correlationFromStats(lightSum, lightSquare, lightDot, count);
    const colorScore = (
      correlationFromStats(chromaASum, chromaASquare, chromaADot, count)
      + correlationFromStats(chromaBSum, chromaBSquare, chromaBDot, count)
    ) / 2;
    const absoluteAppearance = 1 - clamp((appearanceError / count) / .62, 0, 1);
    return lightScore * .55 + colorScore * .22 + absoluteAppearance * .23;
  }

  function searchGrid(source, descriptor, width, height, stride, keep) {
    const best = [];
    const maxX = source.width - width;
    const maxY = source.height - height;
    let cutoff = -Infinity;
    for (let y = 0; y <= maxY; y += stride) {
      for (let x = 0; x <= maxX; x += stride) {
        const score = compareRegion(source, descriptor, x, y, width, height);
        if (score <= cutoff) continue;
        best.push({ x, y, score });
        best.sort((a, b) => b.score - a.score);
        if (best.length > keep) best.pop();
        cutoff = best.length === keep ? best[best.length - 1].score : -Infinity;
      }
    }
    return best;
  }

  function searchGridFast(source, descriptor, width, height, stride, keep) {
    const best = [];
    const maxX = source.width - width;
    const maxY = source.height - height;
    const xOffsets = Int16Array.from(
      { length: descriptor.columns },
      (_, column) => clamp(Math.round(((column + .5) / descriptor.columns) * width), 0, width - 1),
    );
    const yOffsets = Int16Array.from(
      { length: descriptor.rows },
      (_, row) => clamp(Math.round(((row + .5) / descriptor.rows) * height), 0, height - 1),
    );
    let cutoff = -Infinity;
    for (let y = 0; y <= maxY; y += stride) {
      for (let x = 0; x <= maxX; x += stride) {
        const score = compareRegionFastPrepared(source, descriptor, x, y, xOffsets, yOffsets);
        if (score <= cutoff) continue;
        best.push({ x, y, score });
        best.sort((a, b) => b.score - a.score);
        if (best.length > keep) best.pop();
        cutoff = best.length === keep ? best[best.length - 1].score : -Infinity;
      }
    }
    return best;
  }

  function compareRegionKeyAppearance(source, target, startX, startY, width, height) {
    let error = 0;
    for (let pointer = 0; pointer < target.keyIndices.length; pointer += 1) {
      const targetIndex = target.keyIndices[pointer];
      const row = Math.floor(targetIndex / target.columns);
      const column = targetIndex - row * target.columns;
      const sourceY = clamp(Math.round(startY + ((row + .5) / target.rows) * height), 0, source.height - 1);
      const sourceX = clamp(Math.round(startX + ((column + .5) / target.columns) * width), 0, source.width - 1);
      const sourceIndex = sourceY * source.width + sourceX;
      const weight = target.keyWeights[pointer];
      error += Math.abs(target.rawLuminance[targetIndex] - source.luminance[sourceIndex]) * .52 * weight;
      error += Math.abs(target.rawChromaA[targetIndex] - source.chromaA[sourceIndex]) * .24 * weight;
      error += Math.abs(target.rawChromaB[targetIndex] - source.chromaB[sourceIndex]) * .24 * weight;
    }
    return 1 - clamp((error / target.keyIndices.length) / .45, 0, 1);
  }

  function searchGridKey(source, descriptor, width, height, stride, keep) {
    const best = [];
    const bufferLimit = keep * 16;
    const maxX = source.width - width;
    const maxY = source.height - height;
    let cutoff = -Infinity;
    for (let y = 0; y <= maxY; y += stride) {
      for (let x = 0; x <= maxX; x += stride) {
        const score = compareRegionKeyAppearance(source, descriptor, x, y, width, height);
        if (score <= cutoff) continue;
        best.push({ x, y, score, channel: 'key-feature' });
        best.sort((a, b) => b.score - a.score);
        if (best.length > bufferLimit) best.pop();
        cutoff = best.length === bufferLimit ? best[best.length - 1].score : -Infinity;
      }
    }
    return suppressNearby(best, Math.max(3, Math.round(Math.min(width, height) * .55))).slice(0, keep);
  }

  function searchGridDual(source, descriptor, width, height, stride, keepPerChannel) {
    const structural = [];
    const keyFeature = [];
    const maxX = source.width - width;
    const maxY = source.height - height;
    const xOffsets = Int16Array.from(
      { length: descriptor.columns },
      (_, column) => clamp(Math.round(((column + .5) / descriptor.columns) * width), 0, width - 1),
    );
    const yOffsets = Int16Array.from(
      { length: descriptor.rows },
      (_, row) => clamp(Math.round(((row + .5) / descriptor.rows) * height), 0, height - 1),
    );
    const add = (list, candidate) => {
      list.push(candidate);
      list.sort((a, b) => b.score - a.score);
      if (list.length > keepPerChannel) list.pop();
    };
    for (let y = 0; y <= maxY; y += stride) {
      for (let x = 0; x <= maxX; x += stride) {
        const scores = compareRegionFastPreparedDual(source, descriptor, x, y, xOffsets, yOffsets);
        if (structural.length < keepPerChannel || scores.structural > structural[structural.length - 1].score) {
          add(structural, { x, y, score: scores.structural, channel: 'structural' });
        }
        if (keyFeature.length < keepPerChannel || scores.keyFeature > keyFeature[keyFeature.length - 1].score) {
          add(keyFeature, { x, y, score: scores.keyFeature, channel: 'key-feature' });
        }
      }
    }
    return [...structural, ...keyFeature];
  }

  function compareRegionFastPreparedDual(source, target, startX, startY, xOffsets, yOffsets) {
    const focusCount = target.focusIndices.length;
    let lightSum = 0;
    let lightSquare = 0;
    let lightDot = 0;
    let chromaASum = 0;
    let chromaASquare = 0;
    let chromaADot = 0;
    let chromaBSum = 0;
    let chromaBSquare = 0;
    let chromaBDot = 0;
    let focusAppearanceError = 0;
    let keyAppearanceError = 0;

    for (let targetIndex = 0; targetIndex < target.columns * target.rows; targetIndex += 1) {
      const focusPosition = target.focusPositionByIndex[targetIndex];
      const keyWeight = target.keyWeightByIndex[targetIndex];
      if (focusPosition < 0 && !keyWeight) continue;
      const row = Math.floor(targetIndex / target.columns);
      const column = targetIndex - row * target.columns;
      const sourceIndex = (startY + yOffsets[row]) * source.width + startX + xOffsets[column];
      const light = source.luminance[sourceIndex];
      const chromaA = source.chromaA[sourceIndex];
      const chromaB = source.chromaB[sourceIndex];
      const pixelError = Math.abs(target.rawLuminance[targetIndex] - light) * .52
        + Math.abs(target.rawChromaA[targetIndex] - chromaA) * .24
        + Math.abs(target.rawChromaB[targetIndex] - chromaB) * .24;
      if (focusPosition >= 0) {
        lightSum += light;
        lightSquare += light * light;
        lightDot += light * target.focusLuminance[focusPosition];
        chromaASum += chromaA;
        chromaASquare += chromaA * chromaA;
        chromaADot += chromaA * target.focusChromaA[focusPosition];
        chromaBSum += chromaB;
        chromaBSquare += chromaB * chromaB;
        chromaBDot += chromaB * target.focusChromaB[focusPosition];
        focusAppearanceError += pixelError * target.focusWeights[focusPosition];
      }
      if (keyWeight) keyAppearanceError += pixelError * keyWeight;
    }

    const lightScore = correlationFromStats(lightSum, lightSquare, lightDot, focusCount);
    const colorScore = (
      correlationFromStats(chromaASum, chromaASquare, chromaADot, focusCount)
      + correlationFromStats(chromaBSum, chromaBSquare, chromaBDot, focusCount)
    ) / 2;
    const focusAppearance = 1 - clamp((focusAppearanceError / focusCount) / .62, 0, 1);
    const keyAppearance = 1 - clamp((keyAppearanceError / target.keyIndices.length) / .45, 0, 1);
    return {
      structural: lightScore * .36 + colorScore * .14 + focusAppearance * .5,
      keyFeature: keyAppearance,
    };
  }

  function compareRegionFastPrepared(source, target, startX, startY, xOffsets, yOffsets) {
    const focusIndices = target.focusIndices;
    const count = focusIndices?.length || target.columns * target.rows;
    let lightSum = 0;
    let lightSquare = 0;
    let lightDot = 0;
    let chromaASum = 0;
    let chromaASquare = 0;
    let chromaADot = 0;
    let chromaBSum = 0;
    let chromaBSquare = 0;
    let chromaBDot = 0;
    let appearanceError = 0;
    if (focusIndices) {
      for (let pointer = 0; pointer < focusIndices.length; pointer += 1) {
        const targetIndex = focusIndices[pointer];
        const row = Math.floor(targetIndex / target.columns);
        const column = targetIndex - row * target.columns;
        const index = (startY + yOffsets[row]) * source.width + startX + xOffsets[column];
        const light = source.luminance[index];
        const chromaA = source.chromaA[index];
        const chromaB = source.chromaB[index];
        lightSum += light;
        lightSquare += light * light;
        lightDot += light * target.focusLuminance[pointer];
        chromaASum += chromaA;
        chromaASquare += chromaA * chromaA;
        chromaADot += chromaA * target.focusChromaA[pointer];
        chromaBSum += chromaB;
        chromaBSquare += chromaB * chromaB;
        chromaBDot += chromaB * target.focusChromaB[pointer];
        const appearanceWeight = target.focusWeights?.[pointer] || 1;
        appearanceError += Math.abs(target.rawLuminance[targetIndex] - light) * .52 * appearanceWeight;
        appearanceError += Math.abs(target.rawChromaA[targetIndex] - chromaA) * .24 * appearanceWeight;
        appearanceError += Math.abs(target.rawChromaB[targetIndex] - chromaB) * .24 * appearanceWeight;
      }
    } else {
      let pointer = 0;
      for (let row = 0; row < target.rows; row += 1) {
        const rowStart = (startY + yOffsets[row]) * source.width + startX;
        for (let column = 0; column < target.columns; column += 1) {
          const index = rowStart + xOffsets[column];
          const light = source.luminance[index];
          const chromaA = source.chromaA[index];
          const chromaB = source.chromaB[index];
          lightSum += light;
          lightSquare += light * light;
          lightDot += light * target.luminance[pointer];
          chromaASum += chromaA;
          chromaASquare += chromaA * chromaA;
          chromaADot += chromaA * target.chromaA[pointer];
          chromaBSum += chromaB;
          chromaBSquare += chromaB * chromaB;
          chromaBDot += chromaB * target.chromaB[pointer];
          appearanceError += Math.abs(target.rawLuminance[pointer] - light) * .52;
          appearanceError += Math.abs(target.rawChromaA[pointer] - chromaA) * .24;
          appearanceError += Math.abs(target.rawChromaB[pointer] - chromaB) * .24;
          pointer += 1;
        }
      }
    }

    const lightScore = correlationFromStats(lightSum, lightSquare, lightDot, count);
    const colorScore = (
      correlationFromStats(chromaASum, chromaASquare, chromaADot, count)
      + correlationFromStats(chromaBSum, chromaBSquare, chromaBDot, count)
    ) / 2;
    const absoluteAppearance = 1 - clamp((appearanceError / count) / .62, 0, 1);
    return lightScore * .36 + colorScore * .14 + absoluteAppearance * .5;
  }

  function geometricScales(min, max, ratio) {
    const values = [];
    let current = min;
    while (current <= max * 1.001) {
      values.push(current);
      current *= ratio;
    }
    if (!values.some((value) => Math.abs(value - 1) < .025) && min <= 1 && max >= 1) values.push(1);
    values.sort((a, b) => a - b);
    return values;
  }

  function suppressNearby(candidates, radius) {
    const kept = [];
    for (const candidate of candidates) {
      if (!kept.some((item) => Math.hypot(item.x - candidate.x, item.y - candidate.y) < radius
        && Math.abs((item.scale || 1) - (candidate.scale || 1)) < .18)) kept.push(candidate);
    }
    return kept;
  }

  function intersectionOverUnion(first, second) {
    const left = Math.max(first.x, second.x);
    const top = Math.max(first.y, second.y);
    const right = Math.min(first.x + first.width, second.x + second.width);
    const bottom = Math.min(first.y + first.height, second.y + second.height);
    const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
    const union = first.width * first.height + second.width * second.height - intersection;
    return union > 0 ? intersection / union : 0;
  }

  function selectDistinct(candidates, limit = 3, maxOverlap = .28) {
    const sorted = [...candidates].sort((a, b) => b.rawScore - a.rawScore);
    const selected = [];
    for (const candidate of sorted) {
      if (selected.every((existing) => intersectionOverUnion(existing, candidate) < maxOverlap)) {
        selected.push(candidate);
        if (selected.length === limit) break;
      }
    }
    return selected;
  }

  function resizePixels(source, width, height) {
    const output = {
      width,
      height,
      luminance: new Float32Array(width * height),
      chromaA: new Float32Array(width * height),
      chromaB: new Float32Array(width * height),
    };
    for (let y = 0; y < height; y += 1) {
      const sourceY = clamp(Math.round(((y + .5) / height) * source.height - .5), 0, source.height - 1);
      for (let x = 0; x < width; x += 1) {
        const sourceX = clamp(Math.round(((x + .5) / width) * source.width - .5), 0, source.width - 1);
        const from = sourceY * source.width + sourceX;
        const to = y * width + x;
        output.luminance[to] = source.luminance[from];
        output.chromaA[to] = source.chromaA[from];
        output.chromaB[to] = source.chromaB[from];
      }
    }
    return output;
  }

  function descriptorFromPixels(source, columns, rows) {
    const sampled = resizePixels(source, columns, rows);
    return buildDescriptor(sampled.luminance, sampled.chromaA, sampled.chromaB, columns, rows);
  }

  return {
    appearanceScore,
    buildDescriptor,
    clamp,
    compareRegion,
    compareRegionFast,
    compareRegionKeyAppearance,
    correlation,
    correlationFromStats,
    descriptorFromPixels,
    geometricScales,
    intersectionOverUnion,
    normalize,
    normalizeSoft,
    pixelsFromRgba,
    resizePixels,
    searchGrid,
    searchGridDual,
    searchGridFast,
    searchGridKey,
    selectDistinct,
    suppressNearby,
  };
}));
