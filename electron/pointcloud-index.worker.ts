// electron/pointcloud-index.worker.ts — worker_threads entry that runs a WPI index build off
// the Electron-main event loop. Receives build params via workerData, streams progress back to
// the parent, and honors a 'cancel' message. Built by Vite as a sibling of main in dist-electron.

import { parentPort, workerData } from 'node:worker_threads';
import { buildPointCloudIndex } from './pointcloud-index-builder';
import { createFileChunkSource } from './file-chunk-source';
import type { IndexWorkerInbound, IndexWorkerOutbound, RunIndexBuildParams } from './pointcloud-index-runner';

const port = parentPort;
if (port) {
  let cancelled = false;
  port.on('message', (msg: IndexWorkerInbound) => {
    if (msg?.type === 'cancel') cancelled = true;
  });

  const params = workerData as RunIndexBuildParams;
  const post = (msg: IndexWorkerOutbound) => port.postMessage(msg);

  void (async () => {
    try {
      const source = await createFileChunkSource(params.sourcePath);
      const result = await buildPointCloudIndex({
        source,
        outDir: params.outDir,
        fileName: params.fileName,
        sourceFingerprint: params.sourceFingerprint,
        generatorVersion: params.generatorVersion,
        onProgress: (label, pct) => post({ type: 'progress', label, pct }),
        shouldCancel: () => cancelled,
        nodeCapacity: params.nodeCapacity,
        maxDepth: params.maxDepth,
      });
      post({ type: 'result', ok: true, result });
    } catch (err) {
      const isCancel = err instanceof Error && err.name === 'PointCloudIndexCancelled';
      post({ type: 'result', ok: false, error: err instanceof Error ? err.message : String(err), cancelled: isCancel });
    }
  })();
}
