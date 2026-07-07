import { z } from 'zod';
import { POINT_CLOUD_INDEX_ASSET_KIND } from './pointcloud-index';
import { ANALYTIC_SURFEL_ASSET_KIND } from './analytic-surfels';

export const truthStatusSchema = z.enum([
  'source',
  'source-normalized',
  'preview-sampled',
  'indexed-full',
  'derived',
  'authored',
  'edited',
  'export',
]);

export const simulationLayerStatusSchema = z.enum(['active', 'hidden', 'error']);
export const simulationLayerKindSchema = z.enum([
  'asset',
  'point-cloud-preview',
  'point-cloud-index',
  'derived-surface',
  'derived-surfel',
]);

const boundsSchema = z.object({
  minX: z.number(),
  minY: z.number(),
  minZ: z.number(),
  maxX: z.number(),
  maxY: z.number(),
  maxZ: z.number(),
});

const xyzTupleSchema = z.tuple([z.number(), z.number(), z.number()]);

export const pointCloudIndexTypeSchema = z.literal('wpi-octree');

const pointCloudIndexSchema = z.object({
  sourceAssetId: z.string().min(1),
  indexType: pointCloudIndexTypeSchema,
  indexVersion: z.union([z.literal(1), z.literal(2)]),
  ownership: z.enum(['file-order', 'strided']).optional(),
  source: z.object({
    headerSha256: z.string().min(1),
    fileSize: z.number().nonnegative(),
    mtimeMs: z.number().nullable(),
    rgbEncoding: z.enum(['u16', 'u8-in-u16']).optional(),
  }),
  pointCount: z.number().nonnegative(),
  bounds: boundsSchema,
  scale: xyzTupleSchema,
  offset: xyzTupleSchema,
  units: z.string().min(1),
  generatedAt: z.string().min(1),
  generator: z.object({
    name: z.literal('workbench'),
    version: z.string().min(1),
  }),
});

const analyticSurfelSchema = z.object({
  sourceAssetId: z.string().min(1),
  indexAssetId: z.string().nullable(),
  surfelType: z.literal('analytic-surfel-octree'),
  surfelVersion: z.union([z.literal(1), z.literal(2)]),
  surfelCellScale: z.number().positive().optional(),
  source: z.object({
    headerSha256: z.string().min(1),
    fileSize: z.number().nonnegative(),
    mtimeMs: z.number().nullable(),
  }),
  surfelCount: z.number().nonnegative(),
  bounds: boundsSchema,
  generatedAt: z.string().min(1),
  generator: z.object({
    name: z.literal('workbench'),
    version: z.string().min(1),
  }),
});

const assetRecordSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  truthStatus: truthStatusSchema,
  importPolicy: z.enum(['copy', 'reference']),
  sourcePath: z.string().nullable(),
  managedPath: z.string().nullable(),
  units: z.string().nullable(),
  warnings: z.array(z.string()),
  hashes: z.object({
    sha256: z.string().optional(),
    importedAt: z.string().optional(),
    modifiedAt: z.string().optional(),
  }),
  pointCloud: z
    .object({
      format: z.enum(['las', 'laz']),
      extension: z.string().min(1),
      fileSize: z.number().nonnegative(),
      pointCount: z.number().nonnegative(),
      lasVersion: z.string().min(1),
      pointFormat: z.number().int().nonnegative(),
      pointRecordLength: z.number().int().positive(),
      bounds: boundsSchema,
      scale: xyzTupleSchema,
      offset: xyzTupleSchema,
      crsText: z.string().nullable(),
      unitsLinear: z.enum(['usSurveyFoot', 'foot', 'meter', 'unknown']),
      unitsRaw: z.string().min(1),
      headerSha256: z.string().min(1),
      rgbEncoding: z.enum(['u16', 'u8-in-u16']).optional(),
    })
    .optional(),
  pointCloudIndex: pointCloudIndexSchema.optional(),
  analyticSurfel: analyticSurfelSchema.optional(),
});

const simulationLayerSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  kind: simulationLayerKindSchema.default('asset'),
  name: z.string().min(1),
  status: simulationLayerStatusSchema,
  assetId: z.string().nullable(),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
});

const featureSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  type: z.enum(['marker', 'polyline', 'measurement']),
  name: z.string().min(1),
  geometry: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
});

const reviewFlagSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high']),
  message: z.string().min(1),
  status: z.enum(['open', 'resolved']),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
});

const comparisonRefSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  name: z.string().min(1),
  target: z.string().min(1),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
});

const analysisResultSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  name: z.string().min(1),
  summary: z.string().min(1),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
});

const realitySimulationSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: z.string().min(1),
    mode: z.string().min(1),
    phaseContext: z.string().min(1),
    settings: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
    createdAt: z.string().min(1),
    modifiedAt: z.string().min(1),
  })
  .strict();

export const projectManifestSchema = z
  .object({
    schemaVersion: z.string().min(1),
    info: z.record(z.string(), z.unknown()),
    crs: z.record(z.string(), z.unknown()),
    settings: z.record(z.string(), z.unknown()),
    standards: z.record(z.string(), z.unknown()),
    assets: z.array(assetRecordSchema),
    groups: z.array(z.record(z.string(), z.unknown())),
    realitySimulation: realitySimulationSchema,
    simulationLayers: z.array(simulationLayerSchema),
    features: z.array(featureSchema),
    reviewFlags: z.array(reviewFlagSchema),
    comparisonRefs: z.array(comparisonRefSchema),
    analysisResults: z.array(analysisResultSchema),
    lineouts: z.array(z.record(z.string(), z.unknown())),
    reports: z.array(z.record(z.string(), z.unknown())),
    exports: z.array(z.record(z.string(), z.unknown())),
    recovery: z.object({
      uncleanShutdown: z.boolean(),
      lastIntentId: z.string().nullable(),
      lastIntentAt: z.string().nullable(),
      lastRecoveredAt: z.string().nullable(),
    }),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    const simId = manifest.realitySimulation.id;
    const assetIds = new Set(manifest.assets.map((asset) => asset.id));

    for (const asset of manifest.assets) {
      // pointCloudIndex metadata is present exactly when the asset is a fully-indexed
      // point-cloud-index asset — truth and payload must never drift apart.
      const isIndexAsset = asset.kind === POINT_CLOUD_INDEX_ASSET_KIND && asset.truthStatus === 'indexed-full';
      if ((asset.pointCloudIndex !== undefined) !== isIndexAsset) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `asset ${asset.id}: pointCloudIndex metadata must be present exactly when kind is '${POINT_CLOUD_INDEX_ASSET_KIND}' and truthStatus is 'indexed-full'`,
        });
      }
      if (asset.pointCloudIndex && !assetIds.has(asset.pointCloudIndex.sourceAssetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `point-cloud index asset ${asset.id} references unknown sourceAssetId ${asset.pointCloudIndex.sourceAssetId}`,
        });
      }
      const isAnalyticSurfelAsset = asset.kind === ANALYTIC_SURFEL_ASSET_KIND && asset.truthStatus === 'derived';
      if ((asset.analyticSurfel !== undefined) !== isAnalyticSurfelAsset) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `asset ${asset.id}: analyticSurfel metadata must be present exactly when kind is '${ANALYTIC_SURFEL_ASSET_KIND}' and truthStatus is 'derived'`,
        });
      }
      if (asset.analyticSurfel && !assetIds.has(asset.analyticSurfel.sourceAssetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `analytic surfel asset ${asset.id} references unknown sourceAssetId ${asset.analyticSurfel.sourceAssetId}`,
        });
      }
      if (asset.analyticSurfel?.indexAssetId && !assetIds.has(asset.analyticSurfel.indexAssetId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `analytic surfel asset ${asset.id} references unknown indexAssetId ${asset.analyticSurfel.indexAssetId}`,
        });
      }
    }

    for (const layer of manifest.simulationLayers) {
      if (layer.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `simulationLayers entry ${layer.id} points to unknown simulationId`,
        });
      }
    }

    for (const feature of manifest.features) {
      if (feature.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `feature ${feature.id} points to unknown simulationId`,
        });
      }
    }

    for (const flag of manifest.reviewFlags) {
      if (flag.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `reviewFlag ${flag.id} points to unknown simulationId`,
        });
      }
    }

    for (const ref of manifest.comparisonRefs) {
      if (ref.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `comparisonRef ${ref.id} points to unknown simulationId`,
        });
      }
    }

    for (const result of manifest.analysisResults) {
      if (result.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `analysisResult ${result.id} points to unknown simulationId`,
        });
      }
    }
  });

export type ProjectManifestSchema = z.infer<typeof projectManifestSchema>;
