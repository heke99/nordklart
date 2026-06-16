import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import {
  insertBalancedLines,
  insertDraftJournalEntry,
  seedCompany,
} from '@/tests/pg/fixtures'

describe('engine.pg — triggers & RPCs that mocks cannot catch', () => {
  it('rejects INSERT into journal_entries when the fiscal period is closed', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany({ isClosed: true })

    await expect(
      insertDraftJournalEntry({ userId, companyId, fiscalPeriodId }),
    ).rejects.toThrow(/locked\/closed fiscal period/i)
  })

  it('commit_journal_entry assigns sequential voucher numbers under concurrency', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    const entryA = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    const entryB = await insertDraftJournalEntry({ userId, companyId, fiscalPeriodId })
    await insertBalancedLines(entryA)
    await insertBalancedLines(entryB)

    // Two dedicated clients so the row-level lock on voucher_sequences is
    // actually exercised — not just a single connection serialising calls.
    const clientA = await getPool().connect()
    const clientB = await getPool().connect()
    try {
      const [resA, resB] = await Promise.all([
        clientA.query<{ voucher_number: number }>(
          `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
          [companyId, entryA],
        ),
        clientB.query<{ voucher_number: number }>(
          `SELECT voucher_number FROM public.commit_journal_entry($1::uuid, $2::uuid)`,
          [companyId, entryB],
        ),
      ])
      const numbers = [resA.rows[0]!.voucher_number, resB.rows[0]!.voucher_number].sort(
        (a, b) => a - b,
      )
      expect(numbers).toEqual([1, 2])
    } finally {
      clientA.release()
      clientB.release()
    }
  })

  it('rejects UPDATE to a posted journal entry (committed immutability)', async () => {
    const { userId, companyId, fiscalPeriodId } = await seedCompany()

    // Bypass commit_journal_entry by inserting directly as 'posted'. The
    // immutability trigger fires on UPDATE, not INSERT, so this is legal
    // setup on the superuser connection.
    const entryId = await insertDraftJournalEntry({
      userId,
      companyId,
      fiscalPeriodId,
      status: 'posted',
      voucherNumber: 1,
    })

    await expect(
      getPool().query(
        `UPDATE public.journal_entries SET description = 'tampered' WHERE id = $1`,
        [entryId],
      ),
    ).rejects.toThrow(/Cannot modify a posted journal entry/i)
  })
})
