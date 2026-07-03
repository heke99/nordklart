import { describe, it, expect } from 'vitest'
import {
  signPayload,
  parseSignatureHeader,
  verifySignature,
  generateWebhookSecret,
} from '../signing'

const SECRET = 'a'.repeat(64)
const BODY = JSON.stringify({ event_type: 'invoice.paid', data: { id: 'x' } })

describe('signPayload', () => {
  it('produces a Stripe-style header t=<unix>,v1=<hex>', () => {
    const { header, parts } = signPayload({ body: BODY, secret: SECRET, timestamp: 1_750_000_000 })
    expect(header).toBe(`t=1750000000,v1=${parts.v1}`)
    expect(parts.v1).toMatch(/^[0-9a-f]{64}$/)
  })

  it('changes the signature when the body changes', () => {
    const a = signPayload({ body: BODY, secret: SECRET, timestamp: 1_750_000_000 })
    const b = signPayload({ body: BODY + ' ', secret: SECRET, timestamp: 1_750_000_000 })
    expect(a.parts.v1).not.toBe(b.parts.v1)
  })
})

describe('parseSignatureHeader', () => {
  it('parses valid headers', () => {
    expect(parseSignatureHeader('t=123,v1=abc')).toEqual({ t: 123, v1: 'abc' })
    expect(parseSignatureHeader(' t=123 , v1=abc ')).toEqual({ t: 123, v1: 'abc' })
  })

  it('returns null on malformed headers', () => {
    expect(parseSignatureHeader('')).toBeNull()
    expect(parseSignatureHeader('v1=abc')).toBeNull()
    expect(parseSignatureHeader('t=abc,v1=def')).toBeNull()
    expect(parseSignatureHeader('nonsense')).toBeNull()
  })
})

describe('verifySignature', () => {
  const now = 1_750_000_000

  it('accepts a valid signature within the tolerance window', () => {
    const { header } = signPayload({ body: BODY, secret: SECRET, timestamp: now })
    expect(verifySignature({ body: BODY, header, secret: SECRET, now })).toBe(true)
  })

  it('rejects a signature outside the tolerance window (replay protection)', () => {
    const { header } = signPayload({ body: BODY, secret: SECRET, timestamp: now - 600 })
    expect(verifySignature({ body: BODY, header, secret: SECRET, now })).toBe(false)
    // But passes with a wider tolerance.
    expect(
      verifySignature({ body: BODY, header, secret: SECRET, now, toleranceSeconds: 900 }),
    ).toBe(true)
  })

  it('rejects a tampered body', () => {
    const { header } = signPayload({ body: BODY, secret: SECRET, timestamp: now })
    expect(verifySignature({ body: BODY + 'x', header, secret: SECRET, now })).toBe(false)
  })

  it('rejects the wrong secret', () => {
    const { header } = signPayload({ body: BODY, secret: SECRET, timestamp: now })
    expect(verifySignature({ body: BODY, header, secret: 'b'.repeat(64), now })).toBe(false)
  })

  it('returns false (never throws) for malformed v1 values', () => {
    expect(
      verifySignature({ body: BODY, header: `t=${now},v1=zz-not-hex`, secret: SECRET, now }),
    ).toBe(false)
    expect(
      verifySignature({ body: BODY, header: 'garbage', secret: SECRET, now }),
    ).toBe(false)
  })
})

describe('generateWebhookSecret', () => {
  it('returns 64 hex chars (256-bit entropy) and never repeats', () => {
    const a = generateWebhookSecret()
    const b = generateWebhookSecret()
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(a).not.toBe(b)
  })
})
