'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'

type RetryResponse = {
  state?: string
  onboardingPath?: string
  error?: string
}

export function RetryWorkspaceProvisioningButton() {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  async function retry() {
    setIsLoading(true)
    setMessage(null)

    try {
      const response = await fetch('/api/auth/signup-draft/retry', { method: 'POST' })
      const body = await response.json().catch(() => ({})) as RetryResponse

      if (response.ok && body.onboardingPath) {
        router.replace(body.onboardingPath)
        router.refresh()
        return
      }

      if (response.status === 409) {
        setMessage('Installationen pågår redan. Vänta ett ögonblick och försök sedan igen.')
        return
      }

      setMessage(body.error || 'Vi kunde inte fortsätta installationen just nu. Försök igen om en stund.')
    } catch {
      setMessage('Vi kunde inte nå installationstjänsten just nu. Försök igen om en stund.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="space-y-3">
      <Button type="button" className="w-full" onClick={retry} disabled={isLoading}>
        {isLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        {isLoading ? 'Försöker fortsätta...' : 'Fortsätt installationen'}
      </Button>
      {message ? <p className="text-center text-sm text-muted-foreground" role="status">{message}</p> : null}
    </div>
  )
}
