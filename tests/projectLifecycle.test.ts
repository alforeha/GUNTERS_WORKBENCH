import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ProjectService } from '../electron/project-service';
import { projectManifestSchema } from '../src/shared/manifest-schema';

describe('ProjectService lifecycle', () => {
  it('creates required folder structure and valid manifest', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const session = await svc.createProject({ parentDir: parent, projectName: 'P1' });

    for (const required of ['sources', 'derived', 'edited', 'exports', 'reports', 'history', 'cache']) {
      expect(existsSync(path.join(session.projectFolder, required))).toBe(true);
    }

    const parsed = projectManifestSchema.safeParse(session.manifest);
    expect(parsed.success).toBe(true);
    expect(session.manifest.realitySimulation.id).toBe('sim-primary');
  });

  it('updates backup on save and reloads cleanly', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P2' });

    created.manifest.info['note'] = 'saved once';
    const saved = await svc.saveProject(created.manifest);

    expect(existsSync(saved.backupPath)).toBe(true);

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder: saved.projectFolder });
    expect(reopened.manifest.info['note']).toBe('saved once');
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(false);
  });

  it('detects unclean save state from temp file', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P3' });

    await writeFile(path.join(created.projectFolder, 'project.json.tmp'), '{"partial":true}\n', 'utf8');
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.recoveryDetected).toBe(true);
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(true);
  });

  it('adds derived layer as flat membership and persists through reopen', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P4' });

    const generated = await svc.generatePlaceholderDerivedLayer();
    expect(generated.session.manifest.assets.some((a) => a.truthStatus === 'derived')).toBe(true);
    expect(generated.session.manifest.simulationLayers.length).toBe(1);
    expect(generated.session.manifest.simulationLayers[0]?.simulationId).toBe(
      generated.session.manifest.realitySimulation.id,
    );
    expect(generated.session.manifest.simulationLayers[0]?.status).toBe('active');

    await svc.closeProject();
    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.manifest.simulationLayers.length).toBe(1);
    const artifactPath = path.join(reopened.projectFolder, reopened.manifest.assets[0]?.managedPath ?? '');
    const artifactRaw = await readFile(artifactPath, 'utf8');
    expect(JSON.parse(artifactRaw).positions.length).toBeGreaterThan(0);

    const hydrated = await svc.readDerivedSurfaceArtifact(reopened.manifest.assets[0]?.managedPath ?? '');
    expect(hydrated.id).toBe(generated.surface.id);
    expect(hydrated.positions.length).toBe(generated.surface.positions.length);
    expect(hydrated.indices.length).toBe(generated.surface.indices.length);
  });

  it('rejects manifest shape that puts membership IDs inside realitySimulation', () => {
    const invalid = {
      schemaVersion: '1.0.0',
      info: {},
      crs: {},
      settings: {},
      standards: {},
      assets: [],
      groups: [],
      realitySimulation: {
        id: 'sim-primary',
        name: 'Primary',
        status: 'empty',
        mode: 'single-primary',
        phaseContext: 'scaffold',
        settings: {},
        warnings: [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        layerIds: ['bad'],
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

    const parsed = projectManifestSchema.safeParse(invalid);
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown top-level manifest keys', () => {
    const parsed = projectManifestSchema.safeParse({
      schemaVersion: '1.0.0',
      info: {},
      crs: {},
      settings: {},
      standards: {},
      assets: [],
      groups: [],
      realitySimulation: {
        id: 'sim-primary',
        name: 'Primary',
        status: 'empty',
        mode: 'single-primary',
        phaseContext: 'scaffold',
        settings: {},
        warnings: [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
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
      extraTopLevel: true,
    });

    expect(parsed.success).toBe(false);
  });

  it('treats an unparseable journal tail as unclean shutdown', async () => {
    const parent = await mkdtemp(path.join(tmpdir(), 'wb-'));
    const svc = new ProjectService();
    const created = await svc.createProject({ parentDir: parent, projectName: 'P5' });

    await writeFile(
      path.join(created.projectFolder, 'history', 'journal.log'),
      '{"event":"complete"}\n{"event":"intent"\n',
      'utf8',
    );
    await svc.closeProject();

    const reopened = await svc.openProject({ projectFolder: created.projectFolder });
    expect(reopened.recoveryDetected).toBe(true);
    expect(reopened.manifest.recovery.uncleanShutdown).toBe(true);
  });
});
