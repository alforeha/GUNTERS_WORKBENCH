import type { Boundary, Breakline, Polyline3D, SourceMeta, SurfaceModel } from '../contract';

export interface SurfaceExportSummary {
  modifiedVertexCount: number | null;
  modified: boolean;
}

export interface LandXMLWriteOptions {
  appName?: string;
  surfaceSummaries?: Record<string, SurfaceExportSummary | undefined>;
}

export interface LandXMLWriteStats {
  surfaceCount: number;
  points: number;
  faces: number;
  breaklines: number;
  boundaries: number;
  contours: number;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8"?>';
const LANDXML_CLOSE = '</LandXML>';

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatNumber(value: number, precisionHint: number): string {
  return value.toFixed(Math.max(0, precisionHint));
}

function landXmlOpenTag(): string {
  const now = new Date();
  const date = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('-');
  const time = [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join(':');
  return `<LandXML version="1.2" xmlns="http://www.landxml.org/schema/LandXML-1.2" date="${date}" time="${time}">`;
}

function unitsTag(units: SourceMeta['units']): string {
  const linearUnit = escapeXml(units.raw || units.linear);
  if (units.linear === 'meter') return `<Units><Metric linearUnit="${linearUnit}"/></Units>`;
  return `<Units><Imperial linearUnit="${linearUnit}"/></Units>`;
}

function writePntList3D(pts: Float64Array, precisionHint: number): string {
  const values: string[] = [];
  for (let i = 0; i < pts.length; i += 3) {
    values.push(
      formatNumber(pts[i + 1]!, precisionHint),
      formatNumber(pts[i]!, precisionHint),
      formatNumber(pts[i + 2]!, precisionHint),
    );
  }
  return `<PntList3D>${values.join(' ')}</PntList3D>`;
}

function writePolylines(tagName: string, items: Polyline3D[], precisionHint: number): string {
  if (items.length === 0) return '';
  return `<${tagName}>${items.map((item) => `<Contour>${writePntList3D(item.pts, precisionHint)}</Contour>`).join('')}</${tagName}>`;
}

function writeBoundaries(boundaries: Boundary[], precisionHint: number): string {
  if (boundaries.length === 0) return '';
  return `<Boundaries>${boundaries
    .map((boundary) => `<Boundary bndType="${boundary.kind}">${writePntList3D(boundary.pts, precisionHint)}</Boundary>`)
    .join('')}</Boundaries>`;
}

function writeBreaklines(breaklines: Breakline[], precisionHint: number): string {
  const specBreaklines = breaklines.filter((item) => item.sourceSpelling === 'spec-breaklines');
  if (specBreaklines.length === 0) return '';
  return `<SourceData><Breaklines>${specBreaklines
    .map((breakline) => `<Breakline>${writePntList3D(breakline.pts, precisionHint)}</Breakline>`)
    .join('')}</Breaklines></SourceData>`;
}

function writePoints(surface: SurfaceModel): string {
  const points: string[] = [];
  for (let vertexId = 0; vertexId < surface.sourcePointIds.length; vertexId++) {
    const offset = vertexId * 3;
    points.push(
      `<P id="${surface.sourcePointIds[vertexId]!}">` +
        `${formatNumber(surface.positions[offset + 1]!, surface.precisionHint)} ` +
        `${formatNumber(surface.positions[offset]!, surface.precisionHint)} ` +
        `${formatNumber(surface.positions[offset + 2]!, surface.precisionHint)}` +
        `</P>`,
    );
  }
  return `<Pnts>${points.join('')}</Pnts>`;
}

function writeFaces(surface: SurfaceModel): string {
  if (!surface.indices || surface.indices.length === 0) return '';
  const faces: string[] = [];
  for (let faceIndex = 0; faceIndex < surface.indices.length; faceIndex += 3) {
    const a = surface.sourcePointIds[surface.indices[faceIndex]!]!;
    const b = surface.sourcePointIds[surface.indices[faceIndex + 1]!]!;
    const c = surface.sourcePointIds[surface.indices[faceIndex + 2]!]!;
    const invisible = surface.faceVisibility?.[faceIndex / 3] === 0 ? ' i="1"' : '';
    faces.push(`<F${invisible}>${a} ${b} ${c}</F>`);
  }
  return `<Faces>${faces.join('')}</Faces>`;
}

function provenanceComment(surface: SurfaceModel, summary: SurfaceExportSummary | undefined, appName: string): string {
  const triangulation =
    surface.provenance === 'source-explicit'
      ? 'triangulation preserved from source'
      : 'triangulation rebuilt';
  let status = 'no changes';
  if (summary?.modifiedVertexCount !== null && summary?.modifiedVertexCount !== undefined) {
    status =
      summary.modifiedVertexCount > 0
        ? `${summary.modifiedVertexCount} ${summary.modifiedVertexCount === 1 ? 'vertex' : 'vertices'} modified`
        : 'no changes';
  } else if (summary?.modified || surface.dirty) {
    status = 'surface modified';
  }
  return `<!-- exported by ${escapeXml(appName)}; ${status}; ${triangulation} -->`;
}

function writeSurface(surface: SurfaceModel, summary: SurfaceExportSummary | undefined, appName: string): string {
  return (
    `<Surface name="${escapeXml(surface.name)}">` +
    provenanceComment(surface, summary, appName) +
    `<Definition surfType="TIN">` +
    writePoints(surface) +
    writeFaces(surface) +
    writeBreaklines(surface.breaklines, surface.precisionHint) +
    writePolylines('Contours', surface.contours ?? [], surface.precisionHint) +
    writeBoundaries(surface.boundaries, surface.precisionHint) +
    `</Definition>` +
    `</Surface>`
  );
}

export function writeLandXML(
  surfaces: SurfaceModel | SurfaceModel[],
  opts: LandXMLWriteOptions = {},
): { xml: string; stats: LandXMLWriteStats } {
  const list = Array.isArray(surfaces) ? surfaces : [surfaces];
  if (list.length === 0) throw new Error('writeLandXML requires at least one surface');
  const primary = list[0]!;
  const appName = opts.appName ?? 'gunters.app TIN editor';
  const stats: LandXMLWriteStats = {
    surfaceCount: list.length,
    points: 0,
    faces: 0,
    breaklines: 0,
    boundaries: 0,
    contours: 0,
  };
  const xml =
    XML_HEADER +
    landXmlOpenTag() +
    unitsTag(primary.meta.units) +
    `<Project name="${escapeXml(primary.name)}"/>` +
    `<Application name="${escapeXml(appName)}" version="0.1.0"/>` +
    `<Surfaces>` +
    list
      .map((surface) => {
        stats.points += surface.sourcePointIds.length;
        stats.faces += surface.indices ? surface.indices.length / 3 : 0;
        stats.breaklines += surface.breaklines.filter((item) => item.sourceSpelling === 'spec-breaklines').length;
        stats.boundaries += surface.boundaries.length;
        stats.contours += surface.contours?.length ?? 0;
        return writeSurface(surface, opts.surfaceSummaries?.[surface.id], appName);
      })
      .join('') +
    `</Surfaces>` +
    LANDXML_CLOSE;
  return { xml, stats };
}
