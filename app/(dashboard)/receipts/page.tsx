import Link from 'next/link'
import { FileText, ReceiptText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/page-header'

export const dynamic = 'force-dynamic'

export default function ReceiptsPage() {
  return (
    <div className="space-y-6">
      <PageHeader
        title="Kvitton"
        description="Samla kvitton, tolka dem och skapa bokföring med spårbar koppling mellan underlag och verifikation."
        action={<Button asChild><Link href="/documents"><ReceiptText className="mr-2 h-4 w-4" />Ladda upp kvitto</Link></Button>}
      />
      <div className="grid gap-4 md:grid-cols-3">
        <Info title="Inkorg" body="Uppladdade kvitton tolkas och hamnar i inkorgen för granskning innan bokföring." href="/documents" cta="Öppna underlag" />
        <Info title="Privat betalt" body="Kvitton som betalats privat skapas som utlägg och bokförs direkt mot rätt ägarkonto." href="/expenses/new" cta="Skapa utlägg" />
        <Info title="Kontroll" body="Superadmin kan se om kvittot saknar verifikation, dokumentlänk eller bankmatchning." href="/platform/companies" cta="Öppna bolagskontroll" />
      </div>
      <div className="rounded-3xl border bg-card p-6 shadow-sm">
        <div className="flex items-start gap-3"><FileText className="mt-1 h-5 w-5 text-primary" /><div><h2 className="text-xl font-semibold">Produktregel</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">Kvitton, utlägg och leverantörsfakturor använder samma bokföringsmotor. Skillnaden ligger i UI, standardvärden och kontrollstatus — inte i separata bokföringsregler.</p></div></div>
      </div>
    </div>
  )
}

function Info({ title, body, href, cta }: { title: string; body: string; href: string; cta: string }) {
  return <div className="rounded-3xl border bg-card p-5 shadow-sm"><h2 className="text-xl font-semibold">{title}</h2><p className="mt-2 text-sm leading-6 text-muted-foreground">{body}</p><Button asChild size="sm" variant="secondary" className="mt-5"><Link href={href}>{cta}</Link></Button></div>
}
