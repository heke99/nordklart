#!/usr/bin/env node
/**
 * Force explicit awareness when a migration redefines a critical database object.
 *
 * `CREATE OR REPLACE FUNCTION f` does not extend f — it REPLACES it. Every
 * branch, status value, authorization check, GUC carve-out and search_path pin
 * that the previous definition had is gone unless the new body restates it.
 * That is not a hypothetical: six production incidents in this repository came
 * from exactly this, each one a later migration that rewrote a function in full
 * and dropped a case nobody noticed was there.
 *
 *   - the opening-balance source_type retag carve-out
 *   - delete_last_voucher losing the ability to clear reversed_by_id
 *   - the SIE workpaper blocker precedence
 *   - three separate commit_method values a writer used but the CHECK forbade
 *
 * This guard cannot tell whether a new definition is correct — nothing
 * mechanical can. What it can do is refuse to let one land silently. When the
 * count of definitions for a critical object changes, the build fails until the
 * author records the new count, which is the moment they are asked to diff the
 * previous definition and confirm nothing was lost.
 *
 * Usage:
 *   node scripts/checks/migration-redefinition.mjs           # verify
 *   node scripts/checks/migration-redefinition.mjs --write    # acknowledge
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATION_DIR = path.join(ROOT, 'supabase', 'migrations')
const REGISTRY = path.join(ROOT, 'supabase', 'critical-object-redefinitions.json')

/**
 * Objects whose redefinition has to be deliberate. Scoped rather than
 * exhaustive: a guard that fires on all 253 redefined objects would be noise,
 * and noise gets ratcheted away. These are the ones where a dropped branch
 * means wrong bookkeeping, a security hole, or a blocked economic flow.
 */
const CRITICAL_OBJECTS = [
  // Journal immutability and retention — legally required (BFL 7 kap).
  'enforce_journal_entry_immutability',
  'enforce_journal_entry_line_immutability',
  'enforce_retention_journal_entries',
  'enforce_document_metadata_immutability',
  'block_document_deletion',
  // Voucher lifecycle.
  'commit_journal_entry',
  'delete_last_voucher',
  'mark_entry_as_opening_balance',
  'next_voucher_number',
  // Period locking.
  'enforce_period_lock',
  'enforce_company_lock_date',
  // Settlement and bank allocation.
  'settle_customer_invoice',
  'settle_supplier_invoice',
  'settle_customer_invoice_v2',
  'settle_supplier_invoice_v2',
  'create_planned_draft_entry',
  'match_batch_allocate',
  'enforce_single_bank_payment_allocation',
  // Year-end.
  'execute_year_end_closing',
  'year_end_db_blockers',
  'year_end_control_status',
  '__year_end_assert_actor',
  '__year_end_prior_result_transfer',
  // SIE.
  'finalize_sie_import',
  'replace_sie_import',
  'undo_sie_import_internal',
  '__sie_reverse_import_entries',
  // Access control.
  'resolve_company_access',
  'resolve_company_access_for_user',
  'user_company_ids',
  'user_can_write_company',
  'user_can_access_company_v2',
  'require_service_role',
  'validate_and_increment_api_key',
  'resolve_year_end_period_capability_for_user',
  'company_feature_access',
  // Stripe / billing.
  'stripe_finalize_checkout_v2',
  'stripe_sync_subscription_v2',
  'stripe_apply_one_time_purchase_event',
  // Audit.
  'write_audit_log',
  'audit_log_immutable',
]

function stripComments(sql) {
  return sql.replace(/--[^\n]*/g, ' ')
}

/** Migration files that define each critical object, in chain order. */
function definitionsByObject() {
  const files = fs.readdirSync(MIGRATION_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b))

  const found = new Map(CRITICAL_OBJECTS.map((name) => [name, []]))
  for (const file of files) {
    const sql = stripComments(fs.readFileSync(path.join(MIGRATION_DIR, file), 'utf8'))
    for (const name of CRITICAL_OBJECTS) {
      // A definition, not a call: CREATE [OR REPLACE] FUNCTION/TRIGGER/VIEW <name>.
      const pattern = new RegExp(
        String.raw`CREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|TRIGGER|VIEW|MATERIALIZED\s+VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\s*\.\s*)?"?${name}"?\s*[\s(]`,
        'gi',
      )
      const count = [...sql.matchAll(pattern)].length
      for (let i = 0; i < count; i += 1) found.get(name).push(file)
    }
  }
  return found
}

function buildRegistry(found) {
  const entries = {}
  for (const [name, files] of found) {
    if (files.length === 0) continue
    entries[name] = { definitions: files.length, last: files[files.length - 1] }
  }
  return { format: 1, objects: entries }
}

function main() {
  const found = definitionsByObject()
  const current = buildRegistry(found)

  if (process.argv.includes('--write')) {
    fs.writeFileSync(REGISTRY, `${JSON.stringify(current, null, 2)}\n`)
    const total = Object.values(current.objects).reduce((sum, e) => sum + e.definitions, 0)
    console.log(
      `Wrote ${path.relative(ROOT, REGISTRY)}: `
      + `${Object.keys(current.objects).length} critical object(s), ${total} definition(s).`,
    )
    return
  }

  if (!fs.existsSync(REGISTRY)) {
    console.error(`Missing ${path.relative(ROOT, REGISTRY)}. Run with --write to create it.`)
    process.exit(1)
  }
  const expected = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'))
  const failures = []

  for (const [name, entry] of Object.entries(current.objects)) {
    const previous = expected.objects[name]
    if (!previous) {
      failures.push(
        `${name}: newly tracked (${entry.definitions} definition(s), latest ${entry.last}).`,
      )
    } else if (previous.definitions !== entry.definitions) {
      failures.push(
        `${name}: ${previous.definitions} -> ${entry.definitions} definition(s). `
        + `New definition in ${entry.last}, previous was ${previous.last}.`,
      )
    }
  }
  for (const name of Object.keys(expected.objects)) {
    if (!current.objects[name]) {
      failures.push(`${name}: all definitions disappeared from the migration chain.`)
    }
  }

  if (failures.length > 0) {
    console.error('A critical database object was redefined.\n')
    for (const failure of failures) console.error(`  - ${failure}`)
    console.error(
      '\nCREATE OR REPLACE does not extend a function, it replaces it. Every branch,'
      + '\nstatus value, authorization check, GUC carve-out and search_path pin from the'
      + '\nprevious definition is gone unless your new body restates it. Six production'
      + '\nincidents in this repository started exactly here.'
      + '\n\nBefore acknowledging, diff your new definition against the previous one and'
      + '\nconfirm you did not drop:'
      + '\n  * a branch or status value the old body handled'
      + '\n  * an authorization check (require_service_role, can_write, auth.uid)'
      + '\n  * a GUC carve-out (current_setting(...)) the old body honoured'
      + '\n  * SET search_path — and if the body calls pgcrypto, the extensions schema'
      + '\n  * a literal the surrounding CHECK constraints must permit'
      + '\n\nThen record it:  node scripts/checks/migration-redefinition.mjs --write\n',
    )
    process.exit(1)
  }

  const total = Object.values(current.objects).reduce((sum, e) => sum + e.definitions, 0)
  console.log(
    `Migration redefinition guard OK: ${Object.keys(current.objects).length} critical object(s), `
    + `${total} acknowledged definition(s).`,
  )
}

main()
