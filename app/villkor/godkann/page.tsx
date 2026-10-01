import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { FileCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { safeReturnTo } from '@/lib/auth/safe-return-to'
import { NORDKLART_LEGAL_NAME, NORDKLART_ORG_NUMBER } from '@/lib/branding/legal-identity'
import { LEGAL_ACCEPT_PATH } from '@/lib/legal/acceptance-gate'
import { AcceptTermsForm, type PendingDocument } from './AcceptTermsForm'

export const dynamic = 'force-dynamic'

export default async function AcceptTermsPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>
}) {
  const { next } = await searchParams
  const destination = safeReturnTo(next, '/')
  // Never bounce back to this page after accepting.
  const target = destination.startsWith(LEGAL_ACCEPT_PATH) ? '/' : destination

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect(`/login?next=${encodeURIComponent(LEGAL_ACCEPT_PATH)}`)

  const { data: pending } = await supabase.rpc('pending_legal_documents')
  const documents = (pending ?? []) as PendingDocument[]
  if (documents.length === 0) redirect(target)

  const t = await getTranslations('legal_gate')

  return (
    <main className="min-h-screen bg-background px-4 py-10">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <div className="text-center">
          <div className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-lg bg-secondary">
            <FileCheck className="h-6 w-6 text-primary" />
          </div>
          <h1 className="font-display text-3xl tracking-tight">{t('title')}</h1>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">
            {t('intro', { entity: NORDKLART_LEGAL_NAME, orgNumber: NORDKLART_ORG_NUMBER })}
          </p>
        </div>
        <AcceptTermsForm documents={documents} target={target} />
      </div>
    </main>
  )
}
