import * as pdfjs from 'pdfjs-dist';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore -- standard build worker has no declaration file
import * as pdfjsWorker from 'pdfjs-dist/build/pdf.worker.mjs';
import { buildPdfDataset } from '../core/pdf/metadata';
import type { PdfDocumentDataset, PdfPageInfo } from '../core/contract';

const PDF_DPI = 150;
const PDF_SCALE = PDF_DPI / 72;

// PDF.js reads workerSrc before it falls back to the inline fake-worker path inside
// this app worker. Exposing WorkerMessageHandler makes that path stay fully in-bundle.
pdfjs.GlobalWorkerOptions.workerSrc = 'pdf.worker.mjs'; // bundler copies pdfjs-dist/build/pdf.worker.mjs
(globalThis as { pdfjsWorker?: typeof pdfjsWorker }).pdfjsWorker = pdfjsWorker;

// Custom canvas factory so pdfjs never calls document.createElement inside a Worker.
class OffscreenCanvasFactory {
  create(width: number, height: number): { canvas: OffscreenCanvas; context: OffscreenCanvasRenderingContext2D } {
    if (width <= 0 || height <= 0) throw new Error('Invalid canvas size');
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    return { canvas, context };
  }
  reset(pair: { canvas: OffscreenCanvas }, width: number, height: number): void {
    if (!pair.canvas) throw new Error('Canvas is not specified');
    pair.canvas.width = width;
    pair.canvas.height = height;
  }
  destroy(pair: { canvas: OffscreenCanvas | null; context: OffscreenCanvasRenderingContext2D | null }): void {
    if (!pair.canvas) throw new Error('Canvas is not specified');
    pair.canvas.width = pair.canvas.height = 0;
    pair.canvas = null;
    pair.context = null;
  }
}

interface PdfDocumentProxy {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    rotate: number;
    getViewport(options: { scale: number }): { width: number; height: number };
    render(options: {
      canvas?: OffscreenCanvas;
      canvasContext: OffscreenCanvasRenderingContext2D;
      viewport: unknown;
      transform?: number[];
    }): { promise: Promise<void> };
    cleanup(): void;
  }>;
  getMetadata(): Promise<{ info?: Record<string, unknown> }>;
}

export interface PdfOpenRequest {
  kind: 'open';
  id: number;
  fileName: string;
  payload: Blob | ArrayBuffer;
}

export interface PdfDecodeTileRequest {
  kind: 'decodeTile';
  id: number;
  pageIndex: number;
  window: [number, number, number, number];
  whiteThreshold: number;
}

export type PdfWorkerRequest = PdfOpenRequest | PdfDecodeTileRequest;

export interface PdfTilePayload {
  pageIndex: number;
  width: number;
  height: number;
  x: number;
  y: number;
  rgba: Uint8ClampedArray;
}

export type PdfWorkerMessage =
  | { id: number; type: 'progress'; label: string }
  | { id: number; type: 'opened'; ok: true; dataset: PdfDocumentDataset }
  | { id: number; type: 'tile'; ok: true; tile: PdfTilePayload }
  | { id: number; type: 'result'; ok: false; error: string };

// postMessage reference set by the worker scope so renderBasePage can broadcast.
let workerPost: ((msg: PdfWorkerMessage, transfer?: ArrayBuffer[]) => void) | null = null;

let openState:
  | {
      doc: PdfDocumentProxy;
      dataset: PdfDocumentDataset;
      openRequestId: number;
      baseCanvases: Map<number, OffscreenCanvas>;
      renderingPages: Map<number, Promise<OffscreenCanvas>>;
    }
  | null = null;

function textValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function metadataValue(info: Record<string, unknown>, key: string): string | null {
  return textValue(info[key]);
}

async function blobOrBufferToBytes(payload: Blob | ArrayBuffer): Promise<Uint8Array> {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  return new Uint8Array(await payload.arrayBuffer());
}

async function handleOpen(
  req: PdfOpenRequest,
  onProgress?: (label: string) => void,
): Promise<{ response: PdfWorkerMessage; transfer: ArrayBuffer[] }> {
  onProgress?.('reading PDF...');
  const bytes = await blobOrBufferToBytes(req.payload);
  onProgress?.('parsing pages...');
  const loadingTask = pdfjs.getDocument({
    data: bytes,
    useWorkerFetch: false,
    CanvasFactory: OffscreenCanvasFactory,
  } as Parameters<typeof pdfjs.getDocument>[0]);
  const doc = (await loadingTask.promise) as unknown as PdfDocumentProxy;
  const metadata = await doc.getMetadata().catch(() => null);
  const info = metadata?.info && typeof metadata.info === 'object'
    ? (metadata.info as Record<string, unknown>)
    : {};
  const pages: PdfPageInfo[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport72 = page.getViewport({ scale: 1 });
    const viewport150 = page.getViewport({ scale: PDF_SCALE });
    pages.push({
      pageIndex: i - 1,
      widthPt: viewport72.width,
      heightPt: viewport72.height,
      widthPx150: Math.ceil(viewport150.width),
      heightPx150: Math.ceil(viewport150.height),
      rotation: page.rotate,
    });
    page.cleanup();
  }
  const dataset = buildPdfDataset({
    fileName: req.fileName,
    pageCount: doc.numPages,
    pages,
    title: metadataValue(info, 'Title'),
    creator: metadataValue(info, 'Creator'),
    producer: metadataValue(info, 'Producer'),
    creationDate: metadataValue(info, 'CreationDate'),
    modificationDate: metadataValue(info, 'ModDate'),
  });
  openState = { doc, dataset, openRequestId: req.id, baseCanvases: new Map(), renderingPages: new Map() };
  return { response: { id: req.id, type: 'opened', ok: true, dataset }, transfer: [] };
}

function applyWhiteThreshold(data: Uint8ClampedArray, threshold: number): void {
  if (threshold === 0) return;
  const clamped = Math.max(200, Math.min(255, Math.round(threshold)));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i]! >= clamped && data[i + 1]! >= clamped && data[i + 2]! >= clamped) data[i + 3] = 0;
  }
}

async function handleDecodeTile(
  req: PdfDecodeTileRequest,
): Promise<{ response: PdfWorkerMessage; transfer: ArrayBuffer[] }> {
  if (!openState) throw new Error('PDF worker not opened');
  const pageInfo = openState.dataset.pages[req.pageIndex];
  if (!pageInfo) throw new Error(`PDF page ${req.pageIndex + 1} not found`);
  const [rawX0, rawY0, rawX1, rawY1] = req.window;
  const x0 = Math.max(0, Math.floor(rawX0));
  const y0 = Math.max(0, Math.floor(rawY0));
  const x1 = Math.min(pageInfo.widthPx150, Math.ceil(rawX1));
  const y1 = Math.min(pageInfo.heightPx150, Math.ceil(rawY1));
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);

  const baseCanvas = await renderBasePage(req.pageIndex);

  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
  ctx.drawImage(baseCanvas, x0, y0, width, height, 0, 0, width, height);
  const image = ctx.getImageData(0, 0, width, height);
  applyWhiteThreshold(image.data, req.whiteThreshold);
  return {
    response: {
      id: req.id,
      type: 'tile',
      ok: true,
      tile: { pageIndex: req.pageIndex, width, height, x: x0, y: y0, rgba: image.data },
    },
    transfer: [image.data.buffer],
  };
}

async function renderBasePage(pageIndex: number): Promise<OffscreenCanvas> {
  if (!openState) throw new Error('PDF worker not opened');
  const cached = openState.baseCanvases.get(pageIndex);
  if (cached) return cached;
  const inFlight = openState.renderingPages.get(pageIndex);
  if (inFlight) return inFlight;
  const pageInfo = openState.dataset.pages[pageIndex];
  if (!pageInfo) throw new Error(`PDF page ${pageIndex + 1} not found`);
  const renderPromise = (async (): Promise<OffscreenCanvas> => {
    // Signal activity so callers can show status text.
    workerPost?.({ id: openState!.openRequestId, type: 'progress', label: 'rendering PDF...' });
    const page = await openState!.doc.getPage(pageIndex + 1);
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvasW = pageInfo.widthPx150;
    const canvasH = pageInfo.heightPx150;
    const canvas = new OffscreenCanvas(canvasW, canvasH);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasW, canvasH);
    await page.render({
      canvas,
      canvasContext: ctx,
      viewport,
    }).promise;
    page.cleanup();
    openState!.baseCanvases.set(pageIndex, canvas);
    openState!.renderingPages.delete(pageIndex);
    return canvas;
  })();
  openState.renderingPages.set(pageIndex, renderPromise);
  return renderPromise;
}

export async function handlePdfRequest(
  req: PdfWorkerRequest,
  onProgress?: (label: string) => void,
): Promise<{ response: PdfWorkerMessage; transfer: ArrayBuffer[] }> {
  try {
    if (req.kind === 'open') return await handleOpen(req, onProgress);
    if (req.kind === 'decodeTile') return await handleDecodeTile(req);
    throw new Error('Unknown PDF worker request');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: { id: req.id, type: 'result', ok: false, error: msg }, transfer: [] };
  }
}

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<PdfWorkerRequest>) => void) | null;
    postMessage(msg: PdfWorkerMessage, transfer?: ArrayBuffer[]): void;
  };
  workerPost = (msg, transfer) => scope.postMessage(msg, transfer);
  scope.onmessage = (e: MessageEvent<PdfWorkerRequest>) => {
    const { id } = e.data;
    const progress = e.data.kind === 'open'
      ? (label: string) => scope.postMessage({ id, type: 'progress', label })
      : undefined;
    void handlePdfRequest(e.data, progress).then(({ response, transfer }) =>
      scope.postMessage(response, transfer),
    );
  };
}
