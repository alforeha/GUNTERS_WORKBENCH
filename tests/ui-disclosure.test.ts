// tests/ui-disclosure.test.ts - the four-state disclosure lines that moved
// from the status panel into the viewer banner. Truth wording must survive
// the move: source / indexed-full / preview-sampled / derived / mixed.

import { describe, expect, it } from 'vitest'
import { buildIndexDisclosureLine, buildPreviewDisclosureLine } from '../src/ui/model'

const basePreview = {
  sampledPointCount: 1_200_000,
  totalPointCount: 12_400_000,
  warnings: [] as string[],
  sourceAvailable: true,
}

describe('buildPreviewDisclosureLine', () => {
  it('states sampled counts and preview-sampled truth', () => {
    const line = buildPreviewDisclosureLine(basePreview, 0)
    expect(line).toBe('Preview - sampled 1.2M of 12.4M points - truth preview-sampled; source asset remains source')
  })

  it('discloses the densification fallback as a mixed display', () => {
    const line = buildPreviewDisclosureLine(basePreview, 50_000)
    expect(line).toContain('source densification fallback')
    expect(line).toContain('truth preview-sampled')
  })

  it('does not claim mixed display when the source is unavailable', () => {
    const line = buildPreviewDisclosureLine({ ...basePreview, sourceAvailable: false }, 50_000)
    expect(line).not.toContain('densification fallback')
  })

  it('appends asset warnings', () => {
    const line = buildPreviewDisclosureLine({ ...basePreview, warnings: ['Unit mismatch: source units differ from project units.'] }, 0)
    expect(line).toContain('WARNING: Unit mismatch')
  })
})

describe('buildIndexDisclosureLine', () => {
  it('wraps the engine streaming text with the indexed-full truth statement', () => {
    const line = buildIndexDisclosureLine('Indexed-full - streaming 3.1M of 12.4M points - refining')
    expect(line).toBe(
      'Indexed-full - streaming 3.1M of 12.4M points - refining - truth indexed-full; source asset remains source',
    )
  })
})
