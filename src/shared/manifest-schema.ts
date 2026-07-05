import { z } from 'zod';

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
});

const simulationLayerSchema = z.object({
  id: z.string().min(1),
  simulationId: z.string().min(1),
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
