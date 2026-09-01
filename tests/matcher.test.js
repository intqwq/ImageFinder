'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  clamp,
  compareRegion,
  descriptorFromPixels,
  intersectionOverUnion,
  pixelsFromRgba,
  searchGridFast,
  searchGridKey,
  selectDistinct,
} = require('../matcher-core.js');

const CONDITIONS = [
  'exact',
  'downscale',
  'upscale',
  'brightness',
  'contrast',
  'color-shift',
  'noise',
  'blur',
  'occlusion',
  'repeated-distractors',
  'edge-placement',
  'combined-degradation',
];

function seededRandom(seed) {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function makePixels(width, height, random, patterned = false) {
  const result = {
    width,
    height,
    luminance: new Float32Array(width * height),
    chromaA: new Float32Array(width * height),
    chromaB: new Float32Array(width * height),
  };
  const phaseA = random() * Math.PI * 2;
  const phaseB = random() * Math.PI * 2;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      const wave = Math.sin(x * .43 + phaseA) * .16 + Math.cos(y * .37 + phaseB) * .14;
      const rings = Math.sin(Math.hypot(x - width * .55, y - height * .42) * .72) * .11;
      const detail = patterned ? wave + rings : (random() - .5) * .22;
      result.luminance[index] = clamp(.48 + detail + (random() - .5) * .06, 0, 1);
      result.chromaA[index] = clamp(Math.sin(x * .31 + y * .13 + phaseB) * (patterned ? .34 : .1), -1, 1);
      result.chromaB[index] = clamp(Math.cos(x * .17 - y * .29 + phaseA) * (patterned ? .3 : .1), -1, 1);
    }
  }
  return result;
}

function sample(source, x, y, channel, blur) {
  if (!blur) return source[channel][clamp(y, 0, source.height - 1) * source.width + clamp(x, 0, source.width - 1)];
  let total = 0;
  let count = 0;
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      total += source[channel][clamp(y + offsetY, 0, source.height - 1) * source.width + clamp(x + offsetX, 0, source.width - 1)];
      count += 1;
    }
  }
  return total / count;
}

function insertPatch(source, query, box, options, random) {
  const { brightness = 0, contrast = 1, colorA = 0, colorB = 0, noise = 0, blur = false, occlusion = 0 } = options;
  for (let y = 0; y < box.height; y += 1) {
    for (let x = 0; x < box.width; x += 1) {
      const sourceX = clamp(Math.round(((x + .5) / box.width) * query.width - .5), 0, query.width - 1);
      const sourceY = clamp(Math.round(((y + .5) / box.height) * query.height - .5), 0, query.height - 1);
      const destination = (box.y + y) * source.width + box.x + x;
      source.luminance[destination] = clamp((sample(query, sourceX, sourceY, 'luminance', blur) - .5) * contrast + .5 + brightness + (random() - .5) * noise, 0, 1);
      source.chromaA[destination] = clamp(sample(query, sourceX, sourceY, 'chromaA', blur) + colorA + (random() - .5) * noise, -1, 1);
      source.chromaB[destination] = clamp(sample(query, sourceX, sourceY, 'chromaB', blur) + colorB + (random() - .5) * noise, -1, 1);
    }
  }

  if (occlusion > 0) {
    const occlusionWidth = Math.max(1, Math.round(box.width * occlusion));
    const startX = box.x + Math.floor((box.width - occlusionWidth) / 2);
    for (let y = box.y + Math.floor(box.height * .62); y < box.y + box.height; y += 1) {
      for (let x = startX; x < startX + occlusionWidth; x += 1) {
        const index = y * source.width + x;
        source.luminance[index] = .5;
        source.chromaA[index] = 0;
        source.chromaB[index] = 0;
      }
    }
  }
}

function profileOptions(condition, random) {
  const options = {};
  if (condition === 'brightness') options.brightness = random() * .22 - .11;
  if (condition === 'contrast') options.contrast = .72 + random() * .55;
  if (condition === 'color-shift') {
    options.colorA = random() * .16 - .08;
    options.colorB = random() * .16 - .08;
  }
  if (condition === 'noise') options.noise = .13;
  if (condition === 'blur') options.blur = true;
  if (condition === 'occlusion') options.occlusion = .18;
  if (condition === 'combined-degradation') Object.assign(options, {
    brightness: random() * .12 - .06,
    contrast: .82 + random() * .3,
    colorA: random() * .08 - .04,
    colorB: random() * .08 - .04,
    noise: .07,
    blur: random() > .5,
    occlusion: .1,
  });
  return options;
}

function rankMatches(source, query, targetWidth) {
  const aspect = query.width / query.height;
  const coarse = descriptorFromPixels(query, 7, 7);
  const fine = descriptorFromPixels(query, 10, 10);
  const widths = [...new Set([
    Math.max(7, Math.round(targetWidth * .84)),
    Math.max(7, Math.round(targetWidth * .92)),
    Math.max(7, Math.round(targetWidth)),
    Math.max(7, Math.round(targetWidth * 1.08)),
    Math.max(7, Math.round(targetWidth * 1.17)),
  ])];
  const candidates = [];
  for (const width of widths) {
    const height = Math.max(7, Math.round(width / aspect));
    const stride = Math.max(1, Math.round(Math.min(width, height) / 4));
    for (const candidate of searchGridFast(source, coarse, width, height, stride, 18)) {
      candidates.push({ ...candidate, width, height, stride });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const refined = [];
  for (const candidate of candidates.slice(0, 32)) {
    let best = { ...candidate, score: -Infinity };
    const radius = candidate.stride + 2;
    for (let y = Math.max(0, candidate.y - radius); y <= Math.min(source.height - candidate.height, candidate.y + radius); y += 1) {
      for (let x = Math.max(0, candidate.x - radius); x <= Math.min(source.width - candidate.width, candidate.x + radius); x += 1) {
        const score = compareRegion(source, fine, x, y, candidate.width, candidate.height);
        if (score > best.score) best = { ...candidate, x, y, score };
      }
    }
    refined.push({ ...best, rawScore: best.score });
  }
  return selectDistinct(refined, 3);
}

for (const condition of CONDITIONS) {
  test(`randomized ${condition} cases keep the true target in the top three`, () => {
    for (let iteration = 0; iteration < 6; iteration += 1) {
      const random = seededRandom(0x51f15e + CONDITIONS.indexOf(condition) * 1009 + iteration * 7919);
      const query = makePixels(22 + Math.floor(random() * 8), 18 + Math.floor(random() * 8), random, true);
      const source = makePixels(112 + Math.floor(random() * 18), 86 + Math.floor(random() * 14), random, false);
      let scale = .8 + random() * .72;
      if (condition === 'downscale') scale = .55 + random() * .22;
      if (condition === 'upscale') scale = 1.45 + random() * .45;
      const width = Math.max(8, Math.round(query.width * scale));
      const height = Math.max(8, Math.round(query.height * scale));
      const edge = condition === 'edge-placement';
      const box = {
        x: edge ? (random() > .5 ? 0 : source.width - width) : Math.floor(random() * (source.width - width)),
        y: edge ? (random() > .5 ? 0 : source.height - height) : Math.floor(random() * (source.height - height)),
        width,
        height,
      };

      if (condition === 'repeated-distractors') {
        const distractor = makePixels(query.width, query.height, random, true);
        insertPatch(source, distractor, { x: 4, y: 4, width, height }, { noise: .03 }, random);
        insertPatch(source, distractor, { x: source.width - width - 4, y: source.height - height - 4, width, height }, { colorA: .05 }, random);
      }
      insertPatch(source, query, box, profileOptions(condition, random), random);
      const matches = rankMatches(source, query, width);
      const found = matches.some((match) => intersectionOverUnion(match, box) >= .42);
      assert.ok(found, `${condition} seed ${iteration}: expected ${JSON.stringify(box)}, got ${JSON.stringify(matches)}`);
    }
  });
}

test('ranking suppresses scale duplicates and returns three separate regions', () => {
  const candidates = [
    { x: 10, y: 10, width: 20, height: 20, rawScore: .93 },
    { x: 11, y: 10, width: 21, height: 20, rawScore: .92 },
    { x: 60, y: 12, width: 20, height: 20, rawScore: .86 },
    { x: 30, y: 55, width: 20, height: 20, rawScore: .81 },
  ];
  assert.deepEqual(selectDistinct(candidates, 3), [candidates[0], candidates[2], candidates[3]]);
});

test('transparent pixels are composited over white instead of becoming black', () => {
  const pixels = pixelsFromRgba(Uint8ClampedArray.from([
    255, 0, 0, 255,
    0, 0, 0, 0,
    0, 0, 255, 128,
  ]), 3, 1);
  assert.ok(Math.abs(pixels.luminance[0] - .299) < .001);
  assert.ok(Math.abs(pixels.luminance[1] - 1) < .001);
  assert.ok(pixels.luminance[2] > .55 && pixels.luminance[2] < .57);
});

test('three repeated true instances are returned as three distinct matches', () => {
  const random = seededRandom(0x3feed);
  const query = makePixels(24, 20, random, true);
  const source = makePixels(132, 98, random, false);
  const boxes = [
    { x: 5, y: 6, width: 24, height: 20 },
    { x: 56, y: 12, width: 24, height: 20 },
    { x: 96, y: 70, width: 24, height: 20 },
  ];
  for (const box of boxes) insertPatch(source, query, box, {}, random);
  const matches = rankMatches(source, query, 24);
  assert.equal(matches.length, 3);
  for (const box of boxes) assert.ok(matches.some((match) => intersectionOverUnion(match, box) >= .65));
});

test('low-information inputs produce finite scores instead of NaN', () => {
  const source = {
    width: 40,
    height: 30,
    luminance: new Float32Array(1200).fill(.8),
    chromaA: new Float32Array(1200),
    chromaB: new Float32Array(1200),
  };
  const query = {
    width: 12,
    height: 12,
    luminance: new Float32Array(144).fill(.8),
    chromaA: new Float32Array(144),
    chromaB: new Float32Array(144),
  };
  const descriptor = descriptorFromPixels(query, 7, 7);
  const candidates = searchGridFast(source, descriptor, 12, 12, 3, 3);
  assert.equal(candidates.length, 3);
  assert.ok(candidates.every((candidate) => Number.isFinite(candidate.score)));
});

test('randomized pale targets are distinguished by sparse absolute-color features', () => {
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const random = seededRandom(0xb10e000 + iteration * 3571);
    const query = {
      width: 32,
      height: 32,
      luminance: new Float32Array(1024).fill(.97),
      chromaA: new Float32Array(1024),
      chromaB: new Float32Array(1024),
    };
    const marks = [
      [7, 8, 3, 2], [22, 9, 4, 2], [12, 14, 2, 3],
      [16, 21, 3, 6], [24, 26, 3, 3], [6, 24, 2, 2],
    ];
    for (const [left, top, width, height] of marks) {
      for (let y = top; y < top + height; y += 1) {
        for (let x = left; x < left + width; x += 1) {
          const index = y * query.width + x;
          query.luminance[index] = .35 + random() * .25;
          query.chromaA[index] = -.12 - random() * .12;
          query.chromaB[index] = .28 + random() * .18;
        }
      }
    }

    const source = {
      width: 144,
      height: 112,
      luminance: new Float32Array(144 * 112),
      chromaA: new Float32Array(144 * 112),
      chromaB: new Float32Array(144 * 112),
    };
    for (let index = 0; index < source.luminance.length; index += 1) {
      source.luminance[index] = .94 + random() * .05;
      source.chromaA[index] = (random() - .5) * .025;
      source.chromaB[index] = (random() - .5) * .025;
    }

    // Structurally similar pale distractors use the wrong feature colors.
    for (const [x, y] of [[4, 4], [52, 8], [100, 12], [8, 68], [96, 72]]) {
      const distractor = {
        ...query,
        luminance: Float32Array.from(query.luminance),
        chromaA: Float32Array.from(query.chromaA, (value) => -value + .12),
        chromaB: Float32Array.from(query.chromaB, (value) => -value),
      };
      insertPatch(source, distractor, { x, y, width: 32, height: 32 }, { noise: .025 }, random);
    }
    const target = { x: 40 + iteration * 4, y: 44, width: 32, height: 32 };
    insertPatch(source, query, target, { noise: .012 }, random);

    const descriptor = descriptorFromPixels(query, 24, 24);
    const candidates = searchGridKey(source, descriptor, 32, 32, 4, 12);
    assert.ok(
      candidates.slice(0, 3).some((candidate) => Math.hypot(candidate.x - target.x, candidate.y - target.y) <= 4),
      `seed ${iteration}: expected ${JSON.stringify(target)}, got ${JSON.stringify(candidates.slice(0, 3))}`,
    );
  }
});

test('randomized search stays inside a practical CPU budget', () => {
  const started = performance.now();
  for (let iteration = 0; iteration < 12; iteration += 1) {
    const random = seededRandom(9000 + iteration);
    const query = makePixels(24, 20, random, true);
    const source = makePixels(128, 96, random, false);
    const box = { x: 17 + iteration, y: 21 + iteration, width: 18, height: 15 };
    insertPatch(source, query, box, { noise: .05 }, random);
    rankMatches(source, query, box.width);
  }
  assert.ok(performance.now() - started < 6000, '12 randomized searches should complete within 6 seconds');
});
