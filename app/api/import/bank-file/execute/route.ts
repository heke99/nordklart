import { NextResponse } from 'next/server'
import { z } from 'zod'
import { eventBus } from '@/lib/events'
import { ensureInitialized } from '@/lib/init'
import { ingestTransactions, type RawTransaction } from '@/lib/transactions/ingest'
import { parseBankFile, generateFileHash, generateExternalId } from '@/lib/import/bank-file/parser'
import { parseGenericCSV } from '@/lib/import/bank-file/formats/generic-csv'
import type { GenericCSVColumnMapping } from '@/lib/import/bank-file/types'
import type { IngestOptions } from '@/types'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import type { Transaction } from '@/types'

ensureInitialized()

/**
 * POST /api/import/bank-file/execute (revision items K01–K04, K08)
 *
 * Executes a bank file import FROM THE ARCHIVED ORIGINAL FILE (K03): the
 * server downloads the file the parse endpoint archived, recomputes the
 * hash, re-parses and creates the transactions. A client-supplied
 * transaction list is never trusted.
 *
 * Row-level status in bank_file_import_rows makes retries idempotent (K04):
 * a partially failed file finalizes as 'partial' — never 'completed' — and a
 * re-run only processes rows that are still pending/failed.
 *
 * The import contract flags are honored end to end (K01/K02):
 *   - auto_categorize=false → no automation runs at all,
 *   - skip_duplicates=true → duplicates skipped and reported,
 *     skip_duplicates=false → duplicates block the import.
 */
const executeSchema = z
  .object({
    file_hash: z
      .string()
      .regex(/^[a-f0-9]{16,64}$/i, 'Ogiltig filsignatur — kör om förhandsgranskningen.'),
    skip_duplicates: z.boolean().default(true),
    auto_categorize: z.boolean().default(true),
    settlement_account: z
      .string()
      .regex(/^\d{4}$/, 'settlement_account måste vara ett fyrsiffrigt konto')
      .default('1930'),
    /** Generic CSV only: the user's column mapping, applied to the archived
     * original server-side. */
    column_mapping: z
      .object({
        date: z.number().int().min(0),
        description: z.number().int().min(0),
        amount: z.number().int().min(0),
        reference: z.number().int().min(0).optional(),
        counterparty: z.number().int().min(0).optional(),
        balance: z.number().int().min(0).optional(),
        delimiter: z.string().min(1).max(3),
        decimal_separator: z.enum([',', '.']),
        skip_rows: z.number().int().min(0).max(100),
        date_format: z.string().min(4).max(20),
      })
      .optional(),
  })
  // Legacy clients still send transactions/format/filename — accepted but
  // IGNORED (the archived original is the only source of truth, K03).
  .passthrough()

export const POST = withRouteContext(
  'bank_file.execute',
  async (request, ctx) => {
    const { user, supabase, companyId, log, requestId } = ctx

    let rawBody: unknown
    try {
      rawBody = await request.json()
    } catch {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: { message: 'Ogiltig JSON-body' },
      })
    }

    const parse = executeSchema.safeParse(rawBody)
    if (!parse.success) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        details: {
          message: 'Ogiltiga importalternativ',
          issues: parse.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      })
    }
    const { file_hash, skip_duplicates, auto_categorize, settlement_account, column_mapping } =
      parse.data

    const opLog = log.child({ fileHash: file_hash })

    try {
      // Resolve the import record created by the parse endpoint.
      const { data: importRecord, error: importFetchError } = await supabase
        .from('bank_file_imports')
        .select('*')
        .eq('company_id', companyId)
        .eq('file_hash', file_hash)
        .maybeSingle()

      if (importFetchError) {
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: importFetchError.message },
        })
      }
      if (!importRecord || !importRecord.file_storage_path) {
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: {
            message:
              'Ingen arkiverad originalfil hittades för denna filsignatur. Kör förhandsgranskningen (parse) igen.',
          },
        })
      }
      if (importRecord.status === 'completed') {
        // Idempotent replay: the file is already fully imported.
        return NextResponse.json({
          data: {
            import_id: importRecord.id,
            status: 'completed',
            imported: importRecord.imported_rows,
            duplicates: importRecord.duplicate_rows,
            errors: importRecord.failed_rows,
            idempotent: true,
          },
        })
      }

      // Download and re-parse the ARCHIVED original (K03). Verify the hash.
      const { data: fileBlob, error: downloadError } = await supabase.storage
        .from('bank-files')
        .download(importRecord.file_storage_path)
      if (downloadError || !fileBlob) {
        return errorResponseFromCode('BANK_FILE_EXECUTE_FAILED', opLog, {
          requestId,
          details: {
            reason: `Den arkiverade originalfilen kunde inte läsas: ${downloadError?.message ?? 'okänt fel'}`,
          },
        })
      }
      const content = await fileBlob.text()
      const serverHash = generateFileHash(content)
      if (serverHash !== file_hash.toLowerCase()) {
        return errorResponseFromCode('BANK_FILE_EXECUTE_FAILED', opLog, {
          requestId,
          details: { reason: 'Filsignaturen stämmer inte med den arkiverade filen.' },
        })
      }

      const parseResult =
        importRecord.file_format === 'generic_csv' && column_mapping
          ? parseGenericCSV(content, column_mapping as GenericCSVColumnMapping)
          : parseBankFile(content, importRecord.filename, importRecord.file_format || undefined)
      if (parseResult.transactions.length === 0) {
        return errorResponseFromCode('BANK_FILE_NO_TRANSACTIONS', opLog, { requestId })
      }

      // Mark processing + persist the honored options (K01/K02 contract).
      const { error: statusError } = await supabase
        .from('bank_file_imports')
        .update({
          status: 'processing',
          total_rows: parseResult.transactions.length,
          transaction_count: parseResult.transactions.length,
          settlement_account,
          options: {
            skip_duplicates,
            auto_categorize,
            settlement_account,
          },
        })
        .eq('id', importRecord.id)
        .eq('company_id', companyId)
      if (statusError) {
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: statusError.message },
        })
      }

      // Row-level bookkeeping (K04): upsert one row per parsed transaction
      // with a stable row key. Retries only touch rows not yet imported.
      const format = importRecord.file_format
      const rowKeyed = parseResult.transactions.map((tx, index) => ({
        tx,
        rowIndex: index,
        rowKey: generateExternalId(tx, format, index),
      }))

      const ROW_BATCH = 500
      for (let i = 0; i < rowKeyed.length; i += ROW_BATCH) {
        const batch = rowKeyed.slice(i, i + ROW_BATCH).map((r) => ({
          import_id: importRecord.id,
          company_id: companyId,
          row_index: r.rowIndex,
          row_key: r.rowKey,
          status: 'pending',
        }))
        const { error: rowInsertError } = await supabase
          .from('bank_file_import_rows')
          .upsert(batch, { onConflict: 'import_id,row_key', ignoreDuplicates: true })
        if (rowInsertError) {
          return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
            requestId,
            details: { reason: rowInsertError.message },
          })
        }
      }

      // Fetch current row statuses — a retry processes only pending/failed rows.
      const { data: existingRows, error: rowsFetchError } = await supabase
        .from('bank_file_import_rows')
        .select('row_key, status')
        .eq('import_id', importRecord.id)
        .eq('company_id', companyId)
        .limit(100000)
      if (rowsFetchError) {
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: rowsFetchError.message },
        })
      }
      const rowStatusByKey = new Map<string, string>(
        (existingRows ?? []).map((r) => [r.row_key as string, r.status as string]),
      )

      const toProcess = rowKeyed.filter((r) => {
        const status = rowStatusByKey.get(r.rowKey)
        return status === undefined || status === 'pending' || status === 'failed'
      })

      const rawTransactions: RawTransaction[] = toProcess.map((r) => ({
        date: r.tx.date,
        description: r.tx.description,
        amount: r.tx.amount,
        currency: r.tx.currency || 'SEK',
        external_id: r.rowKey,
        reference: r.tx.reference || null,
        import_source: format === 'camt053' ? 'camt053' : `csv_${format}`,
      }))

      const ingestOptions: IngestOptions = {
        settlementAccount: settlement_account,
      }
      // K01: auto_categorize=false disables ALL automation.
      if (!auto_categorize) ingestOptions.disableAutomation = true

      const ingestResult =
        rawTransactions.length > 0
          ? await ingestTransactions(supabase, companyId, user.id, rawTransactions, ingestOptions)
          : {
              imported: 0,
              duplicates: 0,
              reconciled: 0,
              auto_categorized: 0,
              auto_matched_invoices: 0,
              errors: 0,
              transaction_ids: [] as string[],
              automation_errors: 0,
              mapping_required: 0,
              row_results: [],
            }

      // K02: skip_duplicates=false ⇒ duplicates BLOCK the import.
      const newDuplicates = ingestResult.row_results.filter((r) => r.status === 'duplicate')
      if (!skip_duplicates && newDuplicates.length > 0) {
        await supabase
          .from('bank_file_imports')
          .update({
            status: 'failed',
            error_message: `${newDuplicates.length} dubbletter hittades och skip_duplicates är avstängt. Ingen rad importerades i denna körning.`,
          })
          .eq('id', importRecord.id)
          .eq('company_id', companyId)
        // Note: rows imported in THIS run before the duplicate check are
        // impossible — dedup happens before insert in ingestTransactions,
        // and duplicate rows are never inserted.
        return errorResponseFromCode('VALIDATION_ERROR', opLog, {
          requestId,
          details: {
            message: `${newDuplicates.length} transaktioner är dubbletter. Importen blockerades eftersom skip_duplicates=false.`,
            duplicates: newDuplicates.slice(0, 20).map((r) => r.external_id),
          },
        })
      }

      // Persist per-row outcomes (K04).
      for (const rowResult of ingestResult.row_results) {
        const status =
          rowResult.status === 'imported'
            ? 'imported'
            : rowResult.status === 'duplicate'
              ? 'duplicate'
              : 'failed'
        await supabase
          .from('bank_file_import_rows')
          .update({
            status,
            error_message: rowResult.error,
            transaction_id: rowResult.transaction_id,
            updated_at: new Date().toISOString(),
          })
          .eq('import_id', importRecord.id)
          .eq('company_id', companyId)
          .eq('row_key', rowResult.external_id)
      }

      // Recount authoritative row totals.
      const { data: finalRows, error: finalRowsError } = await supabase
        .from('bank_file_import_rows')
        .select('status')
        .eq('import_id', importRecord.id)
        .eq('company_id', companyId)
        .limit(100000)
      if (finalRowsError) {
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: finalRowsError.message },
        })
      }
      const counts = { imported: 0, duplicate: 0, failed: 0, pending: 0 }
      for (const r of finalRows ?? []) {
        counts[(r.status as keyof typeof counts) ?? 'pending'] =
          (counts[(r.status as keyof typeof counts) ?? 'pending'] ?? 0) + 1
      }

      // Final status (K04): any failed/pending row ⇒ 'partial', never
      // 'completed'. Zero imported with failures ⇒ 'failed'.
      const finalStatus =
        counts.failed + counts.pending === 0
          ? 'completed'
          : counts.imported + counts.duplicate === 0
            ? 'failed'
            : 'partial'

      const errorMessage =
        ingestResult.errors > 0 && ingestResult.first_error
          ? `${ingestResult.errors} fel: ${ingestResult.first_error.message}${ingestResult.first_error.details ? ` (${ingestResult.first_error.details})` : ''}`
          : counts.failed > 0
            ? `${counts.failed} rader kunde inte importeras`
            : null

      const { error: finalizeError } = await supabase
        .from('bank_file_imports')
        .update({
          imported_count: counts.imported,
          imported_rows: counts.imported,
          duplicate_count: counts.duplicate,
          duplicate_rows: counts.duplicate,
          failed_rows: counts.failed + counts.pending,
          matched_count: ingestResult.auto_matched_invoices,
          status: finalStatus,
          error_message: errorMessage,
        })
        .eq('id', importRecord.id)
        .eq('company_id', companyId)
      if (finalizeError) {
        // Controlled status finalization (I17-analog for bank files): never
        // answer success when the status could not be saved.
        return errorResponseFromCode('BANK_FILE_IMPORT_RECORD_FAILED', opLog, {
          requestId,
          details: { reason: finalizeError.message },
        })
      }

      if (ingestResult.imported > 0 && ingestResult.transaction_ids.length > 0) {
        try {
          const { data: importedTransactions } = await supabase
            .from('transactions')
            .select('*')
            .in('id', ingestResult.transaction_ids)

          if (importedTransactions && importedTransactions.length > 0) {
            await eventBus.emit({
              type: 'transaction.synced',
              payload: {
                transactions: importedTransactions as Transaction[],
                userId: user.id,
                companyId,
              },
            })
          }
        } catch (err) {
          opLog.warn('transaction.synced event emission failed', err as Error)
        }
      }

      return NextResponse.json({
        data: {
          import_id: importRecord.id,
          status: finalStatus,
          ...ingestResult,
          imported: counts.imported,
          duplicates: counts.duplicate,
          errors: counts.failed,
          automation_errors: ingestResult.automation_errors,
          mapping_required: ingestResult.mapping_required,
        },
      })
    } catch (err) {
      opLog.error('bank file execute failed', err as Error)
      return errorResponseFromCode('BANK_FILE_EXECUTE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  // One viewer policy (K08): viewers are read-only — the previous
  // rawInsertOnly viewer exception is removed; RLS enforces the same at the
  // database layer.
  { requireWrite: true },
)
