// tests/feature-schema.test.ts - Create Sim schema widening: legacy feature
// records keep validating, the new fields validate and default correctly,
// evidence refs are kind-discriminated, exclusion zones are FK-checked, and
// the two design guardrails hold (features never carry truthStatus, assets
// never carry authorship, surfels are never source evidence).

import { describe, expect, it } from 'vitest'
import { evidenceRefSchema, projectManifestSchema } from '../src/shared/manifest-schema'
import type { EvidenceRef, ExclusionZoneRecord, FeatureRecord, ProjectManifest } from '../src/shared/workbench-types'
import { SIM_ID, SOURCE_ASSET_ID, SURFEL_ASSET_ID, makeFeature, makeManifest } from './ui-fixtures'

const STAMP = '2026-07-01T00:00:00.000Z'

function makeWidenedFeature(overrides: Partial<FeatureRecord> = {}): FeatureRecord {
  return {
    ...makeFeature('feat-region-1', 'polyline'),
    family: 'region',
    templateId: 'region.grass',
    subtype: 'grass',
    authorship: 'authored',
    confidence: 'high',
    lifecycleStatus: 'authored',
    evidenceRefs: [
      {
        kind: 'asset-point',
        coordinate: [100.5, 200.25, 31.75],
        assetId: SOURCE_ASSET_ID,
        sourceClass: 2,
        sourceRGB: [12000, 34000, 5600],
      },
    ],
    parameters: { verticalScale: 0.4, heightBehavior: 'drape' },
    representations: { cad: { layer: 'SURF-GRASS', hatch: 'GRASS' } },
    display: { visible: true },
    parentFeatureId: null,
    metadata: {},
    ...overrides,
  }
}

function makeZone(featureId: string, overrides: Partial<ExclusionZoneRecord> = {}): ExclusionZoneRecord {
  return {
    id: 'zone-1',
    simulationId: SIM_ID,
    featureId,
    polygon: [
      [0, 0, 0],
      [10, 0, 0],
      [10, 10, 0],
      [0, 10, 0],
    ],
    createdAt: STAMP,
    modifiedAt: STAMP,
    ...overrides,
  }
}

describe('featureSchema back-compat', () => {
  it('validates a legacy marker|polyline|measurement-only manifest unchanged', () => {
    const manifest = makeManifest({
      features: [makeFeature('feat-1', 'marker'), makeFeature('feat-2', 'polyline'), makeFeature('feat-3', 'measurement')],
    })
    const parsed = projectManifestSchema.safeParse(JSON.parse(JSON.stringify(manifest)))
    expect(parsed.success).toBe(true)
  })

  it('defaults evidenceRefs/parameters/metadata on legacy records', () => {
    const parsed = projectManifestSchema.safeParse(makeManifest({ features: [makeFeature('feat-1', 'marker')] }))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    const feature = parsed.data.features[0]!
    expect(feature.evidenceRefs).toEqual([])
    expect(feature.parameters).toEqual({})
    expect(feature.metadata).toEqual({})
  })
})

describe('widened feature fields', () => {
  it('validates a fully widened region record', () => {
    const parsed = projectManifestSchema.safeParse(makeManifest({ features: [makeWidenedFeature()] }))
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown family / authorship / lifecycleStatus', () => {
    const badFamily = makeWidenedFeature({ family: 'road' as FeatureRecord['family'] })
    expect(projectManifestSchema.safeParse(makeManifest({ features: [badFamily] })).success).toBe(false)

    const badAuthorship = makeWidenedFeature({ authorship: 'scanned' as FeatureRecord['authorship'] })
    expect(projectManifestSchema.safeParse(makeManifest({ features: [badAuthorship] })).success).toBe(false)

    const badLifecycle = makeWidenedFeature({ lifecycleStatus: 'deleted' as FeatureRecord['lifecycleStatus'] })
    expect(projectManifestSchema.safeParse(makeManifest({ features: [badLifecycle] })).success).toBe(false)
  })

  it('defaults display.visible to true when display is present but empty', () => {
    const feature = makeWidenedFeature({ display: {} as FeatureRecord['display'] })
    const parsed = projectManifestSchema.safeParse(makeManifest({ features: [feature] }))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.features[0]!.display?.visible).toBe(true)
  })
})

describe('evidenceRefSchema', () => {
  const kinds: EvidenceRef['kind'][] = [
    'picked-coordinate',
    'asset-point',
    'asset-vertex',
    'asset-edge',
    'surface-hit',
    'manual-note',
  ]

  it('accepts every documented kind with a bare coordinate', () => {
    for (const kind of kinds) {
      const parsed = evidenceRefSchema.safeParse({ kind, coordinate: [1, 2, 3] })
      expect(parsed.success, `kind ${kind}`).toBe(true)
    }
  })

  it('rejects an unknown kind', () => {
    expect(evidenceRefSchema.safeParse({ kind: 'surfel-point', coordinate: [1, 2, 3] }).success).toBe(false)
  })

  it('rejects a coordinate that is not an xyz tuple', () => {
    expect(evidenceRefSchema.safeParse({ kind: 'picked-coordinate', coordinate: [1, 2] }).success).toBe(false)
  })

  it('rejects a sourceRGB that is not a 3-tuple', () => {
    expect(
      evidenceRefSchema.safeParse({ kind: 'asset-point', coordinate: [1, 2, 3], sourceRGB: [1, 2] }).success,
    ).toBe(false)
  })

  it('accepts featureId provenance on authored-feature vertex/edge snaps', () => {
    const parsed = evidenceRefSchema.safeParse({ kind: 'asset-vertex', coordinate: [1, 2, 3], featureId: 'feat-1' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.featureId).toBe('feat-1')
  })

  it('keeps the note field on manual-note refs', () => {
    const parsed = evidenceRefSchema.safeParse({ kind: 'manual-note', coordinate: [1, 2, 3], note: 'paced off from fence' })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.kind === 'manual-note' && parsed.data.note).toBe('paced off from fence')
  })
})

describe('surfel evidence guardrail', () => {
  it('rejects evidence that records a surfel asset as source', () => {
    const feature = makeWidenedFeature({
      evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3], assetId: SURFEL_ASSET_ID }],
    })
    const parsed = projectManifestSchema.safeParse(makeManifest({ features: [feature] }))
    expect(parsed.success).toBe(false)
    if (parsed.success) return
    expect(JSON.stringify(parsed.error.issues)).toMatch(/surfel/i)
  })

  it('accepts evidence against the source cloud asset', () => {
    const feature = makeWidenedFeature({
      evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3], assetId: SOURCE_ASSET_ID }],
    })
    expect(projectManifestSchema.safeParse(makeManifest({ features: [feature] })).success).toBe(true)
  })

  it('allows a dangling evidence assetId (asset removed after authoring)', () => {
    const feature = makeWidenedFeature({
      evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3], assetId: 'asset-removed-later' }],
    })
    expect(projectManifestSchema.safeParse(makeManifest({ features: [feature] })).success).toBe(true)
  })
})

describe('exclusionZones', () => {
  function withZone(zone: ExclusionZoneRecord): ProjectManifest {
    const manifest = makeManifest({ features: [makeWidenedFeature({ id: 'feat-bldg-1', family: 'building' })] })
    manifest.exclusionZones = [zone]
    return manifest
  }

  it('accepts a zone linked to an existing feature in the singleton sim', () => {
    expect(projectManifestSchema.safeParse(withZone(makeZone('feat-bldg-1'))).success).toBe(true)
  })

  it('rejects a zone pointing at an unknown simulationId', () => {
    const parsed = projectManifestSchema.safeParse(withZone(makeZone('feat-bldg-1', { simulationId: 'sim-other' })))
    expect(parsed.success).toBe(false)
  })

  it('rejects a zone pointing at an unknown featureId', () => {
    expect(projectManifestSchema.safeParse(withZone(makeZone('feat-gone'))).success).toBe(false)
  })

  it('rejects a degenerate polygon (fewer than 3 vertices)', () => {
    const zone = makeZone('feat-bldg-1', {
      polygon: [
        [0, 0, 0],
        [10, 0, 0],
      ],
    })
    expect(projectManifestSchema.safeParse(withZone(zone)).success).toBe(false)
  })

  it('defaults exclusionZones to [] for legacy manifests missing the key', () => {
    const legacy = JSON.parse(JSON.stringify(makeManifest())) as Record<string, unknown>
    delete legacy.exclusionZones
    const parsed = projectManifestSchema.safeParse(legacy)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.exclusionZones).toEqual([])
  })
})

describe('design guardrails', () => {
  it('strips truthStatus from features (truth is an asset property)', () => {
    const tainted = { ...makeFeature('feat-1', 'marker'), truthStatus: 'source' } as unknown as FeatureRecord
    const parsed = projectManifestSchema.safeParse(makeManifest({ features: [tainted] }))
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.features[0]).not.toHaveProperty('truthStatus')
  })

  it('strips authorship from assets (authorship is a feature property)', () => {
    const manifest = makeManifest()
    ;(manifest.assets[0] as unknown as Record<string, unknown>).authorship = 'authored'
    const parsed = projectManifestSchema.safeParse(manifest)
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.assets[0]).not.toHaveProperty('authorship')
  })
})
