import Link from 'next/link'
import { ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'

export const dynamic = 'force-dynamic'

export default function ExpensesPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Utlägg"
        description="Registrera kvitton som ägare eller anställd har betalat privat. Under huven bokförs utlägget direkt mot rätt ägarkonto och underlaget länkas till verifikationen."
        action={<Button asChild><Link href="/supplier-invoices/new?paid_with_private_funds=true"><ReceiptText className="mr-2 h-4 w-4" />Nytt utlägg</Link></Button>}
      />
      <div className="rounded-3xl border bg-card p-6 shadow-sm">
        <h2 className="text-xl font-semibold">Så fungerar utlägg</h2>
        <div className="mt-4 grid gap-4 md:grid-cols-3">
          <Info title="1. Lägg upp underlag" body="Ladda upp kvitto eller välj ett tolkat underlag från inkorgen." />
          <Info title="2. Bokför som privat betalt" body="Aktiebolag bokas mot 2893 och enskild firma mot 2018." />
          <Info title="3. Kontrollera kopplingen" body="Bolagskortets bokföringskontroll visar om underlag, verifikation eller betalningsrad saknas." />
        </div>
        <div className="mt-5 flex flex-wrap gap-3">
          <Button asChild><Link href="/supplier-invoices/new?paid_with_private_funds=true">Registrera utlägg</Link></Button>
          <Button asChild variant="secondary"><Link href="/supplier-invoices?status=paid">Se bokförda utlägg och kostnader</Link></Button>
        </div>
      </div>
    </div>
  )
}

function Info({ title, body }: { title: string; body: string }) {
  return <div className="rounded-2xl border bg-background/60 p-4"><h3 className="font-semibold">{title}</h3><p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p></div>
}
