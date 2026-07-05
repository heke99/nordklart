'use client'

import { useState } from 'react'
import { ArrowUpRight, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { switchCompany } from '@/lib/company/actions'

/**
 * Switches the active company context to the client and performs a hard
 * navigation to /app — the same teardown semantics as CompanySwitcher, so
 * nothing from the previous company context can survive the switch.
 */
export function OpenClientWorkspaceButton({ companyId }: { companyId: string }) {
  const { toast } = useToast()
  const [isPending, setIsPending] = useState(false)

  const openWorkspace = async () => {
    if (isPending) return
    setIsPending(true)
    const result = await switchCompany(companyId)
    if (result.error) {
      setIsPending(false)
      toast({
        title: 'Kunde inte öppna kundens arbetsyta',
        description: result.error,
        variant: 'destructive',
      })
      return
    }
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        const channel = new BroadcastChannel('nordklart-company-switch')
        channel.postMessage({ companyId })
        channel.close()
      } catch {
        // Best-effort — the hard reload below still corrects this tab.
      }
    }
    window.location.assign('/app')
  }

  return (
    <Button variant="ghost" size="sm" onClick={openWorkspace} disabled={isPending}>
      {isPending ? (
        <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
      ) : (
        <ArrowUpRight className="mr-1 h-3.5 w-3.5" />
      )}
      Öppna
    </Button>
  )
}
