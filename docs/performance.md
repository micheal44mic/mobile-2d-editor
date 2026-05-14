# Performance Notes

Target: keep interaction under a 16.7 ms frame budget on mobile browsers, with Android Chrome as the main practical target.

## Baseline

The old bottleneck was not only memory. The real enemy was repeated work:

```text
large surface + live layer compositing + brush stamping + main thread input
```

A 4K paint editor cannot rely on one monolithic canvas and then add multilayer, undo, redo, blend modes, and high-frequency brush input on top.

## New Runtime

The new app uses:

- Rust/WASM for brush command generation, stroke sampling, tile graph, and undo/redo stacks;
- TypeScript for UI, input, and browser API orchestration;
- a tile store instead of one giant brush layer;
- a dirty composite cache;
- WebGPU-first final presentation;
- Canvas 2D fallback using the same tile model;
- coalesced pointer input.

## Work Scaling

The runtime should scale with:

```text
touched tiles during a stroke
visible tiles during presentation
dirty composite tiles after undo/redo
```

It should not scale with:

```text
full document pixels every frame
all layer pixels every frame
full 4K snapshots for undo
```

## Android Rules

- Keep input sampling separate from raster work.
- Batch stroke commands.
- Rebuild only dirty tiles.
- Composite visible cache tiles, not all layers live every frame.
- Avoid `getImageData()` in the drawing loop.
- Avoid full-document undo snapshots.
- Prefer WebGPU/WebGL texture work once brush stamping moves fully to GPU.

## Current Limit

The current WebGPU backend presents visible composite tiles on the GPU. The tile store still rasterizes brush stamps into tile canvases so the app has a reliable Canvas fallback and testable undo/redo. The architecture is now ready for moving stamp rasterization from tile canvas to WebGPU tile textures without changing the app/core contract.

## Test Commands

```bash
npm test
npm run check
```
