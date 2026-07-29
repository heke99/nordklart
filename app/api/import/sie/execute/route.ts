import { NextResponse } from 'next/server'
import { z } from 'zod'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'
import { suggestMappings } from '@/lib/import/account-mapper'
import { executeSIEImport, checkDuplicateImport } from '@/lib/import/sie-import'
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-data'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { AccountMapping, SIEAccountMappingRecord } from '@/lib/import/types'
import { isSieFiscalPeriodAllowed, resolveSieFiscalYearAccess } from '@/lib/import/access'
import { loadArchivedSIEParseSession } from '@/lib/import/sie-parse-session'
import { verifySIECompanyIdentity } from '@/lib/import/company-identity-server'
import { createServiceClient } from '@/lib/supabase/server'

// SIE imports with many vouchers need extended execution time
export const maxDuration = 300

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
    replaceImportId: z.string().uuid().nullable().optional(),
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
    const parseSessionIdRaw = formData.get('parseSessionId')
    const mappingsJson = formData.get('mappings') as string | null
    const optionsJson = formData.get('options') as string | null

    const parseSessionId = z.string().uuid().safeParse(parseSessionIdRaw)
    if (!parseSessionId.success) {
      return errorResponseFromCode('SIE_PARSE_SESSION_INVALID', log, {
        requestId,
        details: { reason: 'parseSessionId saknas eller är ogiltigt.' },
      })
    }

    const opLog = log.child({ parseSessionId: parseSessionId.data })
    const sessionDb = createServiceClient()

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
      if (options.onExistingPeriod === 'replace' && !options.replaceImportId) {
        return errorResponseFromCode('VALIDATION_FAILED', opLog, {
          requestId,
          details: { reason: 'replaceImportId krävs när en tidigare import ska ersättas.' },
        })
      }
      if (options.onExistingPeriod !== 'replace' && options.replaceImportId) {
        return errorResponseFromCode('VALIDATION_FAILED', opLog, {
          requestId,
          details: { reason: 'replaceImportId får endast användas i replace-läge.' },
        })
      }

      const { data: companySettings } = await supabase
        .from('company_settings')
        .select('default_voucher_series')
        .eq('company_id', companyId)
        .maybeSingle()
      const companyDefaultSeries = companySettings?.default_voucher_series || 'B'

      const archivedSession = await loadArchivedSIEParseSession({
        supabase: sessionDb,
        companyId,
        userId: user.id,
        sessionId: parseSessionId.data,
      }).catch((error: unknown) => {
        opLog.warn('invalid archived SIE parse session', {
          reason: error instanceof Error ? error.message : 'unknown',
        })
        return null
      })
      if (!archivedSession) {
        return errorResponseFromCode('SIE_PARSE_SESSION_INVALID', opLog, {
          requestId,
        })
      }
      const { session, rawBytes, content } = archivedSession
      if (
        (session.replace_import_id ?? null)
        !== (options.replaceImportId ?? null)
      ) {
        return errorResponseFromCode('SIE_PARSE_SESSION_INVALID', opLog, {
          requestId,
          details: {
            reason:
              'Importsessionens ersättningsmål stämmer inte med execute-anropet.',
          },
        })
      }

      // Full server-side re-parse AND re-validation of the original file
      // (I13): the execute endpoint never trusts client-parsed data.
      const parsed = parseSIEFile(content)
      const { identity } = await verifySIECompanyIdentity(
        supabase,
        companyId,
        {
          organisationNumber: parsed.header.orgNumber,
          companyName: parsed.header.companyName,
        },
      )
      if (identity.status !== 'match') {
        return errorResponseFromCode(
          identity.status === 'mismatch'
            ? 'SIE_COMPANY_IDENTITY_MISMATCH'
            : 'SIE_COMPANY_IDENTITY_MISSING',
          opLog,
          { requestId, details: { identity } },
        )
      }
      const fiscalAccess = await resolveSieFiscalYearAccess(
        supabase,
        ctx.sieImportAccess,
        companyId,
        parsed.stats.fiscalYearStart,
        parsed.stats.fiscalYearEnd,
      )
      if (options.replaceImportId) {
        const { data: prior, error: priorError } = await supabase
          .from('sie_imports')
          .select('id,status,fiscal_period_id,fiscal_year_start,fiscal_year_end')
          .eq('id', options.replaceImportId)
          .eq('company_id', companyId)
          .maybeSingle()
        if (priorError) throw new Error(priorError.message)
        if (!prior || !['completed', 'partial'].includes(prior.status) || !isSieFiscalPeriodAllowed(ctx.sieImportAccess, prior.fiscal_period_id)) {
          return errorResponseFromCode('SIE_IMPORT_NOT_FOUND', opLog, { requestId })
        }
        if (prior.fiscal_year_start !== parsed.stats.fiscalYearStart || prior.fiscal_year_end !== parsed.stats.fiscalYearEnd) {
          return errorResponseFromCode('VALIDATION_FAILED', opLog, {
            requestId,
            details: { reason: 'Den korrigerade filen måste avse exakt samma räkenskapsår som importen som ersätts.' },
          })
        }
      }
      if (!fiscalAccess.allowed) {
        return errorResponseFromCode('PERMISSION_DENIED', opLog, {
          requestId,
          details: { reason: 'SIE-filen avser ett annat räkenskapsår än det köpta engångsbokslutet.' },
        })
      }

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
          reason: `Kontomappning godkänd inför import (${mapping.matchType}).`,
          accounting_impact: {
            changes_booking_account: true,
            changes_total_debit: false,
            changes_total_credit: false,
          },
        }))
      if (mappingCorrections.length > 0) {
        const { error: correctionError } = await sessionDb.rpc(
          'record_sie_import_corrections',
          {
            p_company_id: companyId,
            p_parse_session_id: session.id,
            p_user_id: user.id,
            p_corrections: mappingCorrections,
          },
        )
        if (correctionError) {
          return errorResponseFromCode('SIE_IMPORT_UNEXPECTED', opLog, {
            requestId,
            details: {
              reason: `Korrigeringsloggen kunde inte sparas: ${correctionError.message}`,
            },
          })
        }
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
          filename: session.file_name,
          fileContent: content,
          createFiscalPeriod: options.createFiscalPeriod,
          importOpeningBalances: options.importOpeningBalances,
          importTransactions: options.importTransactions,
          voucherSeries: options.voucherSeries || companyDefaultSeries,
          updateAccountNames: options.updateAccountNames,
          onExistingPeriod: options.onExistingPeriod,
          replaceImportId: options.replaceImportId ?? null,
          approveOreRounding: options.approveOreRounding,
          approveSkippedVouchers: options.approveSkippedVouchers,
          approveMigrationAdjustment: options.approveMigrationAdjustment,
          ignoreKsummaMismatch: options.ignoreKsummaMismatch,
          rawFileBytes: rawBytes,
          parseSessionId: session.id,
        },
      )

      await sessionDb
        .from('sie_parse_sessions')
        .update({
          status: result.success ? 'completed' : 'failed',
          sie_import_id: result.importId,
          completed_at: result.success ? new Date().toISOString() : null,
          error_message: result.success ? null : result.errors.join('; '),
        })
        .eq('id', session.id)
        .eq('company_id', companyId)

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
  { requireWrite: true, accessPolicy: 'sie_import' },
)
