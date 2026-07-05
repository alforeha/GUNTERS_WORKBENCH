import { fromArrayBuffer, fromBlob } from 'geotiff';
import { buildGeotiffDataset, parseWorldFile } from '../core/geotiff/metadata';
import type { GeotiffDataset, GeoTransform } from '../core/contract';

export interface GeotiffOpenRequest {
  kind: 'open';
  id: number;
  fileName: string;
  payload: Blob | ArrayBuffer;
  worldFileText?: string | null;
}

export interface GeotiffDecodeTileRequest {
  kind: 'decodeTile';
  id: number;
  window: [number, number, number, number];
  scaleDivisor: 1 | 2 | 4;
}

/** Decode one coarse full-extent overview (for CPU sampling, e.g. point-cloud recolor). */
export interface GeotiffOverviewRequest {
  kind: 'overview';
  id: number;
  maxDimension: number;
}

export type GeotiffWorkerRequest = GeotiffOpenRequest | GeotiffDecodeTileRequest | GeotiffOverviewRequest;

export interface GeotiffTilePayload {
  width: number;
  height: number;
  rgba: Uint8Array;
  scaleDivisor: 1 | 2 | 4;
}

export interface GeotiffOverviewPayload {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export type GeotiffWorkerMessage =
  | { id: number; type: 'progress'; label: string }
  | { id: number; type: 'opened'; ok: true; dataset: GeotiffDataset }
  | { id: number; type: 'tile'; ok: true; tile: GeotiffTilePayload }
  | { id: number; type: 'overview'; ok: true; overview: GeotiffOverviewPayload }
  | { id: number; type: 'result'; ok: false; error: string };

let openState:
  | {
      image: Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>['getImage']>>;
      dataset: GeotiffDataset;
    }
  | null = null;

function embeddedTransformFromImage(
  image: Awaited<ReturnType<Awaited<ReturnType<typeof fromArrayBuffer>>['getImage']>>,
): GeoTransform | null {
  try {
    const origin = image.getOrigin();
    const resolution = image.getResolution();
    const tiepoints = image.fileDirectory.hasTag('ModelTiepoint')
      ? (image.fileDirectory.getValue('ModelTiepoint') as number[] | Float64Array)
      : null;
    return {
      pixelScale: [origin.length > 0 ? resolution[0] ?? 0 : 0, origin.length > 1 ? resolution[1] ?? 0 : 0],
      origin: [origin[0] ?? 0, origin[1] ?? 0],
      tiepoint:
        tiepoints && tiepoints.length >= 6
          ? [
              tiepoints[0] ?? 0,
              tiepoints[1] ?? 0,
              tiepoints[2] ?? 0,
              tiepoints[3] ?? 0,
              tiepoints[4] ?? 0,
              tiepoints[5] ?? 0,
            ]
          : null,
      source: 'embedded',
    };
  } catch {
    return null;
  }
}

function worldFileTransformFromText(text: string | null | undefined): GeoTransform | null {
  if (!text) return null;
  const parsed = parseWorldFile(text);
  return {
    pixelScale: [parsed.scaleX, parsed.scaleY],
    origin: [parsed.originX, parsed.originY],
    tiepoint: null,
    source: 'world-file',
  };
}

function buildRgbaBuffer(
  rasters: Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array | (ArrayLike<number> & { length: number }),
  width: number,
  height: number,
  samplesPerPixel: number,
): Uint8Array {
  const totalPixels = width * height;
  const out = new Uint8Array(totalPixels * 4);
  const clamp = (value: number): number => Math.max(0, Math.min(255, Math.round(value)));
  for (let i = 0; i < totalPixels; i++) {
    const src = i * samplesPerPixel;
    const dst = i * 4;
    if (samplesPerPixel >= 3) {
      out[dst] = clamp(Number(rasters[src] ?? 0));
      out[dst + 1] = clamp(Number(rasters[src + 1] ?? rasters[src] ?? 0));
      out[dst + 2] = clamp(Number(rasters[src + 2] ?? rasters[src] ?? 0));
      // The reference orthomosaic carries a 4th band that decodes as zero for visible pixels,
      // so treating it as display alpha makes the entire drape disappear.
      out[dst + 3] = 255;
    } else {
      const gray = clamp(Number(rasters[src] ?? 0));
      out[dst] = gray;
      out[dst + 1] = gray;
      out[dst + 2] = gray;
      out[dst + 3] = 255;
    }
  }
  return out;
}

async function handleOpen(
  req: GeotiffOpenRequest,
  onProgress?: (label: string) => void,
): Promise<{ response: GeotiffWorkerMessage; transfer: ArrayBuffer[] }> {
  onProgress?.('reading metadata…');
  onProgress?.('parsing GeoTIFF tags…');
  const tiff = req.payload instanceof ArrayBuffer
    ? await fromArrayBuffer(req.payload)
    : await fromBlob(req.payload);
  const image = await tiff.getImage();
  const crsText = image.fileDirectory.hasTag('GeoAsciiParams')
    ? (image.fileDirectory.getValue('GeoAsciiParams') as string | null)
    : null;
  const dataset = buildGeotiffDataset({
    fileName: req.fileName,
    width: image.getWidth(),
    height: image.getHeight(),
    samplesPerPixel: image.getSamplesPerPixel(),
    bitsPerSample:
      (image.fileDirectory.getValue('BitsPerSample') as number[] | undefined) ??
      [image.getBitsPerSample()],
    tileWidth: image.getTileWidth(),
    tileHeight: image.getTileHeight(),
    isTiled: image.isTiled,
    crsText,
    embeddedTransform: embeddedTransformFromImage(image),
    worldFileTransform: worldFileTransformFromText(req.worldFileText),
  });
  openState = { image, dataset };
  return {
    response: { id: req.id, type: 'opened', ok: true, dataset },
    transfer: [],
  };
}

async function handleDecodeTile(
  req: GeotiffDecodeTileRequest,
): Promise<{ response: GeotiffWorkerMessage; transfer: ArrayBuffer[] }> {
  if (!openState) throw new Error('GeoTIFF worker not opened');
  const [x0, y0, x1, y1] = req.window;
  const scaleDivisor = req.scaleDivisor;
  const width = Math.max(1, Math.ceil(Math.max(0, x1 - x0) / scaleDivisor));
  const height = Math.max(1, Math.ceil(Math.max(0, y1 - y0) / scaleDivisor));
  const decoded = await openState.image.readRasters({
    window: [x0, y0, x1, y1],
    interleave: true,
    width,
    height,
    resampleMethod: scaleDivisor === 1 ? 'nearest' : 'bilinear',
  });
  const rgba = buildRgbaBuffer(
    decoded as Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array,
    width,
    height,
    openState.dataset.samplesPerPixel,
  );
  const transferableBytes = new Uint8Array(rgba.length);
  transferableBytes.set(rgba);
  return {
    response: {
      id: req.id,
      type: 'tile',
      ok: true,
      tile: { width, height, rgba: transferableBytes, scaleDivisor },
    },
    transfer: [transferableBytes.buffer],
  };
}

async function handleOverview(
  req: GeotiffOverviewRequest,
): Promise<{ response: GeotiffWorkerMessage; transfer: ArrayBuffer[] }> {
  if (!openState) throw new Error('GeoTIFF worker not opened');
  const fullW = openState.dataset.width;
  const fullH = openState.dataset.height;
  const max = Math.max(1, req.maxDimension);
  const scale = Math.max(1, Math.ceil(Math.max(fullW, fullH) / max));
  const width = Math.max(1, Math.round(fullW / scale));
  const height = Math.max(1, Math.round(fullH / scale));
  const decoded = await openState.image.readRasters({
    window: [0, 0, fullW, fullH],
    interleave: true,
    width,
    height,
    resampleMethod: 'bilinear',
  });
  const rgba = buildRgbaBuffer(
    decoded as Uint8Array | Uint8ClampedArray | Uint16Array | Float32Array,
    width,
    height,
    openState.dataset.samplesPerPixel,
  );
  const out = new Uint8Array(rgba.length);
  out.set(rgba);
  return {
    response: { id: req.id, type: 'overview', ok: true, overview: { width, height, rgba: out } },
    transfer: [out.buffer],
  };
}

export async function handleGeotiffRequest(
  req: GeotiffWorkerRequest,
  onProgress?: (label: string) => void,
): Promise<{ response: GeotiffWorkerMessage; transfer: ArrayBuffer[] }> {
  try {
    if (req.kind === 'open') return await handleOpen(req, onProgress);
    if (req.kind === 'decodeTile') return await handleDecodeTile(req);
    if (req.kind === 'overview') return await handleOverview(req);
    throw new Error('Unknown GeoTIFF worker request');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: { id: req.id, type: 'result', ok: false, error: msg }, transfer: [] };
  }
}

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<GeotiffWorkerRequest>) => void) | null;
    postMessage(msg: GeotiffWorkerMessage, transfer?: ArrayBuffer[]): void;
  };
  scope.onmessage = (e: MessageEvent<GeotiffWorkerRequest>) => {
    const { id } = e.data;
    const progress = e.data.kind === 'open'
      ? (label: string) => scope.postMessage({ id, type: 'progress', label })
      : undefined;
    void handleGeotiffRequest(e.data, progress).then(({ response, transfer }) =>
      scope.postMessage(response, transfer),
    );
  };
}
