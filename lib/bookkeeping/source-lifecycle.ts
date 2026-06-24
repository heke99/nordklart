export type SourceLifecycleStatus =
  | 'uploaded'
  | 'extracted'
  | 'needs_review'
  | 'ready_to_book'
  | 'booked'
  | 'linked'
  | 'requires_repair'

export type SourceLifecycleInput = {
  sourceType: 'supplier_invoice' | 'invoice_inbox_item' | 'document' | 'transaction'
  sourceStatus?: string | null
  hasDocument?: boolean
  documentLinked?: boolean
  hasRegistrationEntry?: boolean
  hasPaymentEntry?: boolean
  hasJournalEntry?: boolean
  paidWithPrivateFunds?: boolean
  accountingMethod?: 'accrual' | 'cash' | string | null
}

export type SourceLifecycleResult = {
  status: SourceLifecycleStatus
  issueCode?: string
  issueMessage?: string
}

export function resolveSourceLifecycle(input: SourceLifecycleInput): SourceLifecycleResult {
  if (input.sourceType === 'document') {
    return input.documentLinked
      ? { status: 'linked' }
      : { status: 'needs_review', issueCode: 'document_unlinked', issueMessage: 'Underlag är inte länkat till en verifikation.' }
  }

  if (input.sourceType === 'invoice_inbox_item') {
    if (input.sourceStatus === 'error') return { status: 'requires_repair', issueCode: 'inbox_error', issueMessage: 'Inkorgsunderlag har felstatus.' }
    if (input.sourceStatus === 'ready') return { status: 'needs_review', issueCode: 'inbox_ready', issueMessage: 'Underlag är tolkat men inte bokfört.' }
    if (input.sourceStatus === 'confirmed') return { status: input.hasJournalEntry ? 'booked' : 'requires_repair', issueCode: input.hasJournalEntry ? undefined : 'inbox_confirmed_without_bookkeeping', issueMessage: input.hasJournalEntry ? undefined : 'Bekräftat underlag saknar bokföringskoppling.' }
    return { status: 'uploaded' }
  }

  if (input.sourceType === 'supplier_invoice') {
    if (input.paidWithPrivateFunds && !input.hasPaymentEntry) {
      return { status: 'requires_repair', issueCode: 'private_expense_missing_entry', issueMessage: 'Privat betalt utlägg saknar verifikation.' }
    }
    if (input.accountingMethod === 'accrual' && !input.paidWithPrivateFunds && !input.hasRegistrationEntry) {
      return { status: 'requires_repair', issueCode: 'supplier_invoice_missing_registration_entry', issueMessage: 'Leverantörsfaktura saknar registreringsverifikation.' }
    }
    if ((input.sourceStatus === 'paid' || input.sourceStatus === 'partially_paid') && !input.paidWithPrivateFunds && !input.hasPaymentEntry) {
      return { status: 'requires_repair', issueCode: 'supplier_invoice_missing_payment_entry', issueMessage: 'Betald leverantörsfaktura saknar betalningsverifikation.' }
    }
    if (input.hasDocument && input.documentLinked) return { status: 'linked' }
    if (input.hasRegistrationEntry || input.hasPaymentEntry) return { status: 'booked' }
    return { status: 'ready_to_book' }
  }

  if (input.sourceType === 'transaction') {
    return input.hasJournalEntry
      ? { status: 'booked' }
      : { status: 'needs_review', issueCode: 'transaction_unbooked', issueMessage: 'Bankhändelse saknar verifikation eller matchning.' }
  }

  return { status: 'needs_review' }
}
