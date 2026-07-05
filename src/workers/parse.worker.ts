// src/workers/parse.worker.ts — thin Web Worker wrapper around core/landxml/parse.
//
// All parsing logic lives in src/core (Node-testable); this file only does
// message plumbing: File/Blob → stream → parseLandXML → postMessage with
// transferable buffers (zero-copy back to the main thread). Progress events
// (docs/06 D3) are relayed as {type:'progress', ...} messages.
//
// Vite usage (Sprint 2 wiring):
//   const w = new Worker(new URL('./parse.worker.ts', import.meta.url), { type: 'module' });

import type { SurfaceModel } from '../core/contract';
import { parseLandXML, type ParseProgress } from '../core/landxml/parse';

export interface WorkerParseRequest {
  id: number;                    // correlation id, echoed back
  fileName: string;
  payload: Blob | string;        // File extends Blob; string accepted for tests/tools
}

export interface WorkerProgressMessage extends ParseProgress {
  id: number;
  type: 'progress';
}

export type WorkerParseResponse =
  | { id: number; type: 'result'; ok: true; surfaces: SurfaceModel[] }
  | { id: number; type: 'result'; ok: false; error: string };

export type WorkerParseMessage = WorkerProgressMessage | WorkerParseResponse;

/**
 * Pure, Node-testable request handler. Returns the response message plus the
 * list of ArrayBuffers to pass as transferables (deduplicated). Progress is
 * surfaced through the callback (the worker shell relays it via postMessage).
 */
export async function handleParseRequest(
  req: WorkerParseRequest,
  onProgress?: (p: ParseProgress) => void,
): Promise<{ response: WorkerParseResponse; transfer: ArrayBuffer[] }> {
  try {
    const isString = typeof req.payload === 'string';
    const input = isString ? (req.payload as string) : (req.payload as Blob).stream();
    const bytesTotal = isString ? (req.payload as string).length : (req.payload as Blob).size;
    const { surfaces } = await parseLandXML(input, { fileName: req.fileName, onProgress, bytesTotal });
    return {
      response: { id: req.id, type: 'result', ok: true, surfaces },
      transfer: collectTransferables(surfaces),
    };
  } catch (err) {
    // parseLandXML itself never throws on bad content; this guards plumbing errors
    // (unreadable Blob, OOM, …) so the main thread always gets an answer.
    const msg = err instanceof Error ? err.message : String(err);
    return { response: { id: req.id, type: 'result', ok: false, error: msg }, transfer: [] };
  }
}

/** Every typed-array buffer owned by the surfaces, deduplicated, for zero-copy postMessage. */
export function collectTransferables(surfaces: SurfaceModel[]): ArrayBuffer[] {
  const seen = new Set<ArrayBuffer>();
  const add = (buf: ArrayBufferLike | undefined): void => {
    if (buf instanceof ArrayBuffer && !seen.has(buf)) seen.add(buf);
  };
  for (const s of surfaces) {
    add(s.positions.buffer);
    add(s.sourcePointIds.buffer);
    add(s.indices?.buffer);
    add(s.faceVisibility?.buffer);
    add(s.edges?.buffer);
    for (const b of s.breaklines) add(b.pts.buffer);
    for (const b of s.boundaries) add(b.pts.buffer);
    for (const c of s.contours ?? []) add(c.pts.buffer);
  }
  return [...seen];
}

// ---- worker registration (skipped under Node/Vitest) ----------------------

declare const WorkerGlobalScope: unknown;

if (typeof WorkerGlobalScope !== 'undefined') {
  const scope = globalThis as unknown as {
    onmessage: ((e: MessageEvent<WorkerParseRequest>) => void) | null;
    postMessage(msg: WorkerParseMessage, transfer?: ArrayBuffer[]): void;
  };
  scope.onmessage = (e: MessageEvent<WorkerParseRequest>) => {
    const { id } = e.data;
    const relay = (p: ParseProgress): void => {
      scope.postMessage({ id, type: 'progress', ...p });
    };
    void handleParseRequest(e.data, relay).then(({ response, transfer }) => {
      scope.postMessage(response, transfer);
    });
  };
}
