import type { EvidenceRef, FeatureRecord } from './workbench-types'

export type RegionVisibilityKey = 'boundary' | 'surface' | 'surfacePoints' | 'breaklines' | 'edgeEvidence' | 'interiorEvidence' | 'wireframe'
export type RegionSurfacePointSource = 'manual' | 'generated-grid'
export type RegionGridMode = 'generated-flat'

export interface RegionVisibilityRecord {
  boundary: boolean
  surface: boolean
  surfacePoints: boolean
  breaklines: boolean
  edgeEvidence: boolean
  interiorEvidence: boolean
  wireframe: boolean
}

export interface RegionSurfacePointRecord {
  id: string
  coordinate: [number, number, number]
  source: RegionSurfacePointSource
  evidence?: EvidenceRef
}

export interface GeneratedRegionSurfaceRecord {
  positions: number[]
  indices: number[]
  generatedAt: string
  triangleCount: number
  minElevation: number | null
  maxElevation: number | null
  averageElevation: number | null
}

export interface RegionMetadataRecord {
  edgeEvidence: EvidenceRef[]
  interiorEvidence: EvidenceRef[]
  surfacePoints: RegionSurfacePointRecord[]
  surface: GeneratedRegionSurfaceRecord | null
  visibility: RegionVisibilityRecord
  gridSpacing: number
  gridMode: RegionGridMode
}

const DEFAULT_GRID_SPACING = 10

export function defaultRegionVisibility(): RegionVisibilityRecord {
  return {
    boundary: true,
    surface: true,
    surfacePoints: true,
    breaklines: true,
    edgeEvidence: false,
    interiorEvidence: false,
    wireframe: true,
  }
}

export function defaultRegionMetadata(): RegionMetadataRecord {
  return {
    edgeEvidence: [],
    interiorEvidence: [],
    surfacePoints: [],
    surface: null,
    visibility: defaultRegionVisibility(),
    gridSpacing: DEFAULT_GRID_SPACING,
    gridMode: 'generated-flat',
  }
}

function isVec3(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((axis) => typeof axis === 'number' && Number.isFinite(axis))
}

function cloneEvidenceRef(ref: EvidenceRef): EvidenceRef {
  return {
    ...ref,
    coordinate: [...ref.coordinate] as [number, number, number],
    ...(ref.sourceRGB ? { sourceRGB: [...ref.sourceRGB] as [number, number, number] } : {}),
  }
}

function isEvidenceRef(value: unknown): value is EvidenceRef {
  const ref = value as EvidenceRef | undefined
  return ref !== undefined && typeof ref.kind === 'string' && isVec3(ref.coordinate)
}

function evidenceList(value: unknown, fallback: EvidenceRef[] = []): EvidenceRef[] {
  if (!Array.isArray(value)) return fallback.map(cloneEvidenceRef)
  return value.filter(isEvidenceRef).map(cloneEvidenceRef)
}

function isSurfacePointRecord(value: unknown): value is RegionSurfacePointRecord {
  const point = value as RegionSurfacePointRecord | undefined
  return (
    point !== undefined &&
    typeof point.id === 'string' &&
    (point.source === 'manual' || point.source === 'generated-grid') &&
    isVec3(point.coordinate) &&
    (point.evidence === undefined || isEvidenceRef(point.evidence))
  )
}

function cloneSurfacePoint(point: RegionSurfacePointRecord): RegionSurfacePointRecord {
  return {
    ...point,
    coordinate: [...point.coordinate] as [number, number, number],
    ...(point.evidence ? { evidence: cloneEvidenceRef(point.evidence) } : {}),
  }
}

function isGeneratedSurface(value: unknown): value is GeneratedRegionSurfaceRecord {
  const surface = value as GeneratedRegionSurfaceRecord | undefined
  return (
    surface !== undefined &&
    surface !== null &&
    Array.isArray(surface.positions) &&
    surface.positions.every((entry) => typeof entry === 'number' && Number.isFinite(entry)) &&
    Array.isArray(surface.indices) &&
    surface.indices.every((entry) => Number.isInteger(entry) && entry >= 0) &&
    typeof surface.generatedAt === 'string' &&
    typeof surface.triangleCount === 'number' &&
    (surface.minElevation === null || Number.isFinite(surface.minElevation)) &&
    (surface.maxElevation === null || Number.isFinite(surface.maxElevation)) &&
    (surface.averageElevation === null || Number.isFinite(surface.averageElevation))
  )
}

function cloneSurface(surface: GeneratedRegionSurfaceRecord): GeneratedRegionSurfaceRecord {
  return {
    ...surface,
    positions: [...surface.positions],
    indices: [...surface.indices],
  }
}

function visibilityRecord(value: unknown): RegionVisibilityRecord {
  const raw = value as Partial<Record<RegionVisibilityKey, unknown>> | undefined
  const fallback = defaultRegionVisibility()
  return {
    boundary: raw?.boundary === undefined ? fallback.boundary : raw.boundary === true,
    surface: raw?.surface === undefined ? fallback.surface : raw.surface === true,
    surfacePoints: raw?.surfacePoints === undefined ? fallback.surfacePoints : raw.surfacePoints === true,
    breaklines: raw?.breaklines === undefined ? fallback.breaklines : raw.breaklines === true,
    edgeEvidence: raw?.edgeEvidence === undefined ? fallback.edgeEvidence : raw.edgeEvidence === true,
    interiorEvidence: raw?.interiorEvidence === undefined ? fallback.interiorEvidence : raw.interiorEvidence === true,
    wireframe: raw?.wireframe === undefined ? fallback.wireframe : raw.wireframe === true,
  }
}

export function readRegionMetadata(feature: FeatureRecord): RegionMetadataRecord {
  const raw = feature.metadata?.region as Partial<RegionMetadataRecord> | undefined
  const defaults = defaultRegionMetadata()
  return {
    edgeEvidence: evidenceList(raw?.edgeEvidence, feature.evidenceRefs ?? defaults.edgeEvidence),
    interiorEvidence: evidenceList(raw?.interiorEvidence, defaults.interiorEvidence),
    surfacePoints: Array.isArray(raw?.surfacePoints) ? raw.surfacePoints.filter(isSurfacePointRecord).map(cloneSurfacePoint) : [],
    surface: isGeneratedSurface(raw?.surface) ? cloneSurface(raw.surface) : null,
    visibility: visibilityRecord(raw?.visibility),
    gridSpacing:
      typeof raw?.gridSpacing === 'number' && Number.isFinite(raw.gridSpacing) && raw.gridSpacing > 0
        ? raw.gridSpacing
        : defaults.gridSpacing,
    gridMode: raw?.gridMode === 'generated-flat' ? raw.gridMode : defaults.gridMode,
  }
}

export function writeRegionMetadata(
  feature: FeatureRecord,
  region: RegionMetadataRecord,
): NonNullable<FeatureRecord['metadata']> {
  return {
    ...(feature.metadata ?? {}),
    region: {
      edgeEvidence: region.edgeEvidence.map(cloneEvidenceRef),
      interiorEvidence: region.interiorEvidence.map(cloneEvidenceRef),
      surfacePoints: region.surfacePoints.map(cloneSurfacePoint),
      surface: region.surface ? cloneSurface(region.surface) : null,
      visibility: { ...region.visibility },
      gridSpacing: region.gridSpacing,
      gridMode: region.gridMode,
    },
  }
}
