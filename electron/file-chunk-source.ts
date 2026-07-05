// electron/file-chunk-source.ts — a bounded, seekable ChunkSource backed by a file on disk.
// Shared by the index builder's inline and worker-thread runners so neither loads whole
// files into memory. The source file is only ever read, never written.

import { open, stat } from 'node:fs/promises';
import type { ChunkSource } from '../src/workers/las.worker';

export async function createFileChunkSource(filePath: string): Promise<ChunkSource> {
  const stats = await stat(filePath);
  return {
    size: stats.size,
    async read(start: number, end: number): Promise<ArrayBuffer> {
      const handle = await open(filePath, 'r');
      try {
        const length = Math.max(0, end - start);
        const buffer = Buffer.alloc(length);
        let offset = 0;
        while (offset < length) {
          const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
          if (bytesRead <= 0) break;
          offset += bytesRead;
        }
        return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      } finally {
        await handle.close();
      }
    },
  };
}
