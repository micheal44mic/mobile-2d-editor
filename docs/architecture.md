# Architecture

The editor is now split around the responsibilities that matter for Android performance.

## Rust/WASM Core

`crates/paint-core` owns deterministic editor logic:

- document size and tile graph;
- layer ids and active layer selection;
- brush spacing and stroke sampling;
- brush command generation as typed arrays;
- undo/redo command stacks;
- dirty tile reporting for undo/redo rebuilds.

The browser receives compact command buffers:

```text
[x, y, radius, alpha, x, y, radius, alpha, ...]
```

Undo/redo returns tile lists:

```text
[strokeId, tileCount, tileX, tileY, tileX, tileY, ...]
```

That keeps the main TypeScript side from owning brush math.

## TypeScript App

TypeScript owns browser APIs and orchestration:

- pointer and coalesced pointer input;
- pan, pinch zoom, and wheel zoom;
- UI controls;
- renderer selection;
- mapping Rust command buffers to renderer calls;
- mirroring stroke records so dirty tiles can be rebuilt without full-document redraws.

## Renderer

The renderer is tile-first.

```text
Rust stroke commands
  -> layer tile canvases
  -> dirty composite tiles
  -> visible tile presentation
```

There are two backends:

- `WebGPUTileRenderer`: primary path, uses WebGPU for final presentation of visible composite tiles.
- `CanvasTileRenderer`: fallback path using the same tile store and composite cache.

The store never treats the 4K document as one giant paint surface. Tiles are created only when a stroke touches them.

## Why This Matters

The old model had one large brush layer. That was simple, but it made future multilayer and undo/redo expensive because work scaled toward document size or visible pixels times layers.

The new model scales with:

```text
touched tiles + visible tiles + dirty composite tiles
```

That is the foundation needed before pushing more work into WebGPU shader passes.
