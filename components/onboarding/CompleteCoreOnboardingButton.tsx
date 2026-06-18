'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { ArrowRight } from 'lucide-react'
import { Button } from '@/components/ui/button'

export default function CompleteCoreOnboardingButton({
  href = '/app',
  label = 'Öppna översikten',
}: {
  href?: string
  label?: string
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function complete() {
    setError(null)
    startTransition(async () => {
      const response = await fetch('/api/onboarding/complete-core', { method: 'POST' })
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.data?.dashboard_href !== 'string') {
        setError(body?.error || 'Kunde inte öppna arbetsytan just nu.')
        return
      }
      router.push(body.data.dashboard_href || href)
    })
  }

  return (
    <div className="space-y-2">
      <Button type="button" onClick={complete} disabled={pending}>
        {pending ? 'Öppnar…' : label}
        <ArrowRight className="ml-2 h-4 w-4" />
      </Button>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    </div>
  )
}
