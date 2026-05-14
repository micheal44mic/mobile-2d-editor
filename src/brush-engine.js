(function registerBrushEngine(global) {
  const namespace = global.Mobile2DBrushes || {};
  const TILE_SIZE = 256;

  function createCanvas(width, height) {
    const canvas = document.createElement("canvas");

    canvas.width = Math.max(1, Math.ceil(width));
    canvas.height = Math.max(1, Math.ceil(height));

    return canvas;
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function createEmptyBounds() {
    return {
      maxX: -Infinity,
      maxY: -Infinity,
      minX: Infinity,
      minY: Infinity,
    };
  }

  function hasBounds(bounds) {
    return bounds.minX <= bounds.maxX && bounds.minY <= bounds.maxY;
  }

  class BrushLayer {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.canvas = createCanvas(width, height);
      this.context = this.canvas.getContext("2d", { alpha: true });
      this.memoryBytes = width * height * 4;
      this.tileSize = TILE_SIZE;
      this.tilesX = Math.ceil(this.width / this.tileSize);
      this.contentTiles = new Set();
      this.contentBounds = createEmptyBounds();
      this.isEmpty = true;
    }

    clear() {
      this.context.clearRect(0, 0, this.width, this.height);
      this.contentTiles.clear();
      this.contentBounds = createEmptyBounds();
      this.isEmpty = true;
    }

    markDirty(x, y, width, height) {
      const minX = clamp(Math.floor(x), 0, this.width);
      const minY = clamp(Math.floor(y), 0, this.height);
      const maxX = clamp(Math.ceil(x + width), 0, this.width);
      const maxY = clamp(Math.ceil(y + height), 0, this.height);

      if (minX >= maxX || minY >= maxY) {
        return;
      }

      this.contentBounds.minX = Math.min(this.contentBounds.minX, minX);
      this.contentBounds.minY = Math.min(this.contentBounds.minY, minY);
      this.contentBounds.maxX = Math.max(this.contentBounds.maxX, maxX);
      this.contentBounds.maxY = Math.max(this.contentBounds.maxY, maxY);
      this.isEmpty = false;

      const startTileX = Math.floor(minX / this.tileSize);
      const startTileY = Math.floor(minY / this.tileSize);
      const endTileX = Math.floor((maxX - 1) / this.tileSize);
      const endTileY = Math.floor((maxY - 1) / this.tileSize);

      for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
        for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
          this.contentTiles.add(tileY * this.tilesX + tileX);
        }
      }
    }

    drawSourceRect(context, camera, sourceX, sourceY, sourceWidth, sourceHeight) {
      if (sourceWidth <= 0 || sourceHeight <= 0) {
        return;
      }

      context.drawImage(
        this.canvas,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        camera.x + sourceX * camera.zoom,
        camera.y + sourceY * camera.zoom,
        sourceWidth * camera.zoom,
        sourceHeight * camera.zoom
      );
    }

    drawTiles(context, camera) {
      for (const tileIndex of this.contentTiles) {
        const tileY = Math.floor(tileIndex / this.tilesX);
        const tileX = tileIndex - tileY * this.tilesX;
        const sourceX = tileX * this.tileSize;
        const sourceY = tileY * this.tileSize;
        const sourceWidth = Math.min(this.tileSize, this.width - sourceX);
        const sourceHeight = Math.min(this.tileSize, this.height - sourceY);

        this.drawSourceRect(context, camera, sourceX, sourceY, sourceWidth, sourceHeight);
      }
    }

    drawTo(context, camera) {
      if (this.isEmpty || !hasBounds(this.contentBounds)) {
        return;
      }

      const sourceX = this.contentBounds.minX;
      const sourceY = this.contentBounds.minY;
      const sourceWidth = this.contentBounds.maxX - this.contentBounds.minX;
      const sourceHeight = this.contentBounds.maxY - this.contentBounds.minY;
      const boundsArea = sourceWidth * sourceHeight;
      const tileArea = this.contentTiles.size * this.tileSize * this.tileSize;

      if (this.contentTiles.size > 1 && tileArea < boundsArea * 0.82) {
        this.drawTiles(context, camera);
        return;
      }

      this.drawSourceRect(context, camera, sourceX, sourceY, sourceWidth, sourceHeight);
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

    getDiameter() {
      return Math.round(this.preset.radius * 2);
    }

    setDiameter(diameter) {
      this.preset.radius = Math.max(0.5, diameter * 0.5);
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
      const spacing = Math.max(this.preset.minSpacing || 2, radius * (this.preset.spacing || 0.16));
      const maxSteps = this.preset.maxStampsPerMove || 48;
      const steps = Math.min(maxSteps, Math.max(1, Math.floor(distance / spacing)));

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

      context.globalAlpha = this.getAlpha(pressure);
      context.globalCompositeOperation = "source-over";
      context.drawImage(
        stamp.canvas,
        point.x - stamp.size * 0.5,
        point.y - stamp.size * 0.5
      );
      context.globalAlpha = 1;
      this.layer.markDirty(
        point.x - stamp.size * 0.5,
        point.y - stamp.size * 0.5,
        stamp.size,
        stamp.size
      );
    }
  }

  namespace.BrushLayer = BrushLayer;
  namespace.BrushEngine = BrushEngine;
  global.Mobile2DBrushes = namespace;
})(window);
