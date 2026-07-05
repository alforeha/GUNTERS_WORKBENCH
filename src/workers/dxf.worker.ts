// src/workers/dxf.worker.ts — thin Web Worker wrapper around core/dxf/parse.
// Mirrors parse.worker.ts: all logic in src/core (Node-testable); this file is plumbing.
// dxf-parser needs the whole text in memory (no streaming) — fine at the fixture sizes
// (≤ 9 MB); the win is keeping the 20k-entity parse off the main thread (docs/08 Phase 2).

import type { DxfDataset } from '../core/contract';
import { parseDxf } from '../core/dxf/parse';

export interface DxfWorkerRequest {
  id: number;
  fileName: string;
  payload: Blob | string;
  chordTol?: number;
}

export type DxfWorkerMessage =
  | { id: number; type: 'progress'; label: string }
  | { id: number; type: 'result'; ok: true; dataset: DxfDataset }
  | { id: number; type: 'result'; ok: false; error: string };

/** Node-testable request handler; returns the response + transferable buffers. */
export async function handleDxfRequest(
  req: DxfWorkerRequest,
  onProgress?: (label: string) => void,
): Promise<{ response: DxfWorkerMessage; transfer: ArrayBuffer[] }> {
  try {
    onProgress?.('reading…');
    const text = typeof req.payload === 'string' ? req.payload : await req.payload.text();
    const dataset = parseDxf(text, {
      fileName: req.fileName,
      chordTol: req.chordTol,
      onProgress: (phase) => onProgress?.(phase === 'parsing' ? 'parsing…' : 'normalizing entities…'),
    });
    return {
      response: { id: req.id, type: 'result', ok: true, dataset },
      transfer: collectDxfTransferables(dataset),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { response: { id: req.id, type: 'result', ok: false, error: msg }, transfer: [] };
  }
}

/** Every typed-array buffer owned by the dataset, deduplicated, for zero-copy postMessage. */
export function collectDxfTransferables(dataset: DxfDataset): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  for (const e of dataset.entities) {
    const buf = e.pts.buffer;
    if (buf instanceof ArrayBuffer && !seen.has(buf)) seen.add(buf);
  }
  return [...seen];
}

// ---- worker registration (skipped under Node/Vitest) ----------------------

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<DxfWorkerRequest>) => void) | null;
    postMessage(msg: DxfWorkerMessage, transfer?: ArrayBuffer[]): void;
  };
  scope.onmessage = (e: MessageEvent<DxfWorkerRequest>) => {
    const { id } = e.data;
    void handleDxfRequest(e.data, (label) => scope.postMessage({ id, type: 'progress', label })).then(
      ({ response, transfer }) => scope.postMessage(response, transfer),
    );
  };
}
