import { describe, it, expect } from 'vitest'
import {
  computeIntegrationReadiness,
  READINESS_STATUS_LABELS_SV,
} from '../integration-readiness'
import { SKV_SYSORG_ENV_REQUIREMENTS } from '@/lib/skatteverket/sysorg/config'

function entryFor(id: string, env: Record<string, string | undefined>) {
  const entry = computeIntegrationReadiness(env).find((e) => e.id === id)
  if (!entry) throw new Error(`missing entry ${id}`)
  return entry
}

describe('computeIntegrationReadiness', () => {
  it('covers the full mandated integration set', () => {
    const ids = computeIntegrationReadiness({}).map((e) => e.id)
    for (const expected of [
      'bankid', 'skatteverket', 'enable_banking', 'bankgiro', 'peppol',
      'invoice_financing', 'fortnox', 'visma', 'bokio', 'briox',
      'bjornlunden', 'bolagsverket', 'resend', 'stripe', 'skatteverket_sysorg',
    ]) {
      expect(ids).toContain(expected)
    }
  })

  it('every entry has a Swedish message and a label for its status', () => {
    for (const entry of computeIntegrationReadiness({})) {
      expect(entry.message_sv.length).toBeGreaterThan(10)
      expect(READINESS_STATUS_LABELS_SV[entry.status]).toBeTruthy()
      expect(['superadmin', 'company', 'agency']).toContain(entry.responsible)
    }
  })

  it('BankID: TIC key → production; mock mode → sandbox; nothing → requires_agreement', () => {
    expect(entryFor('bankid', { TIC_IDENTITY_API_KEY: 'k' }).status).toBe('production_ready')
    expect(entryFor('bankid', { TIC_IDENTITY_API_KEY: 'k', BANKID_PROVIDER_MODE: 'test' }).status).toBe('sandbox_ready')
    expect(entryFor('bankid', { BANKID_PROVIDER_MODE: 'mock' }).status).toBe('sandbox_ready')
    expect(entryFor('bankid', {}).status).toBe('requires_agreement')
  })

  it('Skatteverket: kill switch → blocked; full test config → sandbox; partial → misconfigured', () => {
    expect(entryFor('skatteverket', { SKATTEVERKET_DISABLED: 'true' }).status).toBe('blocked')

    const full = {
      SKATTEVERKET_OAUTH2_CLIENT_ID: 'a',
      SKATTEVERKET_OAUTH2_CLIENT_SECRET: 'b',
      SKATTEVERKET_APIGW_CLIENT_ID: 'c',
      SKATTEVERKET_APIGW_CLIENT_SECRET: 'd',
      SKATTEVERKET_TOKEN_ENCRYPTION_KEY: 'e',
    }
    expect(entryFor('skatteverket', full).status).toBe('sandbox_ready')
    expect(entryFor('skatteverket', { ...full, SKATTEVERKET_ENV: 'production' }).status).toBe('production_ready')

    const partial = entryFor('skatteverket', { SKATTEVERKET_OAUTH2_CLIENT_ID: 'a' })
    expect(partial.status).toBe('misconfigured')
    expect(partial.missingEnvVars.length).toBeGreaterThan(0)

    expect(entryFor('skatteverket', {}).status).toBe('requires_agreement')
  })

  // The go-live panel and the token call must agree about what the sysorg
  // track needs. They did not: the panel checked five variables, the token
  // call also requires the organisation certificate, its PIN and the
  // filframställare identity — so a deployment could read "production_ready"
  // while requestAccessToken() would throw. Both now derive from
  // SKV_SYSORG_ENV_REQUIREMENTS.
  const SYSORG_FULL = {
    SKV_OAUTH_CLIENT_ID: 'a',
    SKV_OAUTH_CLIENT_SECRET: 'b',
    SKV_APIGW_CLIENT_ID: 'c',
    SKV_APIGW_CLIENT_SECRET: 'd',
    SKV_ORG_CERT_P12_BASE64: 'e',
    SKV_ORG_CERT_PIN: 'f',
    SKV_FILFRAMSTALLARE_ORGNR: '5566778899',
    SKV_FILFRAMSTALLARE_NAME: 'Nordklart AB',
    SKV_FILFRAMSTALLARE_CONTACT_EMAIL: 'support@example.com',
  }

  it('Skatteverket sysorg: nothing → requires_agreement (external certificate)', () => {
    const entry = entryFor('skatteverket_sysorg', {})
    expect(entry.status).toBe('requires_agreement')
    expect(entry.message_sv).toMatch(/organisationscertifikat/i)
  })

  it('Skatteverket sysorg: the OAuth pair alone is NOT enough to look ready', () => {
    // Exactly the set the old panel checked. It must not read as ready, because
    // the certificate is missing and the token call would fail.
    const entry = entryFor('skatteverket_sysorg', {
      SKV_SYSORG_ENABLED: 'true',
      SKATTEVERKET_OAUTH2_CLIENT_ID: 'a',
      SKATTEVERKET_OAUTH2_CLIENT_SECRET: 'b',
      SKATTEVERKET_APIGW_CLIENT_ID: 'c',
      SKATTEVERKET_APIGW_CLIENT_SECRET: 'd',
    })
    expect(entry.status).toBe('misconfigured')
    expect(entry.missingEnvVars).toContain('SKV_ORG_CERT_P12_BASE64')
    expect(entry.missingEnvVars).toContain('SKV_ORG_CERT_PIN')
    expect(entry.missingEnvVars).toContain('SKV_FILFRAMSTALLARE_ORGNR')
  })

  it('Skatteverket sysorg: complete but switched off → not_configured', () => {
    expect(entryFor('skatteverket_sysorg', SYSORG_FULL).status).toBe('not_configured')
  })

  it('Skatteverket sysorg: complete + enabled → sandbox unless SKV_ENV says prod', () => {
    const enabled = { ...SYSORG_FULL, SKV_SYSORG_ENABLED: 'true' }
    expect(entryFor('skatteverket_sysorg', enabled).status).toBe('sandbox_ready')
    expect(entryFor('skatteverket_sysorg', { ...enabled, SKV_ENV: 'prod' }).status).toBe('production_ready')
  })

  it('Skatteverket sysorg: every declared SKATTEVERKET_* alias resolves the same way', () => {
    // Built from the requirement list itself, so a new variable that forgets to
    // honour its alias fails here rather than in a deployment that set the
    // legacy name.
    const aliased: Record<string, string> = { SKV_SYSORG_ENABLED: 'true' }
    for (const requirement of SKV_SYSORG_ENV_REQUIREMENTS) {
      const alias = requirement.aliases[1] ?? requirement.aliases[0]!
      aliased[alias] = 'x'
    }
    const entry = entryFor('skatteverket_sysorg', aliased)
    expect(entry.missingEnvVars).toEqual([])
    expect(entry.status).toBe('sandbox_ready')
  })

  it('Enable Banking: production vars beat sandbox vars; partial → misconfigured', () => {
    expect(
      entryFor('enable_banking', {
        ENABLE_BANKING_APP_ID_PRODUCTION: 'a',
        ENABLE_BANKING_PRIVATE_KEY_PRODUCTION: 'b',
      }).status,
    ).toBe('production_ready')
    expect(
      entryFor('enable_banking', {
        ENABLE_BANKING_APP_ID: 'a',
        ENABLE_BANKING_PRIVATE_KEY: 'b',
      }).status,
    ).toBe('sandbox_ready')
    expect(entryFor('enable_banking', { ENABLE_BANKING_APP_ID: 'a' }).status).toBe('misconfigured')
    expect(entryFor('enable_banking', {}).status).toBe('requires_agreement')
  })

  it('Stripe: sk_test → sandbox_ready, sk_live → production_ready', () => {
    expect(
      entryFor('stripe', { STRIPE_SECRET_KEY: 'sk_test_x', STRIPE_WEBHOOK_SECRET: 'w' }).status,
    ).toBe('sandbox_ready')
    expect(
      entryFor('stripe', { STRIPE_SECRET_KEY: 'sk_live_x', STRIPE_WEBHOOK_SECRET: 'w' }).status,
    ).toBe('production_ready')
    expect(entryFor('stripe', { STRIPE_SECRET_KEY: 'sk_live_x' }).status).toBe('misconfigured')
    expect(entryFor('stripe', {}).status).toBe('not_configured')
  })

  it('OAuth providers require credentials; Bokio never does', () => {
    expect(entryFor('fortnox', { FORTNOX_CLIENT_ID: 'a', FORTNOX_CLIENT_SECRET: 'b' }).status).toBe('production_ready')
    expect(entryFor('fortnox', { FORTNOX_CLIENT_ID: 'a' }).status).toBe('misconfigured')
    expect(entryFor('fortnox', {}).status).toBe('requires_agreement')
    expect(entryFor('bokio', {}).status).toBe('production_ready')
  })

  it('Peppol + financing default to sandbox outside production', () => {
    const env = { NODE_ENV: 'test' }
    expect(entryFor('peppol', env).status).toBe('sandbox_ready')
    expect(entryFor('invoice_financing', env).status).toBe('sandbox_ready')

    const prodEnv = { NODE_ENV: 'production' }
    expect(entryFor('peppol', prodEnv).status).toBe('requires_agreement')
    expect(entryFor('invoice_financing', prodEnv).status).toBe('requires_agreement')
  })

  it('Bankgiro is always requires_agreement (bank-side signup)', () => {
    expect(entryFor('bankgiro', {}).status).toBe('requires_agreement')
  })
})
