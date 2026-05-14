import { CanvasTileRenderer } from "./CanvasTileRenderer";
import { TileStore } from "./TileStore";
import { WebGPUTileRenderer } from "./WebGPUTileRenderer";
import type { PaintRenderer } from "./types";

export async function createRenderer(
  canvas: HTMLCanvasElement,
  documentWidth: number,
  documentHeight: number,
  tileSize: number
): Promise<PaintRenderer> {
  const store = new TileStore(documentWidth, documentHeight, tileSize);

  try {
    return await WebGPUTileRenderer.create(canvas, store);
  } catch (error) {
    console.warn("WebGPU non disponibile, uso Canvas 2D tile renderer.", error);
    return new CanvasTileRenderer(canvas, store);
  }
}
