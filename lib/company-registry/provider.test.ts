import { describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { lookupCompanyAtBolagsverket } from './provider'

describe('Bolagsverket company registry boundary', () => {
  it('does not make guessed third-party calls before approved configuration exists', async () => {
    await expect(lookupCompanyAtBolagsverket('5560125790')).resolves.toEqual({ available: false })
  })
})
