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

  function intersectRects(first, second) {
    const minX = Math.max(first.minX, second.minX);
    const minY = Math.max(first.minY, second.minY);
    const maxX = Math.min(first.maxX, second.maxX);
    const maxY = Math.min(first.maxY, second.maxY);

    return { maxX, maxY, minX, minY };
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

    getViewportBounds(camera, viewport = null) {
      if (!viewport) {
        return {
          maxX: this.width,
          maxY: this.height,
          minX: 0,
          minY: 0,
        };
      }

      const viewportWidth = viewport.width || this.width;
      const viewportHeight = viewport.height || this.height;

      return {
        maxX: clamp(Math.ceil((viewportWidth - camera.x) / camera.zoom), 0, this.width),
        maxY: clamp(Math.ceil((viewportHeight - camera.y) / camera.zoom), 0, this.height),
        minX: clamp(Math.floor(-camera.x / camera.zoom), 0, this.width),
        minY: clamp(Math.floor(-camera.y / camera.zoom), 0, this.height),
      };
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

    drawTiles(context, camera, bounds) {
      const startTileX = Math.floor(bounds.minX / this.tileSize);
      const startTileY = Math.floor(bounds.minY / this.tileSize);
      const endTileX = Math.floor((bounds.maxX - 1) / this.tileSize);
      const endTileY = Math.floor((bounds.maxY - 1) / this.tileSize);

      for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
        for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
          const tileIndex = tileY * this.tilesX + tileX;

          if (!this.contentTiles.has(tileIndex)) {
            continue;
          }

          const sourceX = Math.max(tileX * this.tileSize, bounds.minX);
          const sourceY = Math.max(tileY * this.tileSize, bounds.minY);
          const tileMaxX = Math.min((tileX + 1) * this.tileSize, this.width, bounds.maxX);
          const tileMaxY = Math.min((tileY + 1) * this.tileSize, this.height, bounds.maxY);
          const sourceWidth = tileMaxX - sourceX;
          const sourceHeight = tileMaxY - sourceY;

          this.drawSourceRect(context, camera, sourceX, sourceY, sourceWidth, sourceHeight);
        }
      }
    }

    countVisibleTiles(bounds) {
      const startTileX = Math.floor(bounds.minX / this.tileSize);
      const startTileY = Math.floor(bounds.minY / this.tileSize);
      const endTileX = Math.floor((bounds.maxX - 1) / this.tileSize);
      const endTileY = Math.floor((bounds.maxY - 1) / this.tileSize);
      let count = 0;

      for (let tileY = startTileY; tileY <= endTileY; tileY += 1) {
        for (let tileX = startTileX; tileX <= endTileX; tileX += 1) {
          if (this.contentTiles.has(tileY * this.tilesX + tileX)) {
            count += 1;
          }
        }
      }

      return count;
    }

    drawTo(context, camera, viewport = null) {
      if (this.isEmpty || !hasBounds(this.contentBounds)) {
        return;
      }

      const visibleBounds = intersectRects(this.contentBounds, this.getViewportBounds(camera, viewport));

      if (!hasBounds(visibleBounds)) {
        return;
      }

      const sourceX = visibleBounds.minX;
      const sourceY = visibleBounds.minY;
      const sourceWidth = visibleBounds.maxX - visibleBounds.minX;
      const sourceHeight = visibleBounds.maxY - visibleBounds.minY;
      const boundsArea = sourceWidth * sourceHeight;
      const visibleTileCount = this.countVisibleTiles(visibleBounds);
      const tileArea = visibleTileCount * this.tileSize * this.tileSize;

      if (visibleTileCount > 1 && tileArea < boundsArea * 0.82) {
        this.drawTiles(context, camera, visibleBounds);
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
        distanceSinceStamp: 0,
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

      if (distance <= 0) {
        return;
      }

      const spacing = this.getSpacing(pressure);
      const maxSteps = this.preset.maxStampsPerMove || 48;
      const distanceSinceStamp = Math.min(
        Math.max(this.stroke.distanceSinceStamp || 0, 0),
        spacing
      );
      const firstStampDistance = Math.max(0, spacing - distanceSinceStamp);
      const stampCount = firstStampDistance <= distance
        ? Math.floor((distance - firstStampDistance) / spacing) + 1
        : 0;

      if (stampCount > maxSteps) {
        this.drawEvenlySpacedStamps(previous, point, maxSteps, pressure);
        this.stroke.distanceSinceStamp = 0;
        this.stroke.last = point;
        return;
      }

      let lastStampDistance = -distanceSinceStamp;
      let nextStampDistance = firstStampDistance;

      for (let index = 0; index < stampCount; index += 1) {
        this.drawStampAtDistance(previous, point, nextStampDistance / distance, pressure);
        lastStampDistance = nextStampDistance;
        nextStampDistance += spacing;
      }

      this.stroke.distanceSinceStamp = distance - lastStampDistance;
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

    getSpacing(pressure) {
      const radius = this.getRadius(pressure);

      return Math.max(this.preset.minSpacing || 2, radius * (this.preset.spacing || 0.16));
    }

    drawStampAtDistance(from, to, amount, pressure) {
      this.drawStamp({
        x: from.x + (to.x - from.x) * amount,
        y: from.y + (to.y - from.y) * amount,
      }, pressure);
    }

    drawEvenlySpacedStamps(from, to, count, pressure) {
      for (let index = 1; index <= count; index += 1) {
        this.drawStampAtDistance(from, to, index / count, pressure);
      }
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
