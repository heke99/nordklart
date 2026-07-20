'use client'

import type { ExtensionDefinition } from '@/lib/extensions/types'
import { WORKSPACES } from '@/lib/extensions/_generated/workspace-map'
import ExtensionWorkspaceShell from './ExtensionWorkspaceShell'
import EmptyExtensionState from './shared/EmptyExtensionState'

// Full-screen workspaces render their own chrome (top bar, title) and opt
// out of the shared ExtensionWorkspaceShell header.
const FULLSCREEN_WORKSPACES = new Set(['general/invoice-inbox'])

export default function ExtensionWorkspaceLoader({
  sector,
  slug,
  definition,
  userId,
}: {
  sector: string
  slug: string
  definition: ExtensionDefinition
  userId: string
}) {
  // Static map lookup instead of a call — the static-components rule treats a
  // call-result component as created during render.
  const WorkspaceComponent = WORKSPACES[`${sector}/${slug}`] ?? null
  const isFullScreen = FULLSCREEN_WORKSPACES.has(`${sector}/${slug}`)

  if (isFullScreen && WorkspaceComponent) {
    return <WorkspaceComponent userId={userId} />
  }

  return (
    <ExtensionWorkspaceShell definition={definition}>
      {WorkspaceComponent ? (
        <WorkspaceComponent userId={userId} />
      ) : (
        <EmptyExtensionState
          title="Bakgrundstjänst"
          description={`${definition.name} körs i bakgrunden och har ingen egen vy. Du kan hantera inställningar under Inställningar.`}
        />
      )}
    </ExtensionWorkspaceShell>
  )
}
