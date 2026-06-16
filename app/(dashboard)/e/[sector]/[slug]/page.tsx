import { createClient } from '@/lib/supabase/server'
import { redirect, notFound } from 'next/navigation'
import { getExtensionDefinition } from '@/lib/extensions/sectors'
import ExtensionWorkspaceLoader from '@/components/extensions/ExtensionWorkspaceLoader'

export default async function ExtensionWorkspacePage({
  params,
}: {
  params: Promise<{ sector: string; slug: string }>
}) {
  const { sector, slug } = await params
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const definition = getExtensionDefinition(sector, slug)
  if (!definition) notFound()

  return (
    <ExtensionWorkspaceLoader
      sector={sector}
      slug={slug}
      definition={definition}
      userId={user.id}
    />
  )
}
