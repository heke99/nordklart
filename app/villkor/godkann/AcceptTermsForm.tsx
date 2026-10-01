'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'

export type PendingDocument = {
  legal_text_version_id: string
  document_type: string
  version: string
  title: string
  public_path: string
}

export function AcceptTermsForm({ documents, target }: { documents: PendingDocument[]; target: string }) {
  const t = useTranslations('legal_gate')
  const [checked, setChecked] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function accept() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch('/api/legal/accept', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionIds: documents.map((d) => d.legal_text_version_id) }),
      })
      if (res.status === 409) {
        // A newer version was published while this page was open.
        window.location.reload()
        return
      }
      if (!res.ok) throw new Error(String(res.status))
      // Full navigation so the middleware sees the new acceptance.
      window.location.assign(target)
    } catch {
      setError(t('error'))
      setSaving(false)
    }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined)
    window.location.assign('/login')
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('documents')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <ul className="divide-y divide-border rounded-lg border border-border">
          {documents.map((doc) => (
            <li key={doc.legal_text_version_id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div>
                <p className="text-sm font-medium">{doc.title}</p>
                <p className="text-xs text-muted-foreground tabular-nums">{t('version', { version: doc.version })}</p>
              </div>
              <Button asChild variant="outline" size="sm">
                <a href={doc.public_path} target="_blank" rel="noopener noreferrer">
                  {t('open')}
                  <ExternalLink className="ml-2 h-4 w-4" aria-hidden />
                </a>
              </Button>
            </li>
          ))}
        </ul>

        <label className="flex items-start gap-3 text-sm leading-6">
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => setChecked(value === true)}
            className="mt-1"
            aria-describedby="legal-gate-decline"
          />
          <span>{t('checkbox')}</span>
        </label>

        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

        <Button className="w-full" disabled={!checked || saving} onClick={accept}>
          {saving ? t('saving') : t('accept')}
        </Button>

        <div className="space-y-3 border-t border-border pt-4">
          <p id="legal-gate-decline" className="text-xs leading-5 text-muted-foreground">{t('decline')}</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="outline" className="flex-1" onClick={logout}>{t('logout')}</Button>
            <Button asChild variant="ghost" className="flex-1">
              <Link href="/settings/account">{t('account')}</Link>
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
