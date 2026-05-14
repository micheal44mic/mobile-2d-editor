const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadBrushModule() {
  const code = fs.readFileSync(
    path.join(__dirname, "..", "src", "brushes", "brush-engine.js"),
    "utf8"
  );
  const backingContext = {
    clearRect() {},
    drawImage() {},
  };
  const sandbox = {
    document: {
      createElement() {
        return {
          height: 0,
          getContext() {
            return backingContext;
          },
          width: 0,
        };
      },
    },
    window: {
      Mobile2DBrushes: {
        BrushTextures: {
          createBrushStamp(settings) {
            const size = Math.ceil(settings.radius * 2);

            return {
              canvas: { size },
              radius: settings.radius,
              size,
            };
          },
        },
      },
    },
  };

  vm.runInNewContext(code, sandbox);
  return sandbox.window.Mobile2DBrushes;
}

function createBrushEngine(options = {}) {
  const brushes = loadBrushModule();
  const draws = [];
  const layer = {
    context: {
      drawImage(_canvas, x, y) {
        draws.push({ x, y });
      },
      globalAlpha: 1,
      globalCompositeOperation: "source-over",
    },
    markDirty() {},
  };
  const engine = new brushes.BrushEngine({
    layer,
    preset: {
      flow: 1,
      maxStampsPerMove: options.maxStampsPerMove || 128,
      minSpacing: options.minSpacing || 2.4,
      pressureOpacity: 0,
      pressureSize: 0,
      radius: options.radius || 11,
      spacing: options.spacing || 0.16,
    },
  });

  return { draws, engine };
}

test("brush spacing accumulates across small pointer moves", () => {
  const { draws, engine } = createBrushEngine({ minSpacing: 2.4 });

  engine.begin({ x: 0, y: 0 });
  engine.move({ x: 1, y: 0 });
  engine.move({ x: 2.39, y: 0 });

  assert.equal(draws.length, 1);

  engine.move({ x: 2.5, y: 0 });

  assert.equal(draws.length, 2);
});

test("many small moves create the same stamp count as one long move", () => {
  const longMove = createBrushEngine({ minSpacing: 2.4 });
  const segmentedMove = createBrushEngine({ minSpacing: 2.4 });

  longMove.engine.begin({ x: 0, y: 0 });
  longMove.engine.move({ x: 100, y: 0 });

  segmentedMove.engine.begin({ x: 0, y: 0 });

  for (let x = 1; x <= 100; x += 1) {
    segmentedMove.engine.move({ x, y: 0 });
  }

  assert.equal(segmentedMove.draws.length, longMove.draws.length);
});

test("large input gaps are capped but still reach the segment end", () => {
  const radius = 10;
  const { draws, engine } = createBrushEngine({
    maxStampsPerMove: 4,
    minSpacing: 2,
    radius,
    spacing: 0.1,
  });

  engine.begin({ x: 0, y: 0 });
  engine.move({ x: 100, y: 0 });

  assert.equal(draws.length, 5);

  const lastDraw = draws.at(-1);
  const lastCenterX = lastDraw.x + radius;

  assert.equal(lastCenterX, 100);
});

test("brush layer draw is clipped to the visible viewport", () => {
  const brushes = loadBrushModule();
  const layer = new brushes.BrushLayer(512, 512);
  const calls = [];

  layer.markDirty(0, 0, 16, 16);
  layer.markDirty(300, 0, 16, 16);
  layer.drawTo({
    drawImage(_canvas, sourceX, sourceY, sourceWidth, sourceHeight) {
      calls.push({ sourceHeight, sourceWidth, sourceX, sourceY });
    },
  }, {
    x: 0,
    y: 0,
    zoom: 1,
  }, {
    height: 128,
    width: 128,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].sourceX, 0);
  assert.equal(calls[0].sourceY, 0);
  assert.ok(calls[0].sourceWidth <= 128);
  assert.ok(calls[0].sourceHeight <= 128);
});
