'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Building2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'

export type LinkableCompany = {
  id: string
  name: string
  orgNumber: string | null
}

/**
 * Link a client company to the agency via /api/agency/clients.
 *
 * Only companies the current user administers can be linked directly
 * (activating a link grants the whole agency access to the client's books,
 * so foreign companies require the client's own approval — enforced by RLS).
 */
export function AddClientDialog({
  agencyId,
  linkableCompanies,
}: {
  agencyId?: string
  linkableCompanies: LinkableCompany[]
}) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [companyId, setCompanyId] = useState<string>('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const submit = async () => {
    if (!companyId || isSubmitting) return
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/agency/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company_id: companyId,
          status: 'active',
          ...(agencyId ? { agency_id: agencyId } : {}),
        }),
      })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: 'Kundbolaget kunde inte kopplas',
          description: body.error ?? 'Ett oväntat fel uppstod. Försök igen.',
          variant: 'destructive',
        })
        return
      }

      toast({
        title: 'Kundbolag kopplat',
        description: 'Bolaget syns nu i byråns kundlista.',
      })
      setCompanyId('')
      setOpen(false)
      router.refresh()
    } catch {
      toast({
        title: 'Kundbolaget kunde inte kopplas',
        description: 'Ett oväntat fel uppstod. Försök igen.',
        variant: 'destructive',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button>
          <Building2 className="mr-2 h-4 w-4" />
          Koppla kundbolag
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Koppla ett kundbolag till byrån</DialogTitle>
          <DialogDescription>
            Välj ett bolag som du administrerar. Byråns medarbetare får då tillgång till kundens
            bokföring enligt sina byråroller.
          </DialogDescription>
        </DialogHeader>
        {linkableCompanies.length === 0 ? (
          <div className="rounded-2xl border bg-muted/40 p-4 text-sm text-muted-foreground">
            Du administrerar inga bolag som kan kopplas just nu. Skapa kundens arbetsyta först,
            eller be kundbolagets ägare att godkänna byråns åtkomst.
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Kundbolag</Label>
              <Select value={companyId} onValueChange={setCompanyId}>
                <SelectTrigger>
                  <SelectValue placeholder="Välj bolag" />
                </SelectTrigger>
                <SelectContent>
                  {linkableCompanies.map((company) => (
                    <SelectItem key={company.id} value={company.id}>
                      {company.name}
                      {company.orgNumber ? ` (${company.orgNumber})` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button className="w-full" onClick={submit} disabled={isSubmitting || !companyId}>
              {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Koppla bolaget
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
