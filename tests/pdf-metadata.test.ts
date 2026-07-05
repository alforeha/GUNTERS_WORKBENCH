import { describe, expect, it } from 'vitest';

import { buildPdfDataset } from '../src/core/pdf/metadata';

describe('PDF metadata helpers', () => {
  it('builds a PDF dataset and flags 150 DPI pages that need tiling', () => {
    const dataset = buildPdfDataset({
      fileName: 'A-BASIN TOPO-REVISED.pdf',
      pageCount: 1,
      pages: [
        {
          pageIndex: 0,
          widthPt: 2592,
          heightPt: 1728,
          widthPx150: 5400,
          heightPx150: 3601,
          rotation: 270,
        },
      ],
      title: 'COVERSHEET 24x36',
      creator: 'Carlson Survey 2024 2024 (24.1)',
      producer: 'pdfplot16.hdi 16.01.051.00000',
      creationDate: 'D:20251029171714',
      modificationDate: 'D:20251029171714',
    });

    expect(dataset.meta.format).toBe('pdf');
    expect(dataset.pageCount).toBe(1);
    expect(dataset.pages[0]?.widthPx150).toBe(5400);
    expect(dataset.report.counts.pages).toBe(1);
    expect(dataset.report.warnings).toContain('page 1 exceeds 4096 px at 150 DPI; tiled texture decode is required');
    expect(dataset.report.infos).toContain('title: COVERSHEET 24x36');
  });
});
