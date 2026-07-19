import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { getBranding } from '@/lib/branding/service'
import { getOpeningBalances } from './opening-balances'
import type { SIEExportOptions, JournalEntry, JournalEntryLine, BASAccount } from '@/types'

function sanitizeProgramName(str: string): string {
  return str.replace(/"/g, '').replace(/[\r\n]/g, ' ').substring(0, 60)
}

/**
 * Generate SIE4 export file
 *
 * SIE (Standard Import Export) is the Swedish standard format for
 * transferring accounting data between systems.
 *
 * Format: CP437 encoded text file (we'll use UTF-8 as modern systems accept it)
 * Line format: #TAG field1 field2 ...
 */
export async function generateSIEExport(
  supabase: SupabaseClient,
  companyId: string,
  options: SIEExportOptions
): Promise<string> {

  // Fetch fiscal period
  const { data: period } = await supabase
    .from('fiscal_periods')
    .select('*')
    .eq('id', options.fiscal_period_id)
    .eq('company_id', companyId)
    .single()

  if (!period) {
    throw new Error('Fiscal period not found')
  }

  // Fetch previous fiscal year for #RAR -1 (per SIE spec, both years should
  // be present). Fail closed (I23): a QUERY error must block the export —
  // writing a file with silently-missing RAR -1/UB -1/RES -1 would look
  // valid but be wrong. "No prior period exists" is a legitimate result.
  const { data: prevPeriod, error: prevPeriodError } = await supabase
    .from('fiscal_periods')
    .select('id, period_start, period_end')
    .eq('company_id', companyId)
    .lt('period_end', period.period_start)
    .order('period_end', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (prevPeriodError) {
    throw new Error(
      `SIE-exporten avbröts: föregående räkenskapsår kunde inte läsas (${prevPeriodError.message}). ` +
        `En fil utan korrekta #RAR -1/#UB -1/#RES -1 skulle se giltig ut men vara ofullständig.`
    )
  }

  // Fetch all accounts
  const accounts = await fetchAllRows(({ from, to }) =>
    supabase
      .from('chart_of_accounts')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('account_number')
      .range(from, to)
  )

  // Fetch ALL posted journal entries with lines — paginated (I21): a period
  // with more vouchers than PostgREST's default page must still export every
  // #VER/#TRANS.
  const entries = await fetchAllRows<JournalEntry>(({ from, to }) => {
    let entriesQuery = supabase
      .from('journal_entries')
      .select('*, lines:journal_entry_lines(*)')
      .eq('company_id', companyId)
      .eq('fiscal_period_id', options.fiscal_period_id)
      .in('status', ['posted', 'reversed'])
      .order('voucher_series')
      .order('voucher_number')

    if (options.exclude_year_end_closing) {
      entriesQuery = entriesQuery.neq('source_type', 'year_end')
    }

    return entriesQuery.range(from, to)
  })

  // Fetch cost centers and projects for dimension records
  const { data: costCenters } = await supabase
    .from('cost_centers')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('code')

  const { data: projects } = await supabase
    .from('projects')
    .select('*')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .order('code')

  const lines: string[] = []
  const now = new Date()

  // === Header ===
  lines.push('#FLAGGA 0')
  lines.push('#FORMAT PC8')
  lines.push('#SIETYP 4')
  const programName = sanitizeProgramName(options.program_name || getBranding().appName)
  lines.push(`#PROGRAM "${programName}" "1.0"`)
  lines.push(`#GEN ${formatSIEDate(now)}`)

  if (options.org_number) {
    lines.push(`#ORGNR ${options.org_number}`)
  }

  lines.push(`#FNAMN "${escapeQuotes(options.company_name)}"`)

  // === Fiscal year ===
  // #RAR 0 = current year, #RAR -1 = previous year (both should be present per spec)
  // Use date strings directly to avoid timezone conversion issues
  lines.push(`#RAR 0 ${dateStringToSIE(period.period_start)} ${dateStringToSIE(period.period_end)}`)

  if (prevPeriod) {
    lines.push(`#RAR -1 ${dateStringToSIE(prevPeriod.period_start)} ${dateStringToSIE(prevPeriod.period_end)}`)
  }

  // === Dimension definitions ===
  // SIE standard: dimension 1 = kostnadsställe, dimension 6 = projekt
  const hasCostCenters = costCenters && costCenters.length > 0
  const hasProjects = projects && projects.length > 0

  // Non-standard dimensions preserved from imports (line.dimensions jsonb):
  // declare their #DIM and #OBJEKT records too so the round-trip
  // import → export → re-import keeps all dimension metadata (I22).
  const extraDimObjects = new Map<string, Set<string>>()
  for (const entry of entries) {
    for (const line of (entry.lines as JournalEntryLine[]) || []) {
      const dims = (line as JournalEntryLine & { dimensions?: Record<string, string> | null })
        .dimensions
      if (!dims) continue
      for (const [dim, code] of Object.entries(dims)) {
        if (dim === '1' || dim === '6') continue
        if (typeof code !== 'string' || code.length === 0) continue
        if (!extraDimObjects.has(dim)) extraDimObjects.set(dim, new Set())
        extraDimObjects.get(dim)!.add(code)
      }
    }
  }

  if (hasCostCenters) {
    lines.push('#DIM 1 "Kostnadsställe"')
  }
  if (hasProjects) {
    lines.push('#DIM 6 "Projekt"')
  }
  for (const dim of [...extraDimObjects.keys()].sort((a, b) => Number(a) - Number(b))) {
    lines.push(`#DIM ${dim} "Dimension ${dim}"`)
  }

  // === Dimension objects (#OBJEKT) ===
  for (const cc of costCenters || []) {
    lines.push(`#OBJEKT 1 "${escapeQuotes(cc.code)}" "${escapeQuotes(cc.name)}"`)
  }
  for (const proj of projects || []) {
    lines.push(`#OBJEKT 6 "${escapeQuotes(proj.code)}" "${escapeQuotes(proj.name)}"`)
  }
  for (const [dim, codes] of [...extraDimObjects.entries()].sort(
    ([a], [b]) => Number(a) - Number(b),
  )) {
    for (const code of [...codes].sort()) {
      lines.push(`#OBJEKT ${dim} "${escapeQuotes(code)}" "${escapeQuotes(code)}"`)
    }
  }

  // === Chart of accounts ===
  for (const account of (accounts as BASAccount[]) || []) {
    lines.push(`#KONTO ${account.account_number} "${escapeQuotes(account.account_name)}"`)

    // #KTYP derived from BAS class: 1 = Tillgång, 2 = Skuld/Eget kapital,
    // 3 = Intäkt, 4–8 = Kostnad.
    const ktyp = accountTypeFromNumber(account.account_number)
    if (ktyp) {
      lines.push(`#KTYP ${account.account_number} ${ktyp}`)
    }

    // #SRU records from chart_of_accounts.sru_code
    if (account.sru_code) {
      lines.push(`#SRU ${account.account_number} ${account.sru_code}`)
    }
  }

  // === Opening balances (IB) ===
  // Routes through getOpeningBalances() so we get the same fallback as trial
  // balance / balance sheet: when opening_balance_entry_id is NULL — which is
  // expected after continuation SIE imports (sie-import.ts skips creating an
  // IB entry once prior posted activity exists) — the compute_prior_opening_
  // balances RPC derives IB from earlier journal lines instead of silently
  // emitting zero #IB records and producing wrong #UB values.
  const openingBalancesByAccount = new Map<string, number>()
  const { balances: obBalances } = await getOpeningBalances(supabase, companyId, {
    period_start: period.period_start,
    opening_balance_entry_id: period.opening_balance_entry_id ?? null,
  })

  for (const [accountNumber, { debit, credit }] of obBalances) {
    const amount = Math.round(((Number(debit) || 0) - (Number(credit) || 0)) * 100) / 100
    if (amount === 0) continue
    lines.push(`#IB 0 ${accountNumber} ${formatAmount(amount)}`)
    openingBalancesByAccount.set(accountNumber, amount)
  }

  // === Journal entries (VER + TRANS) ===
  for (const entry of (entries as JournalEntry[]) || []) {
    const entryLines = (entry.lines as JournalEntryLine[]) || []
    const entryDate = dateStringToSIE(entry.entry_date)
    const series = entry.voucher_series || 'A'
    const description = escapeQuotes(entry.description)

    lines.push(`#VER "${series}" ${entry.voucher_number} ${entryDate} "${description}"`)
    lines.push('{')

    for (const line of entryLines) {
      const amount =
        line.debit_amount > 0
          ? line.debit_amount
          : -line.credit_amount

      const lineDesc = line.line_description
        ? ` "${escapeQuotes(line.line_description)}"`
        : ''

      // Build dimension object list for #TRANS line. Dimensions 1/6 come
      // from the denormalized columns; any other imported dimensions are
      // preserved via the jsonb map (round-trip fidelity for SIE files with
      // non-standard dimensions).
      const dimParts: string[] = []
      if (line.cost_center) {
        dimParts.push(`1 "${escapeQuotes(line.cost_center)}"`)
      }
      if (line.project) {
        dimParts.push(`6 "${escapeQuotes(line.project)}"`)
      }
      const extraDims = (line as JournalEntryLine & { dimensions?: Record<string, string> | null }).dimensions
      if (extraDims) {
        for (const [dim, code] of Object.entries(extraDims)) {
          if (dim === '1' || dim === '6') continue // already covered by columns
          if (typeof code === 'string' && code.length > 0) {
            dimParts.push(`${dim} "${escapeQuotes(code)}"`)
          }
        }
      }
      const objList = dimParts.length > 0 ? `{${dimParts.join(' ')}}` : '{}'

      lines.push(`\t#TRANS ${line.account_number} ${objList} ${formatAmount(amount)} ${entryDate}${lineDesc}`)
    }

    lines.push('}')
  }

  // === Closing balances (UB for balance sheet, RES for income statement) ===
  // Movement balances from journal entries
  const movementBalances = calculateBalances(entries as JournalEntry[])

  // Merge all accounts that have either IB or movements
  const allAccountNumbers = new Set([
    ...openingBalancesByAccount.keys(),
    ...movementBalances.keys(),
  ])

  for (const accountNumber of [...allAccountNumbers].sort()) {
    const accountClass = parseInt(accountNumber[0])
    const ib = openingBalancesByAccount.get(accountNumber) || 0
    const movement = movementBalances.get(accountNumber) || 0

    if (accountClass <= 2) {
      // Balance sheet: UB = IB + movements during period
      const ub = Math.round((ib + movement) * 100) / 100
      lines.push(`#UB 0 ${accountNumber} ${formatAmount(ub)}`)
    } else {
      // Income statement: RES = movements only (IB should be zero)
      lines.push(`#RES 0 ${accountNumber} ${formatAmount(movement)}`)
    }
  }

  // === Prior-year balances (#UB -1 / #RES -1) ===
  // #RAR -1 was emitted above whenever a prior period exists — a conforming
  // file must then also carry the prior year's balances:
  //   * #UB -1 equals the current year's #IB 0 by the SIE continuity
  //     invariant (IB(0) = UB(-1)).
  //   * #RES -1 is computed from the prior period's posted P&L movements.
  if (prevPeriod) {
    for (const [accountNumber, amount] of [...openingBalancesByAccount.entries()].sort(
      ([a], [b]) => a.localeCompare(b),
    )) {
      if (parseInt(accountNumber[0]) <= 2) {
        lines.push(`#UB -1 ${accountNumber} ${formatAmount(amount)}`)
      }
    }

    // Fail closed (I23): a failure to read the prior year's movements blocks
    // the export instead of emitting a seemingly-valid file with missing
    // #RES -1 records. Paginated (I21).
    const prevEntries = await fetchAllRows<JournalEntry>(({ from, to }) =>
      supabase
        .from('journal_entries')
        .select('id, lines:journal_entry_lines(account_number, debit_amount, credit_amount)')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', (prevPeriod as { id: string }).id)
        .in('status', ['posted', 'reversed'])
        .neq('source_type', 'year_end')
        .order('id', { ascending: true })
        .range(from, to)
    ).catch((err: Error) => {
      throw new Error(
        `SIE-exporten avbröts: föregående års verifikationer kunde inte läsas (${err.message}). ` +
          `#RES -1 skulle annars saknas eller vara felaktiga.`
      )
    })

    const prevMovements = calculateBalances(prevEntries)
    for (const [accountNumber, movement] of [...prevMovements.entries()].sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      if (parseInt(accountNumber[0]) >= 3 && movement !== 0) {
        lines.push(`#RES -1 ${accountNumber} ${formatAmount(movement)}`)
      }
    }
  }

  return lines.join('\r\n') + '\r\n'
}

/**
 * Encode SIE content to actual PC8/CP437 bytes (revision item I20).
 *
 * The file declares `#FORMAT PC8`, so the bytes on the wire must BE CP437 —
 * shipping UTF-8 under a PC8 declaration breaks å/ä/ö in every conforming
 * importer. The mapping mirrors the CP437 decode table in sie-parser.ts.
 * Characters without a CP437 representation are replaced with '?'.
 */
const UNICODE_TO_CP437: Record<string, number> = {
  'Ç': 0x80, 'ü': 0x81, 'é': 0x82, 'â': 0x83, 'ä': 0x84, 'à': 0x85,
  'å': 0x86, 'ç': 0x87, 'ê': 0x88, 'ë': 0x89, 'è': 0x8a, 'ï': 0x8b,
  'î': 0x8c, 'ì': 0x8d, 'Ä': 0x8e, 'Å': 0x8f, 'É': 0x90, 'æ': 0x91,
  'Æ': 0x92, 'ô': 0x93, 'ö': 0x94, 'ò': 0x95, 'û': 0x96, 'ù': 0x97,
  'ÿ': 0x98, 'Ö': 0x99, 'Ü': 0x9a, 'ø': 0x9b, '£': 0x9c, 'Ø': 0x9d,
  '×': 0x9e, 'ƒ': 0x9f,
  'á': 0xa0, 'í': 0xa1, 'ó': 0xa2, 'ú': 0xa3, 'ñ': 0xa4, 'Ñ': 0xa5,
  '§': 0x15,
}

export function encodeSieToPc8(content: string): Uint8Array {
  const bytes = new Uint8Array(content.length)
  let n = 0
  for (const ch of content) {
    const code = ch.codePointAt(0)!
    if (code < 0x80) {
      bytes[n++] = code
    } else {
      bytes[n++] = UNICODE_TO_CP437[ch] ?? 0x3f // '?'
    }
  }
  return bytes.subarray(0, n)
}

/**
 * Derive the SIE #KTYP account type from the BAS class digit:
 * 1 → T (Tillgång), 2 → S (Skuld/Eget kapital), 3 → I (Intäkt),
 * 4–8 → K (Kostnad). Unknown/other → null (record omitted).
 */
function accountTypeFromNumber(accountNumber: string): 'T' | 'S' | 'I' | 'K' | null {
  const cls = parseInt(accountNumber?.charAt(0) ?? '', 10)
  if (cls === 1) return 'T'
  if (cls === 2) return 'S'
  if (cls === 3) return 'I'
  if (cls >= 4 && cls <= 8) return 'K'
  return null
}

/**
 * Format a Date object for SIE: YYYYMMDD
 */
function formatSIEDate(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}${m}${d}`
}

/**
 * Convert a "YYYY-MM-DD" date string to SIE format "YYYYMMDD"
 * without going through Date object (avoids timezone issues)
 */
function dateStringToSIE(dateStr: string): string {
  return dateStr.replace(/-/g, '')
}

/**
 * Format amount for SIE (no thousands separator, . as decimal)
 */
function formatAmount(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  return rounded.toFixed(2)
}

/**
 * Escape double quotes in SIE strings
 */
function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"')
}

/**
 * Calculate net balances per account from journal entries
 */
function calculateBalances(
  entries: JournalEntry[]
): Map<string, number> {
  const balances = new Map<string, number>()

  for (const entry of entries || []) {
    const lines = (entry.lines as JournalEntryLine[]) || []
    for (const line of lines) {
      const current = balances.get(line.account_number) || 0
      const netAmount = (Number(line.debit_amount) || 0) - (Number(line.credit_amount) || 0)
      balances.set(line.account_number, Math.round((current + netAmount) * 100) / 100)
    }
  }

  return balances
}
