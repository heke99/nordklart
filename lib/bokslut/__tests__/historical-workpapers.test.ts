import { describe, expect, it } from 'vitest'
import {
  historicalWorkpaperSourceLabel,
  historicalWorkpaperStatusLabel,
  isAccountingErrorStatus,
  isCompletedStatus,
  isConfirmationStatus,
} from '@/lib/bokslut/historical-workpapers'

describe('historical year-end workpaper status model', () => {
  it('keeps imported SIE balances in the confirmation group', () => {
    expect(isConfirmationStatus('imported_from_sie')).toBe(true)
    expect(isAccountingErrorStatus('imported_from_sie')).toBe(false)
    expect(historicalWorkpaperStatusLabel('imported_from_sie')).toBe('Importerat från SIE')
  })

  it('distinguishes a real difference from a missing support register', () => {
    expect(isAccountingErrorStatus('actual_difference')).toBe(true)
    expect(isConfirmationStatus('actual_difference')).toBe(false)
    expect(historicalWorkpaperStatusLabel('actual_difference')).toBe('Verklig differens')
  })

  it('treats accepted SIE balances as completed without implying external evidence', () => {
    expect(isCompletedStatus('sie_balance_accepted')).toBe(true)
    expect(historicalWorkpaperStatusLabel('sie_balance_accepted')).toBe(
      'SIE-saldo accepterat',
    )
    expect(historicalWorkpaperSourceLabel('manual_confirmation')).toBe(
      'Manuell bekräftelse',
    )
    expect(historicalWorkpaperSourceLabel('external_evidence')).toBe(
      'Externt underlag',
    )
  })
})
