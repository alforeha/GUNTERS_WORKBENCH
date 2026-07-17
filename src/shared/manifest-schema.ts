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

// Exported so project open can quarantine (rather than fail on) derived surfel
// records this build cannot represent — see ProjectService.openProject.
export const analyticSurfelSchema = z.object({
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

export const featureFamilySchema = z.enum([
  'region',
  'object',
  'building',
  'utility',
  'line',
  'marker',
  'measurement',
]);
export const featureAuthorshipSchema = z.enum(['authored', 'assisted', 'derived', 'edited', 'imported']);
export const featureConfidenceSchema = z.enum(['low', 'medium', 'high']);
export const featureLifecycleStatusSchema = z.enum(['draft', 'authored', 'reviewed', 'flagged']);

// Evidence provenance for authored features. assetId is optional even on the
// asset-sourced kinds so that deleting an asset later leaves historical refs
// dangling-but-valid instead of bricking the manifest; the superRefine below
// only rejects refs that resolve to a surfel asset (surfels are never source
// evidence).
const evidenceRefFields = {
  coordinate: xyzTupleSchema,
  assetId: z.string().min(1).optional(),
  assetLayerId: z.string().min(1).optional(),
  /** Owning feature when the snap source was another authored feature (vertex/edge). */
  featureId: z.string().min(1).optional(),
  sourceClass: z.number().int().nonnegative().optional(),
  sourceRGB: z.tuple([z.number(), z.number(), z.number()]).optional(),
};

export const evidenceRefSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('picked-coordinate'), ...evidenceRefFields }),
  z.object({ kind: z.literal('asset-point'), ...evidenceRefFields }),
  z.object({ kind: z.literal('asset-vertex'), ...evidenceRefFields }),
  z.object({ kind: z.literal('asset-edge'), ...evidenceRefFields }),
  z.object({ kind: z.literal('surface-hit'), ...evidenceRefFields }),
  z.object({ kind: z.literal('manual-note'), ...evidenceRefFields, note: z.string().optional() }),
]);

const featureRepresentationsSchema = z.object({
  reality: z.record(z.string(), z.unknown()).optional(),
  cad: z.record(z.string(), z.unknown()).optional(),
  report: z.record(z.string(), z.unknown()).optional(),
  export: z.record(z.string(), z.unknown()).optional(),
});

const featureDisplaySchema = z.object({
  visible: z.boolean().default(true),
});

// Widened additively for Create Sim: every new field is optional or defaulted so
// legacy marker|polyline|measurement records keep validating unchanged. `family`
// is the new primary axis; `type` stays as the legacy/derivable axis. Features
// never carry truthStatus (that is an asset property).
export const featureSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  type: z.enum(['marker', 'polyline', 'measurement']),
  name: z.string().min(1),
  geometry: z.record(z.string(), z.unknown()),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
  family: featureFamilySchema.optional(),
  templateId: z.string().min(1).nullable().optional(),
  subtype: z.string().min(1).optional(),
  authorship: featureAuthorshipSchema.optional(),
  confidence: featureConfidenceSchema.optional(),
  lifecycleStatus: featureLifecycleStatusSchema.optional(),
  evidenceRefs: z.array(evidenceRefSchema).default([]),
  parameters: z.record(z.string(), z.unknown()).default({}),
  representations: featureRepresentationsSchema.optional(),
  display: featureDisplaySchema.optional(),
  parentFeatureId: z.string().min(1).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

// Ground-behavior exclusions owned by a feature (e.g. a building footprint).
// Lifecycle is tied to the owning feature: FK-checked in superRefine.
export const exclusionZoneSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
  featureId: z.string().min(1),
  name: z.string().min(1).optional(),
  polygon: z.array(xyzTupleSchema).min(3),
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
    exclusionZones: z.array(exclusionZoneSchema).default([]),
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
      // point-cloud-index asset - truth and payload must never drift apart.
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

    const surfelAssetIds = new Set(
      manifest.assets
        .filter((asset) => asset.kind === ANALYTIC_SURFEL_ASSET_KIND)
        .map((asset) => asset.id),
    );

    for (const feature of manifest.features) {
      if (feature.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `feature ${feature.id} points to unknown simulationId`,
        });
      }
      for (const ref of feature.evidenceRefs) {
        // Dangling assetIds are allowed (the asset may have been removed after
        // authoring); what is never allowed is evidence sourced from surfels.
        if (ref.assetId && surfelAssetIds.has(ref.assetId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `feature ${feature.id} records surfel asset ${ref.assetId} as evidence; surfels are derived and never source evidence`,
          });
        }
      }
    }

    const featureIds = new Set(manifest.features.map((feature) => feature.id));
    for (const zone of manifest.exclusionZones) {
      if (zone.simulationId !== simId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `exclusionZone ${zone.id} points to unknown simulationId`,
        });
      }
      if (!featureIds.has(zone.featureId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `exclusionZone ${zone.id} points to unknown featureId ${zone.featureId}`,
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
