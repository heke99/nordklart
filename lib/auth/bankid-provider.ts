import crypto from 'crypto'

/**
 * BankID provider abstraction.
 *
 * Nordklart's BankID flows (login, consent signing, identity verification)
 * run through this interface so the UI/services never depend on a specific
 * vendor. Two implementations:
 *
 *   - TIC Identity (production/hosted) — registered by the `tic` extension
 *     at init (extensions register into this module; core never imports
 *     extension code).
 *   - Mock (test/demo/self-hosted) — deterministic sessions with no
 *     external calls; auto-completes after collect() is polled twice.
 *
 * "Sign" semantics: the underlying TIC API is an authentication API. A
 * consent/sign flow is therefore implemented as *BankID-verified consent*:
 * the exact text the user approves is stored verbatim on the session +
 * signed_consents row together with the verified identity (personnummer
 * hash + mask + name) and timestamps. This is honest, GDPR-grade consent
 * evidence — it is NOT a qualified electronic signature (which would
 * require a signing-capable provider agreement with BankID/Signicat etc.).
 * Flows that legally require qualified signatures (e.g. digital inlämning
 * to Bolagsverket) must state so in their UI.
 */

export interface BankIdSessionStart {
  /** Provider's session reference (poll/cancel key). */
  sessionRef: string
  autoStartToken: string | null
  qrStartToken: string | null
  qrStartSecret: string | null
  expiresAt: string | null
}

export interface BankIdCollectStatus {
  status: 'pending' | 'complete' | 'failed' | 'cancelled'
  hintCode: string | null
  /** Present when complete. */
  user?: {
    personalNumber: string
    name: string
    givenName: string
    surname: string
  }
  completedAt?: string | null
  /** Rotated QR tokens (TIC regenerates orders ~25s). */
  qrStartToken?: string | null
  qrStartSecret?: string | null
  error?: string | null
}

export interface StartArgs {
  endUserIp: string
  userAgent?: string
  /** For sign/consent flows: the text presented to the user. */
  userVisibleText?: string
}

export interface BankIdProvider {
  readonly id: 'tic' | 'mock'
  readonly mode: 'test' | 'production'
  startAuth(args: StartArgs): Promise<BankIdSessionStart>
  startSign(args: StartArgs & { userVisibleText: string }): Promise<BankIdSessionStart>
  collect(sessionRef: string): Promise<BankIdCollectStatus>
  cancel(sessionRef: string): Promise<void>
}

/**
 * Animated QR payload per BankID's spec:
 *   bankid.{qrStartToken}.{time}.{hmac_sha256(qrStartSecret, time)}
 * where time = whole seconds since the order was created.
 */
export function formatQrData(
  qrStartToken: string,
  qrStartSecret: string,
  elapsedSeconds: number,
): string {
  const time = Math.max(0, Math.floor(elapsedSeconds)).toString()
  const qrAuthCode = crypto
    .createHmac('sha256', qrStartSecret)
    .update(time)
    .digest('hex')
  return `bankid.${qrStartToken}.${time}.${qrAuthCode}`
}

// ── Provider registry ────────────────────────────────────────────────────────

let registeredProvider: BankIdProvider | null = null

/** Called by the TIC extension at registration time. */
export function registerBankIdProvider(provider: BankIdProvider): void {
  registeredProvider = provider
}

/**
 * Resolve the active provider. Preference order:
 *   1. Registered production provider (TIC) when BankID is enabled.
 *   2. Mock provider (self-hosted / tests / demo).
 *
 * Production guard: a hosted production deployment must NEVER silently fall
 * back to the mock provider — a mock "signature" recorded as consent
 * evidence would be worthless and dangerous. If the real provider is
 * missing (extension not loaded, registration failed) the flow fails
 * loudly instead. `BANKID_ALLOW_MOCK=true` is the explicit escape hatch
 * for staging environments that intentionally run hosted-mode without TIC.
 */
export function getBankIdProvider(): BankIdProvider {
  const selfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
  const bankIdEnabled = process.env.NEXT_PUBLIC_BANKID_ENABLED === 'true'

  if (registeredProvider && bankIdEnabled && !selfHosted) {
    return registeredProvider
  }

  if (
    process.env.NODE_ENV === 'production'
    && !selfHosted
    && process.env.BANKID_ALLOW_MOCK !== 'true'
  ) {
    throw new Error(
      bankIdEnabled
        ? 'BankID-providern är inte tillgänglig (TIC-integrationen är inte registrerad). Mock-providern är blockerad i produktion.'
        : 'BankID är inte aktiverat i den här miljön (NEXT_PUBLIC_BANKID_ENABLED). Mock-providern är blockerad i produktion.',
    )
  }

  return mockBankIdProvider
}

// ── Mock provider (test/demo mode) ──────────────────────────────────────────

interface MockSession {
  ref: string
  purpose: 'auth' | 'sign'
  polls: number
  cancelled: boolean
  createdAt: number
}

const mockSessions = new Map<string, MockSession>()

/**
 * Deterministic mock: pending on the first collect, complete on the second.
 * Identity is always the Swedish test personnummer 190001019802
 * ("Test Testsson") so downstream hashing/masking paths run for real.
 */
export const mockBankIdProvider: BankIdProvider = {
  id: 'mock',
  mode: 'test',

  async startAuth() {
    const ref = `mock-${crypto.randomUUID()}`
    mockSessions.set(ref, { ref, purpose: 'auth', polls: 0, cancelled: false, createdAt: Date.now() })
    return {
      sessionRef: ref,
      autoStartToken: `mock-ast-${ref}`,
      qrStartToken: `mock-qst-${ref}`,
      qrStartSecret: 'mock-secret',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }
  },

  async startSign(args) {
    if (!args.userVisibleText?.trim()) {
      throw new Error('Signeringstext saknas (userVisibleText).')
    }
    const ref = `mock-${crypto.randomUUID()}`
    mockSessions.set(ref, { ref, purpose: 'sign', polls: 0, cancelled: false, createdAt: Date.now() })
    return {
      sessionRef: ref,
      autoStartToken: `mock-ast-${ref}`,
      qrStartToken: `mock-qst-${ref}`,
      qrStartSecret: 'mock-secret',
      expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
    }
  },

  async collect(sessionRef) {
    const session = mockSessions.get(sessionRef)
    if (!session) {
      return { status: 'failed', hintCode: 'notFound', error: 'Okänd session' }
    }
    if (session.cancelled) {
      return { status: 'cancelled', hintCode: 'userCancel' }
    }
    session.polls += 1
    if (session.polls < 2) {
      return { status: 'pending', hintCode: 'outstandingTransaction' }
    }
    return {
      status: 'complete',
      hintCode: null,
      user: {
        personalNumber: '190001019802',
        name: 'Test Testsson',
        givenName: 'Test',
        surname: 'Testsson',
      },
      completedAt: new Date().toISOString(),
    }
  },

  async cancel(sessionRef) {
    const session = mockSessions.get(sessionRef)
    if (session) session.cancelled = true
  },
}

/** Test hook: clear mock session state between tests. */
export function __resetMockBankIdSessions(): void {
  mockSessions.clear()
}
