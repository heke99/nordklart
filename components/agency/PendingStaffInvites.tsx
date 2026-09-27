'use client'

import { useCallback, useEffect, useState } from 'react'
import { Loader2, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { formatDateLong } from '@/lib/utils'
import { AGENCY_INVITES_CHANGED_EVENT } from '@/components/agency/InviteStaffDialog'

type PendingInvite = {
  id: string
  email: string
  role: string
  expires_at: string
  expired: boolean
}

const ROLE_LABELS: Record<string, string> = {
  agency_admin: 'Byråadministratör',
  accountant: 'Redovisningskonsult',
  payroll: 'Lönekonsult',
  reviewer: 'Granskare',
  read_only: 'Läsbehörighet',
}

/** Pending staff invitations of an agency, with revoke. Admins only. */
export function PendingStaffInvites({ agencyId }: { agencyId: string }) {
  const { toast } = useToast()
  const [invites, setInvites] = useState<PendingInvite[] | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/agency/staff/invite?agency_id=${encodeURIComponent(agencyId)}`)
    const body = await res.json().catch(() => ({}))
    setInvites(res.ok ? (body.data as PendingInvite[]) : [])
  }, [agencyId])

  useEffect(() => {
    void load()
    const reload = () => void load()
    window.addEventListener(AGENCY_INVITES_CHANGED_EVENT, reload)
    return () => window.removeEventListener(AGENCY_INVITES_CHANGED_EVENT, reload)
  }, [load])

  const revoke = async (id: string) => {
    setRevokingId(id)
    try {
      const res = await fetch('/api/agency/staff/invite', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, agency_id: agencyId }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: 'Kunde inte återkalla inbjudan', description: body.error, variant: 'destructive' })
        return
      }
      setInvites((current) => (current ?? []).filter((invite) => invite.id !== id))
      toast({ title: 'Inbjudan återkallad' })
    } finally {
      setRevokingId(null)
    }
  }

  if (!invites || invites.length === 0) return null

  return (
    <div className="rounded-lg border border-border p-6">
      <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">Väntande inbjudningar</h2>
      <ul className="mt-4 divide-y divide-border">
        {invites.map((invite) => (
          <li key={invite.id} className="flex items-center justify-between gap-3 py-3">
            <div className="min-w-0">
              <div className="truncate text-sm">{invite.email}</div>
              <div className="text-xs text-muted-foreground">
                {ROLE_LABELS[invite.role] ?? invite.role} · {invite.expired ? 'Har gått ut' : `Giltig till ${formatDateLong(invite.expires_at)}`}
              </div>
            </div>
            <div className="flex items-center gap-2">
              {invite.expired ? <Badge variant="secondary">Utgången</Badge> : null}
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Återkalla inbjudan till ${invite.email}`}
                disabled={revokingId === invite.id}
                onClick={() => void revoke(invite.id)}
              >
                {revokingId === invite.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <X className="h-4 w-4" />}
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
