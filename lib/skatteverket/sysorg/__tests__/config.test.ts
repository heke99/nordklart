/**
 * Sysorg production-safety config: no hardcoded filframställare identity,
 * fail-fast in production, explicit environment requirement.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import {
  assertSkvProductionSafety,
  getSkvConfigStatus,
  getSkvEnvironment,
  getSkvFilframstallare,
  getSkvFilframstallareOrNull,
  isSkvEnvironmentExplicit,
  SkvConfigurationError,
} from '@/lib/skatteverket/sysorg/config'

const ENV_KEYS = [
  'SKV_ENV', 'SKATTEVERKET_ENV',
  'SKV_FILFRAMSTALLARE_ORGNR', 'SKATTEVERKET_FILFRAMSTALLARE_ORGNR',
  'SKV_FILFRAMSTALLARE_ID', 'SKATTEVERKET_FILFRAMSTALLARE_ID',
  'SKV_FILFRAMSTALLARE_NAME', 'SKATTEVERKET_FILFRAMSTALLARE_NAME',
  'SKV_FILFRAMSTALLARE_CONTACT_NAME', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_NAME',
  'SKV_FILFRAMSTALLARE_CONTACT_EMAIL', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_EMAIL',
  'SKV_FILFRAMSTALLARE_CONTACT_PHONE', 'SKATTEVERKET_FILFRAMSTALLARE_CONTACT_PHONE',
]

function clearEnv() {
  for (const key of ENV_KEYS) delete process.env[key]
}

function configureFilframstallare() {
  process.env.SKV_FILFRAMSTALLARE_ORGNR = '556000-0167'
  process.env.SKV_FILFRAMSTALLARE_NAME = 'Testbyrån AB'
  process.env.SKV_FILFRAMSTALLARE_CONTACT_EMAIL = 'ansvarig@testbyran.se'
}

describe('sysorg config production safety', () => {
  beforeEach(() => {
    clearEnv()
    vi.stubEnv('NODE_ENV', 'test')
  })

  afterAll(() => {
    clearEnv()
    vi.unstubAllEnvs()
  })

  it('has NO hardcoded filframställare identity (no Gridex fallback)', async () => {
    expect(getSkvFilframstallareOrNull()).toBeNull()
    expect(() => getSkvFilframstallare()).toThrow(SkvConfigurationError)
    // The legal-identity defaults must be gone from the module entirely.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync('lib/skatteverket/sysorg/config.ts', 'utf8'),
    )
    expect(source).not.toMatch(/gridex/i)
    expect(source).not.toMatch(/div3rsa/i)
    expect(source).not.toContain('559416-7149')
  })

  it('returns the configured identity and derives the 12-digit id', () => {
    configureFilframstallare()
    const fil = getSkvFilframstallare()
    expect(fil.name).toBe('Testbyrån AB')
    expect(fil.orgnr).toBe('556000-0167')
    expect(fil.id).toBe('165560000167')
    expect(fil.contactEmail).toBe('ansvarig@testbyran.se')
    // Contact name falls back to the organisation name, never to a person.
    expect(fil.contactName).toBe('Testbyrån AB')
  })

  it('defaults the environment to test and reports non-explicit', () => {
    expect(getSkvEnvironment()).toBe('test')
    expect(isSkvEnvironmentExplicit()).toBe(false)
    process.env.SKV_ENV = 'prod'
    expect(getSkvEnvironment()).toBe('prod')
    expect(isSkvEnvironmentExplicit()).toBe(true)
  })

  it('assertSkvProductionSafety throws in production without an explicit SKV_ENV', () => {
    vi.stubEnv('NODE_ENV', 'production')
    configureFilframstallare()
    expect(() => assertSkvProductionSafety()).toThrow(/SKV_ENV/)
  })

  it('assertSkvProductionSafety throws in production without a configured filframställare', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.SKV_ENV = 'test'
    expect(() => assertSkvProductionSafety()).toThrow(/Filframställare/)
  })

  it('assertSkvProductionSafety throws for SKV_ENV=prod without identity even outside production runtime', () => {
    process.env.SKV_ENV = 'prod'
    expect(() => assertSkvProductionSafety()).toThrow(SkvConfigurationError)
  })

  it('assertSkvProductionSafety passes with explicit env + configured identity', () => {
    vi.stubEnv('NODE_ENV', 'production')
    process.env.SKV_ENV = 'test'
    configureFilframstallare()
    expect(() => assertSkvProductionSafety()).not.toThrow()
  })

  it('assertSkvProductionSafety is a no-op for local/test runtimes on the test API', () => {
    vi.stubEnv('NODE_ENV', 'test')
    expect(() => assertSkvProductionSafety()).not.toThrow()
  })

  it('getSkvConfigStatus reports the filframställare check and production safety', () => {
    const before = getSkvConfigStatus()
    expect(before.filframstallare).toBeNull()
    expect(before.checks.find((c) => c.key === 'filframstallare')?.ok).toBe(false)
    expect(before.productionSafe).toBe(false)

    configureFilframstallare()
    const after = getSkvConfigStatus()
    expect(after.filframstallare?.name).toBe('Testbyrån AB')
    expect(after.checks.find((c) => c.key === 'filframstallare')?.ok).toBe(true)
    expect(after.productionSafe).toBe(true)
  })
})
