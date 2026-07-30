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

const acceptWorkpapersSchema = z.object({
  action: z.literal('accept_sie_workpapers'),
  workpaper_ids: z.array(z.string().uuid()).min(1).max(20),
  comment: z.string().trim().min(3).max(1000),
  reimport_choice: z.enum(['keep', 'replace']).optional(),
})

const adjustWorkpaperSchema = z.object({
  action: z.literal('adjust_workpaper'),
  workpaper_id: z.string().uuid(),
  amount: z.number(),
  adjustment_kind: z.enum([
    'verification_only',
    'support_register_completion',
    'annual_report_reclassification',
    'comment',
    'accounting_correction',
  ]),
  comment: z.string().trim().min(3).max(1000),
})

const commandSchema = z.discriminatedUnion('action', [
  openItemSchema,
  snapshotSchema,
  profitDispositionSchema,
  annotationSchema,
  acceptWorkpapersSchema,
  adjustWorkpaperSchema,
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
      workpapers,
      workpaperEvents,
      controlAccounts,
      profitDispositionProposal,
      sourceImport,
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
      db
        .from('year_end_historical_workpapers')
        .select(
          'id, category, source_sie_import_id, imported_amount, current_amount, external_amount, actual_difference, support_register_available, status, source_type, account_numbers, verification_method, comment, metadata, pending_sie_import_id, pending_imported_amount, conflict_detected_at, confirmed_by, confirmed_at, updated_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .order('category'),
      db
        .from('year_end_historical_workpaper_events')
        .select(
          'id, workpaper_id, event_type, previous_status, new_status, previous_amount, new_amount, source_sie_import_id, adjustment_kind, reason, actor_id, created_at',
        )
        .eq('company_id', companyId)
        .eq('fiscal_period_id', id)
        .order('created_at', { ascending: false })
        .limit(100),
      db
        .from('year_end_control_accounts')
        .select('control_category, account_number, active')
        .eq('company_id', companyId)
        .eq('active', true)
        .order('account_number'),
      db.rpc('year_end_profit_disposition_proposal', {
        p_company_id: companyId,
        p_fiscal_period_id: id,
      }),
      db
        .from('sie_imports')
        .select(
          'id, filename, file_hash, sie_type, fiscal_year_start, fiscal_year_end, accounts_count, transactions_count, total_vouchers, posted_vouchers, warnings, imported_at',
        )
        .eq('company_id', companyId)
        .eq('status', 'completed')
        .eq('fiscal_period_id', id)
        .order('imported_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
    ])

    const failure = [
      period,
      controls,
      receivables,
      payables,
      snapshot,
      profitDisposition,
      annotations,
      workpapers,
      workpaperEvents,
      controlAccounts,
      profitDispositionProposal,
      sourceImport,
    ].find((result) => result.error)
    if (failure?.error) {
      ctx.log.error('historical support read failed', new Error(failure.error.message))
      return NextResponse.json(
        { error: { code: 'HISTORICAL_SUPPORT_READ_FAILED', message: failure.error.message } },
        { status: 500 },
      )
    }

    const confirmerIds = [
      ...new Set(
        (workpapers.data ?? [])
          .map((workpaper) => workpaper.confirmed_by)
          .filter((value): value is string => typeof value === 'string'),
      ),
    ]
    const confirmers = confirmerIds.length > 0
      ? await db.from('profiles').select('id, full_name').in('id', confirmerIds)
      : { data: [], error: null }
    if (confirmers.error) {
      ctx.log.error(
        'historical support confirmer read failed',
        new Error(confirmers.error.message),
      )
      return NextResponse.json(
        {
          error: {
            code: 'HISTORICAL_SUPPORT_CONFIRMER_READ_FAILED',
            message: 'Godkännandehistoriken kunde inte hämtas.',
          },
        },
        { status: 500 },
      )
    }
    const confirmerNames = new Map(
      (confirmers.data ?? []).map((profile) => [
        profile.id,
        profile.full_name || 'Användare',
      ]),
    )

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
        profit_disposition_proposal: profitDispositionProposal.data,
        annotations: annotations.data ?? [],
        workpapers: (workpapers.data ?? []).map((workpaper) => ({
          ...workpaper,
          confirmed_by_name: workpaper.confirmed_by
            ? confirmerNames.get(workpaper.confirmed_by) ?? 'Användare'
            : null,
        })),
        workpaper_events: workpaperEvents.data ?? [],
        control_accounts: (controlAccounts.data ?? []).reduce<Record<string, string[]>>(
          (groups, row) => {
            const category = String(row.control_category)
            groups[category] ??= []
            groups[category].push(String(row.account_number))
            return groups
          },
          {},
        ),
        source_import: sourceImport.data,
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
      if (parsed.data.action === 'accept_sie_workpapers') {
        const { data, error } = await db.rpc('accept_year_end_historical_workpapers', {
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_workpaper_ids: parsed.data.workpaper_ids,
          p_comment: parsed.data.comment,
          p_reimport_choice: parsed.data.reimport_choice ?? null,
        })
        if (error) throw error
        return NextResponse.json({ data })
      }
      if (parsed.data.action === 'adjust_workpaper') {
        if (parsed.data.adjustment_kind === 'accounting_correction') {
          return NextResponse.json(
            {
              error: {
                code: 'ACCOUNTING_CORRECTION_REQUIRES_JOURNAL',
                message:
                  'En bokföringsmässig korrigering måste skapas som rättelseverifikation i bokföringen.',
              },
            },
            { status: 409 },
          )
        }
        const { data, error } = await db.rpc('adjust_year_end_historical_workpaper', {
          p_company_id: companyId,
          p_fiscal_period_id: id,
          p_user_id: user.id,
          p_workpaper_id: parsed.data.workpaper_id,
          p_amount: parsed.data.amount,
          p_adjustment_kind: parsed.data.adjustment_kind,
          p_comment: parsed.data.comment,
        })
        if (error) throw error
        return NextResponse.json({ data })
      }
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
