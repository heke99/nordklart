import Link from 'next/link'
import { ArrowRight, Landmark, Receipt, ReceiptText, Upload, Wand2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'

const actions = [
  { href: '/invoices/new', title: 'Skapa första fakturan', description: 'Skicka en faktura direkt från Nordklart.', icon: Receipt },
  { href: '/bookkeeping', title: 'Bokför en verifikation', description: 'Börja manuellt med en säker verifikation.', icon: ReceiptText },
  { href: '/import?mode=sie', title: 'Importera SIE', description: 'Flytta in befintlig bokföring när det passar.', icon: Upload },
  { href: '/bank-automation', title: 'Koppla bank', description: 'Automatisera stegvis med banktransaktioner.', icon: Landmark },
  { href: '/onboarding/agent', title: 'Lägg till assistent', description: 'Valfritt stöd för bokföringsförslag.', icon: Wand2 },
]

export default function QuickStartPanel({ companyId: _companyId }: { companyId: string }) {
  return (
    <section className="rounded-[1.75rem] border bg-card p-5 shadow-sm md:p-7">
      <p className="text-sm font-medium text-primary">Kom igång</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Välj nästa steg när det passar dig</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Din arbetsyta är klar. Du behöver inte koppla bank eller aktivera fler tjänster för att börja bokföra.
      </p>
      <div className="mt-5 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map((action) => {
          const Icon = action.icon
          return (
            <Link key={action.href} href={action.href} className="group">
              <Card className="h-full transition hover:border-primary/50 hover:shadow-md">
                <CardContent className="p-4">
                  <Icon className="h-5 w-5 text-primary" />
                  <h2 className="mt-3 font-semibold">{action.title}</h2>
                  <p className="mt-1 text-sm leading-5 text-muted-foreground">{action.description}</p>
                  <span className="mt-4 flex items-center text-sm font-medium text-primary">
                    Öppna <ArrowRight className="ml-1.5 h-4 w-4 transition group-hover:translate-x-0.5" />
                  </span>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>
    </section>
  )
}
