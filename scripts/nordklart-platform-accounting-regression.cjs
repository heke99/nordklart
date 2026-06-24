#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs')
const path = require('path')

const root = process.cwd()
const checks = [
  ['platform companies page', 'app/(dashboard)/platform/companies/page.tsx', ['/platform/companies/', 'Bokföringskontroll', 'Aktiv åtkomst']],
  ['platform company detail page', 'app/(dashboard)/platform/companies/[companyId]/page.tsx', ['setCompanySubscriptionFromCardAction', 'grantCompanyAccessFromCardAction', 'Bokföringskontroll']],
  ['platform company actions', 'app/(dashboard)/platform/companies/[companyId]/actions.ts', ['platform_set_company_subscription', 'platform_grant_complimentary_full_access', 'platform_revoke_commercial_access_grant']],
  ['platform company read models', 'lib/platform/company-overview.ts', ['platform_company_overview_v', 'bankgiroStatusLabel', 'listPlatformCompanies']],
  ['platform company detail model', 'lib/platform/company-detail.ts', ['bookkeeping_integrity_issues_v', 'company_subscription_items', 'commercial_access_grants']],
  ['accounting lifecycle helper', 'lib/bookkeeping/source-lifecycle.ts', ['private_expense_missing_entry', 'supplier_invoice_missing_registration_entry', 'transaction_unbooked']],
  ['accounting integrity helper', 'lib/bookkeeping/source-integrity.ts', ['linkSourceDocumentToJournalEntry', 'review_queue_items', 'DOCUMENT_LINK_FAILED']],
  ['supplier invoice document schema', 'lib/api/schemas.ts', ['document_id: uuid.optional()', 'paid_with_private_funds']],
  ['supplier invoice route document linking', 'app/api/supplier-invoices/route.ts', ['linkSourceDocumentToJournalEntry', 'document_id: body.document_id || null', 'documentLinkWarnings']],
  ['sql platform/accounting views', 'supabase/migrations/20260703120000_platform_company_operations_console.sql', ['platform_company_overview_v', 'bookkeeping_integrity_issues_v', 'platform_company_accounting_integrity_v']],
]

let failed = false
for (const [name, file, needles] of checks) {
  const absolute = path.join(root, file)
  if (!fs.existsSync(absolute)) {
    console.error(`FAIL: ${name} missing file ${file}`)
    failed = true
    continue
  }
  const body = fs.readFileSync(absolute, 'utf8')
  for (const needle of needles) {
    if (!body.includes(needle)) {
      console.error(`FAIL: ${name} missing marker ${needle}`)
      failed = true
    }
  }
  if (!failed) console.log(`OK: ${name}`)
}

if (failed) process.exit(1)
console.log('Nordklart platform/accounting regression passed')
