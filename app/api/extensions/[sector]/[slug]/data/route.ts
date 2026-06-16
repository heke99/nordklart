import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

export async function GET(
  request: Request,
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

  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')

  let query = supabase
    .from('extension_data')
    .select('*')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)

  const prefix = searchParams.get('prefix')

  if (key) {
    query = query.eq('key', key)
  } else if (prefix) {
    query = query.ilike('key', `${prefix}%`)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function POST(
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
  const { key, value } = body

  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }

  const extensionId = `${sector}/${slug}`

  const { data, error } = await supabase
    .from('extension_data')
    .upsert(
      {
        user_id: user.id,
        company_id: companyId,
        extension_id: extensionId,
        key,
        value,
      },
      { onConflict: 'user_id,extension_id,key' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
}

export async function DELETE(
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

  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')

  if (!key) {
    return NextResponse.json({ error: 'key query parameter is required' }, { status: 400 })
  }

  const extensionId = `${sector}/${slug}`

  const { error } = await supabase
    .from('extension_data')
    .delete()
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', key)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
