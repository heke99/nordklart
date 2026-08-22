import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany } from '@/tests/pg/fixtures'

/**
 * customers.personal_number is encrypted at rest (20260821130000).
 *
 * The plaintext column and its format CHECK are gone; what remains is a
 * ciphertext column and a four-digit mask that must travel together. These
 * tests exist so a later migration cannot quietly reintroduce a clear-text
 * personnummer column, and so the pair invariant is enforced by the database
 * rather than by whichever route happens to write the row.
 */
describe('customer personnummer at rest (pg-real)', () => {
  it('has no plaintext personal_number column', async () => {
    const { rows } = await getPool().query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'customers'
          AND column_name LIKE 'personal_number%'
        ORDER BY column_name`,
    )
    expect(rows.map((r) => r.column_name)).toEqual([
      'personal_number_enc',
      'personal_number_last4',
    ])
  })

  it('accepts ciphertext together with a four-digit mask', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })
    const id = randomUUID()

    await getPool().query(
      `INSERT INTO public.customers
         (id, user_id, company_id, name, personal_number_enc, personal_number_last4)
       VALUES ($1, $2, $3, 'Privatkund', 'deadbeefcafe', '1234')`,
      [id, userId, companyId],
    )

    const { rows } = await getPool().query<{ personal_number_last4: string }>(
      `SELECT personal_number_last4 FROM public.customers WHERE id = $1`,
      [id],
    )
    expect(rows[0]!.personal_number_last4).toBe('1234')
  })

  it('rejects ciphertext without a mask, and a mask without ciphertext', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    await expect(
      getPool().query(
        `INSERT INTO public.customers (id, user_id, company_id, name, personal_number_enc)
         VALUES ($1, $2, $3, 'Halvskriven', 'deadbeef')`,
        [randomUUID(), userId, companyId],
      ),
    ).rejects.toThrow(/personal_number_pair/)

    await expect(
      getPool().query(
        `INSERT INTO public.customers (id, user_id, company_id, name, personal_number_last4)
         VALUES ($1, $2, $3, 'Bara mask', '1234')`,
        [randomUUID(), userId, companyId],
      ),
    ).rejects.toThrow(/personal_number_pair/)
  })

  it('rejects a mask that is not four digits', async () => {
    const userId = await insertAuthUser()
    const companyId = await insertCompany({ createdBy: userId })

    await expect(
      getPool().query(
        `INSERT INTO public.customers
           (id, user_id, company_id, name, personal_number_enc, personal_number_last4)
         VALUES ($1, $2, $3, 'Fel mask', 'deadbeef', '19850101-1234')`,
        [randomUUID(), userId, companyId],
      ),
    ).rejects.toThrow(/personal_number_last4/)
  })
})
