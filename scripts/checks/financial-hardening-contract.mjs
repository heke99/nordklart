#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const failures = []

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8')
}

function requireText(file, text, explanation = text) {
  const source = read(file)
  if (!source.includes(text)) failures.push(`${file}: missing ${explanation}`)
}

function forbidText(file, text, explanation = text) {
  const source = read(file)
  if (source.includes(text)) failures.push(`${file}: forbidden ${explanation}`)
}

const migration = 'supabase/migrations/20260801140000_production_financial_atomicity_and_billing_lifecycle.sql'
for (const required of [
  'CREATE OR REPLACE FUNCTION public.settle_customer_invoice(',
  'CREATE OR REPLACE FUNCTION public.settle_supplier_invoice(',
  'CREATE OR REPLACE FUNCTION public.stripe_apply_one_time_purchase_event(',
  'CREATE OR REPLACE FUNCTION public.resolve_year_end_period_capability_for_user(',
  "OLD.status = 'posted' AND NEW.status = 'cancelled'",
  'CREATE OR REPLACE FUNCTION public.enforce_single_bank_payment_allocation()',
  'CREATE OR REPLACE VIEW public.bank_payment_allocation_discrepancies_v1',
  'CREATE OR REPLACE VIEW public.customer_subledger_discrepancies_v1',
  'CREATE OR REPLACE VIEW public.supplier_subledger_discrepancies_v1',
]) requireText(migration, required)
for (const signature of [
  'public.settle_customer_invoice',
  'public.settle_supplier_invoice',
  'public.stripe_apply_one_time_purchase_event',
  'public.resolve_year_end_period_capability_for_user',
]) {
  const source = read(migration)
  if (!source.includes(`REVOKE ALL ON FUNCTION ${signature}`)
      || !source.includes(`GRANT EXECUTE ON FUNCTION ${signature}`)
      || !source.includes('TO service_role;')) {
    failures.push(`${migration}: ${signature} must be service-role-only`)
  }
}

const customerRoutes = [
  'app/api/invoices/[id]/mark-paid/route.ts',
  'app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route.ts',
  'app/api/transactions/[id]/match-invoice/route.ts',
  'app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route.ts',
]
for (const file of customerRoutes) {
  requireText(file, 'markInvoicePaid', 'canonical markInvoicePaid service')
  forbidText(file, ".from('invoice_payments').insert", 'direct invoice_payments insert')
  forbidText(file, 'reverseEntry(', 'implicit compensation reversal')
}

const supplierRoutes = [
  'app/api/supplier-invoices/[id]/mark-paid/route.ts',
  'app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route.ts',
  'app/api/transactions/[id]/match-supplier-invoice/route.ts',
  'app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route.ts',
]
for (const file of supplierRoutes) {
  requireText(file, 'settleSupplierInvoiceAtomic', 'canonical supplier settlement service')
  forbidText(file, ".from('supplier_invoice_payments').insert", 'direct supplier_invoice_payments insert')
  forbidText(file, 'reverseEntry(', 'implicit compensation reversal')
}

// H-03: the voucher is created INSIDE the settlement transaction. The
// settlement services must therefore call the v2 RPCs and must not write a
// journal entry of their own beforehand — a pre-created draft reintroduces the
// stranded-voucher state that compensation could only paper over.
const settlementMigration = 'supabase/migrations/20260808120000_settlement_creates_its_own_voucher.sql'
for (const required of [
  'CREATE OR REPLACE FUNCTION public.create_planned_draft_entry(',
  'CREATE OR REPLACE FUNCTION public.settle_customer_invoice_v2(',
  'CREATE OR REPLACE FUNCTION public.settle_supplier_invoice_v2(',
]) requireText(settlementMigration, required)
for (const signature of [
  'public.create_planned_draft_entry',
  'public.settle_customer_invoice_v2',
  'public.settle_supplier_invoice_v2',
]) {
  const source = read(settlementMigration)
  if (!source.includes(`REVOKE ALL ON FUNCTION ${signature}`)
      || !source.includes(`GRANT EXECUTE ON FUNCTION ${signature}`)
      || !source.includes('TO service_role;')) {
    failures.push(`${settlementMigration}: ${signature} must be service-role-only`)
  }
}

requireText('lib/invoices/mark-paid-service.ts', "rpc('settle_customer_invoice_v2'", 'settle_customer_invoice_v2 RPC call')
requireText('lib/supplier-invoices/mark-paid-service.ts', "rpc('settle_supplier_invoice_v2'", 'settle_supplier_invoice_v2 RPC call')
for (const service of ['lib/invoices/mark-paid-service.ts', 'lib/supplier-invoices/mark-paid-service.ts']) {
  forbidText(service, 'createDraftEntry(', 'journal entry written before the settlement transaction')
  forbidText(service, "from('journal_entries')", 'compensating journal_entries write')
}
requireText('lib/year-end/access.ts', "'resolve_year_end_period_capability_for_user'", 'canonical period capability RPC')
for (const eventName of [
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'refund.',
  'charge.refunded',
  'charge.dispute.created',
  'charge.dispute.closed',
]) requireText('app/api/stripe/webhook/route.ts', eventName, `Stripe event ${eventName}`)

if (failures.length > 0) {
  console.error('Financial hardening contract failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exit(1)
}
console.log('Financial hardening contract passed.')
