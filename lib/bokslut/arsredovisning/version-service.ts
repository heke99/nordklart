import { renderToBuffer } from '@react-pdf/renderer'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createServiceClient } from '@/lib/supabase/server'
import { buildArsredovisningData } from './build-data'
import { ArsredovisningPDF } from './arsredovisning-pdf'
import { annualReportFileSlug } from './format'
import {
  runAnnualReportPreflight,
  type AnnualReportPreflightReport,
} from './preflight'
import {
  compareCoreAmounts,
  coreAmountsFromAnnualReport,
  coreAmountsFromIxbrl,
} from './core-amounts'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { generateK2IxbrlDocument } from '@/lib/bokslut/ixbrl/document/k2-document'
import { runPreflightChecks } from '@/lib/bokslut/ixbrl/validate/rules'
import {
  computeSHA256,
  deleteDocument,
  uploadDocument,
} from '@/lib/core/documents/document-service'

export class AnnualReportFinalizationError extends Error {
  constructor(
    message: string,
    public readonly report: AnnualReportPreflightReport,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'AnnualReportFinalizationError'
  }
}

function exactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function containsDraftToken(bytes: Uint8Array): boolean {
  return new TextDecoder('latin1').decode(bytes).toLocaleUpperCase('sv-SE').includes('UTKAST')
}

async function combinedHash(pdfHash: string, ixbrlHash: string): Promise<string> {
  return computeSHA256(exactArrayBuffer(new TextEncoder().encode(`${pdfHash}:${ixbrlHash}`)))
}

async function persistPreflightSafely(
  supabase: SupabaseClient,
  actorUserId: string,
  companyId: string,
  fiscalPeriodId: string,
  report: AnnualReportPreflightReport,
): Promise<void> {
  // Preflight persistence is operational metadata. Validation results must
  // still reach the caller even if an older database has not received the
  // migration yet or a concurrent finalization has locked the project.
  const { error } = await supabase.rpc(
    'record_annual_report_preflight',
    {
      p_company_id: companyId,
      p_fiscal_period_id: fiscalPeriodId,
      p_actor_user_id: actorUserId,
      p_preflight_report: report,
    } as never,
  )
  if (error) console.warn('Could not persist annual-report preflight', error.message)
}

export interface FinalizeAnnualReportResult {
  project_id: string
  version_id: string
  version_number: number
  status: 'signed'
  pdf_document_id: string
  ixbrl_document_id: string
  pdf_sha256: string
  ixbrl_sha256: string
  combined_sha256: string
  validation_report: Record<string, unknown>
}

/**
 * Builds, validates and archives a final annual report. The RPC only records
 * the version after both exact files have been uploaded and all blockers are
 * zero. Direct `isDraft=false` rendering is deliberately not exposed by a
 * route; callers must pass through this service.
 */
export async function finalizeAnnualReport(
  supabase: SupabaseClient,
  actorUserId: string,
  companyId: string,
  fiscalPeriodId: string,
): Promise<FinalizeAnnualReportResult> {
  const { error: projectEnsureError } = await supabase
    .from('annual_report_projects')
    .upsert(
      {
        company_id: companyId,
        fiscal_period_id: fiscalPeriodId,
        status: 'draft',
        annual_report_locked: false,
        preflight_status: 'not_run',
        blocking_issue_count: 0,
        submission_blocked: true,
        created_by: actorUserId,
        updated_by: actorUserId,
      },
      { onConflict: 'company_id,fiscal_period_id', ignoreDuplicates: true },
    )
  if (projectEnsureError) {
    throw new Error(`Failed to initialize annual report project: ${projectEnsureError.message}`)
  }
  const { data: projectState, error: projectStateError } = await supabase
    .from('annual_report_projects')
    .select('document_revision, annual_report_locked')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .single()
  if (projectStateError || !projectState) {
    throw new Error(`Failed to load annual report project revision: ${projectStateError?.message ?? 'not found'}`)
  }
  if (projectState.annual_report_locked) {
    throw new Error('ANNUAL_REPORT_LOCKED_CREATE_NEW_VERSION_REQUIRED')
  }
  const expectedDocumentRevision = Number(projectState.document_revision)

  const [{ data: period, error: periodError }, annualReport] = await Promise.all([
    supabase
      .from('fiscal_periods')
      .select('is_closed, ledger_locked, closing_entry_id')
      .eq('id', fiscalPeriodId)
      .eq('company_id', companyId)
      .single(),
    buildArsredovisningData(supabase, companyId, fiscalPeriodId),
  ])
  if (periodError || !period) throw new Error('Annual report fiscal period not found')

  if (annualReport.accounting_framework !== 'k2') {
    const report = runAnnualReportPreflight(annualReport, {
      period_closed: Boolean(period.is_closed),
      ledger_locked: Boolean(period.ledger_locked),
      closing_entry_id: period.closing_entry_id ?? null,
    })
    report.issues.push({
      code: 'K3_DIGITAL_SUBMISSION_NOT_SUPPORTED',
      severity: 'blocking',
      scope: 'archive',
      message: 'K3 kan ännu inte färdigställas med matchande digital iXBRL-inlämningsfil.',
      requires_reopen: false,
      actions: [{ id: 'download_k3_draft', label: 'Ladda ned K3-utkast' }],
    })
    report.preflight_status = 'failed'
    report.blocking_issue_count += 1
    await persistPreflightSafely(supabase, actorUserId, companyId, fiscalPeriodId, report)
    throw new AnnualReportFinalizationError('Årsredovisningen kan inte färdigställas.', report)
  }

  const initialReport = runAnnualReportPreflight(annualReport, {
    period_closed: Boolean(period.is_closed),
    ledger_locked: Boolean(period.ledger_locked),
    closing_entry_id: period.closing_entry_id ?? null,
  })
  await persistPreflightSafely(
    supabase,
    actorUserId,
    companyId,
    fiscalPeriodId,
    initialReport,
  )
  if (initialReport.blocking_issue_count > 0) {
    throw new AnnualReportFinalizationError(
      'Årsredovisningen har kvarvarande blockerare.',
      initialReport,
    )
  }

  const ixbrlInput = await buildIxbrlInput(supabase, companyId, fiscalPeriodId)
  const ixbrlPreflight = runPreflightChecks(ixbrlInput)
  if (!ixbrlPreflight.ok) {
    const report: AnnualReportPreflightReport = {
      ...initialReport,
      preflight_status: 'failed',
      blocking_issue_count: initialReport.blocking_issue_count + ixbrlPreflight.errors.length,
      warning_count: initialReport.warning_count + ixbrlPreflight.warnings.length,
      issues: [
        ...initialReport.issues,
        ...ixbrlPreflight.errors.map((entry) => ({
          code: `IXBRL_${entry.code}`,
          severity: 'blocking' as const,
          scope: 'archive' as const,
          message: entry.message,
          requires_reopen: false,
          actions: [{ id: 'open_ixbrl_validation', label: 'Visa iXBRL-kontroll' }],
        })),
        ...ixbrlPreflight.warnings.map((entry) => ({
          code: `IXBRL_${entry.code}`,
          severity: 'warning' as const,
          scope: 'archive' as const,
          message: entry.message,
          requires_reopen: false,
          actions: [{ id: 'open_ixbrl_validation', label: 'Visa iXBRL-kontroll' }],
        })),
      ],
    }
    await persistPreflightSafely(supabase, actorUserId, companyId, fiscalPeriodId, report)
    throw new AnnualReportFinalizationError('iXBRL-förhandskontrollen misslyckades.', report)
  }

  const pdfCore = coreAmountsFromAnnualReport(annualReport)
  const ixbrlCore = coreAmountsFromIxbrl(ixbrlInput)
  const coreComparison = compareCoreAmounts(pdfCore, ixbrlCore)

  const pdfBuffer = await renderToBuffer(
    ArsredovisningPDF({ data: annualReport, isDraft: false, draftBlockers: [] }),
  )
  const pdfBytes = new Uint8Array(pdfBuffer)
  const { xhtml, warnings: generationWarnings } = generateK2IxbrlDocument(ixbrlInput, {
    isDraft: false,
  })
  const ixbrlBytes = new TextEncoder().encode(xhtml)
  const pdfContainsDraft = containsDraftToken(pdfBytes)
  const ixbrlContainsDraft = /UTKAST/i.test(xhtml)

  const finalReport = runAnnualReportPreflight(annualReport, {
    period_closed: Boolean(period.is_closed),
    ledger_locked: Boolean(period.ledger_locked),
    closing_entry_id: period.closing_entry_id ?? null,
    pdf_ixbrl_match: coreComparison.match,
    final_pdf_requested: true,
    pdf_text_contains_draft: pdfContainsDraft,
  })
  if (ixbrlContainsDraft) {
    finalReport.issues.push({
      code: 'FINAL_IXBRL_CONTAINS_DRAFT',
      severity: 'blocking',
      scope: 'archive',
      message: 'Slutlig iXBRL innehåller texten UTKAST.',
      requires_reopen: false,
      actions: [{ id: 'regenerate_final_ixbrl', label: 'Generera om iXBRL' }],
    })
    finalReport.blocking_issue_count += 1
    finalReport.preflight_status = 'failed'
  }
  await persistPreflightSafely(
    supabase,
    actorUserId,
    companyId,
    fiscalPeriodId,
    finalReport,
  )
  if (finalReport.blocking_issue_count > 0) {
    throw new AnnualReportFinalizationError(
      'Slutliga dokument klarade inte arkivkontrollen.',
      finalReport,
      { core_comparison: coreComparison },
    )
  }

  const year = annualReport.fiscal_period.period_end.slice(0, 4)
  const slug = annualReportFileSlug(annualReport.company.name)
  const pdfName = `arsredovisning-${slug}-${year}-slutlig.pdf`
  const ixbrlName = `arsredovisning-${slug}-${year}-slutlig.xhtml`
  const pdfArrayBuffer = exactArrayBuffer(pdfBytes)
  const ixbrlArrayBuffer = exactArrayBuffer(ixbrlBytes)

  let pdfDocumentId: string | null = null
  let ixbrlDocumentId: string | null = null
  try {
    const pdfDocument = await uploadDocument(
      supabase,
      actorUserId,
      companyId,
      { name: pdfName, buffer: pdfArrayBuffer, type: 'application/pdf' },
      { upload_source: 'system' },
    )
    pdfDocumentId = pdfDocument.id
    const ixbrlDocument = await uploadDocument(
      supabase,
      actorUserId,
      companyId,
      { name: ixbrlName, buffer: ixbrlArrayBuffer, type: 'application/xhtml+xml' },
      { upload_source: 'system' },
    )
    ixbrlDocumentId = ixbrlDocument.id

    const pdfHash = pdfDocument.sha256_hash
    const ixbrlHash = ixbrlDocument.sha256_hash
    const aggregateHash = await combinedHash(pdfHash, ixbrlHash)
    const validationReport = {
      ...finalReport,
      pdf_ixbrl_match: coreComparison.match,
      core_amounts: coreComparison.fields,
      ixbrl_preflight: ixbrlPreflight,
      ixbrl_generation_warnings: generationWarnings,
      final_pdf_proof: {
        render_mode: 'final',
        binary_scan_contains_draft: pdfContainsDraft,
        template_watermark_enabled: false,
      },
      final_ixbrl_proof: {
        render_mode: 'final',
        text_scan_contains_draft: ixbrlContainsDraft,
      },
    }

    const serviceDb = createServiceClient()
    const { data: version, error: versionError } = await serviceDb.rpc(
      'finalize_annual_report_version',
      {
        p_company_id: companyId,
        p_fiscal_period_id: fiscalPeriodId,
        p_actor_user_id: actorUserId,
        p_expected_document_revision: expectedDocumentRevision,
        p_canonical_snapshot: annualReport,
        p_formal_report_snapshot: annualReport.formal_report,
        p_core_amounts: pdfCore,
        p_validation_report: validationReport,
        p_pdf_document_id: pdfDocument.id,
        p_ixbrl_document_id: ixbrlDocument.id,
        p_pdf_sha256: pdfHash,
        p_ixbrl_sha256: ixbrlHash,
        p_combined_sha256: aggregateHash,
      } as never,
    )
    if (versionError || !version) {
      throw new Error(`Failed to register final annual report version: ${versionError?.message ?? 'no result'}`)
    }

    const result = version as unknown as Omit<FinalizeAnnualReportResult, 'pdf_sha256' | 'ixbrl_sha256' | 'validation_report'>
    return {
      ...result,
      pdf_sha256: pdfHash,
      ixbrl_sha256: ixbrlHash,
      validation_report: validationReport,
    }
  } catch (error) {
    if (ixbrlDocumentId) await deleteDocument(supabase, companyId, ixbrlDocumentId).catch(() => undefined)
    if (pdfDocumentId) await deleteDocument(supabase, companyId, pdfDocumentId).catch(() => undefined)
    throw error
  }
}

export interface ArchivedAnnualReportArtifact {
  version_id: string
  version_number: number
  status: string
  document_id: string
  file_name: string
  mime_type: string
  sha256_hash: string
  bytes: ArrayBuffer
}

export async function loadCurrentAnnualReportArtifact(
  supabase: SupabaseClient,
  companyId: string,
  fiscalPeriodId: string,
  kind: 'pdf' | 'ixbrl',
): Promise<ArchivedAnnualReportArtifact | null> {
  const { data: project, error: projectError } = await supabase
    .from('annual_report_projects')
    .select('current_version_id, status')
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (projectError) throw new Error(`Failed to load annual report project: ${projectError.message}`)
  if (!project?.current_version_id || !['final', 'signed', 'filed', 'registered'].includes(project.status)) {
    return null
  }

  const { data: version, error: versionError } = await supabase
    .from('annual_report_versions')
    .select('id, version_number, status, pdf_document_id, ixbrl_document_id')
    .eq('id', project.current_version_id)
    .eq('company_id', companyId)
    .eq('fiscal_period_id', fiscalPeriodId)
    .maybeSingle()
  if (versionError) throw new Error(`Failed to load annual report version: ${versionError.message}`)
  const documentId = kind === 'pdf' ? version?.pdf_document_id : version?.ixbrl_document_id
  if (!version || typeof documentId !== 'string') return null

  const { data: document, error: documentError } = await supabase
    .from('document_attachments')
    .select('id, storage_path, file_name, mime_type, sha256_hash')
    .eq('id', documentId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (documentError || !document) {
    throw new Error(`Archived annual report document is missing: ${documentError?.message ?? documentId}`)
  }
  const { data: storedFile, error: downloadError } = await supabase.storage
    .from('documents')
    .download(document.storage_path)
  if (downloadError || !storedFile) {
    throw new Error(`Failed to download archived annual report: ${downloadError?.message ?? documentId}`)
  }
  const bytes = await storedFile.arrayBuffer()
  const computedHash = await computeSHA256(bytes)
  if (computedHash !== document.sha256_hash) {
    throw new Error('ANNUAL_REPORT_ARCHIVE_HASH_MISMATCH')
  }
  return {
    version_id: version.id,
    version_number: version.version_number,
    status: version.status,
    document_id: document.id,
    file_name: document.file_name,
    mime_type: document.mime_type ?? (kind === 'pdf' ? 'application/pdf' : 'application/xhtml+xml'),
    sha256_hash: document.sha256_hash,
    bytes,
  }
}
