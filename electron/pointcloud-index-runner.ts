// electron/pointcloud-index-runner.ts — strategies for running a WPI index build off the
// Electron-main event loop. The production strategy spawns a worker_threads Worker; if the
// worker cannot be created or loaded (e.g. a packaging quirk) it transparently falls back to
// an in-process build that still yields cooperatively, so index generation always works.
// A build *error* reported by the worker propagates as-is — only worker-infra failures fall back.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { buildPointCloudIndex, PointCloudIndexCancelled, type BuildPointCloudIndexResult } from './pointcloud-index-builder';
import { createFileChunkSource } from './file-chunk-source';

// Resolved as a runtime string (not `new URL(literal, import.meta.url)`) so Vite treats this as
// a Node worker_threads worker and leaves bundling to the electron lib entry, which emits the
// worker beside main.js in dist-electron.
function workerEntryPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'pointcloud-index.worker.js');
}

export interface RunIndexBuildParams {
  sourcePath: string;
  outDir: string;
  fileName: string;
  sourceFingerprint: { headerSha256: string; fileSize: number; mtimeMs: number | null };
  generatorVersion: string;
  nodeCapacity?: number;
  maxDepth?: number;
}

export interface RunIndexBuildHooks {
  onProgress?: (label: string, pct: number | null) => void;
  signal?: AbortSignal;
}

export type RunIndexBuild = (params: RunIndexBuildParams, hooks: RunIndexBuildHooks) => Promise<BuildPointCloudIndexResult>;

export type IndexWorkerInbound = { type: 'cancel' };
export type IndexWorkerOutbound =
  | { type: 'progress'; label: string; pct: number | null }
  | { type: 'result'; ok: true; result: BuildPointCloudIndexResult }
  | { type: 'result'; ok: false; error: string; cancelled: boolean };

/** In-process build. Yields between chunks so the main event loop stays responsive. */
export const inlineIndexBuild: RunIndexBuild = async (params, hooks) => {
  const source = await createFileChunkSource(params.sourcePath);
  return buildPointCloudIndex({
    source,
    outDir: params.outDir,
    fileName: params.fileName,
    sourceFingerprint: params.sourceFingerprint,
    generatorVersion: params.generatorVersion,
    onProgress: hooks.onProgress,
    shouldCancel: () => hooks.signal?.aborted ?? false,
    nodeCapacity: params.nodeCapacity,
    maxDepth: params.maxDepth,
  });
};

/** Worker-thread build with an inline fallback for worker-infra failures. */
export function createWorkerIndexBuild(): RunIndexBuild {
  return (params, hooks) =>
    new Promise<BuildPointCloudIndexResult>((resolve, reject) => {
      let worker: Worker;
      try {
        worker = new Worker(workerEntryPath(), { workerData: params });
      } catch {
        inlineIndexBuild(params, hooks).then(resolve, reject);
        return;
      }

      let settled = false;
      const onAbort = () => worker.postMessage({ type: 'cancel' } satisfies IndexWorkerInbound);
      const detach = () => hooks.signal?.removeEventListener('abort', onAbort);
      if (hooks.signal) {
        if (hooks.signal.aborted) onAbort();
        else hooks.signal.addEventListener('abort', onAbort);
      }

      worker.on('message', (msg: IndexWorkerOutbound) => {
        if (msg.type === 'progress') {
          hooks.onProgress?.(msg.label, msg.pct);
          return;
        }
        if (msg.type === 'result') {
          settled = true;
          detach();
          void worker.terminate();
          if (msg.ok) resolve(msg.result);
          else if (msg.cancelled) reject(new PointCloudIndexCancelled());
          else reject(new Error(msg.error));
        }
      });

      worker.on('error', () => {
        if (settled) return;
        settled = true;
        detach();
        void worker.terminate();
        inlineIndexBuild(params, hooks).then(resolve, reject);
      });

      worker.on('exit', (code) => {
        if (settled) return;
        settled = true;
        detach();
        if (code === 0) reject(new Error('Index worker exited before returning a result.'));
        else inlineIndexBuild(params, hooks).then(resolve, reject);
      });
    });
}
