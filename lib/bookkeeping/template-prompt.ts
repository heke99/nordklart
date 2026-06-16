/**
 * Template Prompt Builder
 *
 * Generates the booking template list section for AI extraction prompts.
 * Used by both receipt-analyzer and invoice-analyzer to stay in sync.
 */

import { BOOKING_TEMPLATES } from './booking-templates'

/**
 * Build the template list section for AI prompts.
 * Lists all expense templates with their Swedish name, primary debit account, and VAT rate.
 */
export function buildTemplatePromptSection(): string {
  const expenseTemplates = BOOKING_TEMPLATES.filter((t) => t.direction === 'expense')

  const lines = expenseTemplates.map((t) => {
    const vatInfo = t.vat_rate > 0 ? `moms ${t.vat_rate * 100}%` : 'momsfri'
    return `- ${t.id}: ${t.name_sv} (konto ${t.debit_account}, ${vatInfo})`
  })

  return `BOKFÖRINGSMALLAR (välj den mest passande suggestedTemplateId):
${lines.join('\n')}`
}

/**
 * Build a compact template ID list for validation.
 */
export function getValidTemplateIds(): string[] {
  return BOOKING_TEMPLATES.map((t) => t.id)
}
