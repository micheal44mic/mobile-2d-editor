# Mobile 2D Editor

Mobile-first 4K paint editor prototype rebuilt around a Rust/WASM core, TypeScript orchestration, and a tile renderer with WebGPU-first presentation.

## Current Core

- Document: `4096 x 4096`.
- Tile size: `256 x 256`.
- Rust/WASM owns document state, layer ids, tile graph, brush spacing, command generation, and undo/redo stacks.
- TypeScript owns UI, input, browser APIs, camera, and renderer orchestration.
- Renderer is tile-based: layer tiles, dirty composite tiles, visible tile presentation.
- WebGPU is attempted first; Canvas 2D uses the same tile store as fallback.
- Undo/redo rebuilds only touched tiles.
- Coalesced pointer events are consumed where available.
- Performance panel is always visible while tuning.

## Commands

```bash
npm install
npm run dev
npm run build
npm test
npm run check
```

## Structure

```text
.
|-- crates
|   `-- paint-core
|       |-- Cargo.toml
|       `-- src
|           `-- lib.rs
|-- docs
|   |-- architecture.md
|   `-- performance.md
|-- index.html
|-- package.json
|-- src
|   |-- app
|   |   |-- EditorApp.ts
|   |   `-- main.ts
|   |-- generated
|   |   `-- paint-core
|   |-- renderer
|   |   |-- CanvasTileRenderer.ts
|   |   |-- TileStore.ts
|   |   |-- WebGPUTileRenderer.ts
|   |   |-- createRenderer.ts
|   |   |-- stamps.ts
|   |   `-- types.ts
|   |-- styles
|   |   `-- styles.css
|   `-- vite-env.d.ts
`-- tests
    `-- architecture.test.js
```

## Notes

This is not a game engine shell. The rendering model is the editor model: tile graph, dirty composite cache, command history, and backend selection. That gives Android a path that does not scale linearly with a giant 4K canvas and future layer count.
