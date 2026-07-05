import type { ProjectManifest } from './workbench-types';
import { SCHEMA_VERSION } from './workbench-types';

function nowIso(): string {
  return new Date().toISOString();
}

export function createDefaultManifest(projectName: string): ProjectManifest {
  const now = nowIso();
  const simulationId = 'sim-primary';

  return {
    schemaVersion: SCHEMA_VERSION,
    info: {
      projectName,
      createdAt: now,
      modifiedAt: now,
    },
    crs: {},
    settings: {},
    standards: {},
    assets: [],
    groups: [],
    realitySimulation: {
      id: simulationId,
      name: 'Primary Reality Simulation',
      status: 'empty',
      mode: 'single-primary',
      phaseContext: 'scaffold',
      settings: {},
      warnings: [],
      createdAt: now,
      modifiedAt: now,
    },
    simulationLayers: [],
    features: [],
    reviewFlags: [],
    comparisonRefs: [],
    analysisResults: [],
    lineouts: [],
    reports: [],
    exports: [],
    recovery: {
      uncleanShutdown: false,
      lastIntentId: null,
      lastIntentAt: null,
      lastRecoveredAt: null,
    },
  };
}
