// src/shared/wpi-tile.ts — pure (fs-/zlib-/THREE-free) codec for a WPI v1 point-cloud
// index tile's *uncompressed* byte payload. Tiles on disk are this payload gzipped; the
// caller owns (de)compression so this stays testable in isolation.
//
// Geometry is stored LOSSLESSLY as the source LAS int32 grid values (X/Y/Z); world
// coordinates are reconstructed with the index's scale/offset. All multibyte fields are
// little-endian and read/written through DataView so the format is platform-independent.
//
// Layout (documented for index.json via wpiTileByteLayout):
//   header (8 bytes): u32 pointCount, u32 flags (bit0 = hasRgb)
//   then pointCount interleaved records of `wpiRecordStride(hasRgb)` bytes:
//     i32 X, i32 Y, i32 Z, u16 intensity, u8 classification, u8 returnByte   (16 bytes)
//     [ u16 R, u16 G, u16 B ]                                                (+6 = 22 bytes)

export const WPI_TILE_HEADER_BYTES = 8;
const OFF_HEADER_COUNT = 0;
const OFF_HEADER_FLAGS = 4;
export const WPI_TILE_FLAG_HAS_RGB = 1;

const OFF_X = 0;
const OFF_Y = 4;
const OFF_Z = 8;
const OFF_INTENSITY = 12;
const OFF_CLASSIFICATION = 14;
const OFF_RETURN_BYTE = 15;
const OFF_R = 16;
const OFF_G = 18;
const OFF_B = 20;
const BASE_STRIDE = 16;
const RGB_STRIDE = 22;

/** Bytes per interleaved point record, with or without RGB. */
export function wpiRecordStride(hasRgb: boolean): number {
  return hasRgb ? RGB_STRIDE : BASE_STRIDE;
}

/** One source point as stored in a tile (raw LAS grid ints + attributes). */
export interface WpiRecordInput {
  x: number;
  y: number;
  z: number;
  intensity: number;
  classification: number;
  returnByte: number;
  r?: number;
  g?: number;
  b?: number;
}

export interface DecodedWpiTile {
  pointCount: number;
  hasRgb: boolean;
  x: Int32Array;
  y: Int32Array;
  z: Int32Array;
  intensity: Uint16Array;
  classification: Uint8Array;
  returnByte: Uint8Array;
  r: Uint16Array | null;
  g: Uint16Array | null;
  b: Uint16Array | null;
}

/** Write the 8-byte tile header at `offset` in a DataView. */
export function writeWpiTileHeader(view: DataView, offset: number, pointCount: number, hasRgb: boolean): void {
  view.setUint32(offset + OFF_HEADER_COUNT, pointCount, true);
  view.setUint32(offset + OFF_HEADER_FLAGS, hasRgb ? WPI_TILE_FLAG_HAS_RGB : 0, true);
}

/** Write a single interleaved record at `offset` in a DataView. */
export function writeWpiRecord(view: DataView, offset: number, rec: WpiRecordInput, hasRgb: boolean): void {
  view.setInt32(offset + OFF_X, rec.x | 0, true);
  view.setInt32(offset + OFF_Y, rec.y | 0, true);
  view.setInt32(offset + OFF_Z, rec.z | 0, true);
  view.setUint16(offset + OFF_INTENSITY, rec.intensity & 0xffff, true);
  view.setUint8(offset + OFF_CLASSIFICATION, rec.classification & 0xff);
  view.setUint8(offset + OFF_RETURN_BYTE, rec.returnByte & 0xff);
  if (hasRgb) {
    view.setUint16(offset + OFF_R, (rec.r ?? 0) & 0xffff, true);
    view.setUint16(offset + OFF_G, (rec.g ?? 0) & 0xffff, true);
    view.setUint16(offset + OFF_B, (rec.b ?? 0) & 0xffff, true);
  }
}

/** Decode a full uncompressed tile payload into columnar typed arrays. */
export function decodeWpiTile(bytes: Uint8Array): DecodedWpiTile {
  if (bytes.byteLength < WPI_TILE_HEADER_BYTES) {
    throw new Error('WPI tile is smaller than its header.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pointCount = view.getUint32(OFF_HEADER_COUNT, true);
  const flags = view.getUint32(OFF_HEADER_FLAGS, true);
  const hasRgb = (flags & WPI_TILE_FLAG_HAS_RGB) !== 0;
  const stride = wpiRecordStride(hasRgb);
  const expected = WPI_TILE_HEADER_BYTES + pointCount * stride;
  if (bytes.byteLength < expected) {
    throw new Error(`WPI tile truncated: expected ${expected} bytes for ${pointCount} points, got ${bytes.byteLength}.`);
  }

  const x = new Int32Array(pointCount);
  const y = new Int32Array(pointCount);
  const z = new Int32Array(pointCount);
  const intensity = new Uint16Array(pointCount);
  const classification = new Uint8Array(pointCount);
  const returnByte = new Uint8Array(pointCount);
  const r = hasRgb ? new Uint16Array(pointCount) : null;
  const g = hasRgb ? new Uint16Array(pointCount) : null;
  const b = hasRgb ? new Uint16Array(pointCount) : null;

  let offset = WPI_TILE_HEADER_BYTES;
  for (let i = 0; i < pointCount; i++) {
    x[i] = view.getInt32(offset + OFF_X, true);
    y[i] = view.getInt32(offset + OFF_Y, true);
    z[i] = view.getInt32(offset + OFF_Z, true);
    intensity[i] = view.getUint16(offset + OFF_INTENSITY, true);
    classification[i] = view.getUint8(offset + OFF_CLASSIFICATION);
    returnByte[i] = view.getUint8(offset + OFF_RETURN_BYTE);
    if (hasRgb) {
      r![i] = view.getUint16(offset + OFF_R, true);
      g![i] = view.getUint16(offset + OFF_G, true);
      b![i] = view.getUint16(offset + OFF_B, true);
    }
    offset += stride;
  }

  return { pointCount, hasRgb, x, y, z, intensity, classification, returnByte, r, g, b };
}

/** Encode columnar arrays into a full uncompressed tile payload (header + records). */
export function encodeWpiTile(tile: DecodedWpiTile): Uint8Array {
  const stride = wpiRecordStride(tile.hasRgb);
  const bytes = new Uint8Array(WPI_TILE_HEADER_BYTES + tile.pointCount * stride);
  const view = new DataView(bytes.buffer);
  writeWpiTileHeader(view, 0, tile.pointCount, tile.hasRgb);
  let offset = WPI_TILE_HEADER_BYTES;
  for (let i = 0; i < tile.pointCount; i++) {
    writeWpiRecord(
      view,
      offset,
      {
        x: tile.x[i]!,
        y: tile.y[i]!,
        z: tile.z[i]!,
        intensity: tile.intensity[i]!,
        classification: tile.classification[i]!,
        returnByte: tile.returnByte[i]!,
        r: tile.r ? tile.r[i]! : 0,
        g: tile.g ? tile.g[i]! : 0,
        b: tile.b ? tile.b[i]! : 0,
      },
      tile.hasRgb,
    );
    offset += stride;
  }
  return bytes;
}

/**
 * Split a stored returnByte (raw LAS byte 14) into return number + number of returns using the
 * source point format recorded in index.json. PDRF >= 6 packs both as 4-bit nibbles in byte 14;
 * PDRF < 6 packs them as 3-bit fields. Kept explicit so tile readers never guess.
 */
export function decodeReturnByte(returnByte: number, pointFormat: number): { returnNumber: number; numberOfReturns: number } {
  if (pointFormat >= 6) {
    return { returnNumber: returnByte & 0x0f, numberOfReturns: (returnByte >> 4) & 0x0f };
  }
  return { returnNumber: returnByte & 0x07, numberOfReturns: (returnByte >> 3) & 0x07 };
}

/** Machine-readable byte-layout descriptor embedded in index.json for forward readers. */
export function wpiTileByteLayout(hasRgb: boolean): {
  endianness: 'little';
  headerBytes: number;
  recordStride: number;
  header: { name: string; type: string; offset: number }[];
  record: { name: string; type: string; offset: number }[];
} {
  const record = [
    { name: 'x', type: 'int32', offset: OFF_X },
    { name: 'y', type: 'int32', offset: OFF_Y },
    { name: 'z', type: 'int32', offset: OFF_Z },
    { name: 'intensity', type: 'uint16', offset: OFF_INTENSITY },
    { name: 'classification', type: 'uint8', offset: OFF_CLASSIFICATION },
    { name: 'returnByte', type: 'uint8', offset: OFF_RETURN_BYTE },
  ];
  if (hasRgb) {
    record.push(
      { name: 'red', type: 'uint16', offset: OFF_R },
      { name: 'green', type: 'uint16', offset: OFF_G },
      { name: 'blue', type: 'uint16', offset: OFF_B },
    );
  }
  return {
    endianness: 'little',
    headerBytes: WPI_TILE_HEADER_BYTES,
    recordStride: wpiRecordStride(hasRgb),
    header: [
      { name: 'pointCount', type: 'uint32', offset: OFF_HEADER_COUNT },
      { name: 'flags', type: 'uint32', offset: OFF_HEADER_FLAGS },
    ],
    record,
  };
}
