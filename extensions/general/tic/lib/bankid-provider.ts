import type { BankIdProvider, BankIdSessionStart, BankIdCollectStatus, StartArgs } from '@/lib/auth/bankid-provider'
import {
  startBankIdAuth,
  pollBankIdSession,
  cancelBankIdSession,
} from './bankid-client'

/**
 * TIC Identity implementation of the BankIdProvider interface.
 *
 * TIC's API is an authentication API — consent/sign flows are implemented as
 * BankID-verified consent (the exact text is stored on the Nordklart-side
 * session + consent rows; the provider verifies WHO approved it). See the
 * interface doc in lib/auth/bankid-provider.ts for the legal framing.
 *
 * Production vs test is controlled by the TIC account behind
 * TIC_IDENTITY_API_KEY — TIC issues test keys against BankID's test
 * environment. We surface `mode` from BANKID_PROVIDER_MODE (defaults to
 * production on hosted).
 */
export const ticBankIdProvider: BankIdProvider = {
  id: 'tic',
  get mode() {
    return process.env.BANKID_PROVIDER_MODE === 'test' ? 'test' as const : 'production' as const
  },

  async startAuth(args: StartArgs): Promise<BankIdSessionStart> {
    const started = await startBankIdAuth(args.endUserIp, args.userAgent)
    return {
      sessionRef: started.sessionId,
      autoStartToken: started.autoStartToken ?? null,
      qrStartToken: started.qrStartToken ?? null,
      qrStartSecret: started.qrStartSecret ?? null,
      expiresAt: started.sessionExpiresAt ?? null,
    }
  },

  async startSign(args): Promise<BankIdSessionStart> {
    if (!args.userVisibleText?.trim()) {
      throw new Error('Signeringstext saknas (userVisibleText).')
    }
    // TIC exposes authentication sessions; the consent text is persisted on
    // the Nordklart session/consent rows by the consent service.
    return this.startAuth(args)
  },

  async collect(sessionRef: string): Promise<BankIdCollectStatus> {
    const polled = await pollBankIdSession(sessionRef)
    return {
      status: polled.status,
      hintCode: polled.hintCode ?? null,
      user: polled.user
        ? {
            personalNumber: polled.user.personalNumber,
            name: polled.user.name,
            givenName: polled.user.givenName,
            surname: polled.user.surname,
          }
        : undefined,
      completedAt: polled.completedAt ?? null,
      qrStartToken: polled.qrStartToken ?? null,
      qrStartSecret: polled.qrStartSecret ?? null,
      error: polled.error ?? null,
    }
  },

  async cancel(sessionRef: string): Promise<void> {
    await cancelBankIdSession(sessionRef)
  },
}
