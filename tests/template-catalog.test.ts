// tests/template-catalog.test.ts - the seed template catalog: exact family
// coverage per the Create Sim v1 handoff, structural invariants (id naming,
// param defaults inside bounds), and read-only enforcement (no template
// editor exists; the catalog must be immutable at runtime).

import { describe, expect, it } from 'vitest'
import {
  TEMPLATE_CATALOG,
  TEMPLATE_CATALOG_VERSION,
  getTemplate,
  templatesForFamily,
} from '../src/shared/template-catalog'

function subtypes(family: Parameters<typeof templatesForFamily>[0]): string[] {
  return templatesForFamily(family).map((template) => template.subtype).sort()
}

describe('catalog coverage', () => {
  it('is version 1 and non-empty', () => {
    expect(TEMPLATE_CATALOG_VERSION).toBe(1)
    expect(TEMPLATE_CATALOG.length).toBeGreaterThan(0)
  })

  it('seeds exactly the handoff subtype lists per family', () => {
    expect(subtypes('region')).toEqual(
      ['grass', 'pavement', 'gravel', 'dirt', 'concrete', 'landscape', 'water', 'unknown'].sort(),
    )
    expect(subtypes('object')).toEqual(
      ['tree', 'sign', 'pole', 'hydrant', 'valve', 'manhole', 'inlet', 'generic'].sort(),
    )
    expect(subtypes('building')).toEqual(['flat', 'gable', 'hip'].sort())
    expect(subtypes('line')).toEqual(
      ['curb', 'flowline', 'ridge', 'ditch', 'wall-top', 'wall-bottom', 'edge-of-pavement', 'fence'].sort(),
    )
    expect(subtypes('marker')).toEqual(['generic', 'spot-elevation', 'control-point', 'note'].sort())
  })

  it('seeds no utility or measurement templates in v1', () => {
    expect(templatesForFamily('utility')).toEqual([])
    expect(templatesForFamily('measurement')).toEqual([])
  })
})

describe('catalog structural invariants', () => {
  it('has unique ids of the form family.subtype', () => {
    const ids = TEMPLATE_CATALOG.map((template) => template.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of TEMPLATE_CATALOG) {
      expect(template.id).toBe(`${template.family}.${template.subtype}`)
      expect(template.displayName.length).toBeGreaterThan(0)
    }
  })

  it('keeps every param default inside its bounds with a type-matched default', () => {
    for (const template of TEMPLATE_CATALOG) {
      for (const param of template.paramSchema) {
        const label = `${template.id}.${param.name}`
        if (param.type === 'number') {
          expect(typeof param.default, label).toBe('number')
          if (param.min !== undefined) expect(param.default as number, label).toBeGreaterThanOrEqual(param.min)
          if (param.max !== undefined) expect(param.default as number, label).toBeLessThanOrEqual(param.max)
        } else if (param.type === 'boolean') {
          expect(typeof param.default, label).toBe('boolean')
        } else {
          expect(typeof param.default, label).toBe('string')
        }
        if (param.type === 'enum') {
          expect(param.options, label).toBeDefined()
          expect(param.options, label).toContain(param.default)
        }
      }
    }
  })

  it('gives every region an area quantity, hatch reference, and drape default', () => {
    for (const template of templatesForFamily('region')) {
      expect(template.report?.quantityKind, template.id).toBe('area')
      expect(template.cad?.hatch, template.id).toBeTruthy()
      const heightBehavior = template.paramSchema.find((param) => param.name === 'heightBehavior')
      expect(heightBehavior?.default, template.id).toBe('drape')
    }
  })

  it('flags every line except fence as a breakline by default', () => {
    for (const template of templatesForFamily('line')) {
      const flag = template.paramSchema.find((param) => param.name === 'isBreakline')
      expect(flag?.default, template.id).toBe(template.subtype !== 'fence')
    }
  })
})

describe('catalog access + immutability', () => {
  it('looks up templates by id and returns null for unknown ids', () => {
    expect(getTemplate('region.grass')?.subtype).toBe('grass')
    expect(getTemplate('region.asphalt')).toBeNull()
  })

  it('is deep-frozen: templates and param specs reject mutation', () => {
    expect(Object.isFrozen(TEMPLATE_CATALOG)).toBe(true)
    for (const template of TEMPLATE_CATALOG) {
      expect(Object.isFrozen(template), template.id).toBe(true)
      expect(Object.isFrozen(template.paramSchema), template.id).toBe(true)
    }
    expect(() => {
      ;(TEMPLATE_CATALOG[0] as { displayName: string }).displayName = 'hacked'
    }).toThrow()
  })
})
