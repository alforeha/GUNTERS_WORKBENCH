// src/ui/utilityModel.test.ts - utility view-models: list rows, the
// system-filtered add picker, and the detail editor (point vs line split,
// same-geometry re-typing options).

import { describe, expect, it } from 'vitest'
import { makeManifest } from '../../tests/ui-fixtures'
import type { ProjectManifest } from '../shared/workbench-types'
import {
  buildUtilityAddModel,
  buildUtilityEditorModel,
  buildUtilityListModel,
  utilitySummary,
} from './utilityModel'

function addUtility(
  manifest: ProjectManifest,
  templateId: string,
  geometry: Record<string, unknown>,
  parameters: Record<string, unknown> = {},
): ProjectManifest['features'][number] {
  const subtype = templateId.split('.')[1]!
  const feature: ProjectManifest['features'][number] = {
    id: `feat-${subtype}`,
    simulationId: manifest.realitySimulation.id,
    type: geometry.vertices ? 'polyline' : 'marker',
    name: `Test ${subtype}`,
    geometry,
    createdAt: '2026-07-13T00:00:00.000Z',
    modifiedAt: '2026-07-13T00:00:00.000Z',
    family: 'utility',
    templateId,
    subtype,
    parameters,
    evidenceRefs: [{ kind: 'asset-point', coordinate: [1, 2, 3] }],
    display: { visible: true },
    metadata: {},
  }
  manifest.features.push(feature)
  return feature
}

describe('buildUtilityListModel', () => {
  it('maps utility features to rows with system/class labels and summaries', () => {
    const manifest = makeManifest()
    addUtility(manifest, 'utility.storm-manhole', { point: [0, 0, 100] }, { diameter: 4, depth: 8 })
    addUtility(
      manifest,
      'utility.storm-pipe',
      { vertices: [[0, 0, 90], [30, 40, 89]] },
      { pipeSize: 15, material: 'RCP' },
    )

    const rows = buildUtilityListModel(manifest)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({
      systemLabel: 'Storm',
      classLabel: 'Manhole',
      visible: true,
      snappedEvidenceCount: 1,
      freeEvidenceCount: 0,
    })
    expect(rows[0]!.summary).toContain('dia 4 x 8 deep')
    // 3-4-5 triangle: 50 lf plan run.
    expect(rows[1]!.summary).toContain('15" RCP')
    expect(rows[1]!.summary).toContain('2 pts - 50 lf')
  })

  it('ignores non-utility families', () => {
    const manifest = makeManifest()
    expect(buildUtilityListModel(manifest)).toHaveLength(0)
  })
})

describe('buildUtilityAddModel', () => {
  it('filters class options by the selected system', () => {
    const generic = buildUtilityAddModel('generic')
    expect(generic.systems.map((system) => system.id)).toEqual(['generic', 'storm'])
    expect(generic.classes.map((entry) => entry.templateId)).toContain('utility.generic-vault')
    expect(generic.classes.map((entry) => entry.templateId)).not.toContain('utility.storm-inlet')

    const storm = buildUtilityAddModel('storm')
    expect(storm.selectedSystemId).toBe('storm')
    expect(storm.classes.map((entry) => entry.templateId)).toEqual([
      'utility.storm-manhole',
      'utility.storm-inlet',
      'utility.storm-structure',
      'utility.storm-culvert',
      'utility.storm-pipe',
      'utility.storm-stub',
    ])
  })
})

describe('buildUtilityEditorModel', () => {
  it('gives point utilities a placement and point-class type options only', () => {
    const manifest = makeManifest()
    const feature = addUtility(manifest, 'utility.storm-manhole', { point: [10, 20, 100] }, { diameter: 4, depth: 8 })

    const editor = buildUtilityEditorModel(feature)
    expect(editor).toMatchObject({
      systemLabel: 'Storm',
      classLabel: 'Manhole',
      geometryKind: 'point',
      placement: { x: '10', y: '20', z: '100' },
      vertexCount: null,
      previewKind: 'manhole',
    })
    expect(editor!.originLabel).toContain('below-ground')
    const optionIds = editor!.typeOptions.map((option) => option.templateId)
    expect(optionIds).toContain('utility.generic-manhole')
    expect(optionIds).not.toContain('utility.storm-pipe')
  })

  it('gives line utilities run info and line-class type options only', () => {
    const manifest = makeManifest()
    const feature = addUtility(
      manifest,
      'utility.storm-pipe',
      { vertices: [[0, 0, 90], [30, 40, 89]] },
      { pipeSize: 15 },
    )

    const editor = buildUtilityEditorModel(feature)
    expect(editor).toMatchObject({ geometryKind: 'line', placement: null, vertexCount: 2 })
    expect(editor!.lengthLabel).toContain('50 lf')
    const optionIds = editor!.typeOptions.map((option) => option.templateId)
    expect(optionIds).toEqual(
      expect.arrayContaining(['utility.generic-pipe', 'utility.storm-culvert', 'utility.storm-stub']),
    )
    expect(optionIds).not.toContain('utility.storm-manhole')
  })

  it('returns null for non-utility features', () => {
    const manifest = makeManifest()
    const feature = addUtility(manifest, 'utility.storm-manhole', { point: [0, 0, 0] })
    expect(buildUtilityEditorModel({ ...feature, family: 'object' })).toBeNull()
  })
})

describe('utilitySummary', () => {
  it('flags stub runs as assumed and box runs by span x rise', () => {
    const manifest = makeManifest()
    const stub = addUtility(manifest, 'utility.storm-stub', { vertices: [[0, 0, 0], [10, 0, 0]] }, { pipeSize: 15 })
    expect(utilitySummary(stub)).toContain('assumed end')

    const box = addUtility(
      manifest,
      'utility.storm-culvert',
      { vertices: [[0, 0, 0], [10, 0, 0]] },
      { pipeShape: 'box', boxSpan: 6, boxRise: 4 },
    )
    expect(utilitySummary(box)).toContain('6x4 box')
  })
})
