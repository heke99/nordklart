'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { formatDateLong } from '@/lib/utils'

type AccessLevel = 'bookkeeping' | 'review' | 'audit' | 'full_service'

interface AgencyLink {
  id: string
  agency_id: string
  agency_name: string | null
  status: 'pending' | 'active' | 'paused' | 'suspended' | 'ended'
  access_level: AccessLevel
  approved_at: string | null
  created_at: string
}

const STATUS_VARIANT: Record<AgencyLink['status'], 'default' | 'secondary' | 'warning' | 'outline'> = {
  pending: 'warning',
  active: 'default',
  paused: 'secondary',
  suspended: 'secondary',
  ended: 'outline',
}

/**
 * The client company's own view of accounting agencies that have — or ask
 * for — access to its books. Only the company's direct owner/admin sees and
 * manages this (the API returns 403 to everyone else, agency staff included).
 */
export function CompanyAgencyLinksSection() {
  const t = useTranslations('settings_company')
  const { toast } = useToast()
  const [links, setLinks] = useState<AgencyLink[] | null>(null)
  const [forbidden, setForbidden] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [levels, setLevels] = useState<Record<string, AccessLevel>>({})

  const load = useCallback(async () => {
    const res = await fetch('/api/company/agency-links')
    if (res.status === 403) {
      setForbidden(true)
      return
    }
    const body = await res.json().catch(() => ({ data: [] })) as { data?: AgencyLink[] }
    setLinks(body.data ?? [])
  }, [])

  useEffect(() => {
    const timer = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(timer)
  }, [load])

  async function update(link: AgencyLink, action: 'approve' | 'revoke') {
    if (action === 'revoke' && !confirm(t('agency_confirm_revoke', { name: link.agency_name ?? '' }))) return
    setBusyId(link.id)
    try {
      const res = await fetch(`/api/company/agency-links/${link.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(action === 'approve'
          ? { action, access_level: levels[link.id] ?? link.access_level }
          : { action }),
      })
      if (!res.ok) throw new Error()
      toast({ title: action === 'approve' ? t('agency_toast_approved') : t('agency_toast_revoked') })
      await load()
    } catch {
      toast({ title: t('agency_toast_failed'), variant: 'destructive' })
    } finally {
      setBusyId(null)
    }
  }

  if (forbidden) return null

  const visible = (links ?? []).filter((l) => l.status !== 'ended')

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('agency_title')}</CardTitle>
        <CardDescription>{t('agency_description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {links === null ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-muted-foreground" /></div>
        ) : visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('agency_empty')}</p>
        ) : (
          <ul className="divide-y divide-border">
            {visible.map((link) => (
              <li key={link.id} className="flex flex-col gap-3 py-3 md:flex-row md:items-center md:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">{link.agency_name ?? t('agency_unknown')}</span>
                    <Badge variant={STATUS_VARIANT[link.status]}>{t(`agency_status_${link.status}`)}</Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(`agency_level_${link.access_level}`)}
                    {link.approved_at ? ` · ${t('agency_approved_on', { date: formatDateLong(link.approved_at) })}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {link.status === 'pending' ? (
                    <>
                      <Select
                        value={levels[link.id] ?? link.access_level}
                        onValueChange={(v) => setLevels((prev) => ({ ...prev, [link.id]: v as AccessLevel }))}
                      >
                        <SelectTrigger className="w-44" aria-label={t('agency_level_label')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {(['bookkeeping', 'review', 'audit', 'full_service'] as const).map((level) => (
                            <SelectItem key={level} value={level}>{t(`agency_level_${level}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Button size="sm" onClick={() => update(link, 'approve')} disabled={busyId === link.id}>
                        {t('agency_approve')}
                      </Button>
                    </>
                  ) : null}
                  <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => update(link, 'revoke')} disabled={busyId === link.id}>
                    {link.status === 'pending' ? t('agency_decline') : t('agency_revoke')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
