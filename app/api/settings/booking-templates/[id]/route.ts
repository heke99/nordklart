import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireWritePermission } from '@/lib/auth/require-write'
import { z } from 'zod'
import { validateBody } from '@/lib/api/validate'

const BookingTemplateLineSchema = z.object({
  account: z.string().regex(/^\d{4}$/),
  label: z.string().min(1),
  side: z.enum(['debit', 'credit']),
  type: z.enum(['business', 'vat', 'settlement']),
  ratio: z.number().min(0).max(10).optional(),
  vat_rate: z.number().min(0).max(1).optional(),
})

const UpdateBookingTemplateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum([
    'eu_trade', 'tax_account', 'private_transfer',
    'salary', 'representation', 'year_end',
    'vat', 'financial', 'other',
  ]).optional(),
  entity_type: z.enum(['all', 'enskild_firma', 'aktiebolag']).optional(),
  lines: z.array(BookingTemplateLineSchema).min(2).optional(),
})

/**
 * PUT /api/settings/booking-templates/[id]
 * Update a non-system template.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const result = await validateBody(request, UpdateBookingTemplateSchema)
  if (!result.success) return result.response

  // RLS prevents updating system templates
  const { data, error } = await supabase
    .from('booking_template_library')
    .update(result.data)
    .eq('id', id)
    .eq('is_system', false)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!data) return NextResponse.json({ error: 'Template not found' }, { status: 404 })

  return NextResponse.json({ data })
}
