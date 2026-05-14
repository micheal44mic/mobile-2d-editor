import type { Stamp, TileCoord } from "./types";

export function decodeStamps(buffer: Float32Array): Stamp[] {
  const stamps: Stamp[] = [];

  for (let index = 0; index + 3 < buffer.length; index += 4) {
    stamps.push({
      x: buffer[index],
      y: buffer[index + 1],
      radius: buffer[index + 2],
      alpha: buffer[index + 3],
    });
  }

  return stamps;
}

export function decodeHistoryTiles(buffer: Uint32Array): { strokeId: number; tiles: TileCoord[] } {
  const strokeId = buffer[0] ?? 0;
  const count = buffer[1] ?? 0;
  const tiles: TileCoord[] = [];

  for (let index = 0; index < count; index += 1) {
    const offset = 2 + index * 2;

    tiles.push({
      x: buffer[offset],
      y: buffer[offset + 1],
    });
  }

  return { strokeId, tiles };
}
