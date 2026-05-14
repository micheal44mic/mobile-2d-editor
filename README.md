# Mobile 2D Editor

Prototype leggero di editor 2D mobile-first.

## Base attuale

- Canvas centrale con pan e pinch zoom.
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
- Dropped frame misurati su target 60Hz per debug mobile più leggibile.

## Struttura

```text
.
|-- index.html
|-- README.md
`-- src
    |-- app.js
    |-- brushes
    |   |-- brush-engine.js
    |   |-- brush-presets.js
    |   `-- brush-textures.js
    `-- styles
        `-- styles.css
```
