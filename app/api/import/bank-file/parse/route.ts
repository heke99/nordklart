import { NextResponse } from 'next/server'
import { parseBankFile, generateFileHash, detectFileFormat } from '@/lib/import/bank-file/parser'
import { decodeFileContent } from '@/lib/import/shared/encoding'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { BANK_FILE_FORMAT_IDS } from '@/lib/import/bank-file/types'
import type { BankFileFormatId } from '@/lib/import/bank-file/types'

/**
 * POST /api/import/bank-file/parse
 *
 * Accepts a bank file (CSV/XML) via FormData, auto-detects format, and returns
 * a parsed transactions preview with duplicate detection.
 */
export const POST = withRouteContext(
  'bank_file.parse',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const rawFormat = formData.get('format')
    // Validate the caller-supplied format against the canonical enum before
    // it reaches the parser modules.
    let formatOverride: BankFileFormatId | null = null
    if (typeof rawFormat === 'string' && rawFormat.length > 0) {
      if (!(BANK_FILE_FORMAT_IDS as readonly string[]).includes(rawFormat)) {
        return errorResponseFromCode('BANK_FILE_FORMAT_UNKNOWN', log, {
          requestId,
          details: { format: rawFormat, accepted: BANK_FILE_FORMAT_IDS },
        })
      }
      formatOverride = rawFormat as BankFileFormatId
    }

    if (!file) {
      return errorResponseFromCode('BANK_FILE_NO_FILE', log, { requestId })
    }

    if (file.size > 10 * 1024 * 1024) {
      return errorResponseFromCode('BANK_FILE_TOO_LARGE', log, {
        requestId,
        details: { sizeMb: +(file.size / 1024 / 1024).toFixed(1) },
      })
    }

    const opLog = log.child({ filename: file.name, sizeBytes: file.size })

    try {
      const arrayBuffer = await file.arrayBuffer()
      const content = decodeFileContent(arrayBuffer)
      const fileHash = generateFileHash(content)

      const { data: existingImport } = await supabase
        .from('bank_file_imports')
        .select('id, status, imported_count, created_at')
        .eq('company_id', companyId)
        .eq('file_hash', fileHash)
        .maybeSingle()

      if (existingImport && existingImport.status === 'completed') {
        return errorResponseFromCode('BANK_FILE_DUPLICATE', opLog, {
          requestId,
          details: {
            importId: existingImport.id,
            importedCount: existingImport.imported_count,
            importedAt: existingImport.created_at,
          },
        })
      }

      const detectedFormat = formatOverride
        ? null
        : detectFileFormat(content, file.name)

      const parseResult = parseBankFile(content, file.name, formatOverride || undefined)

      // Archive the ORIGINAL file (K03): the execute endpoint re-parses this
      // archived copy server-side and never trusts a client-supplied
      // transaction list. Idempotent — the same content hash maps to the
      // same storage path.
      const storagePath = `${companyId}/${fileHash}.dat`
      const { error: archiveError } = await supabase.storage
        .from('bank-files')
        .upload(storagePath, new Blob([content], { type: 'text/plain' }), { upsert: false })
      if (archiveError && !/already exists|duplicate/i.test(archiveError.message)) {
        opLog.error('bank file archive failed', new Error(archiveError.message))
        return errorResponseFromCode('BANK_FILE_PARSE_FAILED', opLog, {
          requestId,
          details: { reason: `Originalfilen kunde inte arkiveras: ${archiveError.message}` },
        })
      }

      // Create/refresh the import row now (status pending) so execute can
      // resolve the archived file by hash without any client-trusted data.
      const resolvedFormat = detectedFormat?.id || formatOverride || parseResult.format
      const { error: importRowError } = await supabase
        .from('bank_file_imports')
        .upsert(
          {
            user_id: ctx.user.id,
            company_id: companyId,
            filename: file.name,
            file_hash: fileHash,
            file_format: resolvedFormat,
            transaction_count: parseResult.transactions.length,
            total_rows: parseResult.transactions.length,
            status: 'pending',
            file_storage_path: storagePath,
            date_from: parseResult.date_from || null,
            date_to: parseResult.date_to || null,
          },
          { onConflict: 'company_id,file_hash' },
        )
      if (importRowError) {
        opLog.error('bank file import row create failed', new Error(importRowError.message))
        return errorResponseFromCode('BANK_FILE_PARSE_FAILED', opLog, {
          requestId,
          details: { reason: importRowError.message },
        })
      }

      let existingCount = 0
      if (parseResult.transactions.length > 0) {
        const { count } = await supabase
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .gte('date', parseResult.date_from || '1970-01-01')
          .lte('date', parseResult.date_to || '2099-12-31')

        existingCount = count || 0
      }

      return NextResponse.json({
        data: {
          parse_result: parseResult,
          detected_format: detectedFormat?.id || formatOverride || null,
          detected_format_name: detectedFormat?.name || parseResult.format_name,
          file_hash: fileHash,
          filename: file.name,
          existing_transaction_count: existingCount,
          headers: parseResult.format === 'generic_csv'
            ? content.split('\n')[0]?.split(',').map((h) => h.trim()) || []
            : null,
        },
      })
    } catch (err) {
      opLog.error('bank file parse failed', err as Error)
      return errorResponseFromCode('BANK_FILE_PARSE_FAILED', opLog, {
        requestId,
        details: { reason: err instanceof Error ? err.message : 'unknown' },
      })
    }
  },
  // One viewer policy (K08): importing bank data is a write operation.
  { requireWrite: true },
)
