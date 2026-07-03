import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  encryptProviderToken,
  decryptProviderToken,
  isProviderTokenEncrypted,
  providerTokenEncryptionConfigured,
} from '../token-encryption'

const KEY_ENV = 'PROVIDER_TOKEN_ENCRYPTION_KEY'
let prevKey: string | undefined

beforeEach(() => {
  prevKey = process.env[KEY_ENV]
})

afterEach(() => {
  if (prevKey === undefined) delete process.env[KEY_ENV]
  else process.env[KEY_ENV] = prevKey
})

describe('provider token encryption', () => {
  it('round-trips with a configured key', () => {
    process.env[KEY_ENV] = 'test-key-123'
    const cipher = encryptProviderToken('secret-access-token')
    expect(cipher).not.toContain('secret-access-token')
    expect(isProviderTokenEncrypted(cipher)).toBe(true)
    expect(decryptProviderToken(cipher)).toBe('secret-access-token')
  })

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    process.env[KEY_ENV] = 'test-key-123'
    const a = encryptProviderToken('same')
    const b = encryptProviderToken('same')
    expect(a).not.toBe(b)
    expect(decryptProviderToken(a)).toBe('same')
    expect(decryptProviderToken(b)).toBe('same')
  })

  it('passes plaintext through when no key is configured', () => {
    delete process.env[KEY_ENV]
    expect(providerTokenEncryptionConfigured()).toBe(false)
    const stored = encryptProviderToken('legacy-token')
    expect(stored).toBe('legacy-token')
    expect(isProviderTokenEncrypted(stored)).toBe(false)
  })

  it('legacy plaintext rows decrypt as-is (prefixless passthrough)', () => {
    process.env[KEY_ENV] = 'test-key-123'
    expect(decryptProviderToken('plain-old-token')).toBe('plain-old-token')
  })

  it('throws when an encrypted value is read without a key', () => {
    process.env[KEY_ENV] = 'test-key-123'
    const cipher = encryptProviderToken('secret')
    delete process.env[KEY_ENV]
    expect(() => decryptProviderToken(cipher)).toThrow(/PROVIDER_TOKEN_ENCRYPTION_KEY/)
  })

  it('throws on key rotation (wrong key cannot decrypt)', () => {
    process.env[KEY_ENV] = 'key-one'
    const cipher = encryptProviderToken('secret')
    process.env[KEY_ENV] = 'key-two'
    expect(() => decryptProviderToken(cipher)).toThrow()
  })
})
