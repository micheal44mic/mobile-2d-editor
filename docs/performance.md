# Performance Notes

Target: keep interaction under a 16.7 ms frame budget on mobile browsers, with Android Chrome as the main practical target.

## Browser Reality

No web app can honestly guarantee zero dropped frames on every Android device. The renderer has to assume different GPUs, thermal throttling, memory pressure, browser scheduling, battery mode, refresh rates, and background work.

The correct goal is:

- keep the normal path below budget;
- avoid work that grows with the whole document when only part of it is visible;
- degrade preview quality before interaction drops;
- keep final document data independent from preview resolution;
- measure frame time on-device with `?perf=1`.

## Current Runtime

This prototype still uses Canvas 2D with a `4096 x 4096` document, but it now follows the same performance rules a WebGPU renderer would use:

- brush spacing accumulates across pointer events, so stamp density stays stable;
- coalesced pointer events are consumed when the browser exposes them;
- brush layer rendering is clipped to the visible document area;
- brush layer tiles outside the viewport are skipped;
- mobile render scale adapts between `65%` and `100%` when frames exceed budget;
- the document and brush layer stay full resolution even when preview scale drops.

At 4K, the brush layer alone is about 64 MB of pixel memory. That is acceptable for a focused prototype, but Android testing should keep `?perf=1` enabled while tuning brush size, image import, and layer count.

## Final Renderer Direction

For a professional Android-first web editor, the target renderer should be:

```text
TypeScript application shell
WebGPU renderer
WebGL2 fallback
OffscreenCanvas worker where supported
Tile-based layer textures
GPU brush stamp batching
GPU blend/composite passes
Tile-diff undo history
Dynamic preview quality
```

React, Svelte, or Vue should own the UI. The editor surface should not be rendered by the UI framework.

## Android Rules

- Do not call `getImageData()` while drawing.
- Do not allocate new canvases, textures, or large arrays per frame.
- Do not composite the whole document when the viewport only shows a slice.
- Do not save undo as full images.
- Keep brush shapes and grain textures cached.
- Prefer batched stamps over one expensive path operation.
- Reduce preview scale before dropping input responsiveness.

## Test Commands

```bash
npm test
npm run check
```
