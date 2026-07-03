/**
 * Manual skattekonto statement import (fallback when the Skattekonto API is
 * not connected / not available).
 *
 * The user copies the kontoutdrag rows from Skatteverket's Mina sidor
 * ("Skattekonto → Kontoutdrag") and pastes them as text. Accepted line
 * formats (tab-, semicolon- or multi-space-separated):
 *
 *   2026-06-12<TAB>Inbetalning bokförd<TAB>14 380
 *   2026-06-12;Moms feb-mars 2026;-14 380
 *   2026-06-12  Debiterad preliminärskatt   -8 500,00
 *
 * Amounts use Swedish formatting (spaces as thousands separators, comma
 * decimals) or plain numbers. Rows that don't parse are reported back with
 * the reason — nothing is silently dropped.
 */

export interface ParsedSkattekontoRow {
  transaktionsdatum: string
  transaktionstext: string
  belopp: number
}

export interface SkattekontoParseResult {
  rows: ParsedSkattekontoRow[]
  issues: Array<{ line: number; message: string }>
}

const DATE_RE = /^(\d{4}-\d{2}-\d{2})/

/** Parse a Swedish-formatted amount: "1 234,56", "-14 380", "1234.56". */
export function parseSwedishAmount(raw: string): number | null {
  const cleaned = raw
    .replace(/[\s\u00a0\u202f]/g, '') // ordinary + non-breaking + narrow spaces
    .replace(/kr$/i, '')
    .replace(',', '.')
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null
  const value = Number(cleaned)
  return Number.isFinite(value) ? value : null
}

export function parseSkattekontoStatement(text: string): SkattekontoParseResult {
  const rows: ParsedSkattekontoRow[] = []
  const issues: Array<{ line: number; message: string }> = []

  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue

    const dateMatch = line.match(DATE_RE)
    if (!dateMatch) {
      // Header/preamble rows ("Datum  Specifikation  Belopp") are expected —
      // only flag rows that LOOK like data (start with a digit).
      if (/^\d/.test(line)) {
        issues.push({ line: i + 1, message: `Raden börjar inte med ett datum (YYYY-MM-DD): "${line.slice(0, 60)}"` })
      }
      continue
    }

    const rest = line.slice(dateMatch[0].length).replace(/^[;\t]/, '').trim()

    // Amount = last token that parses as a Swedish amount. Everything
    // between date and amount is the transaction text.
    const parts = rest.split(/[;\t]| {2,}/).map((p) => p.trim()).filter(Boolean)
    if (parts.length < 2) {
      // Maybe "text amount" single-space separated — try last whitespace token.
      const lastSpace = rest.lastIndexOf(' ')
      if (lastSpace > 0) {
        const amount = parseSwedishAmount(rest.slice(lastSpace + 1))
        if (amount !== null) {
          rows.push({
            transaktionsdatum: dateMatch[1],
            transaktionstext: rest.slice(0, lastSpace).trim(),
            belopp: amount,
          })
          continue
        }
      }
      issues.push({ line: i + 1, message: `Kunde inte hitta både text och belopp på raden: "${line.slice(0, 60)}"` })
      continue
    }

    // Amount may span the last 1-2 tokens ("1 234,56" splits on double space
    // only, but "14 380" copied with single spaces splits into two tokens).
    let amount: number | null = null
    let textEndIdx = parts.length - 1
    amount = parseSwedishAmount(parts[parts.length - 1])
    if (amount !== null && parts.length >= 3) {
      const joined = parseSwedishAmount(`${parts[parts.length - 2]}${parts[parts.length - 1]}`)
      // "14 380" → tokens ["14","380"]: join when both halves are digit-only
      // and the joined value parses (thousands-separated amount).
      if (joined !== null && /^-?\d{1,3}$/.test(parts[parts.length - 2]) && /^\d{3}(,\d+)?$/.test(parts[parts.length - 1])) {
        amount = joined
        textEndIdx = parts.length - 2
      }
    }
    if (amount === null) {
      issues.push({ line: i + 1, message: `Ogiltigt belopp på raden: "${line.slice(0, 60)}"` })
      continue
    }

    const textValue = parts.slice(0, textEndIdx).join(' ').trim()
    if (!textValue) {
      issues.push({ line: i + 1, message: `Transaktionstext saknas på raden: "${line.slice(0, 60)}"` })
      continue
    }

    rows.push({
      transaktionsdatum: dateMatch[1],
      transaktionstext: textValue,
      belopp: amount,
    })
  }

  return { rows, issues }
}
