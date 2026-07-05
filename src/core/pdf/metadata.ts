import type { ImportReport, PdfDocumentDataset, PdfPageInfo, SourceMeta } from '../contract';

export interface PdfMetadataInput {
  fileName: string;
  pageCount: number;
  pages: PdfPageInfo[];
  title: string | null;
  creator: string | null;
  producer: string | null;
  creationDate: string | null;
  modificationDate: string | null;
}

export function sourceMetaForPdf(fileName: string): SourceMeta {
  return {
    fileName,
    format: 'pdf',
    units: { linear: 'unknown', raw: 'pdf-page-units' },
  };
}

export function reportForPdf(input: PdfMetadataInput): ImportReport {
  const report: ImportReport = {
    counts: {
      pages: input.pageCount,
    },
    triangulationPreserved: false,
    warnings: [],
    infos: [],
    unknownElements: {},
  };
  report.infos.push(`${input.pageCount.toLocaleString()} page${input.pageCount === 1 ? '' : 's'}`);
  for (const page of input.pages) {
    report.infos.push(
      `page ${page.pageIndex + 1}: ${page.widthPx150.toLocaleString()} x ${page.heightPx150.toLocaleString()} px at 150 DPI`,
    );
    if (Math.max(page.widthPx150, page.heightPx150) > 4096) {
      report.warnings.push(
        `page ${page.pageIndex + 1} exceeds 4096 px at 150 DPI; tiled texture decode is required`,
      );
    }
  }
  if (input.title) report.infos.push(`title: ${input.title}`);
  if (input.creator) report.infos.push(`creator: ${input.creator}`);
  if (input.producer) report.infos.push(`producer: ${input.producer}`);
  if (input.creationDate) report.infos.push(`created: ${input.creationDate}`);
  if (input.modificationDate) report.infos.push(`modified: ${input.modificationDate}`);
  return report;
}

export function buildPdfDataset(input: PdfMetadataInput): PdfDocumentDataset {
  return {
    id: `pdf:${input.fileName}`,
    name: input.fileName,
    meta: sourceMetaForPdf(input.fileName),
    pageCount: input.pageCount,
    pages: input.pages,
    title: input.title,
    creator: input.creator,
    producer: input.producer,
    creationDate: input.creationDate,
    modificationDate: input.modificationDate,
    report: reportForPdf(input),
  };
}
