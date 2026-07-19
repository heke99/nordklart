import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseSIEFile, validateSIEFile, detectEncoding, decodeBuffer } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { executeSIEImport, checkDuplicateImport } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { AccountMapping, SIEAccountMappingRecord } from '@/lib/import/types'

// SIE imports with many vouchers need extended execution time
export const maxDuration = 300

/** 20 MB — same ceiling as the parse endpoint. */
const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024

/**
 * Strict runtime schemas (revision item I14): unknown or malformed option
 * and mapping fields produce clear validation errors instead of being
 * silently accepted.
 */
const optionsSchema = z
  .object({
    createFiscalPeriod: z.boolean().default(true),
    importOpeningBalances: z.boolean().default(true),
    importTransactions: z.boolean().default(true),
    voucherSeries: z
      .string()
      .regex(/^[A-ZÅÄÖ]$/i, 'voucherSeries måste vara en enda bokstav')
      .optional(),
    updateAccountNames: z.boolean().default(true),
    onExistingPeriod: z.enum(['block', 'replace']).default('block'),
    /** Explicit approvals for the strict difference policy (I15/I16/I19). */
    approveOreRounding: z.boolean().default(false),
    approveSkippedVouchers: z.boolean().default(false),
    approveMigrationAdjustment: z.boolean().default(false),
    ignoreKsummaMismatch: z.boolean().default(false),
  })
  .strict()

const mappingSchema = z
  .object({
    sourceAccount: z.string().min(1).max(10),
    sourceName: z.string().max(200).optional().nullable(),
    targetAccount: z
      .string()
      .regex(/^\d{4}$/, 'Målkonto måste vara ett fyrsiffrigt BAS-konto')
      .nullable(),
    confidence: z.union([z.number(), z.string()]).optional().nullable(),
    method: z.string().max(50).optional().nullable(),
    targetName: z.string().max(200).optional().nullable(),
  })
  .passthrough()

/** POST /api/import/sie/execute — execute the SIE import. */
export const POST = withRouteContext(
  'sie_import.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const mappingsJson = formData.get('mappings') as string | null
    const optionsJson = formData.get('options') as string | null

    if (!file) {
      return errorResponseFromCode('SIE_PARSE_NO_FILE', log, { requestId })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    // Server-side file validation on execute (I13): the client can never
    // bypass type/size/emptiness checks by skipping the parse endpoint.
    if (file.size === 0) {
      return errorResponseFromCode('VALIDATION_FAILED', opLog, {
        requestId,
        details: { reason: 'Filen är tom' },
      })
    }
    if (file.size > MAX_FILE_SIZE_BYTES) {
      return errorResponseFromCode('VALIDATION_FAILED', opLog, {
        requestId,
        details: { reason: `Filen är för stor (max ${MAX_FILE_SIZE_BYTES / 1024 / 1024} MB)` },
      })
    }

    try {
      // Strict options schema (I14).
      let rawOptions: unknown = {}
      if (optionsJson) {
        try {
          rawOptions = JSON.parse(optionsJson)
        } catch {
          return errorResponseFromCode('VALIDATION_FAILED', opLog, {
            requestId,
            details: { reason: 'options är inte giltig JSON' },
          })
        }
      }
      const optionsParse = optionsSchema.safeParse(rawOptions)
      if (!optionsParse.success) {
        return errorResponseFromCode('VALIDATION_FAILED', opLog, {
          requestId,
          details: {
            reason: 'Ogiltiga importalternativ',
            issues: optionsParse.error.issues.map((i) => ({
              path: i.path.join('.'),
              message: i.message,
            })),
          },
        })
      }
      const options = optionsParse.data

      const { data: companySettings } = await supabase
        .from('company_settings')
        .select('default_voucher_series')
        .eq('company_id', companyId)
        .maybeSingle()
      const companyDefaultSeries = companySettings?.default_voucher_series || 'B'

      const arrayBuffer = await file.arrayBuffer()
      const rawBytes = new Uint8Array(arrayBuffer)
      const encoding = detectEncoding(arrayBuffer)
      const content = decodeBuffer(arrayBuffer, encoding)

      // Full server-side re-parse AND re-validation of the original file
      // (I13): the execute endpoint never trusts client-parsed data.
      const parsed = parseSIEFile(content)
      const validation = validateSIEFile(parsed)
      if (!validation.valid) {
        return errorResponseFromCode('VALIDATION_FAILED', opLog, {
          requestId,
          details: {
            reason: 'SIE-filen klarade inte server-valideringen',
            errors: validation.errors.slice(0, 20),
          },
        })
      }

      if (options.onExistingPeriod !== 'replace') {
        const duplicate = await checkDuplicateImport(supabase, companyId!, content)
        if (duplicate) {
          return errorResponseFromCode('SIE_DUPLICATE_FILE', opLog, {
            requestId,
            details: { importId: duplicate.id, importedAt: duplicate.imported_at },
          })
        }
      }

      let mappings: AccountMapping[]

      if (mappingsJson) {
        let rawMappings: unknown
        try {
          rawMappings = JSON.parse(mappingsJson)
        } catch {
          return errorResponseFromCode('VALIDATION_FAILED', opLog, {
            requestId,
            details: { reason: 'mappings är inte giltig JSON' },
          })
        }
        const mappingsParse = z.array(mappingSchema).safeParse(rawMappings)
        if (!mappingsParse.success) {
          return errorResponseFromCode('VALIDATION_FAILED', opLog, {
            requestId,
            details: {
              reason: 'Ogiltig kontomappning',
              issues: mappingsParse.error.issues.slice(0, 10).map((i) => ({
                path: i.path.join('.'),
                message: i.message,
              })),
            },
          })
        }
        mappings = mappingsParse.data as unknown as AccountMapping[]
      } else {
        const { data: storedMappings } = await supabase
          .from('sie_account_mappings')
          .select('*')
          .eq('company_id', companyId)

        mappings = suggestMappings(
          parsed.accounts,
          BAS_REFERENCE,
          (storedMappings as SIEAccountMappingRecord[]) || undefined,
        )
      }

      const unmapped = mappings.filter((m) => !m.targetAccount)
      if (unmapped.length > 0) {
        return errorResponseFromCode('SIE_IMPORT_UNMAPPED_ACCOUNTS', opLog, {
          requestId,
          details: {
            unmappedCount: unmapped.length,
            unmappedAccounts: unmapped.slice(0, 5).map((m) => ({
              account: m.sourceAccount,
              name: m.sourceName,
            })),
          },
        })
      }

      // Account creation (and #KONTO renames) happen inside executeSIEImport
      // via syncMappedAccounts — the pre-create block that used to live here
      // was a duplicate of that logic.
      const result = await executeSIEImport(
        supabase,
        companyId!,
        user.id,
        parsed,
        mappings,
        {
          filename: file.name,
          fileContent: content,
          createFiscalPeriod: options.createFiscalPeriod,
          importOpeningBalances: options.importOpeningBalances,
          importTransactions: options.importTransactions,
          voucherSeries: options.voucherSeries || companyDefaultSeries,
          updateAccountNames: options.updateAccountNames,
          onExistingPeriod: options.onExistingPeriod,
          approveOreRounding: options.approveOreRounding,
          approveSkippedVouchers: options.approveSkippedVouchers,
          approveMigrationAdjustment: options.approveMigrationAdjustment,
          ignoreKsummaMismatch: options.ignoreKsummaMismatch,
          rawFileBytes: rawBytes,
        },
      )

      if (!result.success) {
        return errorResponseFromCode('SIE_IMPORT_FAILED', opLog, {
          requestId,
          details: { result },
        })
      }

      return NextResponse.json({ success: true, result })
    } catch (err) {
      opLog.error('sie execute unexpected error', err as Error)
      return errorResponseFromCode('SIE_IMPORT_UNEXPECTED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  { requireWrite: true },
)
