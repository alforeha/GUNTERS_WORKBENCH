import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectService } from '../electron/project-service.ts';
import { inlineIndexBuild } from '../electron/pointcloud-index-runner.ts';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const lasPath = args.find((arg) => !arg.startsWith('--'));
  const buildIndex = !args.includes('--skip-index');
  const surfelCellScaleArg = args.find((arg) => arg.startsWith('--surfel-cell-scale='));
  const surfelCellScale = surfelCellScaleArg ? Number(surfelCellScaleArg.split('=')[1]) : 1;
  if (!lasPath) {
    console.error('usage: npx tsx scripts/build-surfel-diag.mts <path-to-las> [--skip-index] [--surfel-cell-scale=<number>]');
    process.exitCode = 1;
    return;
  }

  const workRoot = await mkdtemp(path.join(tmpdir(), 'wb-surfel-diag-'));
  const service = new ProjectService({ runIndexBuild: inlineIndexBuild });
  const created = await service.createProject({ parentDir: workRoot, projectName: 'surfel-diag' });
  const imported = await service.importPointCloud({ filePath: lasPath, importPolicy: 'reference' });
  const sourceAsset = imported.manifest.assets.find((asset) => asset.kind === 'point-cloud');
  if (!sourceAsset) throw new Error('Failed to import point cloud source.');

  let indexMetrics: unknown = null;
  if (buildIndex) {
    console.log(`[surfel-diag] building index for ${lasPath}`);
    const indexed = await service.generatePointCloudIndex({ assetId: sourceAsset.id }, (progress) => {
      const pct = progress.pct === null ? '' : ` ${progress.pct}%`;
      console.log(`[index] ${progress.label}${pct}`);
    });
    indexMetrics = indexed.metrics;
  }

  console.log(`[surfel-diag] building analytic surfels for ${lasPath} (cell scale ${surfelCellScale})`);
  const surfels = await service.generateAnalyticSurfels({ assetId: sourceAsset.id, surfelCellScale }, (progress) => {
    const pct = progress.pct === null ? '' : ` ${progress.pct}%`;
    console.log(`[surfels] ${progress.label}${pct}`);
  });

  const summary = {
    projectFolder: created.projectFolder,
    sourceAssetId: sourceAsset.id,
    indexBuilt: buildIndex,
    surfelCellScale,
    indexMetrics,
    surfelAssetId: surfels.surfelAssetId,
    surfelMetrics: surfels.metrics,
  };
  console.log('[surfel-diag] summary');
  console.log(JSON.stringify(summary, null, 2));
}

void main().catch((error) => {
  console.error('[surfel-diag] failed');
  console.error(error);
  process.exitCode = 1;
});