'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Loader2, UserPlus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'

const ROLE_OPTIONS = [
  { value: 'accountant', label: 'Redovisningskonsult', helper: 'Bokför och hanterar kundernas löpande arbete.' },
  { value: 'payroll', label: 'Lönekonsult', helper: 'Hanterar lönekörningar och AGI för kunderna.' },
  { value: 'reviewer', label: 'Granskare', helper: 'Granskar och godkänner utan skrivbehörighet i bokföringen.' },
  { value: 'read_only', label: 'Läsbehörighet', helper: 'Ser kundstatus utan att kunna ändra något.' },
  { value: 'agency_admin', label: 'Byråadministratör', helper: 'Hanterar medarbetare, kunder och byråns inställningar.' },
] as const

/** Invite a staff member to the agency via /api/agency/staff/invite. */
export function InviteStaffDialog({ agencyId }: { agencyId?: string }) {
  const router = useRouter()
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<string>('accountant')
  const [isSubmitting, setIsSubmitting] = useState(false)

  const selectedRole = ROLE_OPTIONS.find((option) => option.value === role)

  const submit = async () => {
    if (!email.trim() || isSubmitting) return
    setIsSubmitting(true)
    try {
      const response = await fetch('/api/agency/staff/invite', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          role,
          ...(agencyId ? { agency_id: agencyId } : {}),
        }),
      })
      const body = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: 'Inbjudan kunde inte skickas',
          description: body.error ?? 'Ett oväntat fel uppstod. Försök igen.',
          variant: 'destructive',
        })
        return
      }

      toast({
        title: 'Inbjudan skickad',
        description: `${email.trim()} har bjudits in till byrån.`,
      })
      setEmail('')
      setOpen(false)
      router.refresh()
    } catch {
      toast({
        title: 'Inbjudan kunde inte skickas',
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
        <Button variant="secondary">
          <UserPlus className="mr-2 h-4 w-4" />
          Bjud in medarbetare
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bjud in en byråmedarbetare</DialogTitle>
          <DialogDescription>
            Medarbetaren får en inbjudan via e-post och väljer själv lösenord vid första inloggningen.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="agency-invite-email">E-postadress</Label>
            <Input
              id="agency-invite-email"
              type="email"
              autoComplete="email"
              placeholder="namn@byran.se"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label>Roll</Label>
            <Select value={role} onValueChange={setRole}>
              <SelectTrigger>
                <SelectValue placeholder="Välj roll" />
              </SelectTrigger>
              <SelectContent>
                {ROLE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedRole ? (
              <p className="text-xs text-muted-foreground">{selectedRole.helper}</p>
            ) : null}
          </div>
          <Button className="w-full" onClick={submit} disabled={isSubmitting || !email.trim()}>
            {isSubmitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Skicka inbjudan
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
