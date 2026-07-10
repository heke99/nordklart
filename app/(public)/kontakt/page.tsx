import type { Metadata } from 'next'
import Link from 'next/link'
import { Mail, Phone } from 'lucide-react'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'
import { marketingPrimaryCta, marketingSecondaryCta } from '@/components/marketing/MarketingChrome'

export const metadata: Metadata = {
  title: 'Kontakta Nordklart',
  description: 'Kontakta Nordklart om bokföring, bokslut, Bankgiro eller byråupplägg.',
}

export default function KontaktPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Kontakt"
      title="Berätta vad du behöver hjälp med."
      description="Oavsett om du vill börja bokföra, göra ett fristående bokslut, ansöka om Bankgiro eller prata byråupplägg kan du kontakta Nordklart här. Tjänsten tillhandahålls av Gridex El AB."
      highlights={['Bokföring', 'Enbart bokslut', 'Bankgiro via partner', 'Byrå och allt i ett']}
    >
      <section className="px-5 pb-16 md:px-8">
        <div className="mx-auto grid max-w-5xl gap-5 md:grid-cols-2">
          <a href="mailto:hej@nordklart.se" className="rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm transition hover:-translate-y-1 hover:shadow-md">
            <Mail className="mb-5 h-6 w-6 text-primary" aria-hidden="true" />
            <h2 className="text-2xl font-semibold">Mejla oss</h2>
            <p className="mt-3 leading-7 text-muted-foreground">hej@nordklart.se</p>
          </a>
          <div className="rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm">
            <Phone className="mb-5 h-6 w-6 text-primary" aria-hidden="true" />
            <h2 className="text-2xl font-semibold">Boka genomgång</h2>
            <p className="mt-3 leading-7 text-muted-foreground">Vi går igenom bokföring, bokslut, Bankgiro eller byråbehov och visar rätt väg.</p>
            <Link href="/boka-demo" className={`${marketingPrimaryCta} mt-5`}>Boka demo</Link>
          </div>
        </div>
        <div className="mx-auto mt-8 flex max-w-5xl flex-col gap-3 sm:flex-row">
          <Link href="/register?intent=year-end" className={marketingSecondaryCta}>Gör bokslut</Link>
          <Link href="/register?intent=bankgiro" className={marketingSecondaryCta}>Ansök om Bankgiro</Link>
        </div>
      </section>
    </MarketingInfoPage>
  )
}
