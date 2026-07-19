'use client'

import { useCallback, useEffect, useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { formatDate } from '@/lib/utils'
import { ShieldCheck } from 'lucide-react'

interface SignedConsent {
  id: string
  consent_type: string
  title: string
  signed_via: string
  personal_number_masked: string | null
  signer_name: string | null
  status: 'active' | 'revoked'
  revoked_at: string | null
  created_at: string
}

const CONSENT_TYPE_SV: Record<string, string> = {
  agency_data_sharing: 'Byrååtkomst',
  bank_connection: 'Bankkoppling',
  skatteverket: 'Skatteverket',
  invoice_financing: 'Fakturafinansiering',
  api_integration: 'API/integration',
  bankgiro_autogiro: 'Bankgiro/Autogiro',
  arsredovisning_signature: 'Årsredovisning',
  other: 'Övrigt',
}

/**
 * Settings → BankID: signed consents (samtycken) with revocation.
 *
 * Consents are BankID-verified evidence rows — immutable in the DB; only
 * revocation (a status flip, audited) is possible. Signing happens in the
 * flows that need consent (byrådelning, fakturafinansiering, Bankgiro,
 * årsredovisning) via ConsentSigningDialog.
 */
export function BankIdSettingsContent() {
  const { toast } = useToast()
  const [consents, setConsents] = useState<SignedConsent[] | null>(null)
  const [revokingId, setRevokingId] = useState<string | null>(null)

  const reload = useCallback(async () => {
    try {
      const res = await fetch('/api/bankid/consents')
      const json = await res.json()
      if (res.ok) setConsents(json.data ?? [])
      else setConsents([])
    } catch {
      setConsents([])
    }
  }, [])

  useEffect(() => {
    // Defer to the next macrotask so the synchronous setState inside
    // reload does not run directly within the effect body.
    const timer = setTimeout(() => {
      void reload()
    }, 0)
    return () => clearTimeout(timer)
  }, [reload])

  async function revoke(id: string) {
    setRevokingId(id)
    try {
      const res = await fetch(`/api/bankid/consents/${id}/revoke`, { method: 'POST' })
      const json = await res.json()
      if (!res.ok) {
        toast({
          title: 'Kunde inte återkalla samtycket',
          description: json?.error?.message || json?.error || '',
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Samtycket har återkallats' })
      await reload()
    } catch {
      toast({ title: 'Kunde inte återkalla samtycket', variant: 'destructive' })
    } finally {
      setRevokingId(null)
    }
  }

  return (
    <div className="space-y-8">
      <section className="space-y-4">
        <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
          BankID-signerade samtycken
        </h2>
        <p className="text-sm text-muted-foreground">
          Här visas alla samtycken som signerats med BankID — t.ex. delning av
          bokföringsdata med byrå, bankkoppling, fakturafinansiering och
          underskrift av årsredovisning. Ett samtycke kan återkallas men
          aldrig raderas (bevisvärde). Varje signering och återkallelse
          loggas i granskningsloggen.
        </p>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <ShieldCheck className="h-4 w-4" />
              Samtycken
            </CardTitle>
          </CardHeader>
          <CardContent>
            {consents === null ? (
              <div className="space-y-2">
                {[1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-8 w-full" />
                ))}
              </div>
            ) : consents.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Inga BankID-signerade samtycken än. Samtycken skapas i de
                flöden som kräver dem (byrådelning, fakturafinansiering,
                Bankgiro-ansökan, årsredovisning).
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Typ</TableHead>
                    <TableHead>Titel</TableHead>
                    <TableHead>Signerad av</TableHead>
                    <TableHead>Datum</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Åtgärd</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {consents.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell>
                        <Badge variant="secondary">
                          {CONSENT_TYPE_SV[c.consent_type] ?? c.consent_type}
                        </Badge>
                      </TableCell>
                      <TableCell className="max-w-[240px] truncate">{c.title}</TableCell>
                      <TableCell>
                        {c.signer_name ?? '—'}
                        {c.personal_number_masked ? (
                          <span className="ml-1 text-xs text-muted-foreground">
                            ({c.personal_number_masked})
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell className="tabular-nums">{formatDate(c.created_at)}</TableCell>
                      <TableCell>
                        {c.status === 'active' ? (
                          <Badge variant="success">Aktivt</Badge>
                        ) : (
                          <Badge variant="secondary">
                            Återkallat {c.revoked_at ? formatDate(c.revoked_at) : ''}
                          </Badge>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.status === 'active' && (
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() => revoke(c.id)}
                            disabled={revokingId === c.id}
                          >
                            {revokingId === c.id ? 'Återkallar…' : 'Återkalla'}
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </section>
    </div>
  )
}
