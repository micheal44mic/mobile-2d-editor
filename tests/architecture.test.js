import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("app entry uses TypeScript and generated Rust/WASM core", () => {
  const entry = fs.readFileSync(path.join(root, "src", "app", "EditorApp.ts"), "utf8");

  assert.match(entry, /from "\.\.\/generated\/paint-core\/paint_core"/);
  assert.match(entry, /new PaintCore\(DOCUMENT_SIZE, DOCUMENT_SIZE, TILE_SIZE\)/);
});

test("renderer has WebGPU primary backend and Canvas 2D fallback", () => {
  const factory = fs.readFileSync(path.join(root, "src", "renderer", "createRenderer.ts"), "utf8");
  const webgpu = fs.readFileSync(path.join(root, "src", "renderer", "WebGPUTileRenderer.ts"), "utf8");

  assert.match(factory, /WebGPUTileRenderer\.create/);
  assert.match(factory, /CanvasTileRenderer/);
  assert.match(webgpu, /navigator\.gpu\.requestAdapter/);
  assert.match(webgpu, /copyExternalImageToTexture/);
});

test("docs describe the Rust, TypeScript, and WebGPU split", () => {
  const docs = fs.readFileSync(path.join(root, "docs", "architecture.md"), "utf8");

  assert.match(docs, /Rust\/WASM/);
  assert.match(docs, /TypeScript/);
  assert.match(docs, /WebGPU/);
  assert.match(docs, /tile/i);
});
