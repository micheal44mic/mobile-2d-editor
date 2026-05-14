# Mobile 2D Editor

Prototype leggero di editor 2D mobile-first.

## Base attuale

- Canvas centrale con pan e pinch zoom.
- Documento di lavoro 4K: `4096 x 4096`.
- Zoom out minimo sul documento fit con margine laterale da 50px.
- Zoom in limitato con rimbalzo morbido al rilascio.
- Upload immagine locale con preview multiple in cache client-side.
- UI chiara: sfondo bianco, documento bianco con bordo e ombra leggera.
- Zoom più morbido su pulsanti e wheel.
- Profiler attivabile con `?perf=1`.
- Brush separati in `src/brushes`: preset, texture/grain/shape ed engine/layer.
- Primo brush grain pencil: un dito disegna, due dita muovono/zoomano la vista.
- Controlli inferiori dedicati alla grandezza del brush in pixel.
- Rendering brush ottimizzato: salta il layer vuoto e ridisegna solo bounds/tile con contenuto.
- Culling del layer brush sulla viewport: le tile fuori schermo non vengono disegnate.
- Quality governor mobile: abbassa solo la risoluzione di preview quando il frame budget non regge.
- Pointer coalescing dove disponibile per tratto più fluido.
- Dropped frame misurati su target 60Hz per debug mobile più leggibile.

## Comandi

```bash
npm test
npm run check
```

## Struttura

```text
.
|-- index.html
|-- package.json
|-- README.md
|-- docs
|   `-- performance.md
|-- src
|   |-- app.js
|   |-- brushes
|   |   |-- brush-engine.js
|   |   |-- brush-presets.js
|   |   `-- brush-textures.js
|   `-- styles
|       `-- styles.css
`-- tests
    `-- brush-engine.test.js
```
