(function registerBrushTextures(global) {
  const namespace = global.Mobile2DBrushes || {};
  const TAU = Math.PI * 2;

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));

    return canvas;
  }

  function hashNoise(x, y, seed) {
    let value = Math.imul(x + seed * 374761393, 668265263) ^ Math.imul(y + seed * 1442695041, 2246822519);

    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function parseHexColor(hex) {
    const value = hex.replace("#", "");
    const full = value.length === 3
      ? value.split("").map((part) => part + part).join("")
      : value;

    return {
      b: parseInt(full.slice(4, 6), 16),
      g: parseInt(full.slice(2, 4), 16),
      r: parseInt(full.slice(0, 2), 16),
    };
  }

  function smoothstep(edge0, edge1, value) {
    const amount = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0 || 1)));

    return amount * amount * (3 - 2 * amount);
  }

  function createBrushStamp(settings) {
    const radius = Math.max(1, settings.radius || 8);
    const padding = Math.max(3, Math.ceil(radius * 0.18));
    const size = Math.ceil(radius * 2 + padding * 2);
    const center = size * 0.5;
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d", { alpha: true });
    const image = context.createImageData(size, size);
    const data = image.data;
    const color = parseHexColor(settings.color || "#111827");
    const hardness = Math.min(0.98, Math.max(0.05, settings.hardness ?? 0.68));
    const grain = Math.min(1, Math.max(0, settings.grain ?? 0.6));
    const density = Math.min(0.98, Math.max(0.02, settings.grainDensity ?? 0.55));
    const roundness = Math.min(1, Math.max(0.12, settings.roundness ?? 1));
    const angle = settings.angle || 0;
    const seed = settings.grainSeed || 1;
    const sin = Math.sin(angle);
    const cos = Math.cos(angle);

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const dx = x + 0.5 - center;
        const dy = y + 0.5 - center;
        const rx = dx * cos - dy * sin;
        const ry = (dx * sin + dy * cos) / roundness;
        const distance = Math.hypot(rx, ry) / radius;
        const offset = (y * size + x) * 4;

        if (distance > 1) {
          continue;
        }

        const edge = 1 - smoothstep(hardness, 1, distance);
        const noise = hashNoise(x, y, seed);
        const paperBreak = noise > density ? 0.38 + noise * 0.22 : 1;
        const grainAlpha = 1 - grain + grain * paperBreak;
        const alpha = Math.round(255 * edge * grainAlpha);

        data[offset] = color.r;
        data[offset + 1] = color.g;
        data[offset + 2] = color.b;
        data[offset + 3] = alpha;
      }
    }

    context.putImageData(image, 0, 0);

    return {
      canvas,
      radius,
      size,
    };
  }

  function createGrainPreview(size = 96, seed = 1) {
    const canvas = createCanvas(size, size);
    const context = canvas.getContext("2d", { alpha: false });
    const image = context.createImageData(size, size);
    const data = image.data;

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const value = Math.round(hashNoise(x, y, seed) * 255);
        const offset = (y * size + x) * 4;

        data[offset] = value;
        data[offset + 1] = value;
        data[offset + 2] = value;
        data[offset + 3] = 255;
      }
    }

    context.putImageData(image, 0, 0);
    return canvas;
  }

  namespace.BrushTextures = {
    createBrushStamp,
    createGrainPreview,
    hashNoise,
    TAU,
  };
  global.Mobile2DBrushes = namespace;
})(window);
