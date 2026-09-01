'use strict';

const state = {
  needle: null,
  haystack: null,
  result: null,
  selectedMatch: 0,
  previewScale: 1,
  previewMode: 'focus',
  running: false,
};

const elements = {
  needleInput: document.querySelector('#needleInput'),
  haystackInput: document.querySelector('#haystackInput'),
  needleDrop: document.querySelector('#needleDrop'),
  haystackDrop: document.querySelector('#haystackDrop'),
  findButton: document.querySelector('#findButton'),
  readyNote: document.querySelector('#readyNote'),
  scaleRange: document.querySelector('#scaleRange'),
  progressPanel: document.querySelector('#progressPanel'),
  progressStep: document.querySelector('#progressStep'),
  progressPercent: document.querySelector('#progressPercent'),
  progressBar: document.querySelector('#progressBar'),
  resultPanel: document.querySelector('#resultPanel'),
  canvasWrap: document.querySelector('#canvasWrap'),
  resultCanvas: document.querySelector('#resultCanvas'),
  closeupCanvas: document.querySelector('#closeupCanvas'),
  closeupCaption: document.querySelector('#closeupCaption'),
  fitView: document.querySelector('#fitView'),
  focusView: document.querySelector('#focusView'),
  actualView: document.querySelector('#actualView'),
  zoomOut: document.querySelector('#zoomOut'),
  zoomIn: document.querySelector('#zoomIn'),
  zoomValue: document.querySelector('#zoomValue'),
  confidenceScore: document.querySelector('#confidenceScore'),
  confidenceLabel: document.querySelector('#confidenceLabel'),
  scoreRing: document.querySelector('#scoreRing'),
  matchCandidates: document.querySelector('#matchCandidates'),
  resultMessage: document.querySelector('#resultMessage'),
  positionValue: document.querySelector('#positionValue'),
  sizeValue: document.querySelector('#sizeValue'),
  scaleValue: document.querySelector('#scaleValue'),
  downloadButton: document.querySelector('#downloadButton'),
  startOver: document.querySelector('#startOver'),
  runAgain: document.querySelector('#runAgain'),
};

setupDropZone('needle');
setupDropZone('haystack');
elements.findButton.addEventListener('click', runSearch);
elements.runAgain.addEventListener('click', runSearch);
elements.startOver.addEventListener('click', clearAll);
elements.downloadButton.addEventListener('click', downloadResult);
elements.fitView.addEventListener('click', () => setPreviewMode('fit'));
elements.focusView.addEventListener('click', () => setPreviewMode('focus'));
elements.actualView.addEventListener('click', () => setPreviewMode('actual'));
elements.zoomOut.addEventListener('click', () => stepPreviewZoom(1 / 1.25));
elements.zoomIn.addEventListener('click', () => stepPreviewZoom(1.25));
elements.resultCanvas.addEventListener('click', selectCandidateFromCanvas);
window.addEventListener('resize', () => {
  if (!state.result?.length || state.previewMode === 'custom') return;
  requestAnimationFrame(() => setPreviewMode(state.previewMode));
});

function setupDropZone(kind) {
  const drop = elements[`${kind}Drop`];
  const input = elements[`${kind}Input`];
  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => input.files[0] && loadFile(kind, input.files[0]));

  for (const eventName of ['dragenter', 'dragover']) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.add('dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    drop.addEventListener(eventName, (event) => {
      event.preventDefault();
      drop.classList.remove('dragging');
    });
  }
  drop.addEventListener('drop', (event) => {
    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith('image/'));
    if (file) loadFile(kind, file);
  });
}

async function loadFile(kind, file) {
  try {
    if (!file.type.startsWith('image/')) throw new Error('Please choose an image file.');
    const url = URL.createObjectURL(file);
    const image = await decodeImage(url);
    if (state[kind]?.url) URL.revokeObjectURL(state[kind].url);
    state[kind] = { file, url, image };

    const drop = elements[`${kind}Drop`];
    const empty = drop.querySelector('.empty-upload');
    const preview = drop.querySelector('.image-preview');
    preview.querySelector('img').src = url;
    preview.querySelector('b').textContent = file.name;
    preview.querySelector('small').textContent = `${image.naturalWidth} × ${image.naturalHeight} · ${formatBytes(file.size)}`;
    empty.hidden = true;
    preview.hidden = false;
    state.result = null;
    elements.resultPanel.hidden = true;
    updateReadyState();
  } catch (error) {
    showToast(error.message || 'That image could not be opened.');
  }
}

function decodeImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('That image could not be decoded.'));
    image.src = url;
  });
}

function updateReadyState() {
  const ready = Boolean(state.needle && state.haystack);
  elements.findButton.disabled = !ready || state.running;
  elements.readyNote.textContent = ready ? 'Images ready · search locally' : 'Add both images to begin';
  elements.readyNote.classList.toggle('ready', ready);
}

async function runSearch() {
  if (!state.needle || !state.haystack || state.running) return;
  state.running = true;
  elements.findButton.disabled = true;
  elements.resultPanel.hidden = true;
  elements.progressPanel.hidden = false;
  setProgress(2, 'Preparing image data');
  elements.progressPanel.scrollIntoView({ behavior: 'smooth', block: 'center' });

  try {
    const range = elements.scaleRange.value.split(',').map(Number);
    await nextFrame();
    const result = await locateImage(state.needle.image, state.haystack.image, range, (percent, label) => {
      setProgress(percent, label);
    });
    state.result = result;
    setProgress(100, 'Match located');
    await wait(250);
    renderResult(result);
  } catch (error) {
    console.error(error);
    showToast(error.message || 'The search could not be completed.');
  } finally {
    state.running = false;
    elements.progressPanel.hidden = true;
    updateReadyState();
  }
}

async function locateImage(needleImage, haystackImage, range, onProgress) {
  // Both passes feed the same final ranking. A plausible large false positive must never hide
  // a genuine tiny match in a dense source image.
  if (range[0] < .1) {
    const regularResults = await locateRegularImage(
      needleImage,
      haystackImage,
      [Math.max(.35, range[0]), range[1]],
      (percent, label) => onProgress(3 + Math.round(percent * .32), label),
    );

    onProgress(37, 'Expanding to tiny targets');
    const tinyResults = await locateTinyImage(
      needleImage,
      haystackImage,
      [range[0], Math.min(range[1], .38)],
      (percent, label) => onProgress(37 + Math.round(percent * .61), label),
    );
    return selectDistinct([...regularResults, ...tinyResults], 3);
  }

  return selectDistinct(await locateRegularImage(needleImage, haystackImage, range, onProgress), 3);
}

async function locateTinyImage(needleImage, haystackImage, range, onProgress) {
  // Preserve small identity-bearing marks (eyes, clips, logos) that disappear
  // when a multi-megapixel wall is reduced too aggressively.
  const maxSearchDimension = 3600;
  const sourceScale = Math.min(1, maxSearchDimension / Math.max(haystackImage.naturalWidth, haystackImage.naturalHeight));
  const source = imagePixels(
    haystackImage,
    Math.max(1, Math.round(haystackImage.naturalWidth * sourceScale)),
    Math.max(1, Math.round(haystackImage.naturalHeight * sourceScale)),
  );
  const needleAspect = needleImage.naturalWidth / needleImage.naturalHeight;
  const baseWidth = needleImage.naturalWidth * sourceScale;
  const coarseDescriptor = imageDescriptor(needleImage, 12, 12);
  const fineDescriptor = imageDescriptor(needleImage, 14, 14);
  const keyDescriptor = imageDescriptor(needleImage, 24, 24);

  // The upper pixel bound keeps this high-resolution pass focused on genuinely small targets.
  // Larger candidates are handled much faster by locateRegularImage.
  const maxTinyPixels = Math.min(220, Math.max(source.width, source.height) * .22);
  const scales = geometricScales(range[0], range[1], 1.18).filter((scale) => {
    const width = baseWidth * scale;
    const height = width / needleAspect;
    return width >= 7 && height >= 7 && width <= maxTinyPixels && height <= maxTinyPixels
      && width <= source.width && height <= source.height;
  });
  if (!scales.length) return null;

  let candidates = [];
  const searchedKeySizes = new Set();
  for (let index = 0; index < scales.length; index += 1) {
    const scale = scales[index];
    const width = Math.max(7, Math.round(baseWidth * scale));
    const height = Math.max(7, Math.round(width / needleAspect));
    const stride = Math.max(1, Math.round(Math.min(width, height) / 4));
    const structural = searchGridFast(source, coarseDescriptor, width, height, stride, 12);
    candidates.push(...structural.map((candidate) => ({ ...candidate, scale, width, height, stride })));
    for (const keyScaleAdjust of [.95, 1, 1.05]) {
      const keyWidth = Math.max(7, Math.round(width * keyScaleAdjust));
      const keyHeight = Math.max(7, Math.round(height * keyScaleAdjust));
      if (Math.min(keyWidth, keyHeight) < 32 || Math.max(keyWidth, keyHeight) > 96) continue;
      const keySize = `${keyWidth}x${keyHeight}`;
      if (searchedKeySizes.has(keySize)) continue;
      searchedKeySizes.add(keySize);
      const keyStride = Math.max(1, Math.round(Math.min(keyWidth, keyHeight) / 7));
      const keyFeature = searchGridKey(source, keyDescriptor, keyWidth, keyHeight, keyStride, 128);
      candidates.push(...keyFeature.map((candidate) => ({
        ...candidate,
        scale: scale * keyScaleAdjust,
        width: keyWidth,
        height: keyHeight,
        stride: keyStride,
      })));
    }
    onProgress(Math.round(((index + 1) / scales.length) * 70), `Tiny-target scan ${index + 1} of ${scales.length}`);
    await nextFrame();
  }

  onProgress(71, 'Balancing candidates across scales');
  candidates = candidates
    .map((candidate) => {
      const structuralScore = compareRegion(
        source, fineDescriptor, candidate.x, candidate.y, candidate.width, candidate.height,
      );
      const keyScore = compareRegionKeyAppearance(
        source, keyDescriptor, candidate.x, candidate.y, candidate.width, candidate.height,
      );
      return { ...candidate, score: Math.max(structuralScore, structuralScore * .2 + keyScore * .8) };
    })
    .sort((a, b) => b.score - a.score);
  candidates = suppressNearby(candidates, 7).slice(0, 200);

  onProgress(73, 'Verifying tiny-target candidates');
  const refined = [];
  const top = candidates.slice(0, 48);
  for (let index = 0; index < top.length; index += 1) {
    const candidate = top[index];
    let best = { ...candidate, score: -Infinity };
    for (const scaleAdjust of [.9, .95, 1, 1.05, 1.1]) {
      const width = Math.max(7, Math.round(candidate.width * scaleAdjust));
      const height = Math.max(7, Math.round(width / needleAspect));
      const radius = Math.max(3, candidate.stride + 2);
      for (let y = Math.max(0, candidate.y - radius); y <= Math.min(source.height - height, candidate.y + radius); y += 1) {
        for (let x = Math.max(0, candidate.x - radius); x <= Math.min(source.width - width, candidate.x + radius); x += 1) {
          const structuralScore = compareRegion(source, fineDescriptor, x, y, width, height);
          const keyScore = compareRegionKeyAppearance(source, keyDescriptor, x, y, width, height);
          const score = Math.max(structuralScore, structuralScore * .2 + keyScore * .8);
          if (score > best.score) best = { x, y, width, height, scale: candidate.scale * scaleAdjust, score };
        }
      }
    }
    refined.push(best);
    onProgress(73 + Math.round(((index + 1) / top.length) * 27), `Confirming tiny match ${index + 1} of ${top.length}`);
    if (index % 4 === 3) await nextFrame();
  }

  refined.sort((a, b) => b.score - a.score);
  return mapResultsToOriginal(refined, sourceScale, haystackImage, 12);
}

async function locateRegularImage(needleImage, haystackImage, range, onProgress) {
  const maxSearchDimension = 420;
  const sourceScale = Math.min(1, maxSearchDimension / Math.max(haystackImage.naturalWidth, haystackImage.naturalHeight));
  const source = imagePixels(haystackImage, Math.max(1, Math.round(haystackImage.naturalWidth * sourceScale)), Math.max(1, Math.round(haystackImage.naturalHeight * sourceScale)));
  const needleAspect = needleImage.naturalWidth / needleImage.naturalHeight;
  const baseWidth = needleImage.naturalWidth * sourceScale;
  const baseHeight = needleImage.naturalHeight * sourceScale;

  const descriptor = imageDescriptor(needleImage, 10, 10);
  const scales = geometricScales(range[0], range[1], 1.12).filter((scale) => {
    const width = baseWidth * scale;
    const height = baseHeight * scale;
    return width >= 8 && height >= 8 && width <= source.width && height <= source.height;
  });
  if (!scales.length) throw new Error('The fragment is larger than the full image at every selected scale. Try a wider search range or swap the images.');

  let candidates = [];
  for (let index = 0; index < scales.length; index += 1) {
    const scale = scales[index];
    const width = Math.max(8, Math.round(baseWidth * scale));
    const height = Math.max(8, Math.round(width / needleAspect));
    const stride = Math.max(1, Math.round(Math.min(width, height) / 11));
    const perScale = searchGrid(source, descriptor, width, height, stride, 10);
    candidates.push(...perScale.map((candidate) => ({ ...candidate, scale, width, height })));
    candidates.sort((a, b) => b.score - a.score);
    candidates = suppressNearby(candidates, 18).slice(0, 36);
    onProgress(8 + Math.round(((index + 1) / scales.length) * 62), `Scanning scale ${index + 1} of ${scales.length}`);
    await nextFrame();
  }

  onProgress(74, 'Refining strongest regions');
  const refined = [];
  const top = candidates.slice(0, 18);
  for (let index = 0; index < top.length; index += 1) {
    const candidate = top[index];
    let best = candidate;
    for (const scaleAdjust of [0.92, 0.96, 1, 1.04, 1.08]) {
      const width = Math.max(8, Math.round(candidate.width * scaleAdjust));
      const height = Math.max(8, Math.round(width / needleAspect));
      const radius = Math.max(3, Math.round(Math.min(width, height) * 0.13));
      for (let y = Math.max(0, candidate.y - radius); y <= Math.min(source.height - height, candidate.y + radius); y += 1) {
        for (let x = Math.max(0, candidate.x - radius); x <= Math.min(source.width - width, candidate.x + radius); x += 1) {
          const score = compareRegion(source, descriptor, x, y, width, height);
          if (score > best.score) best = { x, y, width, height, scale: candidate.scale * scaleAdjust, score };
        }
      }
    }
    refined.push(best);
    onProgress(74 + Math.round(((index + 1) / top.length) * 20), `Confirming candidate ${index + 1} of ${top.length}`);
    await nextFrame();
  }

  refined.sort((a, b) => b.score - a.score);
  return mapResultsToOriginal(refined, sourceScale, haystackImage, 12);
}

function mapResultsToOriginal(candidates, sourceScale, haystackImage, limit) {
  return selectDistinct(
    candidates.map((candidate) => mapResultToOriginal(candidate, sourceScale, haystackImage)),
    limit,
  );
}

function mapResultToOriginal(best, sourceScale, haystackImage) {
  const originalFactor = 1 / sourceScale;
  const output = {
    x: clamp(Math.round(best.x * originalFactor), 0, haystackImage.naturalWidth - 1),
    y: clamp(Math.round(best.y * originalFactor), 0, haystackImage.naturalHeight - 1),
    width: Math.min(Math.round(best.width * originalFactor), haystackImage.naturalWidth),
    height: Math.min(Math.round(best.height * originalFactor), haystackImage.naturalHeight),
    scale: best.scale,
    rawScore: best.score,
  };
  output.confidence = scoreToConfidence(best.score);
  return output;
}

function imagePixels(image, width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, width, height);
  return pixelsFromRgba(context.getImageData(0, 0, width, height).data, width, height);
}

function imageDescriptor(image, columns, rows) {
  const sampled = imagePixels(image, columns, rows);
  return buildDescriptor(sampled.luminance, sampled.chromaA, sampled.chromaB, columns, rows);
}

const {
  buildDescriptor,
  clamp,
  compareRegion,
  compareRegionKeyAppearance,
  geometricScales,
  pixelsFromRgba,
  searchGrid,
  searchGridFast,
  searchGridKey,
  selectDistinct,
  suppressNearby,
} = window.PixelMatcher;

function scoreToConfidence(score) {
  // A calibrated display score: random regions typically sit near 0, while useful visual matches exceed .55.
  return clamp(Math.round(100 / (1 + Math.exp(-8.3 * (score - .36)))), 1, 99);
}

function renderResult(results, selectedIndex = 0, shouldScroll = true) {
  if (!results.length) throw new Error('No match candidates were produced.');
  state.result = results;
  state.selectedMatch = clamp(selectedIndex, 0, results.length - 1);
  const result = results[state.selectedMatch];
  const canvas = elements.resultCanvas;
  const image = state.haystack.image;
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  context.drawImage(image, 0, 0);

  const colors = ['#d9ff54', '#ff6d3a', '#65d8ff'];
  const canvasScale = Math.max(canvas.width, canvas.height);
  results.forEach((match, index) => {
    const isSelected = index === state.selectedMatch;
    const color = colors[index] || '#ffffff';
    // Size annotations against the whole image, not the match. Tiny matches in a
    // large image would otherwise get sub-pixel outlines in the fitted preview.
    const lineWidth = Math.max(4, Math.round(canvasScale * (isSelected ? .006 : .0045)));
    const framePadding = Math.max(
      lineWidth * (isSelected ? 1.65 : 1.35),
      Math.min(match.width, match.height) * .14,
    );
    const frameX = Math.max(lineWidth, match.x - framePadding);
    const frameY = Math.max(lineWidth, match.y - framePadding);
    const frameRight = Math.min(canvas.width - lineWidth, match.x + match.width + framePadding);
    const frameBottom = Math.min(canvas.height - lineWidth, match.y + match.height + framePadding);
    const frameWidth = Math.max(lineWidth, frameRight - frameX);
    const frameHeight = Math.max(lineWidth, frameBottom - frameY);
    const labelFont = Math.max(14, Math.min(72, Math.round(canvasScale * .018)));
    const paddingX = Math.max(7, labelFont * .42);
    const labelHeight = labelFont * 1.48;
    const label = `#${index + 1} · ${match.confidence}%`;
    context.save();

    context.fillStyle = isSelected ? `${color}28` : `${color}14`;
    context.fillRect(frameX, frameY, frameWidth, frameHeight);

    // The dark underlay keeps the marker legible over both pale and busy images.
    context.strokeStyle = 'rgba(5, 10, 8, .9)';
    context.lineWidth = lineWidth * 1.75;
    context.strokeRect(frameX, frameY, frameWidth, frameHeight);
    context.strokeStyle = color;
    context.lineWidth = lineWidth;
    if (!isSelected) context.setLineDash([lineWidth * 2.5, lineWidth * 1.7]);
    context.strokeRect(frameX, frameY, frameWidth, frameHeight);
    context.setLineDash([]);

    context.font = `700 ${labelFont}px Manrope, sans-serif`;
    const metrics = context.measureText(label);
    const labelWidth = metrics.width + paddingX * 2;
    const labelX = Math.min(frameX, Math.max(0, canvas.width - labelWidth));
    const labelY = frameY - labelHeight >= 0
      ? frameY - labelHeight
      : Math.max(0, Math.min(frameBottom, canvas.height - labelHeight));
    context.fillStyle = 'rgba(5, 10, 8, .92)';
    context.fillRect(labelX - lineWidth * .35, labelY - lineWidth * .35, labelWidth + lineWidth * .7, labelHeight + lineWidth * .7);
    context.fillStyle = color;
    context.fillRect(labelX, labelY, labelWidth, labelHeight);
    context.fillStyle = '#111a14';
    context.fillText(label, labelX + paddingX, labelY + labelFont * 1.12);
    context.restore();
  });

  elements.matchCandidates.replaceChildren(...results.map((match, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `candidate-card${index === state.selectedMatch ? ' active' : ''}`;
    button.style.setProperty('--candidate-color', colors[index] || '#ffffff');
    button.innerHTML = `<b><span>#${index + 1}</span>${match.confidence}%</b><small>${match.x}, ${match.y} · ${match.width}×${match.height}</small>`;
    button.setAttribute('aria-pressed', String(index === state.selectedMatch));
    button.addEventListener('click', () => renderResult(results, index, false));
    return button;
  }));

  const confidenceText = result.confidence >= 82 ? 'Strong match' : result.confidence >= 62 ? 'Likely match' : 'Possible match';
  elements.confidenceScore.textContent = result.confidence;
  elements.confidenceLabel.textContent = confidenceText;
  elements.scoreRing.style.background = `conic-gradient(var(--acid) ${result.confidence * 3.6}deg, #3b443d 0)`;
  elements.positionValue.textContent = `${result.x}, ${result.y} px`;
  elements.sizeValue.textContent = `${result.width} × ${result.height} px`;
  elements.scaleValue.textContent = `${Math.round(result.scale * 100)}%`;
  elements.resultMessage.textContent = result.confidence >= 62
    ? `Candidate #${state.selectedMatch + 1} is one of the three strongest non-overlapping visual matches.`
    : `Candidate #${state.selectedMatch + 1} is uncertain. Compare all three results or try a wider range.`;
  renderCloseup(result, colors[state.selectedMatch] || '#ffffff');
  elements.resultPanel.hidden = false;
  requestAnimationFrame(() => setPreviewMode('focus'));
  if (shouldScroll) elements.resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderCloseup(match, color) {
  const canvas = elements.closeupCanvas;
  const image = state.haystack.image;
  canvas.width = 520;
  canvas.height = 320;
  const context = canvas.getContext('2d');
  const aspect = canvas.width / canvas.height;
  let cropHeight = Math.max(match.height * 4.5, 120);
  let cropWidth = Math.max(match.width * 4.5, cropHeight * aspect);
  cropHeight = cropWidth / aspect;
  if (cropWidth > image.naturalWidth) {
    cropWidth = image.naturalWidth;
    cropHeight = cropWidth / aspect;
  }
  if (cropHeight > image.naturalHeight) {
    cropHeight = image.naturalHeight;
    cropWidth = cropHeight * aspect;
  }
  const centerX = match.x + match.width / 2;
  const centerY = match.y + match.height / 2;
  const cropX = clamp(centerX - cropWidth / 2, 0, image.naturalWidth - cropWidth);
  const cropY = clamp(centerY - cropHeight / 2, 0, image.naturalHeight - cropHeight);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, cropX, cropY, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);

  const scaleX = canvas.width / cropWidth;
  const scaleY = canvas.height / cropHeight;
  const frameX = (match.x - cropX) * scaleX;
  const frameY = (match.y - cropY) * scaleY;
  const frameWidth = match.width * scaleX;
  const frameHeight = match.height * scaleY;
  context.fillStyle = `${color}22`;
  context.fillRect(frameX, frameY, frameWidth, frameHeight);
  context.strokeStyle = 'rgba(5, 10, 8, .9)';
  context.lineWidth = 9;
  context.strokeRect(frameX, frameY, frameWidth, frameHeight);
  context.strokeStyle = color;
  context.lineWidth = 5;
  context.strokeRect(frameX, frameY, frameWidth, frameHeight);
  elements.closeupCaption.textContent = `Candidate #${state.selectedMatch + 1} close-up · ${match.width} × ${match.height} px`;
}

function getFitScale() {
  const canvas = elements.resultCanvas;
  const wrap = elements.canvasWrap;
  if (!canvas.width || !canvas.height) return 1;
  return Math.min(
    Math.max(80, wrap.clientWidth - 48) / canvas.width,
    Math.max(80, wrap.clientHeight - 48) / canvas.height,
  );
}

function setPreviewMode(mode) {
  if (!state.result?.length) return;
  const match = state.result[state.selectedMatch];
  const fitScale = getFitScale();
  let scale = fitScale;
  if (mode === 'actual') scale = 1;
  if (mode === 'focus') {
    const horizontal = Math.max(80, elements.canvasWrap.clientWidth - 96) / Math.max(1, match.width * 5);
    const vertical = Math.max(80, elements.canvasWrap.clientHeight - 96) / Math.max(1, match.height * 5);
    scale = Math.max(fitScale, Math.min(4, horizontal, vertical));
  }
  applyPreviewScale(scale, mode, mode !== 'fit');
}

function applyPreviewScale(scale, mode = 'custom', centerOnMatch = true) {
  const canvas = elements.resultCanvas;
  const fitScale = getFitScale();
  const maxScale = Math.max(4, fitScale);
  state.previewScale = clamp(scale, Math.min(.02, fitScale), maxScale);
  state.previewMode = mode;
  canvas.style.width = `${Math.max(1, canvas.width * state.previewScale)}px`;
  elements.zoomValue.value = `${Math.round(state.previewScale * 100)}%`;
  elements.zoomValue.textContent = `${Math.round(state.previewScale * 100)}%`;
  for (const [button, buttonMode] of [
    [elements.fitView, 'fit'], [elements.focusView, 'focus'], [elements.actualView, 'actual'],
  ]) button.classList.toggle('active', mode === buttonMode);
  if (centerOnMatch) requestAnimationFrame(centerPreviewOnSelectedMatch);
}

function centerPreviewOnSelectedMatch() {
  if (!state.result?.length) return;
  const match = state.result[state.selectedMatch];
  const wrap = elements.canvasWrap;
  const centerX = (match.x + match.width / 2) * state.previewScale;
  const centerY = (match.y + match.height / 2) * state.previewScale;
  wrap.scrollTo({
    left: Math.max(0, centerX - wrap.clientWidth / 2),
    top: Math.max(0, centerY - wrap.clientHeight / 2),
    behavior: 'smooth',
  });
}

function stepPreviewZoom(factor) {
  if (!state.result?.length) return;
  applyPreviewScale(state.previewScale * factor, 'custom', true);
}

function selectCandidateFromCanvas(event) {
  if (!state.result?.length) return;
  const rect = elements.resultCanvas.getBoundingClientRect();
  const x = (event.clientX - rect.left) * (elements.resultCanvas.width / rect.width);
  const y = (event.clientY - rect.top) * (elements.resultCanvas.height / rect.height);
  let selectedIndex = -1;
  let bestDistance = Infinity;
  state.result.forEach((match, index) => {
    const centerX = match.x + match.width / 2;
    const centerY = match.y + match.height / 2;
    const distance = Math.hypot(x - centerX, y - centerY);
    const hitRadius = Math.max(match.width, match.height) * .9 + 30 / Math.max(state.previewScale, .02);
    if (distance <= hitRadius && distance < bestDistance) {
      bestDistance = distance;
      selectedIndex = index;
    }
  });
  if (selectedIndex >= 0) renderResult(state.result, selectedIndex, false);
}

function downloadResult() {
  if (!state.result?.length) return;
  elements.resultCanvas.toBlob((blob) => {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `pixeltrace-${stripExtension(state.haystack.file.name)}.png`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }, 'image/png');
}

function clearAll() {
  for (const kind of ['needle', 'haystack']) {
    if (state[kind]?.url) URL.revokeObjectURL(state[kind].url);
    state[kind] = null;
    const drop = elements[`${kind}Drop`];
    drop.querySelector('.empty-upload').hidden = false;
    drop.querySelector('.image-preview').hidden = true;
    elements[`${kind}Input`].value = '';
  }
  state.result = null;
  elements.resultPanel.hidden = true;
  updateReadyState();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setProgress(percent, label) {
  elements.progressPercent.textContent = `${percent}%`;
  elements.progressBar.style.width = `${percent}%`;
  elements.progressStep.textContent = label;
}

function showToast(message) {
  const toast = document.createElement('div');
  toast.textContent = message;
  Object.assign(toast.style, {
    position: 'fixed', left: '50%', bottom: '28px', transform: 'translateX(-50%)', zIndex: 50,
    background: '#ff6d3a', color: '#19231d', padding: '13px 18px', font: '600 12px Manrope, sans-serif',
    boxShadow: '0 12px 30px rgba(0,0,0,.22)', maxWidth: 'calc(100vw - 32px)',
  });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3600);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function stripExtension(name) { return name.replace(/\.[^.]+$/, ''); }
function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }
function nextFrame() { return new Promise((resolve) => requestAnimationFrame(resolve)); }
