import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const migration = readFileSync(
  resolve(
    process.cwd(),
    'supabase/migrations/20260731171000_annual_report_finalization_and_controlled_reopen.sql',
  ),
  'utf8',
)

describe('annual-report lifecycle migration contract', () => {
  it('separates ledger and annual-report locks and prevents direct final-version writes', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS ledger_locked boolean')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS report_legal_name text')
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS report_registered_office text')
    expect(migration).toContain('annual_report_locked boolean NOT NULL DEFAULT false')
    expect(migration).toContain('DROP POLICY IF EXISTS annual_report_versions_insert')
    expect(migration).not.toMatch(/CREATE POLICY annual_report_versions_insert/)
    expect(migration).toContain('ANNUAL_REPORT_PREFLIGHT_REQUIRED')
    expect(migration).toContain('ANNUAL_REPORT_FINALIZATION_SERVICE_ONLY')
    expect(migration).toContain('document_revision bigint NOT NULL DEFAULT 0')
    expect(migration).toContain('ANNUAL_REPORT_DOCUMENT_CHANGED_DURING_FINALIZATION')
    expect(migration).toContain('ANNUAL_REPORT_COMPARATIVE_SERVICE_ONLY')
    expect(migration).not.toMatch(/CREATE POLICY annual_report_reclassifications_insert/)
  })

  it('uses reversal entries for controlled reopen and keeps document support non-posting', () => {
    expect(migration).toContain("'Kontrollerad återöppning av '")
    expect(migration).toContain("'storno'")
    expect(migration).toContain('record_migrated_open_item')
    expect(migration).toContain('record_historical_balance_reconciliation')
    expect(migration).toContain('ANNUAL_REPORT_LOCKED_CREATE_NEW_VERSION_REQUIRED')
    expect(migration).toContain('journal_entry_created')
    expect(migration).toContain('request_fiscal_period_reopen')
    expect(migration).toContain('fiscal_period_reopen_requested')
    expect(migration).toContain('YEAR_END_REOPEN_NEXT_PERIOD_CLOSED')
    expect(migration).not.toMatch(/CREATE POLICY annual_report_audit_insert/)
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.record_migrated_open_item',
    )
  })

  it('advances filed and registered only for the exact archived iXBRL artifact', () => {
    expect(migration).toContain('sync_annual_report_submission_status')
    expect(migration).toContain('ANNUAL_REPORT_SUBMISSION_ARTIFACT_MISMATCH')
    expect(migration).toContain('coalesce(NEW.archived_document_id, NEW.dokument_id)')
    expect(migration).not.toContain('NEW.document_id')
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION public.sync_annual_report_submission_status()',
    )
    expect(migration).toContain("SET status = 'filed'")
    expect(migration).toContain("SET status = 'registered'")
  })
})
