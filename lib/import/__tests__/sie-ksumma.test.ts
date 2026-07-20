import { describe, expect, it } from 'vitest'
import { verifySieKsumma } from '@/lib/import/sie-ksumma'

/**
 * #KSUMMA verification (revision item I19).
 *
 * CRC-32 (ISO 3309) over the record bytes between the two #KSUMMA markers,
 * with whitespace and quote characters excluded — computed on the RAW file
 * bytes so PC8 files verify byte-for-byte.
 */

function toBytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

/** Reference CRC-32 (same polynomial) for building expected values. */
function crc32Ref(bytes: number[]): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc ^= b
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function checksumOf(lines: string[]): string {
  const bytes: number[] = []
  for (const line of lines) {
    for (const b of toBytes(line)) {
      if (b === 0x20 || b === 0x09 || b === 0x0d || b === 0x0a || b === 0x22) continue
      bytes.push(b)
    }
  }
  return String(crc32Ref(bytes))
}

describe('verifySieKsumma', () => {
  const body = ['#FLAGGA 0', '#FORMAT PC8', '#SIETYP 4', '#VER "A" 1 20250101 "Test"']

  it('returns matches: null when the file declares no checksum', () => {
    const file = body.join('\r\n')
    const result = verifySieKsumma(toBytes(file))
    expect(result.matches).toBeNull()
    expect(result.declared).toBeNull()
  })

  it('verifies a correct #KSUMMA', () => {
    const expected = checksumOf(body)
    const file = ['#KSUMMA', ...body, `#KSUMMA ${expected}`].join('\r\n')
    const result = verifySieKsumma(toBytes(file))
    expect(result.declared).toBe(expected)
    expect(result.computed).toBe(expected)
    expect(result.matches).toBe(true)
  })

  it('flags a mismatching #KSUMMA (tampered/truncated file)', () => {
    const expected = checksumOf(body)
    const tampered = [...body]
    tampered[3] = '#VER "A" 1 20250101 "Tampered"'
    const file = ['#KSUMMA', ...tampered, `#KSUMMA ${expected}`].join('\r\n')
    const result = verifySieKsumma(toBytes(file))
    expect(result.matches).toBe(false)
    expect(result.declared).toBe(expected)
    expect(result.computed).not.toBe(expected)
  })

  it('excludes whitespace and quotes from the checksum scope', () => {
    // Same content with different spacing/quoting layout must verify with
    // the same checksum.
    const spaced = ['#FLAGGA   0', '#FORMAT\tPC8', '#SIETYP 4', '#VER  "A"  1  20250101  "Test"']
    const expected = checksumOf(body)
    const file = ['#KSUMMA', ...spaced, `#KSUMMA ${expected}`].join('\n')
    const result = verifySieKsumma(toBytes(file))
    expect(result.matches).toBe(true)
  })
})
