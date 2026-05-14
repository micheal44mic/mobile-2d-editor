import { TileStore } from "./TileStore";
import type { Camera, PaintRenderer, RendererDiagnostics, Stamp, TileCoord, Viewport } from "./types";

const SHADER = `
struct VertexOut {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vs_main(
  @location(0) position: vec2<f32>,
  @location(1) uv: vec2<f32>,
) -> VertexOut {
  var out: VertexOut;
  out.position = vec4<f32>(position, 0.0, 1.0);
  out.uv = uv;
  return out;
}

@group(0) @binding(0) var tile_sampler: sampler;
@group(0) @binding(1) var tile_texture: texture_2d<f32>;

@fragment
fn fs_main(in: VertexOut) -> @location(0) vec4<f32> {
  return textureSample(tile_texture, tile_sampler, in.uv);
}
`;

type TextureEntry = {
  texture: GPUTexture;
  version: number;
};

export class WebGPUTileRenderer implements PaintRenderer {
  readonly backend = "webgpu" as const;

  private readonly bindGroupLayout: GPUBindGroupLayout;
  private readonly canvas: HTMLCanvasElement;
  private readonly context: GPUCanvasContext;
  private readonly device: GPUDevice;
  private readonly format: GPUTextureFormat;
  private readonly pipeline: GPURenderPipeline;
  private readonly sampler: GPUSampler;
  private readonly store: TileStore;
  private readonly textureCache = new Map<string, TextureEntry>();
  private pixelRatio = 1;
  private renderScale = 1;
  private viewport: Viewport = { height: 1, width: 1 };
  private visibleTileCount = 0;
  private whiteTexture: GPUTexture;

  private constructor(canvas: HTMLCanvasElement, store: TileStore, device: GPUDevice, format: GPUTextureFormat) {
    const context = canvas.getContext("webgpu");

    if (!context) {
      throw new Error("WebGPU canvas context non disponibile.");
    }

    this.canvas = canvas;
    this.context = context;
    this.device = device;
    this.format = format;
    this.store = store;
    this.sampler = device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
    });
    this.bindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          sampler: { type: "filtering" },
          visibility: GPUShaderStage.FRAGMENT,
        },
        {
          binding: 1,
          texture: { sampleType: "float" },
          visibility: GPUShaderStage.FRAGMENT,
        },
      ],
    });
    this.pipeline = device.createRenderPipeline({
      fragment: {
        entryPoint: "fs_main",
        module: device.createShaderModule({ code: SHADER }),
        targets: [
          {
            blend: {
              alpha: {
                dstFactor: "one-minus-src-alpha",
                operation: "add",
                srcFactor: "one",
              },
              color: {
                dstFactor: "one-minus-src-alpha",
                operation: "add",
                srcFactor: "src-alpha",
              },
            },
            format,
          },
        ],
      },
      layout: device.createPipelineLayout({
        bindGroupLayouts: [this.bindGroupLayout],
      }),
      primitive: {
        topology: "triangle-list",
      },
      vertex: {
        buffers: [
          {
            arrayStride: 16,
            attributes: [
              {
                format: "float32x2",
                offset: 0,
                shaderLocation: 0,
              },
              {
                format: "float32x2",
                offset: 8,
                shaderLocation: 1,
              },
            ],
          },
        ],
        entryPoint: "vs_main",
        module: device.createShaderModule({ code: SHADER }),
      },
    });
    this.whiteTexture = this.createSolidTexture([255, 255, 255, 255]);
    this.resize();
  }

  static async create(canvas: HTMLCanvasElement, store: TileStore): Promise<WebGPUTileRenderer> {
    if (!navigator.gpu) {
      throw new Error("WebGPU non supportato.");
    }

    const adapter = await navigator.gpu.requestAdapter();

    if (!adapter) {
      throw new Error("WebGPU adapter non disponibile.");
    }

    const device = await adapter.requestDevice();
    const format = navigator.gpu.getPreferredCanvasFormat();

    return new WebGPUTileRenderer(canvas, store, device, format);
  }

  addLayer(layerId: number): void {
    this.store.addLayer(layerId);
  }

  commitStroke(strokeId: number, layerId: number, stamps: Stamp[]): void {
    this.store.commitStroke(strokeId, layerId, stamps);
  }

  destroy(): void {
    for (const entry of this.textureCache.values()) {
      entry.texture.destroy();
    }

    this.whiteTexture.destroy();
    this.textureCache.clear();
  }

  drawStamps(layerId: number, stamps: Stamp[]): void {
    this.store.drawStamps(layerId, stamps);
  }

  getDiagnostics(): RendererDiagnostics {
    return this.store.getDiagnostics(this.renderScale, this.backend, this.visibleTileCount);
  }

  rebuildTiles(tiles: TileCoord[]): void {
    this.store.rebuildTiles(tiles);

    for (const tile of tiles) {
      const entry = this.textureCache.get(textureKey(tile));

      entry?.texture.destroy();
      this.textureCache.delete(textureKey(tile));
    }
  }

  render(camera: Camera): void {
    const visibleTiles = this.store.visibleTiles(camera, this.viewport);
    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          clearValue: { a: 1, b: 0.98, g: 0.96, r: 0.94 },
          loadOp: "clear",
          storeOp: "store",
          view: this.context.getCurrentTexture().createView(),
        },
      ],
    });

    this.visibleTileCount = visibleTiles.length;
    pass.setPipeline(this.pipeline);
    this.drawTexture(pass, this.whiteTexture, {
      height: this.store.documentHeight * camera.zoom,
      width: this.store.documentWidth * camera.zoom,
      x: camera.x,
      y: camera.y,
    });

    for (const tile of visibleTiles) {
      const tileCanvas = this.store.getCompositeTile(tile);
      const texture = this.uploadTileTexture(tile, tileCanvas);

      this.drawTexture(pass, texture, {
        height: this.store.tileSize * camera.zoom,
        width: this.store.tileSize * camera.zoom,
        x: camera.x + tile.x * this.store.tileSize * camera.zoom,
        y: camera.y + tile.y * this.store.tileSize * camera.zoom,
      });
    }

    pass.end();
    this.device.queue.submit([encoder.finish()]);
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
    this.context.configure({
      alphaMode: "opaque",
      device: this.device,
      format: this.format,
    });
  }

  setStrokeActive(strokeId: number, active: boolean): void {
    this.store.setStrokeActive(strokeId, active);
  }

  private createBindGroup(texture: GPUTexture): GPUBindGroup {
    return this.device.createBindGroup({
      entries: [
        {
          binding: 0,
          resource: this.sampler,
        },
        {
          binding: 1,
          resource: texture.createView(),
        },
      ],
      layout: this.bindGroupLayout,
    });
  }

  private createSolidTexture(rgba: [number, number, number, number]): GPUTexture {
    const texture = this.device.createTexture({
      format: "rgba8unorm",
      size: [1, 1],
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.device.queue.writeTexture(
      { texture },
      new Uint8Array(rgba),
      { bytesPerRow: 4 },
      { height: 1, width: 1 }
    );
    return texture;
  }

  private drawTexture(pass: GPURenderPassEncoder, texture: GPUTexture, rect: Rect): void {
    const vertexData = this.createQuad(rect);
    const vertexBuffer = this.device.createBuffer({
      mappedAtCreation: true,
      size: vertexData.byteLength,
      usage: GPUBufferUsage.VERTEX,
    });

    new Float32Array(vertexBuffer.getMappedRange()).set(vertexData);
    vertexBuffer.unmap();
    pass.setBindGroup(0, this.createBindGroup(texture));
    pass.setVertexBuffer(0, vertexBuffer);
    pass.draw(6);
  }

  private createQuad(rect: Rect): Float32Array {
    const left = (rect.x / this.viewport.width) * 2 - 1;
    const right = ((rect.x + rect.width) / this.viewport.width) * 2 - 1;
    const top = 1 - (rect.y / this.viewport.height) * 2;
    const bottom = 1 - ((rect.y + rect.height) / this.viewport.height) * 2;

    return new Float32Array([
      left, top, 0, 0,
      right, top, 1, 0,
      left, bottom, 0, 1,
      left, bottom, 0, 1,
      right, top, 1, 0,
      right, bottom, 1, 1,
    ]);
  }

  private uploadTileTexture(tile: TileCoord, canvas: HTMLCanvasElement): GPUTexture {
    const key = textureKey(tile);
    const version = this.store.getCompositeTileVersion(tile);
    const cached = this.textureCache.get(key);

    if (cached && cached.version === version) {
      return cached.texture;
    }

    if (cached) {
      this.device.queue.copyExternalImageToTexture(
        { source: canvas },
        { texture: cached.texture },
        { height: canvas.height, width: canvas.width }
      );
      cached.version = version;
      return cached.texture;
    }

    const texture = this.device.createTexture({
      format: "rgba8unorm",
      size: [canvas.width, canvas.height],
      usage: GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });

    this.device.queue.copyExternalImageToTexture(
      { source: canvas },
      { texture },
      { height: canvas.height, width: canvas.width }
    );
    this.textureCache.set(key, { texture, version });
    return texture;
  }
}

type Rect = {
  height: number;
  width: number;
  x: number;
  y: number;
};

function isMobileLike(): boolean {
  return (
    navigator.maxTouchPoints > 0 ||
    window.matchMedia?.("(pointer: coarse)")?.matches === true ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  );
}

function textureKey(tile: TileCoord): string {
  return `${tile.x}:${tile.y}`;
}
