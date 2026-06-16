import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'

const ImportLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

const ImportTemplateSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: z.enum([
    'eu_trade', 'tax_account', 'private_transfer',
    'salary', 'representation', 'year_end',
    'vat', 'financial', 'other',
  ]).default('other'),
  entity_type: z.enum(['all', 'enskild_firma', 'aktiebolag']).default('all'),
  lines: z.array(ImportLineSchema).min(2),
})

const ImportPayloadSchema = z.object({
  version: z.number(),
  templates: z.array(ImportTemplateSchema).min(1).max(100),
})

/**
 * POST /api/settings/booking-templates/import
 * Import templates from JSON (exported from another company).
 * Creates company-scoped templates for the active company.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const parsed = ImportPayloadSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid import format', details: parsed.error.issues },
      { status: 400 },
    )
  }

  const rows = parsed.data.templates.map((t) => ({
    company_id: companyId,
    team_id: null,
    created_by: user.id,
    name: t.name,
    description: t.description,
    category: t.category,
    entity_type: t.entity_type,
    lines: t.lines,
    is_system: false,
  }))

  const { data, error } = await supabase
    .from('booking_template_library')
    .insert(rows)
    .select()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ data, imported: data?.length ?? 0 }, { status: 201 })
}
