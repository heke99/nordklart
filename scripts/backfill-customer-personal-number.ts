#!/usr/bin/env npx tsx
/**
 * Encrypt any plaintext customers.personal_number before the column is dropped.
 *
 * Migration 20260821130000 refuses to drop the plaintext column while it still
 * holds values, because encryption needs PERSONNUMMER_ENCRYPTION_KEY — which
 * lives in the application, not in PostgreSQL. This script closes that gap:
 *
 *   plaintext personal_number
 *     → personal_number_enc   (AES-256-GCM)
 *     → personal_number_last4 (mask for lists, search and CSV)
 *
 * Idempotent: a row that already has ciphertext is skipped, so a re-run after a
 * partial failure is safe. Nothing is deleted here — the migration drops the
 * column afterwards, once it can prove the column is empty.
 *
 * Usage:
 *   npx tsx scripts/backfill-customer-personal-number.ts            # apply
 *   npx tsx scripts/backfill-customer-personal-number.ts --dry-run  # report only
 */

import { config } from 'dotenv'
config({ path: '.env.local' })
import { createClient } from '@supabase/supabase-js'
import { encryptPersonnummer, extractLast4 } from '../lib/salary/personnummer'

const DRY_RUN = process.argv.includes('--dry-run')

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}
if (!process.env.PERSONNUMMER_ENCRYPTION_KEY) {
  console.error('Missing PERSONNUMMER_ENCRYPTION_KEY — the ciphertext would be unreadable later.')
  process.exit(1)
}

const db = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

async function main() {
  const { data, error } = await db
    .from('customers')
    .select('id, personal_number, personal_number_enc')
    .not('personal_number', 'is', null)

  if (error) {
    // The column is already gone on a database that has completed the
    // migration; that is a success, not a failure.
    if (/personal_number/.test(error.message) && /does not exist|column/.test(error.message)) {
      console.log('customers.personal_number no longer exists — nothing to backfill.')
      return
    }
    console.error('Failed to read customers:', error.message)
    process.exit(1)
  }

  const rows = data ?? []
  const pending = rows.filter((row) => !row.personal_number_enc)
  console.log(`${rows.length} row(s) with plaintext, ${pending.length} still to encrypt.`)

  if (DRY_RUN || pending.length === 0) {
    if (DRY_RUN) console.log('--dry-run: nothing written.')
    return
  }

  let done = 0
  for (const row of pending) {
    const plaintext = String(row.personal_number).trim()
    const { error: updateError } = await db
      .from('customers')
      .update({
        personal_number_enc: encryptPersonnummer(plaintext),
        personal_number_last4: extractLast4(plaintext),
      })
      .eq('id', row.id)

    if (updateError) {
      console.error(`Row ${row.id} failed: ${updateError.message}`)
      process.exit(1)
    }
    done += 1
  }

  console.log(`Encrypted ${done} row(s). Clear customers.personal_number, then re-run the migration.`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
