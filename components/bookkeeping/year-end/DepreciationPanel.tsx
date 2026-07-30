'use client'

import { useCallback, useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { Skeleton } from '@/components/ui/skeleton'
import { Loader2 } from 'lucide-react'
import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { formatCurrency } from '@/lib/utils'
import { useToast } from '@/components/ui/use-toast'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'
import type { Asset } from '@/types'

interface ProposalItem {
  asset: Asset
  amount: number
  netBookValueAfter: number
  proRated: boolean
  existingScheduleId?: string
  existingJournalEntryId?: string | null
}

interface Proposal {
  fiscalPeriod: { id: string; name: string; period_start: string; period_end: string }
  items: ProposalItem[]
  totalAmount: number
  stagedAssetIds?: string[]
  groupTouched?: boolean
}

interface DepreciationPanelProps {
  periodId: string
  companyId?: string | null
  /** Called after staging — parent refetches disposition proposals. */
  onPosted: () => void
}

export function DepreciationPanel({ periodId, companyId, onPosted }: DepreciationPanelProps) {
  const { toast } = useToast()
  const [proposal, setProposal] = useState<Proposal | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [posting, setPosting] = useState(false)
  const [selectedAssetIds, setSelectedAssetIds] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation${companySuffix}`)
      const body = await res.json()
      if (!res.ok) {
        setError(getYearEndApiErrorMessage(
          body,
          'Kunde inte ladda avskrivningar',
          res.status,
        ))
        return
      }
      const data = body.data as Proposal
      setProposal(data)
      const staged = new Set(data.stagedAssetIds ?? [])
      setSelectedAssetIds(data.groupTouched
        ? staged
        : new Set(data.items
          .filter((item) => !item.existingJournalEntryId)
          .map((item) => item.asset.id)))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setLoading(false)
    }
  }, [periodId, companyId])

  useEffect(() => {
    // Defer to the next macrotask so the synchronous setState inside
    // load does not run directly within the effect body.
    const timer = setTimeout(() => {
      void load()
    }, 0)
    return () => clearTimeout(timer)
  }, [load])

  const handlePost = useCallback(async () => {
    setPosting(true)
    try {
      const companySuffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
      const res = await fetch(`/api/bookkeeping/fiscal-periods/${periodId}/depreciation${companySuffix}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ asset_ids: [...selectedAssetIds] }),
      })
      const body = await res.json()
      if (!res.ok) {
        setError(getYearEndApiErrorMessage(
          body,
          'Kunde inte spara avskrivningar',
          res.status,
        ))
        return
      }
      const staged = body.data?.staged?.count ?? 0
      toast({
        title: `${staged} avskrivning${staged === 1 ? '' : 'ar'} sparad${
          staged === 1 ? '' : 'e'
        }`,
        description: 'Avskrivningarna bokförs först när bokslutet verkställs.',
      })
      onPosted()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Okänt fel')
    } finally {
      setPosting(false)
    }
  }, [periodId, companyId, onPosted, load, toast, selectedAssetIds])

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-2">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-20 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error) {
    return (
      <Card>
        <CardContent className="p-6 text-destructive">{error}</CardContent>
      </Card>
    )
  }

  if (!proposal) return null

  const allPosted =
    proposal.items.length > 0 && proposal.items.every((i) => Boolean(i.existingJournalEntryId))
  const anyPending =
    proposal.items.length > 0 && proposal.items.some((i) => !i.existingJournalEntryId)

  if (proposal.items.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-muted-foreground">
          Inga aktiva anläggningstillgångar att skriva av.{' '}
          <Link
            href={companyId ? `/assets?company_id=${encodeURIComponent(companyId)}` : '/assets'}
            className="text-primary hover:underline"
          >
            Lägg till tillgångar
          </Link>{' '}
          så räknar bokslutet ut avskrivningarna automatiskt.
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <CardTitle className="text-base">Planenliga avskrivningar</CardTitle>
            <p className="text-sm text-muted-foreground mt-1">
              {proposal.items.length} tillgång{proposal.items.length === 1 ? '' : 'ar'}.
              {allPosted ? ' Allt redan bokfört.' : ' Sparas till bokslutets gemensamma verkställning.'}
            </p>
          </div>
          <p className="font-display text-2xl tabular-nums shrink-0">
            {formatCurrency(proposal.totalAmount)}
          </p>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Tillgång</TableHead>
              <TableHead className="text-right">Avskrivning</TableHead>
              <TableHead className="text-right">Restvärde</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {proposal.items.map((item) => (
              <TableRow key={item.asset.id}>
                <TableCell className="text-sm">
                  <div className="flex items-center gap-3">
                    {!item.existingJournalEntryId && (
                      <Checkbox
                        checked={selectedAssetIds.has(item.asset.id)}
                        onCheckedChange={(checked) => {
                          setSelectedAssetIds((previous) => {
                            const next = new Set(previous)
                            if (checked) next.add(item.asset.id)
                            else next.delete(item.asset.id)
                            return next
                          })
                        }}
                        aria-label={`Ta med avskrivning för ${item.asset.name}`}
                      />
                    )}
                    <span>{item.asset.name}</span>
                  </div>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.amount)}
                  {item.proRated && (
                    <span className="block text-[10px] text-muted-foreground">pro-rata</span>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatCurrency(item.netBookValueAfter)}
                </TableCell>
                <TableCell>
                  {item.existingJournalEntryId ? (
                    <Badge variant="success">Bokförd</Badge>
                  ) : selectedAssetIds.has(item.asset.id) ? (
                    <Badge variant="outline">Vald</Badge>
                  ) : (
                    <Badge variant="secondary">Borttagen</Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        {anyPending && (
          <div className="flex justify-end">
            <Button onClick={handlePost} disabled={posting}>
              {posting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Sparar…
                </>
              ) : (
                'Spara valda avskrivningar'
              )}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
