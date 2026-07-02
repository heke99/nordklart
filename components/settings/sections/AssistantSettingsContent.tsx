'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { AgentMemoryPanel } from '@/components/settings/AgentMemoryPanel'
import { AgentSkillsPanel } from '@/components/settings/AgentSkillsPanel'
import { AssistantFaqPanel } from '@/components/settings/AssistantFaqPanel'

// "Assistenten" — what the assistant remembers about this company (Minne,
// editable), the domain knowledge it ships with (Kompetens, read-only) and
// the seeded FAQ knowledge base it searches first (FAQ, testable).
// A toggle keeps them one click away instead of stacked.
type View = 'memory' | 'skills' | 'faq'

export function AssistantSettingsContent() {
  const searchParams = useSearchParams()
  const router = useRouter()
  const param = searchParams.get('view')
  const view: View = param === 'skills' ? 'skills' : param === 'faq' ? 'faq' : 'memory'

  function setView(next: string) {
    // 'memory' is the default — keep its URL clean (no query string).
    router.replace(
      next === 'skills'
        ? '/settings/assistant?view=skills'
        : next === 'faq'
          ? '/settings/assistant?view=faq'
          : '/settings/assistant',
      { scroll: false },
    )
  }

  return (
    <Tabs value={view} onValueChange={setView} className="space-y-6">
      <TabsList>
        <TabsTrigger value="memory">Minne</TabsTrigger>
        <TabsTrigger value="skills">Kompetens</TabsTrigger>
        <TabsTrigger value="faq">FAQ</TabsTrigger>
      </TabsList>

      {/* Radix unmounts the inactive panel, so each panel's data is fetched
          lazily the first time its tab is opened. */}
      <TabsContent value="memory">
        <AgentMemoryPanel />
      </TabsContent>
      <TabsContent value="skills">
        <AgentSkillsPanel />
      </TabsContent>
      <TabsContent value="faq">
        <AssistantFaqPanel />
      </TabsContent>
    </Tabs>
  )
}
