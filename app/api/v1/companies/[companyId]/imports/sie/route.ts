/**
 * POST /api/v1/companies/{companyId}/imports/sie
 *
 * SIE4 file import. Multipart upload — the file is the request body. The
 * route:
 *   1. Decodes the file (CP437 / Windows-1252 / UTF-8 auto-detected).
 *   2. Parses the SIE structure.
 *   3. Checks for duplicate file-hash imports (rejects if already imported).
 *   4. Runs the full import via `executeSIEImport()` — fiscal period
 *      creation, opening balance entry, voucher commits.
 *   5. Records the result on the `operations` table so the v1 caller
 *      receives a consistent `{ operation_id }` shape.
 *
 * Currently executes INLINE (the operation is stamped `succeeded` /
 * `failed` before the response returns). A future cron worker can take
 * over by flipping `initialStatus` from `'running'` to `'queued'` —
 * the API contract stays identical.
 *
 * SIE imports are expensive: a typical multi-year SIE file produces
 * thousands of journal entries. The dashboard route allows up to 5
 * minutes (`maxDuration = 300`); this route inherits the v1 default.
 * For very large imports, consider chunking client-side.
 */

import { z } from 'zod'
import { accepted } from '@/lib/api/v1/response'
import { registerEndpoint } from '@/lib/api/v1/registry'
import { withApiV1 } from '@/lib/api/v1/with-api-v1'
import { v1ErrorResponseFromCode } from '@/lib/api/v1/errors'
import {
  startOperation,
  completeOperation,
  failOperation,
} from '@/lib/api/v1/operations'
import {
  parseSIEFile,
  validateSIEFile,
  detectEncoding,
  decodeBuffer,
  calculateFileHash,
} from '@/lib/import/sie-parser'
import {
  executeSIEImport,
  checkDuplicateImport,
} from '@/lib/import/sie-import'
import { suggestMappings } from '@/lib/import/account-mapper'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import type { SIEAccountMappingRecord } from '@/lib/import/types'
import { verifySIECompanyIdentity } from '@/lib/import/company-identity-server'
import { archiveSIEParseSession } from '@/lib/import/sie-parse-session'
import {
  MAX_SIE_FILE_SIZE_BYTES,
  hasAllowedSIEFileExtension,
} from '@/lib/import/sie-limits'

const SieImportAccepted = z.object({
  operation_id: z.string().uuid(),
  type: z.literal('import.sie'),
  status: z.literal('queued'),
  poll_url: z.string(),
})

export const maxDuration = 300 // 5 minutes — large multi-year SIE files

registerEndpoint({
  operation: 'imports.sie',
  method: 'POST',
  path: '/api/v1/companies/:companyId/imports/sie',
  summary: 'Import a SIE4 file.',
  description:
    'Accepts a SIE4 file (CP437 / Windows-1252 / UTF-8 auto-detected, up to 50 MB) as the request body, parses it, checks for duplicate imports by file-hash, and replays every #VER + #TRANS into the company\'s bookkeeping. Returns an `operation_id` immediately — poll `GET /api/v1/operations/{id}` for status + final result. The byte-equivalent dashboard route at /api/import/sie/execute backs the same lib helper, so a SIE imported via v1 matches what the dashboard would produce.',
  useWhen:
    'Migrating bookkeeping data from another system (Fortnox, Bokio, Visma) into Nordklart, restoring from a backup .se file, or recreating a period from an archive.',
  doNotUseFor:
    'Bank transaction CSV/XML imports (use POST /imports/bank). Single-voucher creation (use POST /journal-entries). Importing into a period that already has posted entries — SIE imports run on a fresh period.',
  pitfalls: [
    'Body content-type must be multipart/form-data with a `file` field carrying the .se / .sie file (or a JSON body with `file_base64` for agents that can\'t do multipart).',
    'File size cap: 50 MB. Larger files require chunking client-side or a future streaming import endpoint.',
    'Duplicate-file detection is by SHA-256 hash — re-importing the same file returns 409 SIE_IMPORT_DUPLICATE without re-running the import.',
    'The operation can take 1–5 minutes for multi-year files. The HTTP response returns immediately with operation_id; poll /operations/{id} every ~2s for status.',
    'BFL 7 kap räkenskapsinformation: once a SIE import completes, the resulting verifikationer are immutable. Cancellation midway is not supported.',
    'Account mappings are generated server-side from the file\'s #KONTO records (plus stored per-company overrides). By default the file\'s account names are carried into the chart, renaming existing accounts whose names differ — pass options.updateAccountNames=false to keep BAS default names.',
  ],
  example: {
    response: {
      data: {
        operation_id: 'op_a8f1…',
        type: 'import.sie',
        status: 'queued',
        poll_url: '/api/v1/operations/op_a8f1…',
        webhook_event: 'operation.completed',
      },
      meta: { request_id: 'req_…', api_version: '2026-05-12' },
    },
  },
  scope: 'bookkeeping:write',
  risk: 'high',
  idempotent: true,
  reversible: false,
  dryRunSupported: false,
  request: { contentType: 'multipart/form-data' },
  response: { success: SieImportAccepted },
})

export const POST = withApiV1<{ params: Promise<{ companyId: string }> }>(
  'imports.sie',
  async (request, ctx) => {
    // Parse multipart form
    let formData: FormData
    try {
      formData = await request.formData()
    } catch {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'body', message: 'Expected multipart/form-data with a `file` field.' },
      })
    }

    const file = formData.get('file')
    if (!(file instanceof File)) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: { field: 'file', message: 'Missing or invalid `file` field.' },
      })
    }
    if (!hasAllowedSIEFileExtension(file.name)) {
      return v1ErrorResponseFromCode('SIE_PARSE_INVALID_TYPE', ctx.log, {
        requestId: ctx.requestId,
      })
    }
    if (file.size > MAX_SIE_FILE_SIZE_BYTES) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: `File too large (${file.size} bytes). Max ${MAX_SIE_FILE_SIZE_BYTES} bytes.`,
        },
      })
    }

    // Optional execution flags. Defaults mirror the dashboard's "import all"
    // behavior. The schema is permissive — agents can omit and get sane
    // defaults.
    const optionsRaw = formData.get('options')
    let parsedOptions: unknown = {}
    if (typeof optionsRaw === 'string') {
      try {
        parsedOptions = JSON.parse(optionsRaw)
      } catch (err) {
        return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
          requestId: ctx.requestId,
          details: {
            field: 'options',
            message: `options must be a valid JSON string: ${err instanceof Error ? err.message : 'parse error'}`,
          },
        })
      }
    }
    const optionsParse = z
      .object({
        createFiscalPeriod: z.boolean().optional().default(true),
        importOpeningBalances: z.boolean().optional().default(true),
        importTransactions: z.boolean().optional().default(true),
        voucherSeries: z.string().min(1).max(2).optional().default('A'),
        updateAccountNames: z.boolean().optional().default(true),
      })
      // OWASP V4.5: reject unknown keys so a future schema-extension
      // (or a careless edit) doesn't silently pass mass-assigned fields
      // through. Zod's default is to strip unknowns — `.strict()` is
      // belt-and-suspenders.
      .strict()
      .safeParse(parsedOptions)
    if (!optionsParse.success) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          issues: optionsParse.error.issues.map((i) => ({
            field: i.path.join('.'),
            message: i.message,
          })),
        },
      })
    }
    const options = optionsParse.data

    // Decode + parse + hash. These are all sync / fast — done before
    // starting the operation row so a malformed file gets a 400 instead of
    // a permanently-failed operation row.
    const buffer = await file.arrayBuffer()
    const encoding = detectEncoding(buffer)
    const content = decodeBuffer(buffer, encoding)
    const fileHash = await calculateFileHash(content)

    // OWASP V5.2: cheap content-shape check before letting the SIE parser
    // chew on arbitrary bytes. A valid SIE4 file's first 4 KiB contains at
    // least one of #FLAGGA / #PROGRAM / #FORMAT / #SIETYP at the start
    // of a line. The regex requires line-start anchoring so an HTML
    // payload with `<!-- #FLAGGA -->` in a comment can't bypass — the
    // round-3 string-contains check was tighter than no-check, but the
    // regex is tighter still.
    const headerSlice = content.slice(0, 4096)
    if (!/(^|\n)\s*#(FLAGGA|PROGRAM|FORMAT|SIETYP)\b/.test(headerSlice)) {
      return v1ErrorResponseFromCode('SIE_PARSE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: {
          reason: 'File does not appear to be SIE4 — no #FLAGGA / #PROGRAM / #FORMAT / #SIETYP header record at the start of a line in the first 4 KiB.',
        },
      })
    }

    let parsed: Awaited<ReturnType<typeof parseSIEFile>>
    try {
      parsed = parseSIEFile(content)
    } catch (err) {
      ctx.log.error('SIE parse failed', err as Error)
      return v1ErrorResponseFromCode('SIE_PARSE_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
    const validation = validateSIEFile(parsed)
    if (!validation.valid) {
      return v1ErrorResponseFromCode('SIE_PARSE_VALIDATION_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { errors: validation.errors, warnings: validation.warnings },
      })
    }
    const { identity } = await verifySIECompanyIdentity(
      ctx.supabase,
      ctx.companyId!,
      {
        organisationNumber: parsed.header.orgNumber,
        companyName: parsed.header.companyName,
      },
    )
    if (identity.status !== 'match') {
      const failedSession = await archiveSIEParseSession({
        supabase: ctx.supabase,
        companyId: ctx.companyId!,
        userId: ctx.userId,
        fileName: file.name,
        rawBytes: new Uint8Array(buffer),
        fileHash,
        parsed,
        identity,
      })
      return v1ErrorResponseFromCode(
        identity.status === 'mismatch'
          ? 'SIE_COMPANY_IDENTITY_MISMATCH'
          : 'SIE_COMPANY_IDENTITY_MISSING',
        ctx.log,
        {
          requestId: ctx.requestId,
          details: { identity, parse_session_id: failedSession.id },
        },
      )
    }

    // Duplicate-file check before starting the operation. Log the
    // existing import id + timestamp server-side for operator forensics
    // (CC7.2 audit trail), but do NOT echo them in the response body —
    // symmetry with the bank IDOR fix. The agent learns "this file is
    // already imported" via the error code; the server log carries the
    // context for debugging.
    const dup = await checkDuplicateImport(ctx.supabase, ctx.companyId!, content)
    if (dup) {
      ctx.log.info('SIE duplicate import rejected', {
        fileHash,
        existingImportId: dup.id,
        existingImportedAt: dup.imported_at,
      })
      return v1ErrorResponseFromCode('SIE_IMPORT_DUPLICATE', ctx.log, {
        requestId: ctx.requestId,
        // Deliberately empty details. Server log has the forensic info.
      })
    }
    const parseSession = await archiveSIEParseSession({
      supabase: ctx.supabase,
      companyId: ctx.companyId!,
      userId: ctx.userId,
      fileName: file.name,
      rawBytes: new Uint8Array(buffer),
      fileHash,
      parsed,
      identity,
    })

    // Build account mappings server-side from the file's #KONTO records and
    // any stored per-company overrides — same as the dashboard execute route.
    // (This route used to pass [] as mappings, which executeSIEImport's
    // mapping-coverage guard rejects for any real file.)
    const { data: storedMappings } = await ctx.supabase
      .from('sie_account_mappings')
      .select('*')
      .eq('company_id', ctx.companyId)
    const mappings = suggestMappings(
      parsed.accounts,
      BAS_REFERENCE,
      (storedMappings as SIEAccountMappingRecord[]) || undefined,
    )

    // Reject unmappable files with a clean 400 before starting the operation
    // row, mirroring the dashboard route — the alternative is a permanently
    // failed operation from executeSIEImport's coverage guard.
    const unmapped = mappings.filter((m) => !m.targetAccount)
    if (unmapped.length > 0) {
      return v1ErrorResponseFromCode('VALIDATION_ERROR', ctx.log, {
        requestId: ctx.requestId,
        details: {
          field: 'file',
          message: `${unmapped.length} account(s) in the SIE file could not be mapped to BAS accounts.`,
          unmapped_accounts: unmapped.slice(0, 5).map((m) => ({
            account: m.sourceAccount,
            name: m.sourceName,
          })),
        },
      })
    }
    const mappingCorrections = mappings
      .filter(
        (mapping) =>
          mapping.targetAccount
          && mapping.targetAccount !== mapping.sourceAccount,
      )
      .map((mapping) => ({
        source_line_identifier: mapping.sourceAccount,
        field_name: 'account_number',
        original_value: mapping.sourceAccount,
        corrected_value: mapping.targetAccount,
        correction_type: 'account_mapping',
        reason: `Servergenererad kontomappning (${mapping.matchType}).`,
        accounting_impact: {
          changes_booking_account: true,
          changes_total_debit: false,
          changes_total_credit: false,
        },
      }))
    if (mappingCorrections.length > 0) {
      const { error: correctionError } = await ctx.supabase.rpc(
        'record_sie_import_corrections',
        {
          p_company_id: ctx.companyId!,
          p_parse_session_id: parseSession.id,
          p_user_id: ctx.userId,
          p_corrections: mappingCorrections,
        },
      )
      if (correctionError) {
        return v1ErrorResponseFromCode('SIE_IMPORT_FAILED', ctx.log, {
          requestId: ctx.requestId,
          details: { reason: `Correction log failed: ${correctionError.message}` },
        })
      }
    }

    // Start the operation row — caller polls /operations/{id} for status.
    const op = await startOperation(
      ctx.supabase,
      {
        companyId: ctx.companyId!,
        userId: ctx.userId,
        operationType: 'import.sie',
        params: {
          filename: file.name,
          file_size: file.size,
          encoding,
          file_hash: fileHash,
          voucher_count: parsed.vouchers?.length ?? 0,
        },
      },
      ctx.log,
    )

    // Run import INLINE. Future worker can take this over.
    try {
      const result = await executeSIEImport(
        ctx.supabase,
        ctx.companyId!,
        ctx.userId,
        parsed,
        mappings,
        {
          filename: file.name,
          fileContent: content,
          createFiscalPeriod: options.createFiscalPeriod,
          importOpeningBalances: options.importOpeningBalances,
          importTransactions: options.importTransactions,
          voucherSeries: options.voucherSeries,
          updateAccountNames: options.updateAccountNames,
          rawFileBytes: new Uint8Array(buffer),
          parseSessionId: parseSession.id,
        },
      )
      await completeOperation(ctx.supabase, { id: op.id, result }, ctx.log)
    } catch (err) {
      ctx.log.error('SIE import failed', err as Error, {
        operationId: op.id,
        filename: file.name,
        fileHash,
      })
      await failOperation(
        ctx.supabase,
        {
          id: op.id,
          error: {
            code: 'SIE_IMPORT_FAILED',
            message: err instanceof Error ? err.message : 'Unknown failure during SIE import.',
          },
        },
        ctx.log,
      )
      return v1ErrorResponseFromCode('SIE_IMPORT_FAILED', ctx.log, {
        requestId: ctx.requestId,
        details: { operation_id: op.id, reason: err instanceof Error ? err.message : 'unknown' },
      })
    }

    return accepted(op.id, 'import.sie', { requestId: ctx.requestId })
  },
)
