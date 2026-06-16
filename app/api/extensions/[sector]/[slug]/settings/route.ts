import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ sector: string; slug: string }> }
) {
  const { sector, slug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

  const extensionId = `${sector}/${slug}`

  const { data } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', 'settings')
    .single()

  return NextResponse.json({ data: data?.value ?? {} })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ sector: string; slug: string }> }
) {
  const { sector, slug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const body = await request.json()
  const extensionId = `${sector}/${slug}`

  // Get existing settings and merge
  const { data: existing } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', 'settings')
    .single()

  const mergedSettings = { ...(existing?.value ?? {}), ...body }

  const { data, error } = await supabase
    .from('extension_data')
    .upsert(
      {
        user_id: user.id,
        company_id: companyId,
        extension_id: extensionId,
        key: 'settings',
        value: mergedSettings,
      },
      { onConflict: 'user_id,extension_id,key' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data.value })
}
