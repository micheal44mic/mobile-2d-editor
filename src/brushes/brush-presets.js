(function registerBrushPresets(global) {
  const namespace = global.Mobile2DBrushes || {};

  const BRUSH_PRESETS = Object.freeze({
    grainPencil: Object.freeze({
      angle: -0.18,
      color: "#111827",
      flow: 0.42,
      grain: 0.72,
      grainDensity: 0.58,
      grainSeed: 41,
      hardness: 0.68,
      maxStampsPerMove: 48,
      minSpacing: 2.4,
      name: "Grain pencil",
      pressureOpacity: 0.62,
      pressureSize: 0.22,
      radius: 11,
      roundness: 0.92,
      spacing: 0.16,
    }),
  });

  function getBrushPreset(name) {
    const preset = BRUSH_PRESETS[name] || BRUSH_PRESETS.grainPencil;

    return { ...preset };
  }

  namespace.BRUSH_PRESETS = BRUSH_PRESETS;
  namespace.getBrushPreset = getBrushPreset;
  global.Mobile2DBrushes = namespace;
})(window);
