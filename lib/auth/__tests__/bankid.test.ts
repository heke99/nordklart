import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  isBankIdEnabled,
  hashPersonalNumber,
  hashPersonalNumberHmac,
  personalNumberHashCandidates,
  encryptPersonalNumber,
  decryptPersonalNumber,
  maskPersonalNumber,
} from '../bankid'

// Generate a valid 32-byte hex key for tests
const TEST_KEY = 'a'.repeat(64) // 32 bytes in hex

describe('bankid helpers', () => {
  beforeEach(() => {
    vi.stubEnv('BANKID_ENCRYPTION_KEY', TEST_KEY)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('isBankIdEnabled', () => {
    it('returns false when NEXT_PUBLIC_SELF_HOSTED is true', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'true')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'true')
      expect(isBankIdEnabled()).toBe(false)
    })

    it('returns true when BANKID_ENABLED is true and not hosted', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', 'true')
      expect(isBankIdEnabled()).toBe(true)
    })

    it('returns false when BANKID_ENABLED is not set', () => {
      vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', 'false')
      vi.stubEnv('NEXT_PUBLIC_BANKID_ENABLED', '')
      expect(isBankIdEnabled()).toBe(false)
    })
  })

  describe('hashPersonalNumber', () => {
    it('returns a consistent SHA-256 hex hash', () => {
      const hash1 = hashPersonalNumber('199001011234')
      const hash2 = hashPersonalNumber('199001011234')
      expect(hash1).toBe(hash2)
      expect(hash1).toMatch(/^[a-f0-9]{64}$/)
    })

    it('returns different hashes for different numbers', () => {
      const hash1 = hashPersonalNumber('199001011234')
      const hash2 = hashPersonalNumber('199001015678')
      expect(hash1).not.toBe(hash2)
    })
  })

  describe('hashPersonalNumberHmac', () => {
    it('is keyed: differs from the plain SHA-256 hash and depends on the secret', () => {
      process.env.BANKID_HASH_SECRET = 'secret-a'
      const keyed = hashPersonalNumberHmac('199001011234')
      expect(keyed).toMatch(/^[a-f0-9]{64}$/)
      expect(keyed).not.toBe(hashPersonalNumber('199001011234'))

      process.env.BANKID_HASH_SECRET = 'secret-b'
      expect(hashPersonalNumberHmac('199001011234')).not.toBe(keyed)
      process.env.BANKID_HASH_SECRET = 'secret-a'
      expect(hashPersonalNumberHmac('199001011234')).toBe(keyed)
    })

    it('lists lookup candidates with the keyed hash first, legacy second', () => {
      process.env.BANKID_HASH_SECRET = 'secret-a'
      const candidates = personalNumberHashCandidates('199001011234')
      expect(candidates).toEqual([
        hashPersonalNumberHmac('199001011234'),
        hashPersonalNumber('199001011234'),
      ])
    })

    it('throws when no server secret is available', () => {
      const prevHash = process.env.BANKID_HASH_SECRET
      const prevEnc = process.env.BANKID_ENCRYPTION_KEY
      const prevService = process.env.SUPABASE_SERVICE_ROLE_KEY
      delete process.env.BANKID_HASH_SECRET
      delete process.env.BANKID_ENCRYPTION_KEY
      delete process.env.SUPABASE_SERVICE_ROLE_KEY
      try {
        expect(() => hashPersonalNumberHmac('199001011234')).toThrow(/BANKID_HASH_SECRET/)
      } finally {
        if (prevHash) process.env.BANKID_HASH_SECRET = prevHash
        if (prevEnc) process.env.BANKID_ENCRYPTION_KEY = prevEnc
        if (prevService) process.env.SUPABASE_SERVICE_ROLE_KEY = prevService
      }
    })
  })

  describe('encrypt/decrypt round-trip', () => {
    it('encrypts and decrypts a personnummer', () => {
      const pnr = '199001011234'
      const encrypted = encryptPersonalNumber(pnr)
      expect(encrypted).toBeInstanceOf(Buffer)
      // iv (12) + tag (16) + ciphertext (at least 1 byte)
      expect(encrypted.length).toBeGreaterThan(28)

      const decrypted = decryptPersonalNumber(encrypted)
      expect(decrypted).toBe(pnr)
    })

    it('produces different ciphertext each time (random IV)', () => {
      const pnr = '199001011234'
      const enc1 = encryptPersonalNumber(pnr)
      const enc2 = encryptPersonalNumber(pnr)
      expect(enc1.equals(enc2)).toBe(false)
    })

    it('throws when BANKID_ENCRYPTION_KEY is missing', () => {
      vi.stubEnv('BANKID_ENCRYPTION_KEY', '')
      expect(() => encryptPersonalNumber('199001011234')).toThrow('BANKID_ENCRYPTION_KEY')
    })
  })

  describe('maskPersonalNumber', () => {
    it('masks a 12-digit personnummer', () => {
      expect(maskPersonalNumber('199001011234')).toBe('XXXXXXXX-1234')
    })

    it('masks a 10-digit personnummer', () => {
      expect(maskPersonalNumber('9001011234')).toBe('XXXXXX-1234')
    })

    it('handles short input gracefully', () => {
      expect(maskPersonalNumber('12')).toBe('****')
    })
  })
})
