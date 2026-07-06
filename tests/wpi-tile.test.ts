import { describe, expect, it } from 'vitest';
import {
  WPI_TILE_HEADER_BYTES,
  decodeReturnByte,
  decodeWpiTile,
  encodeWpiTile,
  wpiRecordStride,
  wpiTileByteLayout,
  type DecodedWpiTile,
} from '../src/shared/wpi-tile';

function sampleTile(hasRgb: boolean, count = 5): DecodedWpiTile {
  const x = new Int32Array(count);
  const y = new Int32Array(count);
  const z = new Int32Array(count);
  const intensity = new Uint16Array(count);
  const classification = new Uint8Array(count);
  const returnByte = new Uint8Array(count);
  const r = hasRgb ? new Uint16Array(count) : null;
  const g = hasRgb ? new Uint16Array(count) : null;
  const b = hasRgb ? new Uint16Array(count) : null;
  for (let i = 0; i < count; i++) {
    x[i] = i * 100003 - 50000; // include negative int32 to prove signed round-trip
    y[i] = -(i * 7919);
    z[i] = i * 65537;
    intensity[i] = (i * 9973) & 0xffff;
    classification[i] = i % 32;
    returnByte[i] = (i * 3) & 0xff;
    if (hasRgb) {
      r![i] = (i * 4097) & 0xffff;
      g![i] = (i * 8191) & 0xffff;
      b![i] = (i * 65521) & 0xffff;
    }
  }
  return { pointCount: count, hasRgb, x, y, z, intensity, classification, returnByte, r, g, b };
}

describe('wpi tile codec', () => {
  it('round-trips a tile with RGB losslessly', () => {
    const tile = sampleTile(true);
    const decoded = decodeWpiTile(encodeWpiTile(tile));
    expect(decoded.pointCount).toBe(tile.pointCount);
    expect(decoded.hasRgb).toBe(true);
    expect(Array.from(decoded.x)).toEqual(Array.from(tile.x));
    expect(Array.from(decoded.y)).toEqual(Array.from(tile.y));
    expect(Array.from(decoded.z)).toEqual(Array.from(tile.z));
    expect(Array.from(decoded.intensity)).toEqual(Array.from(tile.intensity));
    expect(Array.from(decoded.classification)).toEqual(Array.from(tile.classification));
    expect(Array.from(decoded.returnByte)).toEqual(Array.from(tile.returnByte));
    expect(Array.from(decoded.r!)).toEqual(Array.from(tile.r!));
    expect(Array.from(decoded.g!)).toEqual(Array.from(tile.g!));
    expect(Array.from(decoded.b!)).toEqual(Array.from(tile.b!));
  });

  it('round-trips a tile without RGB and reports no color arrays', () => {
    const tile = sampleTile(false);
    const bytes = encodeWpiTile(tile);
    expect(bytes.byteLength).toBe(WPI_TILE_HEADER_BYTES + tile.pointCount * wpiRecordStride(false));
    const decoded = decodeWpiTile(bytes);
    expect(decoded.hasRgb).toBe(false);
    expect(decoded.r).toBeNull();
    expect(Array.from(decoded.x)).toEqual(Array.from(tile.x));
    expect(Array.from(decoded.z)).toEqual(Array.from(tile.z));
  });

  it('throws on a truncated payload', () => {
    const bytes = encodeWpiTile(sampleTile(true, 4));
    expect(() => decodeWpiTile(bytes.subarray(0, bytes.byteLength - 3))).toThrow(/truncated/i);
  });

  it('decodes returnByte per point format (nibbles for >=6, 3-bit for <6)', () => {
    expect(decodeReturnByte((3 & 0x0f) | ((5 & 0x0f) << 4), 7)).toEqual({ returnNumber: 3, numberOfReturns: 5 });
    expect(decodeReturnByte(0xf7, 8)).toEqual({ returnNumber: 7, numberOfReturns: 15 });
    expect(decodeReturnByte((2 & 0x07) | ((4 & 0x07) << 3), 1)).toEqual({ returnNumber: 2, numberOfReturns: 4 });
  });

  it('documents a byte layout consistent with the record stride', () => {
    const layout = wpiTileByteLayout(true);
    expect(layout.endianness).toBe('little');
    expect(layout.recordStride).toBe(wpiRecordStride(true));
    expect(layout.header).toHaveLength(2);
    expect(layout.record.some((f) => f.name === 'red')).toBe(true);
    expect(wpiTileByteLayout(false).record.some((f) => f.name === 'red')).toBe(false);
  });
});
