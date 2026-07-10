import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export async function POST() {
  const supabase = await createClient()
  const { error } = await supabase.auth.signOut({ scope: 'local' })

  const response = NextResponse.json(
    error ? { ok: false, error: 'Kunde inte logga ut sessionen.' } : { ok: true },
    { status: error ? 500 : 200 },
  )

  response.cookies.set('nordklart-company-id', '', {
    path: '/',
    maxAge: 0,
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
  })

  return response
}
