import { getTemplate, templatesForFamily, type TemplateParamSpec } from '../shared/template-catalog'
import { readRegionMetadata, type RegionVisibilityRecord } from '../shared/regionMetadata'
import type { FeatureRecord } from '../shared/workbench-types'
import { regionGeometryFromFeature, signedAreaXY } from '../viewer/regionGenerators'

export interface RegionEditorModel {
  templateId: string | null
  templateOptions: { id: string; label: string }[]
  visible: boolean
  focused: boolean
  visibility: RegionVisibilityRecord
  gridSpacing: string
  gridActionLabel: string
  gridBehaviorNote: string
  boundaryVertexCount: number
  breaklineCount: number
  breaklineVertexCount: number
  edgeEvidenceCount: number
  interiorEvidenceCount: number
  manualSurfacePointCount: number
  gridSurfacePointCount: number
  surfacePointCount: number
  surfaceInputCount: number
  areaLabel: string
  triangleCount: number
  minElevationLabel: string
  maxElevationLabel: string
  averageElevationLabel: string
  elevationRangeLabel: string
  generatedAt: string | null
  sourceSummary: { label: string; count: number }[]
  params: {
    name: string
    label: string
    value: string
    type: TemplateParamSpec['type']
    options?: string[]
    editable: boolean
  }[]
}

function formatMeasure(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '--'
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/\.?0+$/, '')
}

export function buildRegionEditorModel(feature: FeatureRecord, focused = true): RegionEditorModel | null {
  if (feature.family !== 'region') return null
  const template = feature.templateId ? getTemplate(feature.templateId) : null
  const metadata = readRegionMetadata(feature)
  const geometry = regionGeometryFromFeature(feature)
  const area = geometry?.closed ? Math.abs(signedAreaXY(geometry.border)) : 0
  const surface = metadata.surface
  const minElevation = surface?.minElevation ?? null
  const maxElevation = surface?.maxElevation ?? null
  const averageElevation = surface?.averageElevation ?? null
  const manualSurfacePointCount = metadata.surfacePoints.filter((point) => point.source === 'manual').length
  const gridSurfacePointCount = metadata.surfacePoints.filter((point) => point.source === 'generated-grid').length
  const breaklineVertexCount = (geometry?.breaklines ?? []).reduce((sum, line) => sum + line.length, 0)
  const sourceCounts = new Map<string, number>()
  for (const point of metadata.surfacePoints) {
    const label = point.source === 'generated-grid'
      ? 'Generated flat grid'
      : point.evidence?.kind === 'asset-point'
        ? 'Cloud-linked surface point'
        : point.evidence?.kind === 'asset-vertex' || point.evidence?.kind === 'asset-edge'
          ? 'Feature-linked surface point'
          : 'Manual / assumed surface point'
    sourceCounts.set(label, (sourceCounts.get(label) ?? 0) + 1)
  }
  if (geometry && geometry.breaklines.length > 0) {
    sourceCounts.set('Breakline vertices', (sourceCounts.get('Breakline vertices') ?? 0) + breaklineVertexCount)
  }
  if (metadata.edgeEvidence.length > 0) {
    sourceCounts.set('Boundary edge provenance refs', metadata.edgeEvidence.length)
  }
  const params = template
    ? template.paramSchema.map((param) => {
        const value = feature.parameters?.[param.name] ?? param.default
        return {
          name: param.name,
          label: param.label,
          value: String(value),
          type: param.type,
          ...(param.options ? { options: param.options } : {}),
          editable: true,
        }
      })
    : Object.entries(feature.parameters ?? {}).map(([name, value]) => ({
        name,
        label: name,
        value: String(value),
        type: 'string' as const,
        editable: false,
      }))
  return {
    templateId: feature.templateId ?? null,
    templateOptions: templatesForFamily('region').map((entry) => ({ id: entry.id, label: entry.displayName })),
    visible: feature.display?.visible !== false,
    focused,
    visibility: metadata.visibility,
    gridSpacing: String(metadata.gridSpacing),
    gridActionLabel: 'Add generated grid points',
    gridBehaviorNote: 'This beta pass generates flat grid samples at the current region average elevation. True cloud/index sampling is a next focused pass.',
    boundaryVertexCount: geometry?.border.length ?? 0,
    breaklineCount: geometry?.breaklines.length ?? 0,
    breaklineVertexCount,
    edgeEvidenceCount: metadata.edgeEvidence.length,
    interiorEvidenceCount: metadata.interiorEvidence.length,
    manualSurfacePointCount,
    gridSurfacePointCount,
    surfacePointCount: metadata.surfacePoints.length,
    surfaceInputCount: metadata.surfacePoints.length + (geometry?.breaklines.length ?? 0),
    areaLabel: formatMeasure(area),
    triangleCount: surface?.triangleCount ?? 0,
    minElevationLabel: formatMeasure(minElevation),
    maxElevationLabel: formatMeasure(maxElevation),
    averageElevationLabel: formatMeasure(averageElevation),
    elevationRangeLabel:
      minElevation !== null && maxElevation !== null ? formatMeasure(maxElevation - minElevation) : '--',
    generatedAt: surface?.generatedAt ?? null,
    sourceSummary: [...sourceCounts.entries()].map(([label, count]) => ({ label, count })),
    params,
  }
}
