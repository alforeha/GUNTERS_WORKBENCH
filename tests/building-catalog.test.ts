// tests/building-catalog.test.ts - the beta Buildings catalog: envelope
// template registration through the shared template catalog, roof-type/param
// coverage, and the hosted-feature defaults.

import { describe, expect, it } from 'vitest'
import {
  BUILDING_ENVELOPE_TEMPLATE_ID,
  BUILDING_FACE_FEATURE_TYPES,
  BUILDING_ROOF_TYPES,
  defaultFaceFeatureSize,
  emptyBuildingComponents,
  faceFeatureTypeLabel,
  faceKindLabel,
} from '../src/shared/building-catalog'
import { getTemplate, templatesForFamily } from '../src/shared/template-catalog'

describe('building envelope template registration', () => {
  it('registers building.envelope in the shared catalog as the first building option', () => {
    const template = getTemplate(BUILDING_ENVELOPE_TEMPLATE_ID)
    expect(template).not.toBeNull()
    expect(template).toMatchObject({ family: 'building', subtype: 'envelope', displayName: 'Building (envelope)' })
    // First in family order so the add picker defaults to the envelope flow.
    expect(templatesForFamily('building')[0]!.id).toBe(BUILDING_ENVELOPE_TEMPLATE_ID)
  })

  it('exposes roof type as a parameter covering all six beta roof forms', () => {
    const template = getTemplate(BUILDING_ENVELOPE_TEMPLATE_ID)!
    const roofType = template.paramSchema.find((param) => param.name === 'roofType')
    expect(roofType?.type).toBe('enum')
    expect(roofType?.options).toEqual(['flat', 'gable', 'hip', 'shed', 'complex', 'unknown'])
    expect(roofType?.default).toBe('unknown')
    expect(BUILDING_ROOF_TYPES).toHaveLength(6)
  })

  it('carries the building-level fields: use, materials, levels, elevations, source, notes', () => {
    const template = getTemplate(BUILDING_ENVELOPE_TEMPLATE_ID)!
    const names = template.paramSchema.map((param) => param.name)
    for (const expected of [
      'buildingUse',
      'roofMaterial',
      'wallMaterial',
      'numberOfLevels',
      'baseElevation',
      'finishedFloorElevation',
      'eaveElevation',
      'ridgeElevation',
      'topElevation',
      'sourceType',
      'notes',
    ]) {
      expect(names, expected).toContain(expected)
    }
    // Optional elevations are free-text so "unset" stays honest (no fake 0).
    const eave = template.paramSchema.find((param) => param.name === 'eaveElevation')
    expect(eave?.type).toBe('string')
    expect(eave?.default).toBe('')
  })

  it('names the envelope/face/roof/feature CAD line sets and reports area', () => {
    const template = getTemplate(BUILDING_ENVELOPE_TEMPLATE_ID)!
    expect(template.cad?.layers).toMatchObject({
      envelope: 'BLDG-ENVELOPE',
      face: 'BLDG-FACE',
      roof: 'BLDG-ROOF',
      feature: 'BLDG-FEATURE',
    })
    expect(template.report?.quantityKind).toBe('area')
  })
})

describe('component definitions', () => {
  it('labels all face kinds and hosted-feature types', () => {
    expect(faceKindLabel('wall')).toBe('Wall')
    expect(faceKindLabel('roof')).toBe('Roof plane')
    expect(faceKindLabel('bogus')).toBe('Face')
    expect(faceFeatureTypeLabel('door')).toBe('Door')
    expect(faceFeatureTypeLabel('chimney')).toBe('Chimney')
    expect(faceFeatureTypeLabel('bogus')).toBe('Feature')
    expect(BUILDING_FACE_FEATURE_TYPES).toEqual(['door', 'window', 'chimney', 'vent', 'opening', 'generic'])
  })

  it('gives every hosted-feature type positive default dimensions', () => {
    for (const type of BUILDING_FACE_FEATURE_TYPES) {
      const size = defaultFaceFeatureSize(type)
      expect(size.width, type).toBeGreaterThan(0)
      expect(size.height, type).toBeGreaterThan(0)
      expect(size.depth, type).toBeGreaterThan(0)
    }
    // Doors are person-sized, windows sit above sills - spot-check the two flagship types.
    expect(defaultFaceFeatureSize('door')).toEqual({ width: 3, height: 7, depth: 0.5 })
    expect(defaultFaceFeatureSize('window')).toEqual({ width: 3, height: 4, depth: 0.5 })
  })

  it('starts a building with empty component lists', () => {
    expect(emptyBuildingComponents()).toEqual({ faces: [], faceFeatures: [] })
  })
})
