'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { getYearEndApiErrorMessage } from '@/lib/year-end/api-error'
import { formatCurrency, formatDate } from '@/lib/utils'

/**
 * Lagerinventering vid bokslut. Statutory year-end surface (Swedish only).
 * Enter the counted inventory at anskaffningsvärde (FIFO) per account; the
 * lagerförändring is booked against the class-4 change account.
 */

interface InventoryAccount {
  account: string
  label: string
  change_account: string
  booked_balance: number
}

export function InventoryCountCard({ periodId, companyId }: { periodId: string; companyId: string | null }) {
  const { toast } = useToast()
  const [accounts, setAccounts] = useState<InventoryAccount[] | null>(null)
  const [balanceDate, setBalanceDate] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const suffix = companyId ? `?company_id=${encodeURIComponent(companyId)}` : ''
  const url = `/api/bookkeeping/fiscal-periods/${encodeURIComponent(periodId)}/inventory${suffix}`

  const load = useCallback(async () => {
    const response = await fetch(url)
    const body = await response.json().catch(() => null)
    if (response.ok) {
      setAccounts(body.data.accounts as InventoryAccount[])
      setBalanceDate(body.data.balance_date as string)
    }
  }, [url])

  useEffect(() => {
    const timer = setTimeout(() => void load(), 0)
    return () => clearTimeout(timer)
  }, [load])

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const counts = (accounts ?? [])
      .map((a) => {
        const cost = String(form.get(`cost-${a.account}`) ?? '').trim()
        if (!cost) return null
        const nrv = String(form.get(`nrv-${a.account}`) ?? '').trim()
        return {
          account: a.account,
          cost: Number(cost),
          net_realizable_value: nrv ? Number(nrv) : null,
          method: form.get(`alt-${a.account}`) ? 'alternative_97' : 'lowest_value',
        }
      })
      .filter((c) => c !== null)
    if (counts.length === 0) return
    setBusy(true)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ counts }),
      })
      const body = await response.json().catch(() => null)
      if (!response.ok) throw new Error(getYearEndApiErrorMessage(body, 'Lagerförändringen kunde inte bokföras.', response.status))
      toast({
        title: body.data.journal_entry ? 'Lagerförändring bokförd' : 'Ingen förändring',
        description: body.data.journal_entry ? 'Verifikationen är daterad på balansdagen.' : 'Bokfört lager stämmer redan med inventeringen.',
      })
      await load()
    } catch (error) {
      toast({ title: 'Kunde inte bokföra', description: error instanceof Error ? error.message : 'Okänt fel', variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Lagerinventering</CardTitle></CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm text-muted-foreground">
          Ange inventerat lager per {balanceDate ? formatDate(balanceDate) : 'balansdagen'} till anskaffningsvärde (först in, först ut).
          Lagret värderas till det lägsta av anskaffningsvärde och nettoförsäljningsvärde, eller till 97 % av anskaffningsvärdet
          (inkomstskattelagen 17 kap. 3–4 §§). Lämna tomt för konton utan lager.
        </p>
        {!accounts ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <form onSubmit={submit} className="space-y-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Konto</TableHead>
                  <TableHead className="text-right">Bokfört</TableHead>
                  <TableHead>Anskaffningsvärde</TableHead>
                  <TableHead>Nettoförsäljningsvärde</TableHead>
                  <TableHead>97 %-regeln</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.account}>
                    <TableCell>{a.account} {a.label}</TableCell>
                    <TableCell className="text-right tabular-nums">{formatCurrency(a.booked_balance)}</TableCell>
                    <TableCell>
                      <Label htmlFor={`cost-${a.account}`} className="sr-only">Anskaffningsvärde {a.account}</Label>
                      <Input id={`cost-${a.account}`} name={`cost-${a.account}`} type="number" min="0" step="0.01" />
                    </TableCell>
                    <TableCell>
                      <Label htmlFor={`nrv-${a.account}`} className="sr-only">Nettoförsäljningsvärde {a.account}</Label>
                      <Input id={`nrv-${a.account}`} name={`nrv-${a.account}`} type="number" min="0" step="0.01" />
                    </TableCell>
                    <TableCell>
                      <Checkbox
                        id={`alt-${a.account}`}
                        name={`alt-${a.account}`}
                        aria-label={`Värdera ${a.account} till 97 % av anskaffningsvärdet`}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <div className="flex justify-end">
              <Button disabled={busy} type="submit">Bokför lagerförändring</Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  )
}
