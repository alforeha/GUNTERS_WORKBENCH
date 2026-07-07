import { gunzipSync, gzipSync } from 'node:zlib';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PointCloudBoundsBox } from './workbench-types';

export const ANALYTIC_SURFEL_MANIFEST_FILE = 'index.json';
export const ANALYTIC_SURFEL_COMPLETE_MARKER = 'COMPLETE';
export const ANALYTIC_SURFEL_TILES_DIR = 'tiles';

export interface AnalyticSurfelManifestNode {
  key: string;
  level: number;
  bounds: PointCloudBoundsBox;
  surfelCount: number;
  childKeys: string[];
  tile: string;
}

export interface AnalyticSurfelManifest {
  surfelVersion: 1 | 2;
  surfelType: 'analytic-surfel-octree';
  generator: { name: 'workbench'; version: string };
  generatedAt: string;
  surfelCellScale: number;
  sourceAssetId: string;
  indexAssetId: string | null;
  source: {
    headerSha256: string;
    fileSize: number;
    mtimeMs: number | null;
  };
  bounds: PointCloudBoundsBox;
  spacingEstimate: number;
  totalSurfels: number;
  root: string;
  nodes: AnalyticSurfelManifestNode[];
}

export interface EncodedAnalyticSurfelTile {
  surfelCount: number;
  positions: Float32Array;
  colors: Uint8Array;
  radii: Float32Array;
  normals: Float32Array;
  confidence: Float32Array;
  flags: Uint8Array;
  eigenvalues: Float32Array;
}

export async function writeAnalyticSurfelTile(
  tilesDir: string,
  tileName: string,
  tile: EncodedAnalyticSurfelTile,
): Promise<void> {
  const headerBytes = 4;
  const positionBytes = tile.positions.byteLength;
  const colorBytes = tile.colors.byteLength;
  const radiusBytes = tile.radii.byteLength;
  const normalBytes = tile.normals.byteLength;
  const confidenceBytes = tile.confidence.byteLength;
  const flagBytes = tile.flags.byteLength;
  const eigenBytes = tile.eigenvalues.byteLength;
  const layoutCount = 7;
  const layoutBytes = layoutCount * 4;
  const buffer = Buffer.allocUnsafe(
    headerBytes + layoutBytes + positionBytes + colorBytes + radiusBytes + normalBytes + confidenceBytes + flagBytes + eigenBytes,
  );
  let offset = 0;
  buffer.writeUInt32LE(tile.surfelCount, offset);
  offset += 4;
  for (const size of [positionBytes, colorBytes, radiusBytes, normalBytes, confidenceBytes, flagBytes, eigenBytes]) {
    buffer.writeUInt32LE(size, offset);
    offset += 4;
  }
  offset += copyTyped(buffer, offset, tile.positions);
  offset += copyTyped(buffer, offset, tile.colors);
  offset += copyTyped(buffer, offset, tile.radii);
  offset += copyTyped(buffer, offset, tile.normals);
  offset += copyTyped(buffer, offset, tile.confidence);
  offset += copyTyped(buffer, offset, tile.flags);
  copyTyped(buffer, offset, tile.eigenvalues);
  await writeFile(path.join(tilesDir, tileName), gzipSync(buffer));
}

export async function readAnalyticSurfelTile(tilesDir: string, tileName: string): Promise<EncodedAnalyticSurfelTile> {
  const raw = gunzipSync(await readFile(path.join(tilesDir, tileName)));
  let offset = 0;
  const surfelCount = raw.readUInt32LE(offset);
  offset += 4;
  const positionBytes = raw.readUInt32LE(offset);
  offset += 4;
  const colorBytes = raw.readUInt32LE(offset);
  offset += 4;
  const radiusBytes = raw.readUInt32LE(offset);
  offset += 4;
  const normalBytes = raw.readUInt32LE(offset);
  offset += 4;
  const confidenceBytes = raw.readUInt32LE(offset);
  offset += 4;
  const flagBytes = raw.readUInt32LE(offset);
  offset += 4;

  const v1Total = 4 + 6 * 4 + positionBytes + colorBytes + radiusBytes + normalBytes + confidenceBytes + flagBytes;
  const isV2 = raw.length > v1Total;
  let eigenBytes = 0;
  if (isV2) {
    eigenBytes = raw.readUInt32LE(offset);
    offset += 4;
  }

  const positions = sliceFloat32(raw, offset, positionBytes);
  offset += positionBytes;
  const colors = sliceUint8(raw, offset, colorBytes);
  offset += colorBytes;
  const radii = sliceFloat32(raw, offset, radiusBytes);
  offset += radiusBytes;
  const normals = sliceFloat32(raw, offset, normalBytes);
  offset += normalBytes;
  const confidence = sliceFloat32(raw, offset, confidenceBytes);
  offset += confidenceBytes;
  const flags = sliceUint8(raw, offset, flagBytes);
  offset += flagBytes;

  const eigenvalues = (isV2 && eigenBytes > 0)
    ? sliceFloat32(raw, offset, eigenBytes)
    : new Float32Array(0);
  if (isV2 && eigenBytes > 0) {
    offset += eigenBytes;
  }

  return { surfelCount, positions, colors, radii, normals, confidence, flags, eigenvalues };
}

function copyTyped(buffer: Buffer, offset: number, array: Float32Array | Uint8Array): number {
  Buffer.from(array.buffer, array.byteOffset, array.byteLength).copy(buffer, offset);
  return array.byteLength;
}

function sliceFloat32(buffer: Buffer, offset: number, byteLength: number): Float32Array {
  const src = buffer.subarray(offset, offset + byteLength);
  const ab = new ArrayBuffer(byteLength);
  const dst = new Uint8Array(ab);
  dst.set(src);
  return new Float32Array(ab);
}

function sliceUint8(buffer: Buffer, offset: number, byteLength: number): Uint8Array {
  return Uint8Array.from(buffer.subarray(offset, offset + byteLength));
}
