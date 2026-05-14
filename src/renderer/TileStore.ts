import type { Camera, RendererDiagnostics, Stamp, TileCoord, Viewport } from "./types";

type RasterLayer = {
  id: number;
  opacity: number;
  tiles: Map<string, HTMLCanvasElement>;
  visible: boolean;
};

type StrokeRecord = {
  active: boolean;
  layerId: number;
  stamps: Stamp[];
};

export class TileStore {
  readonly documentHeight: number;
  readonly documentWidth: number;
  readonly tileSize: number;

  private readonly compositeTiles = new Map<string, HTMLCanvasElement>();
  private readonly dirtyCompositeTiles = new Set<string>();
  private readonly layers = new Map<number, RasterLayer>();
  private readonly layerOrder: number[] = [];
  private readonly stampCache = new Map<number, HTMLCanvasElement>();
  private readonly strokes = new Map<number, StrokeRecord>();

  constructor(documentWidth: number, documentHeight: number, tileSize: number) {
    this.documentWidth = documentWidth;
    this.documentHeight = documentHeight;
    this.tileSize = tileSize;
  }

  addLayer(layerId: number): void {
    if (this.layers.has(layerId)) {
      return;
    }

    this.layers.set(layerId, {
      id: layerId,
      opacity: 1,
      tiles: new Map(),
      visible: true,
    });
    this.layerOrder.push(layerId);
  }

  commitStroke(strokeId: number, layerId: number, stamps: Stamp[]): void {
    if (!strokeId || !stamps.length) {
      return;
    }

    this.strokes.set(strokeId, {
      active: true,
      layerId,
      stamps: stamps.map((stamp) => ({ ...stamp })),
    });
  }

  drawStamps(layerId: number, stamps: Stamp[]): void {
    const layer = this.ensureLayer(layerId);

    for (const stamp of stamps) {
      this.drawStampToLayer(layer, stamp);
    }
  }

  getCompositeTile(tile: TileCoord): HTMLCanvasElement {
    const key = tileKey(tile);

    if (this.dirtyCompositeTiles.has(key) || !this.compositeTiles.has(key)) {
      this.rebuildCompositeTile(tile);
    }

    return this.ensureCompositeTile(tile);
  }

  getDiagnostics(renderScale: number, backend: "webgpu" | "canvas2d", visibleTiles: number): RendererDiagnostics {
    let tileCanvases = 0;

    for (const layer of this.layers.values()) {
      tileCanvases += layer.tiles.size;
    }

    return {
      backend,
      compositeTiles: this.compositeTiles.size,
      layers: this.layers.size,
      renderScale,
      tileCanvases,
      visibleTiles,
    };
  }

  rebuildTiles(tiles: TileCoord[]): void {
    const keys = new Set(tiles.map((tile) => tileKey(tile)));

    for (const layer of this.layers.values()) {
      for (const key of keys) {
        const tile = parseTileKey(key);
        const canvas = this.ensureLayerTile(layer, tile);
        const context = canvas.getContext("2d", { alpha: true });

        context?.clearRect(0, 0, this.tileSize, this.tileSize);
      }
    }

    for (const record of this.strokes.values()) {
      if (!record.active) {
        continue;
      }

      const layer = this.ensureLayer(record.layerId);

      for (const stamp of record.stamps) {
        const affectedTiles = this.getStampTiles(stamp).filter((tile) => keys.has(tileKey(tile)));

        this.drawStampToLayer(layer, stamp, affectedTiles);
      }
    }

    for (const key of keys) {
      this.dirtyCompositeTiles.add(key);
    }
  }

  setStrokeActive(strokeId: number, active: boolean): void {
    const record = this.strokes.get(strokeId);

    if (record) {
      record.active = active;
    }
  }

  visibleTiles(camera: Camera, viewport: Viewport): TileCoord[] {
    const minX = clamp(Math.floor((-camera.x) / camera.zoom / this.tileSize), 0, this.tileColumns() - 1);
    const minY = clamp(Math.floor((-camera.y) / camera.zoom / this.tileSize), 0, this.tileRows() - 1);
    const maxX = clamp(
      Math.floor((viewport.width - camera.x) / camera.zoom / this.tileSize),
      0,
      this.tileColumns() - 1
    );
    const maxY = clamp(
      Math.floor((viewport.height - camera.y) / camera.zoom / this.tileSize),
      0,
      this.tileRows() - 1
    );
    const tiles: TileCoord[] = [];

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        tiles.push({ x, y });
      }
    }

    return tiles;
  }

  private drawStampToLayer(layer: RasterLayer, stamp: Stamp, forcedTiles: TileCoord[] | null = null): void {
    const stampCanvas = this.getStampCanvas(stamp.radius);
    const affectedTiles = forcedTiles ?? this.getStampTiles(stamp);

    for (const tile of affectedTiles) {
      const canvas = this.ensureLayerTile(layer, tile);
      const context = canvas.getContext("2d", { alpha: true });

      if (!context) {
        continue;
      }

      context.globalAlpha = stamp.alpha;
      context.globalCompositeOperation = "source-over";
      context.drawImage(
        stampCanvas,
        stamp.x - tile.x * this.tileSize - stampCanvas.width * 0.5,
        stamp.y - tile.y * this.tileSize - stampCanvas.height * 0.5
      );
      context.globalAlpha = 1;
      this.dirtyCompositeTiles.add(tileKey(tile));
    }
  }

  private ensureCompositeTile(tile: TileCoord): HTMLCanvasElement {
    const key = tileKey(tile);
    const cached = this.compositeTiles.get(key);

    if (cached) {
      return cached;
    }

    const canvas = createTileCanvas(this.tileSize);

    this.compositeTiles.set(key, canvas);
    return canvas;
  }

  private ensureLayer(layerId: number): RasterLayer {
    const layer = this.layers.get(layerId);

    if (layer) {
      return layer;
    }

    this.addLayer(layerId);
    return this.layers.get(layerId)!;
  }

  private ensureLayerTile(layer: RasterLayer, tile: TileCoord): HTMLCanvasElement {
    const key = tileKey(tile);
    const cached = layer.tiles.get(key);

    if (cached) {
      return cached;
    }

    const canvas = createTileCanvas(this.tileSize);

    layer.tiles.set(key, canvas);
    return canvas;
  }

  private getStampCanvas(radius: number): HTMLCanvasElement {
    const key = Math.max(1, Math.round(radius * 2));
    const cached = this.stampCache.get(key);

    if (cached) {
      return cached;
    }

    const padding = Math.max(3, Math.ceil(radius * 0.2));
    const size = Math.ceil(radius * 2 + padding * 2);
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: true });

    canvas.width = size;
    canvas.height = size;

    if (context) {
      const image = context.createImageData(size, size);
      const data = image.data;
      const center = size * 0.5;

      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const dx = x + 0.5 - center;
          const dy = y + 0.5 - center;
          const distance = Math.hypot(dx, dy) / radius;
          const offset = (y * size + x) * 4;

          if (distance > 1) {
            continue;
          }

          const edge = 1 - smoothstep(0.66, 1, distance);
          const noise = hashNoise(x, y, key);
          const grain = noise > 0.58 ? 0.5 + noise * 0.25 : 1;
          const alpha = Math.round(255 * edge * grain);

          data[offset] = 17;
          data[offset + 1] = 24;
          data[offset + 2] = 39;
          data[offset + 3] = alpha;
        }
      }

      context.putImageData(image, 0, 0);
    }

    this.stampCache.set(key, canvas);
    return canvas;
  }

  private getStampTiles(stamp: Stamp): TileCoord[] {
    const minX = clamp(Math.floor((stamp.x - stamp.radius) / this.tileSize), 0, this.tileColumns() - 1);
    const minY = clamp(Math.floor((stamp.y - stamp.radius) / this.tileSize), 0, this.tileRows() - 1);
    const maxX = clamp(Math.floor((stamp.x + stamp.radius) / this.tileSize), 0, this.tileColumns() - 1);
    const maxY = clamp(Math.floor((stamp.y + stamp.radius) / this.tileSize), 0, this.tileRows() - 1);
    const tiles: TileCoord[] = [];

    for (let y = minY; y <= maxY; y += 1) {
      for (let x = minX; x <= maxX; x += 1) {
        tiles.push({ x, y });
      }
    }

    return tiles;
  }

  private rebuildCompositeTile(tile: TileCoord): void {
    const canvas = this.ensureCompositeTile(tile);
    const context = canvas.getContext("2d", { alpha: true });

    if (!context) {
      return;
    }

    context.clearRect(0, 0, this.tileSize, this.tileSize);

    for (const layerId of this.layerOrder) {
      const layer = this.layers.get(layerId);

      if (!layer?.visible) {
        continue;
      }

      const source = layer.tiles.get(tileKey(tile));

      if (!source) {
        continue;
      }

      context.globalAlpha = layer.opacity;
      context.globalCompositeOperation = "source-over";
      context.drawImage(source, 0, 0);
    }

    context.globalAlpha = 1;
    this.dirtyCompositeTiles.delete(tileKey(tile));
  }

  private tileColumns(): number {
    return Math.ceil(this.documentWidth / this.tileSize);
  }

  private tileRows(): number {
    return Math.ceil(this.documentHeight / this.tileSize);
  }
}

export function tileKey(tile: TileCoord): string {
  return `${tile.x}:${tile.y}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function createTileCanvas(tileSize: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");

  canvas.width = tileSize;
  canvas.height = tileSize;
  return canvas;
}

function hashNoise(x: number, y: number, seed: number): number {
  let value = Math.imul(x + seed * 374761393, 668265263) ^ Math.imul(y + seed * 1442695041, 2246822519);

  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function parseTileKey(key: string): TileCoord {
  const [x, y] = key.split(":").map(Number);

  return { x, y };
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const amount = clamp((value - edge0) / (edge1 - edge0 || 1), 0, 1);

  return amount * amount * (3 - 2 * amount);
}
