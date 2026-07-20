/**
 * #KSUMMA verification (revision item I19).
 *
 * Per the SIE file format specification (§7 Kontrollsummor): when checksums
 * are used, an empty `#KSUMMA` record appears near the top of the file and
 * the final record is `#KSUMMA <crc32>`. The CRC-32 (ISO 3309 / IEEE 802.3,
 * the same polynomial as zip) is computed over the bytes of all records
 * between the two markers with whitespace (space, tab, CR, LF) and quote
 * characters excluded.
 *
 * The checksum is computed on the RAW file bytes (before any encoding
 * conversion) so PC8/CP437 files verify byte-for-byte.
 */

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(bytes: number[]): number {
  let crc = 0xffffffff
  for (const b of bytes) {
    crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface KsummaResult {
  /** The value declared in the trailing #KSUMMA record, or null when absent. */
  declared: string | null
  /** Our computed CRC-32 (decimal string), or null when no markers exist. */
  computed: string | null
  /** true = verified OK, false = mismatch, null = file has no #KSUMMA. */
  matches: boolean | null
}

const LF = 0x0a
const CR = 0x0d
const SPACE = 0x20
const TAB = 0x09
const QUOTE = 0x22

function isKsummaLine(lineBytes: Uint8Array): { isMarker: boolean; value: string | null } {
  // '#KSUMMA' in ASCII
  const marker = [0x23, 0x4b, 0x53, 0x55, 0x4d, 0x4d, 0x41]
  let i = 0
  // skip leading whitespace
  while (i < lineBytes.length && (lineBytes[i] === SPACE || lineBytes[i] === TAB)) i++
  for (let j = 0; j < marker.length; j++) {
    if (lineBytes[i + j] !== marker[j]) return { isMarker: false, value: null }
  }
  let rest = ''
  for (let k = i + marker.length; k < lineBytes.length; k++) {
    const b = lineBytes[k]
    if (b === SPACE || b === TAB) continue
    rest += String.fromCharCode(b)
  }
  return { isMarker: true, value: rest.length > 0 ? rest : null }
}

/**
 * Verify the #KSUMMA of a raw SIE file. Returns matches: null when the file
 * declares no checksum (verification not applicable).
 */
export function verifySieKsumma(raw: Uint8Array): KsummaResult {
  // Split into lines on LF, tolerating CRLF.
  const lines: Uint8Array[] = []
  let start = 0
  for (let i = 0; i <= raw.length; i++) {
    if (i === raw.length || raw[i] === LF) {
      let end = i
      if (end > start && raw[end - 1] === CR) end--
      lines.push(raw.subarray(start, end))
      start = i + 1
    }
  }

  let startIdx = -1
  let endIdx = -1
  let declared: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const { isMarker, value } = isKsummaLine(lines[i])
    if (!isMarker) continue
    if (value === null && startIdx === -1) {
      startIdx = i
    } else if (value !== null) {
      endIdx = i
      declared = value
    }
  }

  if (startIdx === -1 || endIdx === -1 || declared === null) {
    return { declared: declared ?? null, computed: null, matches: null }
  }

  // CRC over all record bytes between the markers, excluding whitespace and
  // quote characters.
  const bytes: number[] = []
  for (let i = startIdx + 1; i < endIdx; i++) {
    const line = lines[i]
    for (const b of line) {
      if (b === SPACE || b === TAB || b === CR || b === LF || b === QUOTE) continue
      bytes.push(b)
    }
  }

  const computed = String(crc32(bytes))
  return { declared, computed, matches: computed === declared }
}
