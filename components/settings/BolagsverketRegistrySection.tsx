'use client'

import { useEffect, useState } from 'react'
import { useToast } from '@/components/ui/use-toast'
import { Skeleton } from '@/components/ui/skeleton'
import { BolagsverketRegistryView, type BolagsverketDiffRow, type BolagsverketSnapshot } from './BolagsverketRegistryView'
import type { CompanySettings } from '@/types'

type SnapshotResponse = { snapshot: BolagsverketSnapshot | null }
type SyncResponse = {
  snapshot: BolagsverketSnapshot | null
  diff: BolagsverketDiffRow[]
  updatedSettings?: Partial<CompanySettings> | null
  error?: string
}

export function BolagsverketRegistrySection({
  onSettingsUpdated,
}: {
  onSettingsUpdated?: (settings: Partial<CompanySettings>) => void
}) {
  const { toast } = useToast()
  const [snapshot, setSnapshot] = useState<BolagsverketSnapshot | null>(null)
  const [diff, setDiff] = useState<BolagsverketDiffRow[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/company-registry/bolagsverket/snapshot')
      .then(async (res) => {
        if (!res.ok) return null
        return await res.json() as SnapshotResponse
      })
      .then((payload) => {
        if (cancelled) return
        setSnapshot(payload?.snapshot ?? null)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [])

  async function sync(applySafeFields = false) {
    applySafeFields ? setApplying(true) : setSyncing(true)
    try {
      const response = await fetch('/api/company-registry/bolagsverket/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applySafeFields }),
      })
      const payload = await response.json().catch(() => ({})) as SyncResponse
      if (!response.ok) throw new Error(payload.error || 'Kunde inte hämta registeruppgifter.')

      setSnapshot(payload.snapshot ?? null)
      setDiff(payload.updatedSettings ? [] : payload.diff ?? [])
      if (payload.updatedSettings) onSettingsUpdated?.(payload.updatedSettings)
      toast({
        title: applySafeFields ? 'Företagsuppgifter uppdaterade' : 'Uppgifter hämtade',
        description: applySafeFields ? 'Säkra fält har uppdaterats från Bolagsverket.' : 'Kontrollera eventuella skillnader innan du uppdaterar inställningarna.',
      })
    } catch (error) {
      toast({
        title: 'Bolagsverket kunde inte uppdateras',
        description: error instanceof Error ? error.message : 'Försök igen om en stund.',
        variant: 'destructive',
      })
    } finally {
      setSyncing(false)
      setApplying(false)
    }
  }

  if (loading) return <Skeleton className="h-52 w-full rounded-lg" />

  return (
    <BolagsverketRegistryView
      snapshot={snapshot}
      diff={diff}
      loading={syncing}
      applying={applying}
      onSync={() => void sync(false)}
      onApply={() => void sync(true)}
    />
  )
}
