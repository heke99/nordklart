import { describe, expect, it } from 'vitest'
import {
  isSIEImportStatus,
  SIE_IMPORT_STATUSES,
  SIE_IMPORT_STATUS_LABELS,
  SIE_IMPORT_YEAR_END_BLOCKING_STATUSES,
} from '../sie-status'

describe('canonical SIE status model', () => {
  it('has a label for every status', () => {
    expect(Object.keys(SIE_IMPORT_STATUS_LABELS).sort()).toEqual(
      [...SIE_IMPORT_STATUSES].sort(),
    )
  })

  it('recognizes every canonical status and rejects unknown values', () => {
    for (const status of SIE_IMPORT_STATUSES) {
      expect(isSIEImportStatus(status)).toBe(true)
    }
    expect(isSIEImportStatus('done')).toBe(false)
  })

  it('keeps staged and all non-terminal problem states blocking', () => {
    expect(SIE_IMPORT_YEAR_END_BLOCKING_STATUSES).toContain('staged')
    expect(SIE_IMPORT_YEAR_END_BLOCKING_STATUSES).toContain('failed')
    expect(SIE_IMPORT_YEAR_END_BLOCKING_STATUSES).not.toContain('completed')
    expect(SIE_IMPORT_YEAR_END_BLOCKING_STATUSES).not.toContain('replaced')
    expect(SIE_IMPORT_YEAR_END_BLOCKING_STATUSES).not.toContain('undone')
  })
})
