import { describe, expect, it } from 'vitest'
import { resolveDashboardWorkspaceState } from '../workspace-state'

describe('resolveDashboardWorkspaceState', () => {
  it('keeps an empty company on the dashboard instead of treating setup as required', () => {
    const state = resolveDashboardWorkspaceState({})

    expect(state.isEmptyWorkspace).toBe(true)
    expect(state.hasAccountingActivity).toBe(false)
    expect(state.onboardingProgress.hasBankConnected).toBe(false)
    expect(state.onboardingProgress.hasSIEImport).toBe(false)
  })

  it('uses real bank connections for bank status instead of transaction count', () => {
    const state = resolveDashboardWorkspaceState({
      bankConnectionCount: 1,
      transactionCount: 0,
    })

    expect(state.hasBankConnection).toBe(true)
    expect(state.onboardingProgress.hasBankConnected).toBe(true)
  })

  it('treats posted accounting data as real dashboard activity', () => {
    const state = resolveDashboardWorkspaceState({ postedEntriesCount: 1 })

    expect(state.hasAccountingActivity).toBe(true)
    expect(state.isEmptyWorkspace).toBe(false)
  })
})
