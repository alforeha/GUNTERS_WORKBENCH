import type { ImportReport, LasAttributeSummary, PointCloudBounds, PointCloudDataset, SourceMeta } from '../contract';

export interface LasMetadataInput {
  fileName: string;
  fileSize: number;
  header: ArrayBuffer;
  sample?: ArrayBuffer;
}

const HEADER_MIN_BYTES = 375;

function text(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i++) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

function emptyCounts(): Record<string, number> {
  return {};
}

function addCount(counts: Record<string, number>, key: number): void {
  counts[String(key)] = (counts[String(key)] ?? 0) + 1;
}

function pointFormatHasGpsTime(format: number): boolean {
  return format === 1 || format === 3 || format === 4 || format === 5 || format >= 6;
}

function pointFormatHasRgb(format: number): boolean {
  return format === 2 || format === 3 || format === 5 || format === 7 || format === 8 || format === 10;
}

function rgbOffset(format: number): number | null {
  if (format === 2 || format === 3 || format === 5) return pointFormatHasGpsTime(format) ? 28 : 20;
  if (format === 7 || format === 8 || format === 10) return 30;
  return null;
}

function defaultAttributes(pointFormat: number): LasAttributeSummary {
  return {
    hasIntensity: true,
    hasReturns: true,
    hasClassification: true,
    hasClassificationFlags: pointFormat >= 6,
    hasUserData: true,
    hasScanAngle: true,
    hasPointSourceId: true,
    hasGpsTime: pointFormatHasGpsTime(pointFormat),
    hasRgb: pointFormatHasRgb(pointFormat),
    intensityRange: null,
    rgbRange: null,
    sampledPoints: 0,
    classificationCounts: emptyCounts(),
    returnNumberCounts: emptyCounts(),
    numberOfReturnsCounts: emptyCounts(),
    userDataCounts: emptyCounts(),
  };
}

function readPointCount(view: DataView, versionMinor: number): number {
  if (versionMinor >= 4 && view.byteLength >= 255) return Number(view.getBigUint64(247, true));
  return view.getUint32(107, true);
}

function sourceMeta(fileName: string, version: string): SourceMeta {
  return {
    fileName,
    format: 'las',
    formatVersion: `LAS ${version}`,
    units: { linear: 'usSurveyFoot', raw: 'assumed project feet' },
  };
}

function buildReport(dataset: Omit<PointCloudDataset, 'report'>): ImportReport {
  const report: ImportReport = {
    counts: {
      points: dataset.pointCount,
      vlrs: dataset.vlrCount,
      pointFormat: dataset.pointFormat,
      pointRecordLength: dataset.pointRecordLength,
      sampledPoints: dataset.attributes.sampledPoints,
    },
    triangulationPreserved: false,
    warnings: [],
    infos: [],
    unknownElements: {},
  };
  const attrs = dataset.attributes;
  const present = [
    attrs.hasIntensity ? 'intensity' : null,
    attrs.hasReturns ? 'returns' : null,
    attrs.hasClassification ? 'classification' : null,
    attrs.hasClassificationFlags ? 'classification flags' : null,
    attrs.hasUserData ? 'user data' : null,
    attrs.hasScanAngle ? 'scan angle' : null,
    attrs.hasPointSourceId ? 'point source ID' : null,
    attrs.hasGpsTime ? 'GPS time' : null,
    attrs.hasRgb ? 'RGB' : null,
  ].filter(Boolean);
  report.infos.push(`attributes detected: ${present.join(', ')}`);
  if (dataset.pointFormat !== 7) report.warnings.push(`point format ${dataset.pointFormat} is not the Phase 5 reference format 7`);
  if (!attrs.hasRgb) report.warnings.push('RGB is not present in this LAS point format');
  if (dataset.pointDensityPerSqFt !== null) {
    report.infos.push(`average density ${dataset.pointDensityPerSqFt.toFixed(1)} points/sq ft from header bounds`);
  }
  return report;
}

export function parseLasMetadata(input: LasMetadataInput): PointCloudDataset {
  if (input.header.byteLength < HEADER_MIN_BYTES) throw new Error('LAS header is truncated');
  const view = new DataView(input.header);
  const signature = text(view, 0, 4);
  if (signature !== 'LASF') throw new Error('not a LAS file (missing LASF signature)');

  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const version = `${versionMajor}.${versionMinor}`;
  const headerSize = view.getUint16(94, true);
  const offsetToPointData = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const pointFormat = view.getUint8(104) & 0x3f;
  const pointRecordLength = view.getUint16(105, true);
  const pointCount = readPointCount(view, versionMinor);
  const scale: [number, number, number] = [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)];
  const offset: [number, number, number] = [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)];
  const bounds: PointCloudBounds = {
    maxX: view.getFloat64(179, true),
    minX: view.getFloat64(187, true),
    maxY: view.getFloat64(195, true),
    minY: view.getFloat64(203, true),
    maxZ: view.getFloat64(211, true),
    minZ: view.getFloat64(219, true),
  };
  const attributes = sampleAttributes(pointFormat, pointRecordLength, input.sample);
  const area = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
  const pointDensityPerSqFt = area > 0 ? pointCount / area : null;
  const base: Omit<PointCloudDataset, 'report'> = {
    id: `las:${input.fileName}`,
    name: input.fileName,
    meta: sourceMeta(input.fileName, version),
    lasVersion: version,
    pointFormat,
    pointRecordLength,
    pointCount,
    offsetToPointData,
    vlrCount,
    scale,
    offset,
    bounds,
    attributes,
    pointDensityPerSqFt,
  };
  if (headerSize > input.header.byteLength) throw new Error('LAS header size exceeds bytes read');
  return { ...base, report: buildReport(base) };
}

export function sampleAttributes(
  pointFormat: number,
  pointRecordLength: number,
  sample?: ArrayBuffer,
): LasAttributeSummary {
  const out = defaultAttributes(pointFormat);
  if (!sample || pointRecordLength <= 0) return out;
  const view = new DataView(sample);
  const points = Math.floor(view.byteLength / pointRecordLength);
  const rgbAt = rgbOffset(pointFormat);
  let minIntensity = Infinity;
  let maxIntensity = -Infinity;
  let minRgb: [number, number, number] = [Infinity, Infinity, Infinity];
  let maxRgb: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let rgbSeen = false;
  for (let i = 0; i < points; i++) {
    const o = i * pointRecordLength;
    const intensity = view.getUint16(o + 12, true);
    minIntensity = Math.min(minIntensity, intensity);
    maxIntensity = Math.max(maxIntensity, intensity);
    const returnByte = view.getUint8(o + 14);
    addCount(out.returnNumberCounts, pointFormat >= 6 ? returnByte & 0x0f : returnByte & 0x07);
    addCount(out.numberOfReturnsCounts, pointFormat >= 6 ? (returnByte >> 4) & 0x0f : (returnByte >> 3) & 0x07);
    const classification = pointFormat >= 6 ? view.getUint8(o + 16) : view.getUint8(o + 15) & 0x1f;
    addCount(out.classificationCounts, classification);
    const userDataOffset = pointFormat >= 6 ? 17 : 16;
    addCount(out.userDataCounts, view.getUint8(o + userDataOffset));
    if (rgbAt !== null && o + rgbAt + 5 < view.byteLength) {
      const rgb: [number, number, number] = [
        view.getUint16(o + rgbAt, true),
        view.getUint16(o + rgbAt + 2, true),
        view.getUint16(o + rgbAt + 4, true),
      ];
      minRgb = [Math.min(minRgb[0], rgb[0]), Math.min(minRgb[1], rgb[1]), Math.min(minRgb[2], rgb[2])];
      maxRgb = [Math.max(maxRgb[0], rgb[0]), Math.max(maxRgb[1], rgb[1]), Math.max(maxRgb[2], rgb[2])];
      rgbSeen = true;
    }
  }
  out.sampledPoints = points;
  if (points > 0) out.intensityRange = [minIntensity, maxIntensity];
  if (rgbSeen) out.rgbRange = [minRgb, maxRgb];
  return out;
}
