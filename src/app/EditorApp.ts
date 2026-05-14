import init, { PaintCore } from "../generated/paint-core/paint_core";
import { createRenderer } from "../renderer/createRenderer";
import { decodeHistoryTiles, decodeStamps } from "../renderer/stamps";
import type { Camera, PaintRenderer, Stamp } from "../renderer/types";

const DOCUMENT_SIZE = 4096;
const TILE_SIZE = 256;
const VIEW_MARGIN = 50;
const MIN_BRUSH_SIZE = 1;
const MAX_BRUSH_SIZE = 256;

type PointerPoint = {
  id: number;
  x: number;
  y: number;
};

type PendingStroke = {
  layerId: number;
  stamps: Stamp[];
};

type Gesture =
  | { lastX: number; lastY: number; type: "pan" }
  | {
      center: PointerPoint;
      distance: number;
      documentPoint: { x: number; y: number };
      startCamera: Camera;
      type: "pinch";
    }
  | { pointerId: number; type: "brush" }
  | null;

export class EditorApp {
  private readonly brushButton: HTMLButtonElement;
  private readonly brushSizeLabel: HTMLElement;
  private readonly brushSizeRange: HTMLInputElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly documentSizeLabel: HTMLElement;
  private readonly layerCountLabel: HTMLElement;
  private readonly perfPanel: HTMLElement;
  private readonly rendererLabel: HTMLElement;
  private readonly zoomLabel: HTMLElement;

  private brushSize = 72;
  private camera: Camera = { x: 0, y: 0, zoom: 1 };
  private core!: PaintCore;
  private gesture: Gesture = null;
  private isInteracting = false;
  private pendingStroke: PendingStroke | null = null;
  private pointers = new Map<number, PointerPoint>();
  private raf = 0;
  private renderer!: PaintRenderer;
  private tool: "brush" | "pan" = "brush";
  private viewport = { height: 1, width: 1 };
  private zoomBounds = { max: 1, min: 1 };

  private frames = 0;
  private lastFpsAt = performance.now();
  private lastRenderDuration = 0;

  constructor(root: HTMLElement) {
    root.innerHTML = this.template();
    this.canvas = this.required("[data-editor-viewport]", HTMLCanvasElement);
    this.brushButton = this.required("[data-brush-toggle]", HTMLButtonElement);
    this.brushSizeLabel = this.required("[data-brush-size-label]", HTMLElement);
    this.brushSizeRange = this.required("[data-brush-size-range]", HTMLInputElement);
    this.documentSizeLabel = this.required("[data-document-size]", HTMLElement);
    this.layerCountLabel = this.required("[data-layer-count]", HTMLElement);
    this.perfPanel = this.required("[data-perf-panel]", HTMLElement);
    this.rendererLabel = this.required("[data-renderer-label]", HTMLElement);
    this.zoomLabel = this.required("[data-zoom-label]", HTMLElement);
  }

  async start(): Promise<void> {
    await init();
    this.core = new PaintCore(DOCUMENT_SIZE, DOCUMENT_SIZE, TILE_SIZE);
    this.renderer = await createRenderer(this.canvas, this.core.documentWidth(), this.core.documentHeight(), this.core.tileSize());
    this.renderer.addLayer(this.core.activeLayerId());
    this.bindEvents();
    this.syncBrush();
    this.resize();
    this.centerCamera();
    this.updateUi();
    this.scheduleRender();
  }

  private addLayer(): void {
    const layerId = this.core.addLayer();

    this.renderer.addLayer(layerId);
    this.updateUi();
    this.scheduleRender();
  }

  private beginBrushStroke(event: PointerEvent, point: PointerPoint): void {
    const documentPoint = this.screenToDocument(point);
    const stamps = decodeStamps(this.core.beginStroke(documentPoint.x, documentPoint.y, getBrushPressure(event)));

    this.pendingStroke = {
      layerId: this.core.activeLayerId(),
      stamps: [...stamps],
    };
    this.gesture = {
      pointerId: event.pointerId,
      type: "brush",
    };
    this.renderer.drawStamps(this.pendingStroke.layerId, stamps);
    this.scheduleRender();
  }

  private beginPan(point: PointerPoint): void {
    this.gesture = {
      lastX: point.x,
      lastY: point.y,
      type: "pan",
    };
  }

  private beginPinch(): void {
    const [first, second] = this.activePointers();

    if (!first || !second) {
      return;
    }

    const center = {
      id: 0,
      x: (first.x + second.x) * 0.5,
      y: (first.y + second.y) * 0.5,
    };

    this.gesture = {
      center,
      distance: Math.max(1, distance(first, second)),
      documentPoint: this.screenToDocument(center),
      startCamera: { ...this.camera },
      type: "pinch",
    };
  }

  private bindEvents(): void {
    this.canvas.addEventListener("pointerdown", (event) => this.handlePointerDown(event));
    this.canvas.addEventListener("pointermove", (event) => this.handlePointerMove(event));
    this.canvas.addEventListener("pointerup", (event) => this.finishPointer(event));
    this.canvas.addEventListener("pointercancel", (event) => this.finishPointer(event));
    this.canvas.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    window.addEventListener("resize", () => this.resize(), { passive: true });
    this.required("[data-reset-view]", HTMLButtonElement).addEventListener("click", () => this.centerCamera());
    this.required("[data-undo]", HTMLButtonElement).addEventListener("click", () => this.undo());
    this.required("[data-redo]", HTMLButtonElement).addEventListener("click", () => this.redo());
    this.required("[data-add-layer]", HTMLButtonElement).addEventListener("click", () => this.addLayer());
    this.brushButton.addEventListener("click", () => this.toggleBrushTool());
    this.required("[data-brush-size-down]", HTMLButtonElement).addEventListener("click", () => this.setBrushSize(this.brushSize - 1));
    this.required("[data-brush-size-up]", HTMLButtonElement).addEventListener("click", () => this.setBrushSize(this.brushSize + 1));
    this.brushSizeRange.addEventListener("input", () => this.setBrushSize(Number(this.brushSizeRange.value)));
  }

  private centerCamera(): void {
    this.updateZoomBounds();
    this.camera.zoom = this.zoomBounds.min;
    this.camera.x = (this.viewport.width - this.core.documentWidth() * this.camera.zoom) * 0.5;
    this.camera.y = (this.viewport.height - this.core.documentHeight() * this.camera.zoom) * 0.5;
    this.scheduleRender();
    this.updateUi();
  }

  private commitPendingStroke(): void {
    if (!this.pendingStroke) {
      return;
    }

    const strokeId = this.core.endStroke();

    this.renderer.commitStroke(strokeId, this.pendingStroke.layerId, this.pendingStroke.stamps);
    this.pendingStroke = null;
  }

  private finishPointer(event: PointerEvent): void {
    const wasBrushStroke = this.gesture?.type === "brush" && this.gesture.pointerId === event.pointerId;

    this.pointers.delete(event.pointerId);
    this.canvas.releasePointerCapture?.(event.pointerId);

    if (wasBrushStroke) {
      this.commitPendingStroke();
    }

    if (this.pointers.size >= 2) {
      this.beginPinch();
      return;
    }

    if (this.pointers.size === 1) {
      this.beginPan(this.activePointers()[0]);
      return;
    }

    this.gesture = null;
    this.isInteracting = false;
    this.canvas.classList.remove("is-dragging");
    this.scheduleRender();
  }

  private handlePointerDown(event: PointerEvent): void {
    event.preventDefault();
    this.canvas.setPointerCapture?.(event.pointerId);
    this.isInteracting = true;
    this.canvas.classList.add("is-dragging");

    const point = this.pointerPoint(event);

    this.pointers.set(event.pointerId, point);

    if (this.gesture?.type === "brush" && this.pointers.size >= 2) {
      this.commitPendingStroke();
      this.beginPinch();
      return;
    }

    if (this.pointers.size >= 2) {
      this.beginPinch();
      return;
    }

    if (this.tool === "brush") {
      this.beginBrushStroke(event, point);
    } else {
      this.beginPan(point);
    }
  }

  private handlePointerMove(event: PointerEvent): void {
    if (!this.pointers.has(event.pointerId)) {
      return;
    }

    event.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const point = this.pointerPoint(event, rect);

    this.pointers.set(event.pointerId, point);

    if (this.gesture?.type === "brush") {
      if (this.pointers.size >= 2) {
        this.commitPendingStroke();
        this.beginPinch();
        return;
      }

      for (const moveEvent of coalescedEvents(event)) {
        this.moveBrushStroke(moveEvent, this.pointerPoint(moveEvent, rect));
      }
      return;
    }

    if (this.pointers.size >= 2) {
      if (this.gesture?.type !== "pinch") {
        this.beginPinch();
      }

      const [first, second] = this.activePointers();
      const activeGesture = this.gesture;

      if (activeGesture?.type !== "pinch") {
        return;
      }

      const center = {
        id: 0,
        x: (first.x + second.x) * 0.5,
        y: (first.y + second.y) * 0.5,
      };
      const nextZoom = activeGesture.startCamera.zoom * (distance(first, second) / activeGesture.distance);

      this.zoomAt(center, nextZoom, activeGesture.documentPoint);
      return;
    }

    if (this.gesture?.type !== "pan") {
      this.beginPan(point);
      return;
    }

    const dx = point.x - this.gesture.lastX;
    const dy = point.y - this.gesture.lastY;

    this.gesture.lastX = point.x;
    this.gesture.lastY = point.y;
    this.camera.x += dx;
    this.camera.y += dy;
    this.scheduleRender();
  }

  private handleWheel(event: WheelEvent): void {
    event.preventDefault();

    const rect = this.canvas.getBoundingClientRect();
    const point = {
      id: 0,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
    const factor = Math.exp(-clamp(event.deltaY, -70, 70) * 0.00145);

    this.zoomAt(point, this.camera.zoom * factor, this.screenToDocument(point));
  }

  private moveBrushStroke(event: PointerEvent, point: PointerPoint): void {
    if (!this.pendingStroke) {
      return;
    }

    const documentPoint = this.screenToDocument(point);
    const stamps = decodeStamps(this.core.extendStroke(documentPoint.x, documentPoint.y, getBrushPressure(event)));

    if (!stamps.length) {
      return;
    }

    this.pendingStroke.stamps.push(...stamps);
    this.renderer.drawStamps(this.pendingStroke.layerId, stamps);
    this.scheduleRender();
  }

  private pointerPoint(event: PointerEvent, rect = this.canvas.getBoundingClientRect()): PointerPoint {
    return {
      id: event.pointerId,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  private redo(): void {
    const { strokeId, tiles } = decodeHistoryTiles(this.core.redoTiles());

    if (!strokeId) {
      return;
    }

    this.renderer.setStrokeActive(strokeId, true);
    this.renderer.rebuildTiles(tiles);
    this.scheduleRender();
  }

  private render(): void {
    const start = performance.now();

    this.raf = 0;
    this.renderer.render(this.camera);
    this.lastRenderDuration = performance.now() - start;
    this.frames += 1;

    const now = performance.now();

    if (now - this.lastFpsAt > 350) {
      this.updateUi();
      this.frames = 0;
      this.lastFpsAt = now;
    }
  }

  private required<T extends Element>(selector: string, constructor: new (...args: never[]) => T): T {
    const element = document.querySelector(selector);

    if (!(element instanceof constructor)) {
      throw new Error(`Elemento mancante: ${selector}`);
    }

    return element;
  }

  private resize(): void {
    const rect = this.canvas.getBoundingClientRect();

    this.viewport = {
      height: Math.max(1, Math.round(rect.height)),
      width: Math.max(1, Math.round(rect.width)),
    };
    this.renderer.resize();
    this.updateZoomBounds();

    if (!Number.isFinite(this.camera.zoom) || this.camera.zoom <= 0) {
      this.centerCamera();
    }

    this.scheduleRender();
  }

  private scheduleRender(): void {
    if (this.raf) {
      return;
    }

    this.raf = requestAnimationFrame(() => this.render());
  }

  private screenToDocument(point: PointerPoint): { x: number; y: number } {
    return {
      x: (point.x - this.camera.x) / this.camera.zoom,
      y: (point.y - this.camera.y) / this.camera.zoom,
    };
  }

  private setBrushSize(size: number): void {
    this.brushSize = clamp(Math.round(size || this.brushSize), MIN_BRUSH_SIZE, MAX_BRUSH_SIZE);
    this.syncBrush();
    this.updateUi();
  }

  private syncBrush(): void {
    this.core.setBrush(this.brushSize, 2.4, 0.16, 0.42);
  }

  private template(): string {
    return `
      <main class="app-shell">
        <section class="editor-stage" aria-label="Editor 2D">
          <canvas class="editor-viewport" data-editor-viewport aria-label="Viewport documento"></canvas>

          <div class="top-strip" aria-label="Stato documento">
            <span class="status-pill" data-document-size>4096 x 4096</span>
            <span class="status-pill" data-renderer-label>renderer</span>
            <span class="status-pill" data-layer-count>1 layer</span>
            <span class="status-pill" data-zoom-label>100%</span>
            <button class="icon-button is-active" type="button" data-brush-toggle aria-label="Pennello" aria-pressed="true"><span aria-hidden="true">P</span></button>
            <button class="icon-button" type="button" data-add-layer aria-label="Aggiungi layer"><span aria-hidden="true">+</span></button>
            <button class="icon-button" type="button" data-undo aria-label="Undo"><span aria-hidden="true">↶</span></button>
            <button class="icon-button" type="button" data-redo aria-label="Redo"><span aria-hidden="true">↷</span></button>
            <button class="icon-button" type="button" data-reset-view aria-label="Centra documento"><span aria-hidden="true">H</span></button>
          </div>

          <div class="bottom-strip" aria-label="Grandezza pennello">
            <button class="tool-button" type="button" data-brush-size-down aria-label="Riduci pennello">-</button>
            <input class="control-range" data-brush-size-range type="range" min="1" max="256" value="72" aria-label="Grandezza pennello in pixel">
            <span class="status-pill brush-size-label" data-brush-size-label>72 px</span>
            <button class="tool-button" type="button" data-brush-size-up aria-label="Aumenta pennello">+</button>
          </div>

          <aside class="perf-panel" data-perf-panel aria-label="Profiler prestazioni"></aside>
        </section>
      </main>
    `;
  }

  private toggleBrushTool(): void {
    this.tool = this.tool === "brush" ? "pan" : "brush";
    this.brushButton.classList.toggle("is-active", this.tool === "brush");
    this.brushButton.setAttribute("aria-pressed", String(this.tool === "brush"));
  }

  private undo(): void {
    const { strokeId, tiles } = decodeHistoryTiles(this.core.undoTiles());

    if (!strokeId) {
      return;
    }

    this.renderer.setStrokeActive(strokeId, false);
    this.renderer.rebuildTiles(tiles);
    this.scheduleRender();
  }

  private updateUi(): void {
    const diagnostics = this.renderer.getDiagnostics();
    const fps = Math.round((this.frames * 1000) / Math.max(1, performance.now() - this.lastFpsAt));

    this.brushSizeLabel.textContent = `${this.brushSize} px`;
    this.brushSizeRange.value = String(this.brushSize);
    this.documentSizeLabel.textContent = `${this.core.documentWidth()} x ${this.core.documentHeight()}`;
    this.layerCountLabel.textContent = `${this.core.layerCount()} layer`;
    this.rendererLabel.textContent = diagnostics.backend;
    this.zoomLabel.textContent = `${Math.round((this.camera.zoom / this.zoomBounds.min) * 100)}%`;
    this.perfPanel.textContent = [
      `FPS: ${Number.isFinite(fps) ? fps : "--"}`,
      `Render: ${this.lastRenderDuration.toFixed(1)} ms`,
      `Backend: ${diagnostics.backend}`,
      `Scale: ${Math.round(diagnostics.renderScale * 100)}%`,
      `Visible tiles: ${diagnostics.visibleTiles}`,
      `Tile canvases: ${diagnostics.tileCanvases}`,
      `Composite cache: ${diagnostics.compositeTiles}`,
      `Layers: ${diagnostics.layers}`,
    ].join("\n");
  }

  private updateZoomBounds(): void {
    const usableWidth = Math.max(1, this.viewport.width - VIEW_MARGIN * 2);
    const usableHeight = Math.max(1, this.viewport.height - VIEW_MARGIN * 2);
    const min = Math.max(0.02, Math.min(usableWidth / this.core.documentWidth(), usableHeight / this.core.documentHeight()));

    this.zoomBounds = {
      max: Math.max(min * 1.01, Math.min(5, Math.max(1, min * 16))),
      min,
    };
  }

  private zoomAt(screenPoint: PointerPoint, requestedZoom: number, documentPoint: { x: number; y: number }): void {
    const zoom = clamp(requestedZoom, this.zoomBounds.min, this.zoomBounds.max);

    this.camera = {
      x: screenPoint.x - documentPoint.x * zoom,
      y: screenPoint.y - documentPoint.y * zoom,
      zoom,
    };
    this.scheduleRender();
    this.updateUi();
  }

  private activePointers(): PointerPoint[] {
    return Array.from(this.pointers.values()).sort((first, second) => first.id - second.id);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function coalescedEvents(event: PointerEvent): PointerEvent[] {
  const events = typeof event.getCoalescedEvents === "function" ? event.getCoalescedEvents() : [];

  return events.length ? events : [event];
}

function distance(first: PointerPoint, second: PointerPoint): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function getBrushPressure(event: PointerEvent): number {
  return event.pressure && event.pressure > 0 ? event.pressure : 0.5;
}
