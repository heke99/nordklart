import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'

export type LinkSourceDocumentResult = {
  linked: boolean
  warning?: { code: string; message: string }
}

export async function linkSourceDocumentToJournalEntry(params: {
  supabase: SupabaseClient
  companyId: string
  documentId?: string | null
  journalEntryId?: string | null
  sourceType: string
  sourceId: string
}): Promise<LinkSourceDocumentResult> {
  const { supabase, companyId, documentId, journalEntryId, sourceType, sourceId } = params
  if (!documentId || !journalEntryId) return { linked: false }

  try {
    await linkToJournalEntry(supabase, companyId, documentId, journalEntryId)
    return { linked: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    try {
      await supabase.from('review_queue_items').insert({
        company_id: companyId,
        status: 'open',
        category: 'bookkeeping_integrity',
        title: 'Underlag kunde inte länkas till verifikation',
        description: message,
        severity: 'medium',
        source_type: sourceType,
        source_id: sourceId,
        metadata: { document_id: documentId, journal_entry_id: journalEntryId, source_type: sourceType, source_id: sourceId },
      })
    } catch {
      // Review queue schemas can differ between installations. The caller still
      // gets a warning, and SQL integrity views will surface the unlinked source.
    }
    return {
      linked: false,
      warning: {
        code: 'DOCUMENT_LINK_FAILED',
        message: 'Underlaget kunde inte länkas automatiskt till verifikationen. Kontrollpunkten visas i bokföringskontrollen.',
      },
    }
  }
}
