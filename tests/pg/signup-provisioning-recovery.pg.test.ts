import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser } from '@/tests/pg/fixtures'

type ProvisionRow = {
  provision_state: 'not_required' | 'in_progress' | 'failed' | 'provisioned'
  company_id: string | null
  agency_id: string | null
  workspace_type: 'company' | 'agency'
  onboarding_path: string | null
  provision_reference: string | null
}

async function insertReadySignupDraft(params: {
  userId: string
  workspaceType: 'company' | 'agency'
  legalForm?: 'aktiebolag' | 'enskild_firma'
  onboardingIntent?: string | null
}): Promise<string> {
  const draftId = randomUUID()
  const email = `pg-real-${params.userId}@test.invalid`
  const tokenHash = `test-token-${randomUUID()}`
  const legalForm = params.legalForm ?? 'aktiebolag'
  const orgNumber = `556${draftId.replace(/\D/g, '').padEnd(7, '0').slice(0, 7)}`

  await getPool().query(
    `insert into public.signup_drafts (
       id, token_hash, status, login_email, first_name, last_name,
       workspace_type, legal_form, company_name, org_number, contact_email,
       country, onboarding_intent, accepted_terms_at, accepted_privacy_at,
       claimed_by_user_id, email_verified_at, password_set_at, expires_at
     ) values (
       $1, $2, 'ready_for_first_login', $3, 'Provision', 'Test',
       $4, $5, $6, $7, $3,
       'SE', $8, now(), now(),
       $9, now(), now(), now() + interval '30 days'
     )`,
    [
      draftId,
      tokenHash,
      email,
      params.workspaceType,
      legalForm,
      `Provisionering ${params.workspaceType} ${draftId.slice(0, 8)}`,
      orgNumber,
      params.onboardingIntent ?? null,
      params.userId,
    ],
  )

  return draftId
}

async function provision(userId: string): Promise<ProvisionRow> {
  const { rows } = await getPool().query<ProvisionRow>(
    `select * from public.provision_verified_signup_draft_v2($1::uuid)`,
    [userId],
  )
  expect(rows).toHaveLength(1)
  return rows[0]!
}

describe('signup workspace provisioning core v3', () => {
  it('provisions an AB without output-column ambiguity and is idempotent on retry', async () => {
    const userId = await insertAuthUser()
    const draftId = await insertReadySignupDraft({ userId, workspaceType: 'company' })

    const first = await provision(userId)
    expect(first.provision_state).toBe('provisioned')
    expect(first.company_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.agency_id).toBeNull()
    expect(first.onboarding_path).toBe('/onboarding/workspace')

    const companyId = first.company_id!
    const checks = await getPool().query<{
      owner_count: number
      account_count: number
      has_1930: boolean
      has_settings: boolean
      session_path: string | null
      step_count: number
      draft_status: string
      attempts: number
    }>(
      `select
         (select count(*)::int from public.company_members cm where cm.company_id = $1 and cm.user_id = $2 and cm.role = 'owner') as owner_count,
         (select count(*)::int from public.chart_of_accounts coa where coa.company_id = $1) as account_count,
         exists(select 1 from public.cash_accounts ca where ca.company_id = $1 and ca.ledger_account = '1930') as has_1930,
         exists(select 1 from public.company_settings cs where cs.company_id = $1) as has_settings,
         (select os.path from public.onboarding_sessions os where os.company_id = $1 order by os.created_at desc limit 1) as session_path,
         (select count(*)::int from public.onboarding_steps ost where ost.company_id = $1) as step_count,
         (select sd.status from public.signup_drafts sd where sd.id = $3) as draft_status,
         (select sd.provision_attempt_count from public.signup_drafts sd where sd.id = $3) as attempts`,
      [companyId, userId, draftId],
    )

    expect(checks.rows[0]).toMatchObject({
      owner_count: 1,
      has_1930: true,
      has_settings: true,
      session_path: 'bookkeeping_direct',
      draft_status: 'provisioned',
      attempts: 1,
    })
    expect(checks.rows[0]!.account_count).toBeGreaterThan(0)
    expect(checks.rows[0]!.step_count).toBeGreaterThan(0)

    const retry = await provision(userId)
    expect(retry).toMatchObject({
      provision_state: 'provisioned',
      company_id: companyId,
      onboarding_path: '/onboarding/workspace',
    })

    const duplicateCheck = await getPool().query<{ company_count: number; attempts: number }>(
      `select
         (select count(*)::int from public.companies c where c.created_by = $1) as company_count,
         (select sd.provision_attempt_count from public.signup_drafts sd where sd.id = $2) as attempts`,
      [userId, draftId],
    )
    expect(duplicateCheck.rows[0]).toEqual({ company_count: 1, attempts: 1 })
  })

  it('provisions an agency with its own company, agency relation and agency onboarding', async () => {
    const userId = await insertAuthUser()
    const draftId = await insertReadySignupDraft({ userId, workspaceType: 'agency' })

    const result = await provision(userId)
    expect(result).toMatchObject({
      provision_state: 'provisioned',
      workspace_type: 'agency',
      onboarding_path: '/onboarding/agency',
    })
    expect(result.company_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(result.agency_id).toMatch(/^[0-9a-f-]{36}$/)

    const checks = await getPool().query<{
      linked_company_id: string | null
      agency_owner_count: number
      path: string | null
      draft_status: string
    }>(
      `select
         (select a.company_id::text from public.agencies a where a.id = $1) as linked_company_id,
         (select count(*)::int from public.agency_members am where am.agency_id = $1 and am.user_id = $2 and am.role = 'agency_owner') as agency_owner_count,
         (select os.path from public.onboarding_sessions os where os.company_id = $3 order by os.created_at desc limit 1) as path,
         (select sd.status from public.signup_drafts sd where sd.id = $4) as draft_status`,
      [result.agency_id, userId, result.company_id, draftId],
    )

    expect(checks.rows[0]).toEqual({
      linked_company_id: result.company_id,
      agency_owner_count: 1,
      path: 'agency_setup',
      draft_status: 'provisioned',
    })
  })

  it('keeps the legacy RPC as a read-compatible wrapper over the same provisioned workspace', async () => {
    const userId = await insertAuthUser()
    await insertReadySignupDraft({ userId, workspaceType: 'company', onboardingIntent: 'auto' })

    const current = await provision(userId)
    const { rows } = await getPool().query<{
      company_id: string
      agency_id: string | null
      workspace_type: string
      onboarding_path: string
    }>(
      `select * from public.provision_verified_signup_draft($1::uuid)`,
      [userId],
    )

    expect(rows).toEqual([
      {
        company_id: current.company_id,
        agency_id: null,
        workspace_type: 'company',
        onboarding_path: '/onboarding/workspace',
      },
    ])
  })
})
