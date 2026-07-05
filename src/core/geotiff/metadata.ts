import type { GeotiffDataset, GeoTransform, ImportReport, RasterBounds, SourceMeta } from '../contract';

export interface ParsedWorldFile {
  scaleX: number;
  shearX: number;
  shearY: number;
  scaleY: number;
  originX: number;
  originY: number;
}

export interface GeotiffMetadataInput {
  fileName: string;
  width: number;
  height: number;
  samplesPerPixel: number;
  bitsPerSample: number[];
  tileWidth: number;
  tileHeight: number;
  isTiled: boolean;
  crsText: string | null;
  embeddedTransform: GeoTransform | null;
  worldFileTransform: GeoTransform | null;
}

function cleanCrsText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.replace(/\0/g, '').replace(/\|+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

export function parseWorldFile(text: string): ParsedWorldFile {
  const values = text
    .trim()
    .split(/\r?\n/)
    .map((line) => Number(line.trim()));
  if (values.length !== 6 || values.some((value) => !Number.isFinite(value))) {
    throw new Error('world file must contain 6 numeric lines');
  }
  const [scaleX, shearX, shearY, scaleY, originX, originY] = values;
  return {
    scaleX: scaleX!,
    shearX: shearX!,
    shearY: shearY!,
    scaleY: scaleY!,
    originX: originX!,
    originY: originY!,
  };
}

export function boundsFromTransform(
  width: number,
  height: number,
  transform: Pick<GeoTransform, 'origin' | 'pixelScale'>,
): RasterBounds {
  const [originX, originY] = transform.origin;
  const [scaleX, scaleY] = transform.pixelScale;
  const x2 = originX + scaleX * width;
  const y2 = originY + scaleY * height;
  return {
    minX: Math.min(originX, x2),
    minY: Math.min(originY, y2),
    maxX: Math.max(originX, x2),
    maxY: Math.max(originY, y2),
  };
}

export function sourceMetaForGeotiff(fileName: string, crsText: string | null): SourceMeta {
  const raw = cleanCrsText(crsText) ?? 'unknown';
  const lower = raw.toLowerCase();
  let linear: SourceMeta['units']['linear'] = 'unknown';
  if (lower.includes('ussurvey') || lower.includes('us survey') || lower.includes('ftus')) {
    linear = 'usSurveyFoot';
  } else if (lower.includes('foot') || lower.includes('feet') || lower.includes('ft')) {
    linear = 'foot';
  } else if (lower.includes('meter') || lower.includes('metre') || lower.includes('met')) {
    linear = 'meter';
  }
  return {
    fileName,
    format: 'geotiff',
    units: { linear, raw },
  };
}

export function reportForGeotiff(input: GeotiffMetadataInput): ImportReport {
  const transform = input.embeddedTransform ?? input.worldFileTransform;
  const report: ImportReport = {
    counts: {
      widthPx: input.width,
      heightPx: input.height,
      bands: input.samplesPerPixel,
    },
    triangulationPreserved: false,
    warnings: [],
    infos: [],
    unknownElements: {},
  };
  report.infos.push(
    `${input.width.toLocaleString()} x ${input.height.toLocaleString()} px`,
    `${input.samplesPerPixel} band${input.samplesPerPixel === 1 ? '' : 's'} · ${input.bitsPerSample.join('/')} bit`,
    `${input.isTiled ? 'tiled' : 'stripped'} storage · block ${input.tileWidth} x ${input.tileHeight} px`,
  );
  const crsText = cleanCrsText(input.crsText);
  if (crsText) report.infos.push(`CRS: ${crsText}`);
  if (transform) {
    report.infos.push(
      `pixel resolution ${Math.abs(transform.pixelScale[0]).toFixed(6)} x ${Math.abs(transform.pixelScale[1]).toFixed(6)}`,
    );
    if (transform.source === 'world-file' && !input.embeddedTransform) {
      report.warnings.push('embedded GeoTIFF transform missing — using companion world file');
    }
  } else {
    report.warnings.push(
      'No coordinate data found; file cannot be auto-placed. Manual placement will be available in a future update.',
    );
  }
  return report;
}

export function buildGeotiffDataset(input: GeotiffMetadataInput): GeotiffDataset {
  const transform = input.embeddedTransform ?? input.worldFileTransform;
  return {
    id: `geotiff:${input.fileName}`,
    name: input.fileName,
    meta: sourceMetaForGeotiff(input.fileName, input.crsText),
    width: input.width,
    height: input.height,
    samplesPerPixel: input.samplesPerPixel,
    bitsPerSample: input.bitsPerSample,
    tileWidth: input.tileWidth,
    tileHeight: input.tileHeight,
    isTiled: input.isTiled,
    crsText: cleanCrsText(input.crsText),
    geoTransform: transform,
    worldBounds: transform ? boundsFromTransform(input.width, input.height, transform) : null,
    report: reportForGeotiff(input),
  };
}
