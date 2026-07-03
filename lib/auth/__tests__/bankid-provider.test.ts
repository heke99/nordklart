import { describe, it, expect, beforeEach } from 'vitest'
import {
  mockBankIdProvider,
  formatQrData,
  getBankIdProvider,
  registerBankIdProvider,
  __resetMockBankIdSessions,
  type BankIdProvider,
} from '../bankid-provider'
import crypto from 'crypto'

describe('formatQrData', () => {
  it('follows the BankID animated QR spec', () => {
    const qr = formatQrData('token-1', 'secret-1', 3)
    const expectedHmac = crypto.createHmac('sha256', 'secret-1').update('3').digest('hex')
    expect(qr).toBe(`bankid.token-1.3.${expectedHmac}`)
  })

  it('clamps negative elapsed to 0', () => {
    expect(formatQrData('t', 's', -5).split('.')[2]).toBe('0')
  })
})

describe('mockBankIdProvider', () => {
  beforeEach(() => __resetMockBankIdSessions())

  it('completes an auth session on the second collect', async () => {
    const started = await mockBankIdProvider.startAuth({ endUserIp: '127.0.0.1' })
    expect(started.sessionRef).toMatch(/^mock-/)
    expect(started.qrStartToken).toBeTruthy()

    const first = await mockBankIdProvider.collect(started.sessionRef)
    expect(first.status).toBe('pending')

    const second = await mockBankIdProvider.collect(started.sessionRef)
    expect(second.status).toBe('complete')
    expect(second.user?.personalNumber).toBe('190001019802')
    expect(second.user?.name).toBe('Test Testsson')
  })

  it('requires sign text for sign sessions', async () => {
    await expect(
      mockBankIdProvider.startSign({ endUserIp: '127.0.0.1', userVisibleText: '' }),
    ).rejects.toThrow(/Signeringstext/)
  })

  it('cancel flips the session to cancelled', async () => {
    const started = await mockBankIdProvider.startSign({
      endUserIp: '127.0.0.1',
      userVisibleText: 'Jag samtycker.',
    })
    await mockBankIdProvider.cancel(started.sessionRef)
    const status = await mockBankIdProvider.collect(started.sessionRef)
    expect(status.status).toBe('cancelled')
  })

  it('unknown session collects as failed', async () => {
    const status = await mockBankIdProvider.collect('mock-nonexistent')
    expect(status.status).toBe('failed')
  })
})

describe('getBankIdProvider', () => {
  it('falls back to the mock provider when BankID is not enabled', () => {
    const fake: BankIdProvider = { ...mockBankIdProvider, id: 'tic' }
    registerBankIdProvider(fake)
    const prevEnabled = process.env.NEXT_PUBLIC_BANKID_ENABLED
    const prevSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED
    try {
      process.env.NEXT_PUBLIC_BANKID_ENABLED = 'false'
      expect(getBankIdProvider().id).toBe('mock')

      process.env.NEXT_PUBLIC_BANKID_ENABLED = 'true'
      process.env.NEXT_PUBLIC_SELF_HOSTED = 'true'
      expect(getBankIdProvider().id).toBe('mock')

      process.env.NEXT_PUBLIC_SELF_HOSTED = 'false'
      expect(getBankIdProvider().id).toBe('tic')
    } finally {
      process.env.NEXT_PUBLIC_BANKID_ENABLED = prevEnabled
      process.env.NEXT_PUBLIC_SELF_HOSTED = prevSelfHosted
    }
  })
})
