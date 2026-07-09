'use client'

import Link from 'next/link'
import { ArrowRight, FileText, Landmark, Receipt, ReceiptText, Upload, Wand2 } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { useCanWrite } from '@/lib/hooks/use-can-write'

const actions = [
  { href: '/invoices/new', title: 'Skapa första fakturan', description: 'Börja sälja direkt. Bank och SIE kan kopplas senare.', icon: Receipt, requiresWrite: true },
  { href: '/bookkeeping', title: 'Bokför en verifikation', description: 'Skapa en manuell verifikation utan att importera något först.', icon: ReceiptText, requiresWrite: true },
  { href: '/import?mode=sie', title: 'Importera SIE', description: 'Flytta in historik från ett annat system när du vill.', icon: Upload, requiresWrite: true },
  { href: '/import', title: 'Importera underlag', description: 'Ladda upp kvitton, filer eller bankunderlag manuellt.', icon: FileText, requiresWrite: true },
  { href: '/bank-automation', title: 'Koppla bank', description: 'Valfritt steg för automatisk import av transaktioner.', icon: Landmark, requiresWrite: true },
  { href: '/onboarding/agent', title: 'Lägg till assistent', description: 'Valfritt stöd för förslag, regler och återkommande bokföring.', icon: Wand2, requiresWrite: true },
]

export default function QuickStartPanel({ companyId: _companyId }: { companyId: string }) {
  const { canWrite } = useCanWrite()

  // Viewers get a read-only welcome — every quick-start action mutates data
  // (create invoice, import, connect bank), so showing them would only lead
  // to 403s.
  if (!canWrite) {
    return (
      <section className="rounded-[1.75rem] border bg-card p-5 shadow-sm md:p-7">
        <p className="text-sm font-medium text-primary">Översikt</p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">Välkommen</h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Du har läsbehörighet i det här företaget. Bokföring, rapporter och fakturor visas här så snart företaget har aktivitet.
        </p>
      </section>
    )
  }

  return (
    <section className="rounded-[1.75rem] border bg-card p-5 shadow-sm md:p-7">
      <p className="text-sm font-medium text-primary">Översikt</p>
      <h1 className="mt-1 text-2xl font-semibold tracking-tight">Din dashboard är klar</h1>
      <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
        Du kan börja använda Nordklart direkt. Bankkoppling, SIE-import, Skatteverket och assistent är valfria steg som kan göras från dashboarden när det passar.
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
