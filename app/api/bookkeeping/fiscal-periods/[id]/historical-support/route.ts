import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { requireYearEndAccess, yearEndAccessDeniedResponse } from '@/lib/year-end/access'
import { createServiceClient } from '@/lib/supabase/server'

const openItemSchema = z.object({
  action: z.literal('add_open_item'),
  kind: z.enum(['ar', 'ap']),
  counterparty_name: z.string().trim().min(1).max(200),
  counterparty_number: z.string().trim().max(80).optional(),
  invoice_number: z.string().trim().min(1).max(100),
  invoice_date: z.string().date(),
  due_date: z.string().date(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default('SEK'),
  original_amount_currency: z.number().nonnegative(),
  paid_amount_currency: z.number().nonnegative().default(0),
  remaining_amount_currency: z.number().nonnegative(),
  booked_exchange_rate: z.number().positive().optional(),
  control_account: z.string().regex(/^[0-9]{4,}$/),
  comment: z.string().trim().max(1000).optional(),
  external_reference: z.string().trim().max(200).optional(),
  sie_import_id: z.string().uuid().optional(),
  idempotency_key: z.string().min(8).max(128).optional(),
})

const snapshotSchema = z.object({
  action: z.literal('create_company_snapshot'),
  lock: z.boolean().default(true),
  business_description: z.string().trim().max(4000).optional(),
  registered_office: z.string().trim().max(120).optional(),
})

const profitDispositionSchema = z.object({
  action: z.literal('save_profit_disposition'),
  current_year_result: z.number(),
  free_equity: z.number().nonnegative(),
  proposed_dividend: z.number().nonnegative().default(0),
  carried_forward: z.number().nonnegative(),
  amount_per_share: z.number().nonnegative().optional(),
  share_count: z.number().int().positive().optional(),
  planned_payment_date: z.string().date().optional(),
  board_reasoning: z.string().trim().max(4000).optional(),
  prudence_assessment: z.string().trim().max(4000).optional(),
  narrative_override: z.string().trim().max(4000).optional(),
})

const annotationSchema = z.object({
  action: z.literal('add_annotation'),
  target_type: z.enum([
    'year_end',
    'account',
    'journal_entry',
    'receivable',
    'payable',
    'bank_account',
    'equity',
    'tax',
    'vat',
    'dividend',
    'annual_report_section',
  ]),
  target_id: z.string().trim().max(200).optional(),
  visibility: z.enum(['internal', 'auditor', 'annual_report', 'tax_return']),
  annotation_text: z.string().trim().min(1).max(8000),
})

const commandSchema = z.discriminatedUnion('action', [
  openItemSchema,
  snapshotSchema,
  profitDispositionSchema,
  annotationSchema,
])

export const GET = withRouteContext(
  'period.historical_support_read',
  async (_request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId } = ctx
    const db = createServiceClient()
    const access = await requireYearEndAccess(db, companyId, user.id, id, {
      operation: 'period.historical_support_read',
      requestId: ctx.requestId,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const [
      period,
      controls,
      receivables,
      payables,
      snapshot,
      profitDisposition,
      annotations,
    ] = await Promise.all([
      db
        .from('fiscal_periods')
        .select('id, name, period_start, period_end, is_closed, locked_at')
        .eq('company_id', companyId)
        .eq('id', id)
        .single(),
      db.rpc('year_end_control_status', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
      }),
      db
        .from('migrated_customer_receivables')
        .select(
          'id, customer_name_snapshot, invoice_number, invoice_date, due_date, currency, remaining_amount_sek_at_balance_date, control_account, verified_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .is('superseded_at', null)
        .order('invoice_date'),
      db
        .from('migrated_supplier_payables')
        .select(
          'id, supplier_name_snapshot, supplier_invoice_number, invoice_date, due_date, currency, remaining_amount_sek_at_balance_date, control_account, verified_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .is('superseded_at', null)
        .order('invoice_date'),
      db
        .from('year_end_company_snapshots')
        .select(
          'id, organisation_number, legal_name, address_line1, postal_code, city, registered_office, legal_entity_type, confirmed_at, locked_at, snapshot_hash',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .is('superseded_at', null)
        .maybeSingle(),
      db
        .from('year_end_profit_dispositions')
        .select(
          'current_year_result, free_equity, proposed_dividend, carried_forward, status, narrative_override',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .maybeSingle(),
      db
        .from('year_end_annotations')
        .select('id, target_type, target_id, visibility, annotation_text, created_at')
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .is('superseded_at', null)
        .order('created_at', { ascending: false }),
    ])

    const failure = [
      period,
      controls,
      receivables,
      payables,
      snapshot,
      profitDisposition,
      annotations,
    ].find((result) => result.error)
    if (failure?.error) {
      ctx.log.error('historical support read failed', new Error(failure.error.message))
      return NextResponse.json(
        { error: { code: 'HISTORICAL_SUPPORT_READ_FAILED', message: failure.error.message } },
        { status: 500 },
      )
    }

    return NextResponse.json({
      data: {
        period: period.data,
        controls: (controls.data ?? []).map((row: Record<string, unknown>) => ({
          ...row,
          label: controlLabel(String(row.control_category)),
          ledger_balance: row.ledger_amount,
          support_balance: row.supporting_register_amount,
        })),
        receivables: receivables.data ?? [],
        payables: payables.data ?? [],
        company_snapshot: snapshot.data,
        profit_disposition: profitDisposition.data,
        annotations: annotations.data ?? [],
      },
    })
  },
  { allowRequestedCompany: true },
)

function controlLabel(category: string): string {
  return {
    company_identity: 'Företagsidentitet',
    customer_receivables: 'Kundreskontra',
    supplier_payables: 'Leverantörsreskontra',
    bank: 'Bank och kassa',
    equity: 'Eget kapital',
    tax: 'Skatt',
    vat: 'Moms',
    profit_disposition: 'Resultatdisposition',
  }[category] ?? category
}

export const POST = withRouteContext(
  'period.historical_support_write',
  async (request, ctx, { params }: { params: Promise<{ id: string }> }) => {
    const { id } = await params
    const { user, companyId } = ctx
    const db = createServiceClient()
    const access = await requireYearEndAccess(db, companyId, user.id, id, {
      operation: 'period.historical_support_write',
      requestId: ctx.requestId,
      requireWrite: true,
    })
    if (!access.allowed) return yearEndAccessDeniedResponse('year_end.projects', access.reason)

    const parsed = commandSchema.safeParse(await request.json().catch(() => null))
    if (!parsed.success) {
      return NextResponse.json(
        {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Kontrollera de obligatoriska fälten.',
            details: parsed.error.flatten(),
          },
        },
        { status: 400 },
      )
    }

    try {
      if (parsed.data.action === 'add_open_item') {
        const { action: _action, kind, idempotency_key, ...payload } = parsed.data
        const { data, error } = await db.rpc('record_migrated_open_item', {
          p_kind: kind,
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_payload: payload,
          p_idempotency_key: idempotency_key ?? crypto.randomUUID(),
        })
        if (error) throw error
        return NextResponse.json({ data }, { status: 201 })
      }
      if (parsed.data.action === 'save_profit_disposition') {
        const { action: _action, ...payload } = parsed.data
        const { data, error } = await db.rpc('record_year_end_profit_disposition', {
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_payload: payload,
        })
        if (error) throw error
        return NextResponse.json({ data }, { status: 201 })
      }
      if (parsed.data.action === 'add_annotation') {
        const { data, error } = await db.rpc('record_year_end_annotation', {
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_target_type: parsed.data.target_type,
          p_target_id: parsed.data.target_id ?? null,
          p_visibility: parsed.data.visibility,
          p_annotation_text: parsed.data.annotation_text,
        })
        if (error) throw error
        return NextResponse.json({ data: { id: data } }, { status: 201 })
      }

      const [company, settings] = await Promise.all([
        db
          .from('companies')
          .select('name, org_number, entity_type')
          .eq('id', companyId)
          .single(),
        db
          .from('company_settings')
          .select('company_name, org_number, address_line1, address_line2, postal_code, city')
          .eq('company_id', companyId)
          .maybeSingle(),
      ])
      if (company.error || !company.data) throw company.error ?? new Error('Företaget saknas')
      if (settings.error) throw settings.error
      const profile = settings.data
      const { data, error } = await db.rpc('record_year_end_company_snapshot', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
        p_user_id: user.id,
        p_snapshot: {
          organisation_number: company.data.org_number ?? profile?.org_number,
          legal_name: company.data.name ?? profile?.company_name,
          address_line1: profile?.address_line1,
          address_line2: profile?.address_line2,
          postal_code: profile?.postal_code,
          city: profile?.city,
          registered_office: parsed.data.registered_office ?? profile?.city,
          legal_entity_type: company.data.entity_type,
          business_description: parsed.data.business_description,
          registration_status: 'profile_confirmed',
          source_selection: {
            identity: 'companies',
            address: 'company_settings',
          },
          effective_at: new Date().toISOString(),
        },
        p_lock: parsed.data.lock,
      })
      if (error) throw error
      return NextResponse.json({ data }, { status: 201 })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Okänt fel'
      ctx.log.error('historical support write failed', error as Error)
      return NextResponse.json(
        { error: { code: 'HISTORICAL_SUPPORT_WRITE_FAILED', message } },
        { status: /CONFLICT|LOCKED|DIFFERENCE|INVALID|REQUIRED/i.test(message) ? 409 : 500 },
      )
    }
  },
  { allowRequestedCompany: true },
)
