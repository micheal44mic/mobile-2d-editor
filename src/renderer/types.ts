export type Camera = {
  x: number;
  y: number;
  zoom: number;
};

export type RendererDiagnostics = {
  backend: "webgpu" | "canvas2d";
  compositeTiles: number;
  layers: number;
  renderScale: number;
  tileCanvases: number;
  visibleTiles: number;
};

export type Stamp = {
  alpha: number;
  radius: number;
  x: number;
  y: number;
};

export type TileCoord = {
  x: number;
  y: number;
};

export type Viewport = {
  height: number;
  width: number;
};

export interface PaintRenderer {
  readonly backend: "webgpu" | "canvas2d";
  addLayer(layerId: number): void;
  commitStroke(strokeId: number, layerId: number, stamps: Stamp[]): void;
  destroy(): void;
  drawStamps(layerId: number, stamps: Stamp[]): void;
  getDiagnostics(): RendererDiagnostics;
  rebuildTiles(tiles: TileCoord[]): void;
  render(camera: Camera): void;
  resize(): void;
  setStrokeActive(strokeId: number, active: boolean): void;
}
