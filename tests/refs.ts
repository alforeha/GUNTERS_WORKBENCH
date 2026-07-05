import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '_REFS');
const SEARCH_DIRS = [ROOT, join(ROOT, 'BATCH_1'), join(ROOT, 'BATCH_2')];

export function refPath(name: string): string {
  for (const dir of SEARCH_DIRS) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return join(ROOT, name);
}
