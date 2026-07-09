/**
 * pg-real coverage for migration 20260715180000 (Peppol inbound dedupe):
 * inbound e-invoice deliveries are unique per (company, content hash).
 */
import { createHash, randomUUID } from 'node:crypto'
import { describe, it, expect, beforeAll } from 'vitest'
import { getPool } from './setup'
import { insertAuthUser, insertCompany, insertCompanyMember } from './fixtures'

describe('e_invoice_deliveries inbound dedupe', () => {
  let companyId: string
  let otherCompanyId: string

  beforeAll(async () => {
    const owner = await insertAuthUser()
    companyId = await insertCompany({ createdBy: owner })
    await insertCompanyMember({ companyId, userId: owner, role: 'owner' })
    const otherOwner = await insertAuthUser()
    otherCompanyId = await insertCompany({ createdBy: otherOwner })
    await insertCompanyMember({ companyId: otherCompanyId, userId: otherOwner, role: 'owner' })
  })

  it('rejects a second inbound delivery with the same content for the same company', async () => {
    const ubl = `<Invoice><cbc:ID>F-${randomUUID()}</cbc:ID></Invoice>`
    const hash = createHash('sha256').update(ubl).digest('hex')

    const insert = (target: string) =>
      getPool().query(
        `INSERT INTO public.e_invoice_deliveries (company_id, direction, provider, status, ubl_xml, content_sha256)
         VALUES ($1, 'inbound', 'access_point', 'received', $2, $3)`,
        [target, ubl, hash],
      )

    await insert(companyId)
    await expect(insert(companyId)).rejects.toMatchObject({ code: '23505' })
    // The same content delivered to ANOTHER company is a separate delivery.
    await insert(otherCompanyId)
  })

  it('outbound deliveries are not constrained by the inbound index', async () => {
    const ubl = `<Invoice><cbc:ID>OUT-${randomUUID()}</cbc:ID></Invoice>`
    const hash = createHash('sha256').update(ubl).digest('hex')
    const insert = () =>
      getPool().query(
        `INSERT INTO public.e_invoice_deliveries (company_id, direction, provider, status, ubl_xml, content_sha256)
         VALUES ($1, 'outbound', 'access_point', 'sent', $2, $3)`,
        [companyId, ubl, hash],
      )
    await insert()
    await insert()
  })
})
