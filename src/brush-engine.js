(function registerBrushEngine(global) {
  const namespace = global.Mobile2DBrushes || {};

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));

    return canvas;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  class BrushLayer {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.canvas = createCanvas(width, height);
      this.context = this.canvas.getContext("2d", { alpha: true });
      this.memoryBytes = width * height * 4;
    }

    clear() {
      this.context.clearRect(0, 0, this.width, this.height);
    }

    drawTo(context, camera) {
      context.drawImage(
        this.canvas,
        camera.x,
        camera.y,
        this.width * camera.zoom,
        this.height * camera.zoom
      );
    }
  }

  class BrushEngine {
    constructor(options) {
      this.layer = options.layer;
      this.textures = namespace.BrushTextures;
      this.stampCache = new Map();
      this.stroke = null;
      this.setPreset(options.preset);
    }

    setPreset(preset) {
      this.preset = { ...preset };
      this.stampCache.clear();
    }

    begin(point, pressure = 0.5) {
      this.stroke = {
        last: point,
      };
      this.drawStamp(point, pressure);
    }

    move(point, pressure = 0.5) {
      if (!this.stroke) {
        this.begin(point, pressure);
        return;
      }

      const previous = this.stroke.last;
      const distance = Math.hypot(point.x - previous.x, point.y - previous.y);
      const radius = this.getRadius(pressure);
      const spacing = Math.max(1, radius * (this.preset.spacing || 0.16));
      const steps = Math.max(1, Math.floor(distance / spacing));

      for (let index = 1; index <= steps; index += 1) {
        const t = index / steps;

        this.drawStamp({
          x: previous.x + (point.x - previous.x) * t,
          y: previous.y + (point.y - previous.y) * t,
        }, pressure);
      }

      this.stroke.last = point;
    }

    end() {
      this.stroke = null;
    }

    getRadius(pressure) {
      const pressureSize = this.preset.pressureSize || 0;
      const pressureAmount = clamp(pressure || 0.5, 0, 1) - 0.5;

      return Math.max(1, this.preset.radius * (1 + pressureAmount * pressureSize));
    }

    getStamp(radius) {
      const key = Math.round(radius * 2) / 2;
      const cached = this.stampCache.get(key);

      if (cached) {
        return cached;
      }

      const stamp = this.textures.createBrushStamp({
        ...this.preset,
        radius: key,
      });

      this.stampCache.set(key, stamp);
      return stamp;
    }

    getAlpha(pressure) {
      const pressureOpacity = this.preset.pressureOpacity || 0;
      const normalized = clamp(pressure || 0.5, 0, 1);
      const pressureMix = 1 - pressureOpacity + pressureOpacity * normalized;

      return clamp((this.preset.flow || 0.4) * pressureMix, 0.02, 1);
    }

    drawStamp(point, pressure) {
      const radius = this.getRadius(pressure);
      const stamp = this.getStamp(radius);
      const context = this.layer.context;

      context.save();
      context.globalAlpha = this.getAlpha(pressure);
      context.globalCompositeOperation = "source-over";
      context.drawImage(
        stamp.canvas,
        point.x - stamp.size * 0.5,
        point.y - stamp.size * 0.5
      );
      context.restore();
    }
  }

  namespace.BrushLayer = BrushLayer;
  namespace.BrushEngine = BrushEngine;
  global.Mobile2DBrushes = namespace;
})(window);
