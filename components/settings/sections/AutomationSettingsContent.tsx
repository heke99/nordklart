'use client'

import { useEffect, useState } from 'react'
import { Loader2, ShieldCheck } from 'lucide-react'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'

// /settings/automation — the company's controlled-automation policy (Batch 11).
// Everything the bank automation engine consults lives here: modes,
// confidence thresholds, amount cap and per-domain allow flags. Only company
// admins/owners can save (enforced server-side via RLS + requireWrite);
// members see the current policy read-only through the same GET.

type AutomationMode = 'off' | 'suggest' | 'auto_safe' | 'auto_full'
type AfterSyncMode = 'off' | 'suggest_only' | 'process_pending' | 'auto_safe'

interface AutomationSettingsForm {
  bank_transaction_mode: AutomationMode
  invoice_payment_matching_mode: AutomationMode
  supplier_invoice_matching_mode: AutomationMode
  bank_import_after_sync_mode: AfterSyncMode
  min_auto_confidence: number
  min_suggestion_confidence: number
  max_auto_book_amount: number | null
  allow_auto_customer_invoice_settlement: boolean
  allow_auto_supplier_invoice_settlement: boolean
  allow_auto_bank_fee_booking: boolean
  allow_auto_category_booking: boolean
  allow_auto_tax_payment_booking: boolean
  allow_auto_salary_payment_booking: boolean
}

const MODE_OPTIONS: Array<{ value: AutomationMode; label: string; hint: string }> = [
  { value: 'off', label: 'Av', hint: 'Ingen automatik — allt hanteras manuellt.' },
  { value: 'suggest', label: 'Föreslå', hint: 'Automatiken lämnar förslag men bokför aldrig själv.' },
  {
    value: 'auto_safe',
    label: 'Auto (säker)',
    hint: 'Säkra, entydiga träffar bokförs automatiskt. Allt annat blir förslag.',
  },
  {
    value: 'auto_full',
    label: 'Auto (full)',
    hint: 'Som Auto (säker) men med lägre återhållsamhet. Kräver hög tillit till reglerna.',
  },
]

const AFTER_SYNC_OPTIONS: Array<{ value: AfterSyncMode; label: string; hint: string }> = [
  { value: 'off', label: 'Av', hint: 'Nya transaktioner utvärderas inte automatiskt.' },
  { value: 'suggest_only', label: 'Endast förslag', hint: 'Utvärdera och föreslå — aldrig bokföra.' },
  {
    value: 'process_pending',
    label: 'Skapa granskningar',
    hint: 'Utvärdera, föreslå och skapa väntande åtgärder — bokför inte.',
  },
  {
    value: 'auto_safe',
    label: 'Auto (säker)',
    hint: 'Säkra träffar bokförs direkt efter synk/import, resten blir granskningar.',
  },
]

const ALLOW_FLAGS: Array<{
  key: keyof Pick<
    AutomationSettingsForm,
    | 'allow_auto_customer_invoice_settlement'
    | 'allow_auto_supplier_invoice_settlement'
    | 'allow_auto_bank_fee_booking'
    | 'allow_auto_category_booking'
    | 'allow_auto_tax_payment_booking'
    | 'allow_auto_salary_payment_booking'
  >
  label: string
  hint: string
}> = [
  {
    key: 'allow_auto_customer_invoice_settlement',
    label: 'Kundfakturor',
    hint: 'Avräkna kundfakturor automatiskt vid exakt betalning med stark referens (OCR/fakturanummer).',
  },
  {
    key: 'allow_auto_supplier_invoice_settlement',
    label: 'Leverantörsfakturor',
    hint: 'Avräkna leverantörsbetalningar automatiskt. Avstängd som standard — aktivera medvetet.',
  },
  {
    key: 'allow_auto_bank_fee_booking',
    label: 'Bankavgifter',
    hint: 'Bokför små, tydliga bankavgifter automatiskt (6570).',
  },
  {
    key: 'allow_auto_category_booking',
    label: 'Kategoribokningar',
    hint: 'Bokför transaktioner automatiskt utifrån regler och motpartshistorik.',
  },
  {
    key: 'allow_auto_tax_payment_booking',
    label: 'Skattebetalningar',
    hint: 'Bokför inbetalningar till skattekontot (1630) automatiskt.',
  },
  {
    key: 'allow_auto_salary_payment_booking',
    label: 'Löneutbetalningar',
    hint: 'Koppla löneutbetalningar mot godkända lönekörningar automatiskt.',
  },
]

export function AutomationSettingsContent() {
  const { toast } = useToast()
  const [form, setForm] = useState<AutomationSettingsForm | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/automation/settings')
      .then(async (res) => ({ ok: res.ok, json: await res.json() }))
      .then(({ ok, json }) => {
        if (cancelled) return
        if (!ok) {
          toast({
            title: 'Kunde inte hämta automationsinställningar',
            description: json.error,
            variant: 'destructive',
          })
          return
        }
        const { defaults: _defaults, ...rest } = json.data as AutomationSettingsForm & {
          defaults: unknown
        }
        setForm(rest)
      })
      .catch(() => {
        if (!cancelled) {
          toast({ title: 'Kunde inte hämta automationsinställningar', variant: 'destructive' })
        }
      })
    return () => {
      cancelled = true
    }
  }, [toast])

  function update<K extends keyof AutomationSettingsForm>(
    key: K,
    value: AutomationSettingsForm[K],
  ) {
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev))
  }

  async function save() {
    if (!form) return
    setSaving(true)
    try {
      const res = await fetch('/api/automation/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      })
      const json = await res.json()
      if (!res.ok) {
        toast({ title: 'Kunde inte spara', description: json.error, variant: 'destructive' })
        return
      }
      toast({ title: 'Automationsinställningarna sparades' })
    } finally {
      setSaving(false)
    }
  }

  if (!form) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-muted-foreground" />
            Automationslägen
          </CardTitle>
          <CardDescription>
            Styr vad systemet får göra med nya banktransaktioner. Oavsett läge bokförs aldrig
            något automatiskt i stängda perioder, vid tvetydiga kandidater, vid oklar moms eller
            när en SIE-import överlappar perioden — sådana fall blir alltid granskningar.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <ModeField
            label="Banktransaktioner"
            hintPrefix="Kategorisering och bokföring av transaktioner."
            value={form.bank_transaction_mode}
            options={MODE_OPTIONS}
            onChange={(v) => update('bank_transaction_mode', v as AutomationMode)}
          />
          <ModeField
            label="Kundfakturamatchning"
            hintPrefix="Matchning av inbetalningar mot kundfakturor."
            value={form.invoice_payment_matching_mode}
            options={MODE_OPTIONS}
            onChange={(v) => update('invoice_payment_matching_mode', v as AutomationMode)}
          />
          <ModeField
            label="Leverantörsfakturamatchning"
            hintPrefix="Matchning av utbetalningar mot leverantörsfakturor."
            value={form.supplier_invoice_matching_mode}
            options={MODE_OPTIONS}
            onChange={(v) => update('supplier_invoice_matching_mode', v as AutomationMode)}
          />
          <ModeField
            label="Efter banksynk/import"
            hintPrefix="Vad som händer direkt när nya transaktioner kommer in."
            value={form.bank_import_after_sync_mode}
            options={AFTER_SYNC_OPTIONS}
            onChange={(v) => update('bank_import_after_sync_mode', v as AfterSyncMode)}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Trösklar och gränser</CardTitle>
          <CardDescription>
            Träffsäkerheten är automatikens egen bedömning (0–100 %). Under förslagsgränsen händer
            ingenting; mellan gränserna blir det förslag; över auto-gränsen kan bokning ske om
            läget och kategorin tillåter det.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="min-auto">Tröskel för auto-bokning (%)</Label>
            <Input
              id="min-auto"
              type="number"
              min={50}
              max={100}
              value={Math.round(form.min_auto_confidence * 100)}
              onChange={(e) =>
                update('min_auto_confidence', Math.min(100, Math.max(50, Number(e.target.value))) / 100)
              }
            />
            <p className="text-xs text-muted-foreground">Standard 95 %. Lägre än 50 % tillåts inte.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="min-suggest">Tröskel för förslag (%)</Label>
            <Input
              id="min-suggest"
              type="number"
              min={0}
              max={100}
              value={Math.round(form.min_suggestion_confidence * 100)}
              onChange={(e) =>
                update(
                  'min_suggestion_confidence',
                  Math.min(100, Math.max(0, Number(e.target.value))) / 100,
                )
              }
            />
            <p className="text-xs text-muted-foreground">Standard 70 %.</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="max-amount">Maxbelopp för auto-bokning (SEK)</Label>
            <Input
              id="max-amount"
              type="number"
              min={0}
              placeholder="Ingen gräns"
              value={form.max_auto_book_amount ?? ''}
              onChange={(e) =>
                update(
                  'max_auto_book_amount',
                  e.target.value === '' ? null : Math.max(1, Number(e.target.value)),
                )
              }
            />
            <p className="text-xs text-muted-foreground">
              Transaktioner över gränsen blir alltid förslag. Tomt = ingen gräns.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Vad får bokas automatiskt</CardTitle>
          <CardDescription>
            Även i auto-läge bokförs bara kategorier du uttryckligen tillåtit. Allt annat blir
            förslag eller väntande åtgärder.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {ALLOW_FLAGS.map((flag) => (
            <div key={flag.key} className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-medium">{flag.label}</p>
                <p className="text-xs text-muted-foreground">{flag.hint}</p>
              </div>
              <Switch
                checked={form[flag.key]}
                onCheckedChange={(checked) => update(flag.key, checked)}
                aria-label={flag.label}
              />
            </div>
          ))}
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button onClick={() => void save()} disabled={saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Spara inställningar
        </Button>
      </div>
    </div>
  )
}

function ModeField({
  label,
  hintPrefix,
  value,
  options,
  onChange,
}: {
  label: string
  hintPrefix: string
  value: string
  options: Array<{ value: string; label: string; hint: string }>
  onChange: (value: string) => void
}) {
  const selected = options.find((o) => o.value === value)
  return (
    <div className="grid gap-1.5 sm:grid-cols-[220px_1fr] sm:items-center">
      <Label>{label}</Label>
      <div className="space-y-1">
        <Select value={value} onValueChange={onChange}>
          <SelectTrigger className="w-full sm:w-64">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {hintPrefix} {selected?.hint}
        </p>
      </div>
    </div>
  )
}
