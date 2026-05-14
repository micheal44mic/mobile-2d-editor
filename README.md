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
- Brush separati in file dedicati: preset, texture/grain/shape ed engine/layer.
- Primo brush grain pencil: un dito disegna, due dita muovono/zoomano la vista.
- Controlli inferiori dedicati alla grandezza del brush in pixel.
