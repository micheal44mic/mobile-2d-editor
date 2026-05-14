use std::collections::{BTreeSet, HashMap};
use wasm_bindgen::prelude::*;

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
struct TileCoord {
    x: u32,
    y: u32,
}

#[derive(Clone, Copy, Debug)]
struct Stamp {
    x: f32,
    y: f32,
    radius: f32,
}

#[derive(Clone, Debug)]
struct BrushSettings {
    diameter: f32,
    flow: f32,
    max_stamps_per_move: u32,
    min_spacing: f32,
    pressure_opacity: f32,
    pressure_size: f32,
    spacing_ratio: f32,
}

impl Default for BrushSettings {
    fn default() -> Self {
        Self {
            diameter: 22.0,
            flow: 0.42,
            max_stamps_per_move: 96,
            min_spacing: 2.4,
            pressure_opacity: 0.62,
            pressure_size: 0.22,
            spacing_ratio: 0.16,
        }
    }
}

#[derive(Clone, Debug)]
struct Layer {
    id: u32,
    active_strokes: BTreeSet<u32>,
}

#[derive(Clone, Debug)]
struct StrokeDraft {
    distance_since_stamp: f32,
    last: (f32, f32),
    layer_id: u32,
    stamps: Vec<Stamp>,
    tiles: BTreeSet<TileCoord>,
}

#[derive(Clone, Debug)]
struct StrokeRecord {
    active: bool,
    layer_id: u32,
    tiles: Vec<TileCoord>,
}

#[derive(Debug)]
struct PaintCoreState {
    active_layer_id: u32,
    brush: BrushSettings,
    command_buffer: Vec<f32>,
    document_height: u32,
    document_width: u32,
    layers: Vec<Layer>,
    next_layer_id: u32,
    next_stroke_id: u32,
    pending_stroke: Option<StrokeDraft>,
    redo_stack: Vec<u32>,
    strokes: HashMap<u32, StrokeRecord>,
    tile_size: u32,
    undo_stack: Vec<u32>,
}

impl PaintCoreState {
    fn new(document_width: u32, document_height: u32, tile_size: u32) -> Self {
        let safe_tile_size = tile_size.max(64);

        Self {
            active_layer_id: 1,
            brush: BrushSettings::default(),
            command_buffer: Vec::with_capacity(4096),
            document_height,
            document_width,
            layers: vec![Layer {
                id: 1,
                active_strokes: BTreeSet::new(),
            }],
            next_layer_id: 2,
            next_stroke_id: 1,
            pending_stroke: None,
            redo_stack: Vec::new(),
            strokes: HashMap::new(),
            tile_size: safe_tile_size,
            undo_stack: Vec::new(),
        }
    }

    fn add_layer(&mut self) -> u32 {
        let id = self.next_layer_id;

        self.next_layer_id += 1;
        self.layers.push(Layer {
            id,
            active_strokes: BTreeSet::new(),
        });
        self.active_layer_id = id;
        id
    }

    fn set_active_layer(&mut self, layer_id: u32) -> bool {
        if self.layers.iter().any(|layer| layer.id == layer_id) {
            self.active_layer_id = layer_id;
            true
        } else {
            false
        }
    }

    fn set_brush(
        &mut self,
        diameter: f32,
        min_spacing: f32,
        spacing_ratio: f32,
        flow: f32,
    ) {
        self.brush.diameter = diameter.clamp(1.0, 512.0);
        self.brush.min_spacing = min_spacing.clamp(0.5, 128.0);
        self.brush.spacing_ratio = spacing_ratio.clamp(0.01, 2.0);
        self.brush.flow = flow.clamp(0.01, 1.0);
    }

    fn tile_columns(&self) -> u32 {
        self.document_width.div_ceil(self.tile_size)
    }

    fn tile_rows(&self) -> u32 {
        self.document_height.div_ceil(self.tile_size)
    }

    fn begin_stroke(&mut self, x: f32, y: f32, pressure: f32) {
        self.command_buffer.clear();
        self.pending_stroke = Some(StrokeDraft {
            distance_since_stamp: 0.0,
            last: (x, y),
            layer_id: self.active_layer_id,
            stamps: Vec::new(),
            tiles: BTreeSet::new(),
        });
        self.emit_stamp(x, y, pressure);
    }

    fn extend_stroke(&mut self, x: f32, y: f32, pressure: f32) {
        if self.pending_stroke.is_none() {
            self.begin_stroke(x, y, pressure);
            return;
        }

        self.command_buffer.clear();

        let Some(draft) = self.pending_stroke.as_ref() else {
            return;
        };
        let previous = draft.last;
        let dx = x - previous.0;
        let dy = y - previous.1;
        let distance = (dx * dx + dy * dy).sqrt();

        if distance <= f32::EPSILON {
            return;
        }

        let spacing = self.spacing(pressure);
        let distance_since_stamp = draft.distance_since_stamp.clamp(0.0, spacing);
        let first_stamp_distance = (spacing - distance_since_stamp).max(0.0);
        let stamp_count = if first_stamp_distance <= distance {
            ((distance - first_stamp_distance) / spacing).floor() as u32 + 1
        } else {
            0
        };

        if stamp_count > self.brush.max_stamps_per_move {
            for index in 1..=self.brush.max_stamps_per_move {
                let amount = index as f32 / self.brush.max_stamps_per_move as f32;
                self.emit_stamp(previous.0 + dx * amount, previous.1 + dy * amount, pressure);
            }

            if let Some(draft) = self.pending_stroke.as_mut() {
                draft.distance_since_stamp = 0.0;
                draft.last = (x, y);
            }
            return;
        }

        let mut last_stamp_distance = -distance_since_stamp;
        let mut next_stamp_distance = first_stamp_distance;

        for _ in 0..stamp_count {
            let amount = next_stamp_distance / distance;

            self.emit_stamp(previous.0 + dx * amount, previous.1 + dy * amount, pressure);
            last_stamp_distance = next_stamp_distance;
            next_stamp_distance += spacing;
        }

        if let Some(draft) = self.pending_stroke.as_mut() {
            draft.distance_since_stamp = distance - last_stamp_distance;
            draft.last = (x, y);
        }
    }

    fn end_stroke(&mut self) -> u32 {
        self.command_buffer.clear();

        let Some(draft) = self.pending_stroke.take() else {
            return 0;
        };

        if draft.stamps.is_empty() {
            return 0;
        }

        let stroke_id = self.next_stroke_id;
        let tiles: Vec<_> = draft.tiles.into_iter().collect();

        self.next_stroke_id += 1;
        self.undo_stack.push(stroke_id);
        self.redo_stack.clear();
        self.strokes.insert(
            stroke_id,
            StrokeRecord {
                active: true,
                layer_id: draft.layer_id,
                tiles: tiles.clone(),
            },
        );

        if let Some(layer) = self.layers.iter_mut().find(|layer| layer.id == draft.layer_id) {
            layer.active_strokes.insert(stroke_id);
        }

        stroke_id
    }

    fn undo_tiles(&mut self) -> Vec<u32> {
        while let Some(stroke_id) = self.undo_stack.pop() {
            let Some(record) = self.strokes.get_mut(&stroke_id) else {
                continue;
            };

            if !record.active {
                continue;
            }

            record.active = false;
            self.redo_stack.push(stroke_id);

            if let Some(layer) = self.layers.iter_mut().find(|layer| layer.id == record.layer_id) {
                layer.active_strokes.remove(&stroke_id);
            }

            return encode_history_tiles(stroke_id, &record.tiles);
        }

        vec![0, 0]
    }

    fn redo_tiles(&mut self) -> Vec<u32> {
        while let Some(stroke_id) = self.redo_stack.pop() {
            let Some(record) = self.strokes.get_mut(&stroke_id) else {
                continue;
            };

            if record.active {
                continue;
            }

            record.active = true;
            self.undo_stack.push(stroke_id);

            if let Some(layer) = self.layers.iter_mut().find(|layer| layer.id == record.layer_id) {
                layer.active_strokes.insert(stroke_id);
            }

            return encode_history_tiles(stroke_id, &record.tiles);
        }

        vec![0, 0]
    }

    fn stroke_tiles(&self, stroke_id: u32) -> Vec<u32> {
        self.strokes
            .get(&stroke_id)
            .map(|record| encode_history_tiles(stroke_id, &record.tiles))
            .unwrap_or_else(|| vec![0, 0])
    }

    fn radius(&self, pressure: f32) -> f32 {
        let pressure_amount = pressure.clamp(0.0, 1.0) - 0.5;
        let base_radius = self.brush.diameter * 0.5;

        (base_radius * (1.0 + pressure_amount * self.brush.pressure_size)).max(1.0)
    }

    fn spacing(&self, pressure: f32) -> f32 {
        let radius = self.radius(pressure);

        self.brush.min_spacing.max(radius * self.brush.spacing_ratio)
    }

    fn alpha(&self, pressure: f32) -> f32 {
        let pressure_mix =
            1.0 - self.brush.pressure_opacity + self.brush.pressure_opacity * pressure.clamp(0.0, 1.0);

        (self.brush.flow * pressure_mix).clamp(0.02, 1.0)
    }

    fn emit_stamp(&mut self, x: f32, y: f32, pressure: f32) {
        let radius = self.radius(pressure);
        let alpha = self.alpha(pressure);
        let stamp = Stamp {
            x,
            y,
            radius,
        };
        let tiles = self.tiles_for_stamp(stamp);

        self.command_buffer.extend_from_slice(&[x, y, radius, alpha]);

        if let Some(draft) = self.pending_stroke.as_mut() {
            draft.stamps.push(stamp);

            for tile in tiles {
                draft.tiles.insert(tile);
            }
        }
    }

    fn tiles_for_stamp(&self, stamp: Stamp) -> Vec<TileCoord> {
        let min_x = (stamp.x - stamp.radius).floor().max(0.0) as u32;
        let min_y = (stamp.y - stamp.radius).floor().max(0.0) as u32;
        let max_x = (stamp.x + stamp.radius)
            .ceil()
            .min(self.document_width.saturating_sub(1) as f32) as u32;
        let max_y = (stamp.y + stamp.radius)
            .ceil()
            .min(self.document_height.saturating_sub(1) as f32) as u32;
        let start_tile_x = min_x / self.tile_size;
        let start_tile_y = min_y / self.tile_size;
        let end_tile_x = max_x / self.tile_size;
        let end_tile_y = max_y / self.tile_size;
        let mut tiles = Vec::new();

        for tile_y in start_tile_y..=end_tile_y {
            for tile_x in start_tile_x..=end_tile_x {
                tiles.push(TileCoord {
                    x: tile_x,
                    y: tile_y,
                });
            }
        }

        tiles
    }
}

fn encode_history_tiles(stroke_id: u32, tiles: &[TileCoord]) -> Vec<u32> {
    let mut encoded = Vec::with_capacity(2 + tiles.len() * 2);

    encoded.push(stroke_id);
    encoded.push(tiles.len() as u32);

    for tile in tiles {
        encoded.push(tile.x);
        encoded.push(tile.y);
    }

    encoded
}

#[wasm_bindgen]
pub struct PaintCore {
    state: PaintCoreState,
}

#[wasm_bindgen]
impl PaintCore {
    #[wasm_bindgen(constructor)]
    pub fn new(document_width: u32, document_height: u32, tile_size: u32) -> Self {
        Self {
            state: PaintCoreState::new(document_width, document_height, tile_size),
        }
    }

    #[wasm_bindgen(js_name = addLayer)]
    pub fn add_layer(&mut self) -> u32 {
        self.state.add_layer()
    }

    #[wasm_bindgen(js_name = activeLayerId)]
    pub fn active_layer_id(&self) -> u32 {
        self.state.active_layer_id
    }

    #[wasm_bindgen(js_name = beginStroke)]
    pub fn begin_stroke(&mut self, x: f32, y: f32, pressure: f32) -> js_sys::Float32Array {
        self.state.begin_stroke(x, y, pressure);
        js_sys::Float32Array::from(self.state.command_buffer.as_slice())
    }

    #[wasm_bindgen(js_name = documentHeight)]
    pub fn document_height(&self) -> u32 {
        self.state.document_height
    }

    #[wasm_bindgen(js_name = documentWidth)]
    pub fn document_width(&self) -> u32 {
        self.state.document_width
    }

    #[wasm_bindgen(js_name = endStroke)]
    pub fn end_stroke(&mut self) -> u32 {
        self.state.end_stroke()
    }

    #[wasm_bindgen(js_name = extendStroke)]
    pub fn extend_stroke(&mut self, x: f32, y: f32, pressure: f32) -> js_sys::Float32Array {
        self.state.extend_stroke(x, y, pressure);
        js_sys::Float32Array::from(self.state.command_buffer.as_slice())
    }

    #[wasm_bindgen(js_name = layerCount)]
    pub fn layer_count(&self) -> u32 {
        self.state.layers.len() as u32
    }

    #[wasm_bindgen(js_name = redoTiles)]
    pub fn redo_tiles(&mut self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.redo_tiles().as_slice())
    }

    #[wasm_bindgen(js_name = setActiveLayer)]
    pub fn set_active_layer(&mut self, layer_id: u32) -> bool {
        self.state.set_active_layer(layer_id)
    }

    #[wasm_bindgen(js_name = setBrush)]
    pub fn set_brush(&mut self, diameter: f32, min_spacing: f32, spacing_ratio: f32, flow: f32) {
        self.state
            .set_brush(diameter, min_spacing, spacing_ratio, flow);
    }

    #[wasm_bindgen(js_name = strokeTiles)]
    pub fn stroke_tiles(&self, stroke_id: u32) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.stroke_tiles(stroke_id).as_slice())
    }

    #[wasm_bindgen(js_name = tileColumns)]
    pub fn tile_columns(&self) -> u32 {
        self.state.tile_columns()
    }

    #[wasm_bindgen(js_name = tileRows)]
    pub fn tile_rows(&self) -> u32 {
        self.state.tile_rows()
    }

    #[wasm_bindgen(js_name = tileSize)]
    pub fn tile_size(&self) -> u32 {
        self.state.tile_size
    }

    #[wasm_bindgen(js_name = undoTiles)]
    pub fn undo_tiles(&mut self) -> js_sys::Uint32Array {
        js_sys::Uint32Array::from(self.state.undo_tiles().as_slice())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stamp_count(buffer: &[f32]) -> usize {
        buffer.len() / 4
    }

    #[test]
    fn spacing_accumulates_across_small_moves() {
        let mut core = PaintCoreState::new(4096, 4096, 256);

        core.set_brush(22.0, 2.4, 0.16, 1.0);
        core.begin_stroke(0.0, 0.0, 0.5);
        core.extend_stroke(1.0, 0.0, 0.5);
        assert_eq!(stamp_count(&core.command_buffer), 0);

        core.extend_stroke(2.39, 0.0, 0.5);
        assert_eq!(stamp_count(&core.command_buffer), 0);

        core.extend_stroke(2.5, 0.0, 0.5);
        assert_eq!(stamp_count(&core.command_buffer), 1);
    }

    #[test]
    fn segmented_motion_matches_long_motion_stamp_count() {
        let mut long = PaintCoreState::new(4096, 4096, 256);
        let mut segmented = PaintCoreState::new(4096, 4096, 256);

        long.set_brush(22.0, 2.4, 0.16, 1.0);
        segmented.set_brush(22.0, 2.4, 0.16, 1.0);

        long.begin_stroke(0.0, 0.0, 0.5);
        long.extend_stroke(100.0, 0.0, 0.5);
        let long_count = long
            .pending_stroke
            .as_ref()
            .map(|stroke| stroke.stamps.len())
            .unwrap_or_default();

        segmented.begin_stroke(0.0, 0.0, 0.5);
        for x in 1..=100 {
            segmented.extend_stroke(x as f32, 0.0, 0.5);
        }
        let segmented_count = segmented
            .pending_stroke
            .as_ref()
            .map(|stroke| stroke.stamps.len())
            .unwrap_or_default();

        assert_eq!(segmented_count, long_count);
    }

    #[test]
    fn undo_and_redo_return_only_touched_tiles() {
        let mut core = PaintCoreState::new(4096, 4096, 256);

        core.begin_stroke(8.0, 8.0, 0.5);
        core.extend_stroke(280.0, 8.0, 0.5);
        let stroke_id = core.end_stroke();
        assert_ne!(stroke_id, 0);

        let undo_tiles = core.undo_tiles();
        assert_eq!(undo_tiles[0], stroke_id);
        assert!(undo_tiles[1] >= 2);

        let redo_tiles = core.redo_tiles();
        assert_eq!(redo_tiles[0], stroke_id);
        assert_eq!(redo_tiles, undo_tiles);
    }

    #[test]
    fn layers_can_be_created_and_selected() {
        let mut core = PaintCoreState::new(4096, 4096, 256);
        let layer_id = core.add_layer();

        assert_eq!(core.layers.len(), 2);
        assert_eq!(core.active_layer_id, layer_id);
        assert!(core.set_active_layer(1));
        assert_eq!(core.active_layer_id, 1);
        assert!(!core.set_active_layer(999));
    }
}
