const VIEW_MARGIN = 50;
const DOCUMENT = Object.freeze({
  height: 1536,
  width: 1536,
});
const MAX_ZOOM_MULTIPLIER = 8;
const MAX_ZOOM_ABSOLUTE = 5;
const SETTLE_EPSILON = 0.02;
const SETTLE_STIFFNESS = 0.22;
const SETTLE_FRICTION = 0.72;
const ZOOM_BUTTON_STEP = 1.12;
const WHEEL_SENSITIVITY = 0.00145;
const WHEEL_DELTA_LIMIT = 70;
const WHEEL_SETTLE_DELAY = 80;
const HOME_ZOOM_SNAP_RATIO = 1.015;
const PREVIEW_LONG_EDGES = Object.freeze([256, 512, 1024, 1536, 2048, 3072]);
const MOBILE_PREVIEW_CAP = 2048;
const DESKTOP_PREVIEW_CAP = 3072;
const IMAGE_LAYER_MAX_DOCUMENT_RATIO = 0.84;
const PERF_ENABLED = new URLSearchParams(window.location.search).has("perf");
const PERF_RING_SIZE = 1000;
const PERF_UI_INTERVAL = 300;
const LONG_TASK_MS = 50;

const canvas = document.querySelector("[data-editor-viewport]");
const imageInput = document.querySelector("[data-image-input]");
const imageStatusLabel = document.querySelector("[data-image-status]");
const imageUploadButton = document.querySelector("[data-image-upload]");
const resetButton = document.querySelector("[data-reset-view]");
const zoomInButton = document.querySelector("[data-zoom-in]");
const zoomOutButton = document.querySelector("[data-zoom-out]");
const zoomRange = document.querySelector("[data-zoom-range]");
const zoomLabel = document.querySelector("[data-zoom-label]");
const documentSizeLabel = document.querySelector("[data-document-size]");
const perfPanel = document.querySelector("[data-perf-panel]");
const context = canvas.getContext("2d", { alpha: false });
const assetCache = new Map();

const state = {
  camera: {
    x: 0,
    y: 0,
    zoom: 1,
    vx: 0,
    vy: 0,
    vz: 0,
  },
  gesture: null,
  imageLayer: null,
  isInteracting: false,
  pointers: new Map(),
  raf: 0,
  settleRaf: 0,
  size: {
    dpr: 1,
    height: 1,
    width: 1,
  },
  zoomBounds: {
    max: 1,
    min: 1,
  },
  wheelAnchor: null,
  zoomSettleAnchor: null,
};
const perf = createPerfState();

function createRing(limit) {
  return {
    count: 0,
    index: 0,
    items: new Array(limit),
    limit,
  };
}

function ringPush(ring, value) {
  ring.items[ring.index] = value;
  ring.index = (ring.index + 1) % ring.limit;
  ring.count = Math.min(ring.count + 1, ring.limit);
}

function ringValues(ring) {
  const values = [];
  const start = ring.count === ring.limit ? ring.index : 0;

  for (let offset = 0; offset < ring.count; offset += 1) {
    values.push(ring.items[(start + offset) % ring.limit]);
  }

  return values;
}

function createPerfState() {
  return {
    compositeTimes: createRing(PERF_RING_SIZE),
    dirtyPixels: createRing(PERF_RING_SIZE),
    droppedFrames: 0,
    enabled: PERF_ENABLED,
    frameBudget: 16.7,
    frameTimes: createRing(PERF_RING_SIZE),
    importTimes: createRing(64),
    inputLatencies: createRing(PERF_RING_SIZE),
    lastFrameAt: 0,
    lastUiAt: 0,
    longTaskObserver: null,
    longTaskCount: 0,
    longTasks: createRing(256),
    pendingInputAt: 0,
    renderTimes: createRing(PERF_RING_SIZE),
    storage: {
      quota: 0,
      usage: 0,
    },
  };
}

function average(values) {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values, percent) {
  if (!values.length) {
    return 0;
  }

  const sorted = [...values].sort((first, second) => first - second);
  const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1);

  return sorted[index];
}

function formatMs(value) {
  return `${value.toFixed(value < 10 ? 1 : 0)} ms`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("it-IT", {
    maximumFractionDigits: 1,
  }).format(value);
}

function formatBytes(bytes) {
  if (!bytes) {
    return "0 MB";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${formatNumber(value)} ${units[unitIndex]}`;
}

function estimateImageCacheBytes() {
  let bytes = 0;

  for (const asset of assetCache.values()) {
    for (const preview of asset.previews) {
      bytes += preview.width * preview.height * 4;
    }
  }

  return bytes;
}

function estimateViewportBytes() {
  return canvas.width * canvas.height * 4;
}

function estimateLayerBytes() {
  const baseBytes = DOCUMENT.width * DOCUMENT.height * 4;
  const imageBytes = state.imageLayer
    ? Math.round(state.imageLayer.width * state.imageLayer.height * 4)
    : 0;

  return baseBytes + imageBytes;
}

function recordInputForPerf(event) {
  if (!perf.enabled) {
    return;
  }

  const stamp = event.timeStamp;
  perf.pendingInputAt = stamp > 0 && stamp < performance.now() + 1000
    ? stamp
    : performance.now();
}

function recordPerfMeasure(name, duration) {
  if (!perf.enabled) {
    return;
  }

  if (name === "render") {
    ringPush(perf.renderTimes, duration);
  } else if (name === "composite") {
    ringPush(perf.compositeTimes, duration);
  } else if (name === "image import") {
    ringPush(perf.importTimes, duration);
  }
}

async function measurePerfAsync(name, task) {
  if (!perf.enabled) {
    return task();
  }

  const start = performance.now();

  try {
    return await task();
  } finally {
    recordPerfMeasure(name, performance.now() - start);
  }
}

async function updateStorageEstimate() {
  if (!perf.enabled || !navigator.storage?.estimate) {
    return;
  }

  try {
    const estimate = await navigator.storage.estimate();

    perf.storage.usage = estimate.usage || 0;
    perf.storage.quota = estimate.quota || 0;
  } catch (error) {
    perf.storage.usage = 0;
    perf.storage.quota = 0;
  }
}

function scheduleStoragePerfUpdate() {
  if (!perf.enabled) {
    return;
  }

  updateStorageEstimate().finally(() => {
    window.setTimeout(scheduleStoragePerfUpdate, 5000);
  });
}

function updateFrameBudget(frameP50) {
  if (!frameP50) {
    return;
  }

  perf.frameBudget = frameP50 < 12 ? 8.3 : 16.7;
}

function updatePerfPanel(now = performance.now()) {
  if (!perf.enabled || !perfPanel || now - perf.lastUiAt < PERF_UI_INTERVAL) {
    return;
  }

  perf.lastUiAt = now;

  const frameTimes = ringValues(perf.frameTimes);
  const renderTimes = ringValues(perf.renderTimes);
  const compositeTimes = ringValues(perf.compositeTimes);
  const inputLatencies = ringValues(perf.inputLatencies);
  const importTimes = ringValues(perf.importTimes);
  const dirtyPixels = ringValues(perf.dirtyPixels);
  const frameP50 = percentile(frameTimes, 50);
  const frameP95 = percentile(frameTimes, 95);
  const inputP95 = percentile(inputLatencies, 95);
  const inputP99 = percentile(inputLatencies, 99);
  const renderP95 = percentile(renderTimes, 95);
  const compositeP95 = percentile(compositeTimes, 95);
  const importLast = importTimes[importTimes.length - 1] || 0;
  const fps = frameTimes.length ? 1000 / average(frameTimes.slice(-60)) : 0;
  const dirtyAverage = average(dirtyPixels) / 1000000;
  const jsHeap = performance.memory?.usedJSHeapSize || 0;
  const imageCacheBytes = estimateImageCacheBytes();
  const storageQuota = perf.storage.quota ? formatBytes(perf.storage.quota) : "n/d";
  const storageUsage = perf.storage.quota ? formatBytes(perf.storage.usage) : "n/d";
  const longTaskP95 = percentile(ringValues(perf.longTasks), 95);
  const layerCount = state.imageLayer ? 2 : 1;

  updateFrameBudget(frameP50);

  perfPanel.textContent = [
    "PERF ?perf=1",
    `FPS: ${fps ? fps.toFixed(0) : "--"}`,
    `Frame p95: ${formatMs(frameP95)}`,
    `Input p95/p99: ${formatMs(inputP95)} / ${formatMs(inputP99)}`,
    `Render p95: ${formatMs(renderP95)}`,
    `Composite p95: ${formatMs(compositeP95)}`,
    `Image import last: ${importLast ? formatMs(importLast) : "n/d"}`,
    `Dirty pixels/frame: ${formatNumber(dirtyAverage)} MP`,
    `Layers: ${layerCount}`,
    `Layer estimate: ${formatBytes(estimateLayerBytes())}`,
    `Viewport canvas: ${formatBytes(estimateViewportBytes())}`,
    `Image cache: ${formatBytes(imageCacheBytes)}`,
    "Undo memory: 0 MB",
    `Storage: ${storageUsage} / ${storageQuota}`,
    `Long tasks: ${perf.longTaskCount} p95 ${formatMs(longTaskP95)}`,
    `Dropped frames: ${perf.droppedFrames}`,
  ].join("\n");
}

function startPerfMonitor() {
  if (!perf.enabled || !perfPanel) {
    return;
  }

  perfPanel.hidden = false;

  if ("PerformanceObserver" in window) {
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.duration >= LONG_TASK_MS) {
            perf.longTaskCount += 1;
            ringPush(perf.longTasks, entry.duration);
          }
        }
      });

      observer.observe({ buffered: true, type: "longtask" });
      perf.longTaskObserver = observer;
    } catch (error) {
      console.warn("Long Task API non disponibile.", error);
    }
  }

  const tick = (timestamp) => {
    if (perf.lastFrameAt) {
      const frameTime = timestamp - perf.lastFrameAt;

      ringPush(perf.frameTimes, frameTime);

      if (frameTime > perf.frameBudget * 1.5) {
        perf.droppedFrames += Math.max(1, Math.round(frameTime / perf.frameBudget) - 1);
      }
    }

    perf.lastFrameAt = timestamp;
    updatePerfPanel(timestamp);
    requestAnimationFrame(tick);
  };

  scheduleStoragePerfUpdate();
  requestAnimationFrame(tick);
}

function isMobileLike() {
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)")?.matches === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}

function getRenderDpr() {
  return isMobileLike()
    ? 1
    : Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));
}

function getMaxPreviewLongEdge() {
  return isMobileLike() ? MOBILE_PREVIEW_CAP : DESKTOP_PREVIEW_CAP;
}

function nextFrame() {
  return new Promise((resolve) => {
    requestAnimationFrame(resolve);
  });
}

function getImageSourceSize(source) {
  return {
    height: source.naturalHeight || source.height,
    width: source.naturalWidth || source.width,
  };
}

function getFileCacheKey(file) {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

async function decodeImageFile(file) {
  if ("createImageBitmap" in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: "from-image" });
    } catch (error) {
      console.warn("createImageBitmap non riuscito, uso fallback img.", error);
    }
  }

  return new Promise((resolve, reject) => {
    const image = new Image();
    const url = URL.createObjectURL(file);

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Immagine non leggibile."));
    };
    image.src = url;
  });
}

function createScaledCanvas(source, width, height) {
  const preview = document.createElement("canvas");
  const previewContext = preview.getContext("2d", { alpha: true });

  preview.width = width;
  preview.height = height;
  previewContext.imageSmoothingEnabled = true;
  previewContext.imageSmoothingQuality = "high";
  previewContext.drawImage(source, 0, 0, width, height);

  return preview;
}

function getPreviewTargets(width, height) {
  const longest = Math.max(width, height);
  const cappedLongest = Math.max(1, Math.min(longest, getMaxPreviewLongEdge()));
  const targets = PREVIEW_LONG_EDGES.filter((edge) => edge < cappedLongest);

  targets.push(Math.round(cappedLongest));

  return Array.from(new Set(targets)).filter((edge) => edge >= 16);
}

async function buildPreviewPyramid(source, width, height) {
  const longest = Math.max(width, height);
  const targets = getPreviewTargets(width, height);
  const previews = [];

  for (const target of targets) {
    const scale = Math.min(1, target / longest);
    const previewWidth = Math.max(1, Math.round(width * scale));
    const previewHeight = Math.max(1, Math.round(height * scale));
    const bitmap = createScaledCanvas(source, previewWidth, previewHeight);

    previews.push({
      bitmap,
      height: previewHeight,
      longest: Math.max(previewWidth, previewHeight),
      width: previewWidth,
    });

    await nextFrame();
  }

  return previews;
}

async function createImageAsset(file) {
  const cacheKey = getFileCacheKey(file);
  const cached = assetCache.get(cacheKey);

  if (cached) {
    return cached;
  }

  const source = await decodeImageFile(file);
  const { height, width } = getImageSourceSize(source);
  const previews = await buildPreviewPyramid(source, width, height);

  if (typeof source.close === "function") {
    source.close();
  }

  const asset = {
    cacheKey,
    height,
    name: file.name,
    previews,
    width,
  };

  assetCache.set(cacheKey, asset);

  return asset;
}

function createImageLayer(asset) {
  const maxWidth = DOCUMENT.width * IMAGE_LAYER_MAX_DOCUMENT_RATIO;
  const maxHeight = DOCUMENT.height * IMAGE_LAYER_MAX_DOCUMENT_RATIO;
  const fit = Math.min(1, maxWidth / asset.width, maxHeight / asset.height);
  const width = Math.max(1, asset.width * fit);
  const height = Math.max(1, asset.height * fit);

  return {
    asset,
    height,
    width,
    x: (DOCUMENT.width - width) * 0.5,
    y: (DOCUMENT.height - height) * 0.5,
  };
}

function getPreferredPreview(layer) {
  const neededWidth = layer.width * state.camera.zoom * state.size.dpr;
  const neededHeight = layer.height * state.camera.zoom * state.size.dpr;
  const neededLongest = Math.max(neededWidth, neededHeight) * 1.15;
  const previews = layer.asset.previews;

  return previews.find((preview) => preview.longest >= neededLongest) || previews[previews.length - 1];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function getFitZoom() {
  const usableWidth = Math.max(1, state.size.width - VIEW_MARGIN * 2);
  const usableHeight = Math.max(1, state.size.height - VIEW_MARGIN * 2);

  return Math.min(usableWidth / DOCUMENT.width, usableHeight / DOCUMENT.height);
}

function updateZoomBounds() {
  const min = Math.max(0.02, getFitZoom());
  const max = Math.max(min * 1.01, Math.min(MAX_ZOOM_ABSOLUTE, min * MAX_ZOOM_MULTIPLIER));

  state.zoomBounds = { max, min };
}

function rubberDelta(delta, scale, minLimit = 24) {
  const limit = Math.max(minLimit, Math.abs(scale) * 0.28);

  return limit * (1 - 1 / (delta / limit + 1));
}

function rubberClamp(value, min, max, scale, minLimit = 24) {
  if (value < min) {
    return min - rubberDelta(min - value, scale, minLimit);
  }

  if (value > max) {
    return max + rubberDelta(value - max, scale, minLimit);
  }

  return value;
}

function rubberClampZoom(value) {
  const minRubber = Math.max(0.02, state.zoomBounds.min * 0.12);
  const maxRubber = Math.max(0.025, state.zoomBounds.max * 0.045);

  if (value < state.zoomBounds.min) {
    return state.zoomBounds.min - rubberDelta(state.zoomBounds.min - value, state.zoomBounds.min, minRubber);
  }

  if (value > state.zoomBounds.max) {
    return state.zoomBounds.max + rubberDelta(value - state.zoomBounds.max, state.zoomBounds.max, maxRubber);
  }

  return value;
}

function getPanBounds(zoom = state.camera.zoom) {
  const docWidth = DOCUMENT.width * zoom;
  const docHeight = DOCUMENT.height * zoom;
  const horizontalCenter = (state.size.width - docWidth) * 0.5;
  const verticalCenter = (state.size.height - docHeight) * 0.5;
  const horizontalFits = docWidth <= state.size.width - VIEW_MARGIN * 2;
  const verticalFits = docHeight <= state.size.height - VIEW_MARGIN * 2;

  return {
    maxX: horizontalFits ? horizontalCenter : VIEW_MARGIN,
    maxY: verticalFits ? verticalCenter : VIEW_MARGIN,
    minX: horizontalFits ? horizontalCenter : state.size.width - VIEW_MARGIN - docWidth,
    minY: verticalFits ? verticalCenter : state.size.height - VIEW_MARGIN - docHeight,
  };
}

function applyElasticPan(camera = state.camera) {
  const bounds = getPanBounds(camera.zoom);

  camera.x = rubberClamp(camera.x, bounds.minX, bounds.maxX, state.size.width);
  camera.y = rubberClamp(camera.y, bounds.minY, bounds.maxY, state.size.height);
}

function clampPanForZoom(camera, boundsZoom = camera.zoom) {
  const bounds = getPanBounds(boundsZoom);

  return {
    ...camera,
    x: clamp(camera.x, bounds.minX, bounds.maxX),
    y: clamp(camera.y, bounds.minY, bounds.maxY),
  };
}

function cameraFromZoomAnchor(anchor, zoom) {
  return {
    x: anchor.screen.x - anchor.document.x * zoom,
    y: anchor.screen.y - anchor.document.y * zoom,
    zoom,
  };
}

function createZoomAnchor(point, camera = state.camera) {
  return {
    document: screenToDocument(point, camera),
    screen: {
      x: point.x,
      y: point.y,
    },
  };
}

function clampCamera(camera = state.camera, anchor = null) {
  const zoom = clamp(camera.zoom, state.zoomBounds.min, state.zoomBounds.max);
  const next = anchor ? cameraFromZoomAnchor(anchor, zoom) : { ...camera, zoom };

  return clampPanForZoom(next, zoom);
}

function setCamera(camera, options = {}) {
  state.camera.x = camera.x;
  state.camera.y = camera.y;
  state.camera.zoom = camera.zoom;

  if (options.elastic !== false) {
    applyElasticPan(state.camera);
  }

  scheduleRender();
  updateZoomUi();
}

function centerCamera() {
  updateZoomBounds();
  const zoom = state.zoomBounds.min;
  const x = (state.size.width - DOCUMENT.width * zoom) * 0.5;
  const y = (state.size.height - DOCUMENT.height * zoom) * 0.5;

  state.camera.vx = 0;
  state.camera.vy = 0;
  state.camera.vz = 0;
  state.wheelAnchor = null;
  state.zoomSettleAnchor = null;
  setCamera({ x, y, zoom }, { elastic: false });
}

function shouldSnapHome(camera = state.camera) {
  return camera.zoom <= state.zoomBounds.min * HOME_ZOOM_SNAP_RATIO;
}

function snapHomeOrSettleCamera(anchor = null) {
  if (shouldSnapHome()) {
    centerCamera();
    return;
  }

  settleCamera(anchor);
}

function settleCamera(anchor = null) {
  cancelAnimationFrame(state.settleRaf);
  const target = clampCamera(state.camera, anchor);

  const tick = () => {
    const dx = target.x - state.camera.x;
    const dy = target.y - state.camera.y;
    const dz = target.zoom - state.camera.zoom;

    state.camera.vx = (state.camera.vx + dx * SETTLE_STIFFNESS) * SETTLE_FRICTION;
    state.camera.vy = (state.camera.vy + dy * SETTLE_STIFFNESS) * SETTLE_FRICTION;
    state.camera.vz = (state.camera.vz + dz * SETTLE_STIFFNESS) * SETTLE_FRICTION;
    state.camera.x += state.camera.vx;
    state.camera.y += state.camera.vy;
    state.camera.zoom += state.camera.vz;

    const stillMoving =
      Math.abs(dx) > SETTLE_EPSILON ||
      Math.abs(dy) > SETTLE_EPSILON ||
      Math.abs(dz) > 0.0001 ||
      Math.abs(state.camera.vx) > SETTLE_EPSILON ||
      Math.abs(state.camera.vy) > SETTLE_EPSILON ||
      Math.abs(state.camera.vz) > 0.0001;

    if (stillMoving) {
      scheduleRender();
      updateZoomUi();
      state.settleRaf = requestAnimationFrame(tick);
      return;
    }

    state.camera.x = target.x;
    state.camera.y = target.y;
    state.camera.zoom = target.zoom;
    state.camera.vx = 0;
    state.camera.vy = 0;
    state.camera.vz = 0;
    state.settleRaf = 0;
    scheduleRender();
    updateZoomUi();
  };

  state.settleRaf = requestAnimationFrame(tick);
}

function screenToDocument(point, camera = state.camera) {
  return {
    x: (point.x - camera.x) / camera.zoom,
    y: (point.y - camera.y) / camera.zoom,
  };
}

function zoomAt(point, requestedZoom, options = {}) {
  const anchor = options.anchor || createZoomAnchor(point);
  const zoom = options.elastic === false
    ? clamp(requestedZoom, state.zoomBounds.min, state.zoomBounds.max)
    : rubberClampZoom(requestedZoom);
  const boundsZoom = clamp(zoom, state.zoomBounds.min, state.zoomBounds.max);
  const next = clampPanForZoom(cameraFromZoomAnchor(anchor, zoom), boundsZoom);

  state.zoomSettleAnchor = anchor;
  setCamera(next, { elastic: false });
}

function getPointerPoint(event) {
  const rect = canvas.getBoundingClientRect();

  return {
    id: event.pointerId,
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function getActivePointers() {
  return Array.from(state.pointers.values()).sort((first, second) => first.id - second.id);
}

function getDistance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getCenter(first, second) {
  return {
    x: (first.x + second.x) * 0.5,
    y: (first.y + second.y) * 0.5,
  };
}

function beginPan(point) {
  state.gesture = {
    lastX: point.x,
    lastY: point.y,
    type: "pan",
  };
}

function beginPinch() {
  const [first, second] = getActivePointers();

  if (!first || !second) {
    return;
  }

  const center = getCenter(first, second);

  state.gesture = {
    center,
    distance: Math.max(1, getDistance(first, second)),
    documentPoint: screenToDocument(center),
    startCamera: { ...state.camera },
    type: "pinch",
  };
}

function handlePointerDown(event) {
  recordInputForPerf(event);
  event.preventDefault();
  canvas.setPointerCapture?.(event.pointerId);
  cancelAnimationFrame(state.settleRaf);
  window.clearTimeout(handleWheel.settleTimer);
  state.settleRaf = 0;
  state.wheelAnchor = null;
  state.isInteracting = true;
  canvas.classList.add("is-dragging");
  state.pointers.set(event.pointerId, getPointerPoint(event));

  if (state.pointers.size >= 2) {
    beginPinch();
  } else {
    state.zoomSettleAnchor = null;
    beginPan(getPointerPoint(event));
  }
}

function handlePointerMove(event) {
  if (!state.pointers.has(event.pointerId)) {
    return;
  }

  recordInputForPerf(event);
  event.preventDefault();
  state.pointers.set(event.pointerId, getPointerPoint(event));

  if (state.pointers.size >= 2) {
    if (state.gesture?.type !== "pinch") {
      beginPinch();
    }

    const [first, second] = getActivePointers();
    const center = getCenter(first, second);
    const distance = Math.max(1, getDistance(first, second));
    const rawZoom = state.gesture.startCamera.zoom * (distance / state.gesture.distance);
    const zoom = rubberClampZoom(rawZoom);
    const anchor = {
      document: state.gesture.documentPoint,
      screen: center,
    };
    const boundsZoom = clamp(zoom, state.zoomBounds.min, state.zoomBounds.max);
    const next = clampPanForZoom(cameraFromZoomAnchor(anchor, zoom), boundsZoom);

    state.zoomSettleAnchor = anchor;
    setCamera(next, { elastic: false });
    return;
  }

  if (state.gesture?.type !== "pan") {
    beginPan(getPointerPoint(event));
    return;
  }

  const point = getPointerPoint(event);
  const dx = point.x - state.gesture.lastX;
  const dy = point.y - state.gesture.lastY;

  state.gesture.lastX = point.x;
  state.gesture.lastY = point.y;
  setCamera({
    x: state.camera.x + dx,
    y: state.camera.y + dy,
    zoom: state.camera.zoom,
  });
}

function finishPointer(event) {
  if (state.pointers.has(event.pointerId)) {
    state.pointers.delete(event.pointerId);
  }

  if (canvas.hasPointerCapture?.(event.pointerId)) {
    canvas.releasePointerCapture(event.pointerId);
  }

  if (state.pointers.size >= 2) {
    beginPinch();
    return;
  }

  if (state.pointers.size === 1) {
    state.zoomSettleAnchor = null;
    beginPan(getActivePointers()[0]);
    return;
  }

  state.gesture = null;
  state.isInteracting = false;
  canvas.classList.remove("is-dragging");
  const releaseAnchor = state.zoomSettleAnchor;

  snapHomeOrSettleCamera(releaseAnchor);
  state.zoomSettleAnchor = null;
}

function handleWheel(event) {
  recordInputForPerf(event);
  event.preventDefault();
  cancelAnimationFrame(state.settleRaf);
  state.settleRaf = 0;

  const rect = canvas.getBoundingClientRect();
  const point = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
  const delta = clamp(event.deltaY, -WHEEL_DELTA_LIMIT, WHEEL_DELTA_LIMIT);
  const factor = Math.exp(-delta * WHEEL_SENSITIVITY);
  const anchor = state.wheelAnchor || createZoomAnchor(point);

  anchor.screen = point;
  state.wheelAnchor = anchor;
  zoomAt(point, state.camera.zoom * factor, { anchor });
  window.clearTimeout(handleWheel.settleTimer);
  handleWheel.settleTimer = window.setTimeout(() => {
    snapHomeOrSettleCamera(anchor);
    state.wheelAnchor = null;
    state.zoomSettleAnchor = null;
  }, WHEEL_SETTLE_DELAY);
}

function setZoomByNormalized(value) {
  if (perf.enabled) {
    perf.pendingInputAt = performance.now();
  }

  const t = clamp(Number(value) / 1000, 0, 1);
  const zoom = state.zoomBounds.min * ((state.zoomBounds.max / state.zoomBounds.min) ** t);
  const point = {
    x: state.size.width * 0.5,
    y: state.size.height * 0.5,
  };

  zoomAt(point, zoom, { elastic: false });
  snapHomeOrSettleCamera(state.zoomSettleAnchor);
  state.zoomSettleAnchor = null;
}

function stepZoom(direction) {
  if (perf.enabled) {
    perf.pendingInputAt = performance.now();
  }

  const factor = direction > 0 ? ZOOM_BUTTON_STEP : 1 / ZOOM_BUTTON_STEP;
  const point = {
    x: state.size.width * 0.5,
    y: state.size.height * 0.5,
  };

  zoomAt(point, state.camera.zoom * factor);
  snapHomeOrSettleCamera(state.zoomSettleAnchor);
  state.zoomSettleAnchor = null;
}

function setImageStatus(text) {
  if (!imageStatusLabel) {
    return;
  }

  imageStatusLabel.hidden = false;
  imageStatusLabel.textContent = text;
}

function updateImageStatus() {
  if (!imageStatusLabel) {
    return;
  }

  if (!state.imageLayer) {
    imageStatusLabel.hidden = true;
    return;
  }

  const preview = getPreferredPreview(state.imageLayer);

  imageStatusLabel.hidden = false;
  imageStatusLabel.textContent = `${preview.longest}px`;
}

async function handleImageInputChange(event) {
  const file = event.target.files?.[0];

  if (!file) {
    return;
  }

  const cacheKey = getFileCacheKey(file);
  const wasCached = assetCache.has(cacheKey);

  setImageStatus(wasCached ? "cache" : "preview...");

  try {
    const asset = await measurePerfAsync("image import", () => createImageAsset(file));

    state.imageLayer = createImageLayer(asset);
    scheduleRender();
    updateImageStatus();
  } catch (error) {
    console.error(error);
    setImageStatus("errore");
  } finally {
    event.target.value = "";
  }
}

function resize() {
  const rect = canvas.getBoundingClientRect();
  const dpr = getRenderDpr();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const pixelWidth = Math.max(1, Math.round(width * dpr));
  const pixelHeight = Math.max(1, Math.round(height * dpr));
  const previousMin = state.zoomBounds.min;
  const previousZoom = state.camera.zoom;

  state.size = { dpr, height, width };

  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  updateZoomBounds();

  if (!Number.isFinite(previousZoom) || previousZoom <= 0 || previousMin <= 0) {
    centerCamera();
  } else {
    const zoomRatio = previousZoom / previousMin;
    const nextZoom = clamp(state.zoomBounds.min * zoomRatio, state.zoomBounds.min, state.zoomBounds.max);
    const center = {
      x: width * 0.5,
      y: height * 0.5,
    };
    const docCenter = screenToDocument(center);

    setCamera({
      x: center.x - docCenter.x * nextZoom,
      y: center.y - docCenter.y * nextZoom,
      zoom: nextZoom,
    }, { elastic: false });
    settleCamera();
  }

  scheduleRender();
}

function drawChecker(ctx, x, y, width, height, zoom) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, width, height);
  ctx.restore();
}

function drawImageLayer(ctx, layer) {
  const preview = getPreferredPreview(layer);
  const { x, y, zoom } = state.camera;
  const targetX = x + layer.x * zoom;
  const targetY = y + layer.y * zoom;
  const targetWidth = layer.width * zoom;
  const targetHeight = layer.height * zoom;

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = state.isInteracting ? "medium" : "high";
  ctx.drawImage(preview.bitmap, targetX, targetY, targetWidth, targetHeight);

  if (!state.isInteracting) {
    ctx.strokeStyle = "rgba(16, 17, 15, 0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(targetX + 0.5, targetY + 0.5, targetWidth - 1, targetHeight - 1);
  }

  ctx.restore();
}

function drawDocument(ctx) {
  const { x, y, zoom } = state.camera;
  const width = DOCUMENT.width * zoom;
  const height = DOCUMENT.height * zoom;

  ctx.save();
  ctx.shadowColor = "rgba(15, 23, 42, 0.16)";
  ctx.shadowBlur = 26;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(x, y, width, height);
  ctx.restore();

  drawChecker(ctx, x, y, width, height, zoom);

  if (state.imageLayer) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, width, height);
    ctx.clip();
    drawImageLayer(ctx, state.imageLayer);
    ctx.restore();
  }

  ctx.save();
  ctx.strokeStyle = "rgba(15, 23, 42, 0.16)";
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, width - 1, height - 1);
  ctx.restore();
}

function render() {
  state.raf = 0;

  const { dpr, height, width } = state.size;
  const renderStart = perf.enabled ? performance.now() : 0;

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  const compositeStart = perf.enabled ? performance.now() : 0;
  drawDocument(context);

  if (perf.enabled) {
    const end = performance.now();

    recordPerfMeasure("composite", end - compositeStart);
    recordPerfMeasure("render", end - renderStart);
    ringPush(perf.dirtyPixels, canvas.width * canvas.height);

    if (perf.pendingInputAt) {
      ringPush(perf.inputLatencies, Math.max(0, end - perf.pendingInputAt));
      perf.pendingInputAt = 0;
    }

    updatePerfPanel(end);
  }
}

function scheduleRender() {
  if (state.raf) {
    return;
  }

  state.raf = requestAnimationFrame(render);
}

function updateZoomUi() {
  const zoom = state.camera.zoom;
  const percentage = Math.round((zoom / state.zoomBounds.min) * 100);
  const min = state.zoomBounds.min;
  const max = state.zoomBounds.max;
  const t = max > min
    ? Math.log(zoom / min) / Math.log(max / min)
    : 0;

  if (zoomLabel) {
    zoomLabel.textContent = `${percentage}%`;
  }

  if (zoomRange && document.activeElement !== zoomRange) {
    zoomRange.value = String(Math.round(clamp(t, 0, 1) * 1000));
  }

  updateImageStatus();
}

function bindEvents() {
  canvas.addEventListener("pointerdown", handlePointerDown);
  canvas.addEventListener("pointermove", handlePointerMove);
  canvas.addEventListener("pointerup", finishPointer);
  canvas.addEventListener("pointercancel", finishPointer);
  canvas.addEventListener("wheel", handleWheel, { passive: false });
  window.addEventListener("resize", resize, { passive: true });
  resetButton?.addEventListener("click", centerCamera);
  imageUploadButton?.addEventListener("click", () => imageInput?.click());
  imageInput?.addEventListener("change", handleImageInputChange);
  zoomInButton?.addEventListener("click", () => stepZoom(1));
  zoomOutButton?.addEventListener("click", () => stepZoom(-1));
  zoomRange?.addEventListener("input", () => setZoomByNormalized(zoomRange.value));
}

function init() {
  if (!canvas || !context) {
    throw new Error("Viewport canvas non disponibile.");
  }

  if (documentSizeLabel) {
    documentSizeLabel.textContent = `${DOCUMENT.width} x ${DOCUMENT.height}`;
  }

  bindEvents();
  resize();
  centerCamera();
  updateImageStatus();
  startPerfMonitor();
}

init();
