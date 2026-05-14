import { TileStore } from "./TileStore";
import type { Camera, PaintRenderer, RendererDiagnostics, Stamp, TileCoord, Viewport } from "./types";

export class CanvasTileRenderer implements PaintRenderer {
  readonly backend = "canvas2d" as const;

  protected readonly canvas: HTMLCanvasElement;
  protected readonly store: TileStore;
  protected context: CanvasRenderingContext2D;
  protected pixelRatio = 1;
  protected renderScale = 1;
  protected viewport: Viewport = { height: 1, width: 1 };
  protected visibleTileCount = 0;

  constructor(canvas: HTMLCanvasElement, store: TileStore) {
    const context = canvas.getContext("2d", { alpha: false });

    if (!context) {
      throw new Error("Canvas 2D non disponibile.");
    }

    this.canvas = canvas;
    this.context = context;
    this.store = store;
    this.resize();
  }

  addLayer(layerId: number): void {
    this.store.addLayer(layerId);
  }

  commitStroke(strokeId: number, layerId: number, stamps: Stamp[]): void {
    this.store.commitStroke(strokeId, layerId, stamps);
  }

  destroy(): void {}

  drawStamps(layerId: number, stamps: Stamp[]): void {
    this.store.drawStamps(layerId, stamps);
  }

  getDiagnostics(): RendererDiagnostics {
    return this.store.getDiagnostics(this.renderScale, this.backend, this.visibleTileCount);
  }

  rebuildTiles(tiles: TileCoord[]): void {
    this.store.rebuildTiles(tiles);
  }

  render(camera: Camera): void {
    const ctx = this.context;
    const visibleTiles = this.store.visiblePaintTiles(camera, this.viewport);

    this.visibleTileCount = visibleTiles.length;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.fillStyle = "#f8fafc";
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);

    this.drawDocumentBackground(ctx, camera);

    ctx.save();
    ctx.beginPath();
    ctx.rect(
      camera.x,
      camera.y,
      this.store.documentWidth * camera.zoom,
      this.store.documentHeight * camera.zoom
    );
    ctx.clip();

    for (const tile of visibleTiles) {
      const tileCanvas = this.store.getCompositeTile(tile);
      const x = camera.x + tile.x * this.store.tileSize * camera.zoom;
      const y = camera.y + tile.y * this.store.tileSize * camera.zoom;
      const size = this.store.tileSize * camera.zoom;

      ctx.drawImage(tileCanvas, x, y, size, size);
    }

    ctx.restore();
    this.drawDocumentBorder(ctx, camera);
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const baseDpr = isMobileLike() ? 1 : Math.min(1.5, Math.max(1, window.devicePixelRatio || 1));

    this.renderScale = isMobileLike() ? 0.82 : 1;
    this.pixelRatio = Math.max(0.5, baseDpr * this.renderScale);
    this.viewport = {
      height: Math.max(1, Math.round(rect.height)),
      width: Math.max(1, Math.round(rect.width)),
    };
    this.canvas.width = Math.max(1, Math.round(this.viewport.width * this.pixelRatio));
    this.canvas.height = Math.max(1, Math.round(this.viewport.height * this.pixelRatio));
  }

  setStrokeActive(strokeId: number, active: boolean): void {
    this.store.setStrokeActive(strokeId, active);
  }

  protected drawDocumentBackground(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const width = this.store.documentWidth * camera.zoom;
    const height = this.store.documentHeight * camera.zoom;

    ctx.save();
    ctx.shadowColor = "rgba(15, 23, 42, 0.16)";
    ctx.shadowBlur = 24;
    ctx.shadowOffsetY = 12;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(camera.x, camera.y, width, height);
    ctx.restore();
  }

  protected drawDocumentBorder(ctx: CanvasRenderingContext2D, camera: Camera): void {
    ctx.save();
    ctx.strokeStyle = "rgba(15, 23, 42, 0.18)";
    ctx.lineWidth = 1;
    ctx.strokeRect(
      camera.x + 0.5,
      camera.y + 0.5,
      this.store.documentWidth * camera.zoom - 1,
      this.store.documentHeight * camera.zoom - 1
    );
    ctx.restore();
  }
}

function isMobileLike(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)")?.matches === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}
