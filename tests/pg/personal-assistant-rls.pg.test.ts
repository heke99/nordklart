/**
 * Personal assistant rows: own-row writes, in a company you belong to.
 *
 * `agent_conversations`, `chat_sessions` and `chat_messages` hold one user's
 * conversation with the assistant, not company data. Three properties have to
 * hold simultaneously, and each of them was broken at some point:
 *
 *  1. a read-only member can still talk to the assistant — starting a
 *     conversation writes a row, so requiring company *write* capability
 *     (as 20260808170000 did across 147 policies) silently locked viewers and
 *     auditors out of the feature;
 *  2. one member cannot touch another member's conversation — the original
 *     membership-only policy allowed exactly that;
 *  3. nothing crosses a company boundary.
 *
 * `withUserContext` rolls back, so every assertion about a successful write
 * lives inside the same transaction as the write.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import { seedCompany, insertAuthUser, insertCompanyMember } from './fixtures'

/** Seeded out of band (superuser, RLS bypassed) so it survives into the test. */
async function seedConversation(companyId: string, ownerId: string): Promise<string> {
  const id = randomUUID()
  await getPool().query(
    `INSERT INTO public.agent_conversations (id, company_id, user_id, intent_id, title)
     VALUES ($1, $2, $3, 'general.help', 'Fråga om moms')`,
    [id, companyId, ownerId],
  )
  return id
}

describe('personal assistant rows — RLS', () => {
  let companyId: string
  let ownerId: string
  let viewerId: string
  let otherWriterId: string

  beforeAll(async () => {
    const seeded = await seedCompany()
    companyId = seeded.companyId
    ownerId = seeded.userId

    viewerId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: viewerId, role: 'viewer' })

    otherWriterId = await insertAuthUser()
    await insertCompanyMember({ companyId, userId: otherWriterId, role: 'member' })
  })

  it('lets a viewer start their own conversation', async () => {
    // The whole point: reading the books and asking the assistant about them
    // are the same job. A viewer has no write capability for the company and
    // must still be able to do this.
    await withUserContext(viewerId, async (client) => {
      const inserted = await client.query(
        `INSERT INTO public.agent_conversations (company_id, user_id, intent_id, title)
         VALUES ($1, $2, 'general.help', 'Fråga om moms')
         RETURNING user_id`,
        [companyId, viewerId],
      )
      expect(inserted.rows[0].user_id).toBe(viewerId)
    })
  })

  it('lets a viewer write their own chat session and messages', async () => {
    await withUserContext(viewerId, async (client) => {
      const sessionId = randomUUID()
      await client.query(
        `INSERT INTO public.chat_sessions (id, company_id, user_id) VALUES ($1, $2, $3)`,
        [sessionId, companyId, viewerId],
      )
      const message = await client.query(
        `INSERT INTO public.chat_messages (company_id, user_id, session_id, role, content)
         VALUES ($1, $2, $3, 'user', 'Hur bokför jag en leverantörsfaktura?')
         RETURNING id`,
        [companyId, viewerId, sessionId],
      )
      expect(message.rowCount).toBe(1)
    })
  })

  it('refuses to create a conversation owned by someone else', async () => {
    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.agent_conversations (company_id, user_id, intent_id, title)
           VALUES ($1, $2, 'general.help', 'inplanterad')`,
          [companyId, ownerId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('refuses to edit another member’s conversation, writer or not', async () => {
    const ownerConversation = await seedConversation(companyId, ownerId)

    // otherWriterId has write capability for this company. Under the original
    // membership-only policy that was enough to rewrite someone else's chat.
    await withUserContext(otherWriterId, async (client) => {
      const result = await client.query(
        `UPDATE public.agent_conversations SET title = 'kapad' WHERE id = $1`,
        [ownerConversation],
      )
      expect(result.rowCount).toBe(0)
    })

    const { rows } = await getPool().query(
      `SELECT title FROM public.agent_conversations WHERE id = $1`,
      [ownerConversation],
    )
    expect(rows[0].title).toBe('Fråga om moms')
  })

  it('refuses to delete another member’s conversation', async () => {
    const ownerConversation = await seedConversation(companyId, ownerId)

    await withUserContext(viewerId, async (client) => {
      const result = await client.query(
        `DELETE FROM public.agent_conversations WHERE id = $1`,
        [ownerConversation],
      )
      expect(result.rowCount).toBe(0)
    })

    const { rows } = await getPool().query(
      `SELECT count(*)::int AS n FROM public.agent_conversations WHERE id = $1`,
      [ownerConversation],
    )
    expect(rows[0].n).toBe(1)
  })

  it('refuses a conversation in a company the user does not belong to', async () => {
    const other = await seedCompany()

    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.agent_conversations (company_id, user_id, intent_id, title)
           VALUES ($1, $2, 'general.help', 'främmande bolag')`,
          [other.companyId, viewerId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })

  it('keeps company-level assistant memory behind write capability', async () => {
    // agent_memory has no user_id — it is shared knowledge about the company,
    // so a viewer must not be able to add to it. This is the boundary that
    // makes the carve-out above safe rather than a blanket relaxation.
    await expect(
      withUserContext(viewerId, async (client) => {
        await client.query(
          `INSERT INTO public.agent_memory (company_id, kind, content)
           VALUES ($1, 'fact', 'Bolaget använder kontantmetoden')`,
          [companyId],
        )
      }),
    ).rejects.toThrow(/row-level security/i)
  })
})
