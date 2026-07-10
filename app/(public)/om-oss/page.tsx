import type { Metadata } from 'next'
import { Building2, Layers3, ShieldCheck } from 'lucide-react'
import { MarketingInfoPage } from '@/components/marketing/MarketingInfoPage'
import {
  NORDKLART_LEGAL_DISCLOSURE,
  NORDKLART_LEGAL_NAME,
  NORDKLART_ORG_NUMBER,
} from '@/lib/branding/legal-identity'

export const metadata: Metadata = {
  title: 'Om Nordklart och Gridex El AB',
  description:
    'Nordklart är ett digitalt system för bokföring, fakturor och bokslut som tillhandahålls av Gridex El AB, org.nr 559416-7149.',
}

export default function OmOssPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Om oss"
      title="Nordklart är systemet. Gridex El AB är bolaget bakom tjänsten."
      description={NORDKLART_LEGAL_DISCLOSURE}
      highlights={[
        'Nordklart är produkt- och systemnamnet',
        `${NORDKLART_LEGAL_NAME} är avtalspart`,
        `Organisationsnummer ${NORDKLART_ORG_NUMBER}`,
        'Svensk digital ekonomitjänst',
      ]}
      sections={[
        {
          title: 'En tydlig produktidentitet',
          body: 'Nordklart är namnet på den digitala tjänsten och plattformen för bokföring, fakturering, rapportering och bokslut. Namnet används i produkten, på webbplatsen och i kommunikationen med användare.',
          points: [
            'Nordklart är inte ett separat aktiebolag',
            'Konton och arbetsytor skapas i Nordklart-systemet',
            'Produktens support och kommunikation kan använda nordklart.se',
          ],
        },
        {
          title: 'Bolaget bakom Nordklart',
          body: `${NORDKLART_LEGAL_NAME}, org.nr ${NORDKLART_ORG_NUMBER}, tillhandahåller Nordklart och är den juridiska avtalsparten för tjänsten om inget annat uttryckligen anges i ett särskilt avtal.`,
          points: [
            'Avtal och betalningar kopplas till Gridex El AB',
            'Gridex El AB anges som ansvarigt bolag i juridiska texter',
            'Personuppgiftsroller framgår i integritetspolicy och personuppgiftsbiträdesavtal',
          ],
        },
        {
          title: 'Vad systemet hjälper till med',
          body: 'Nordklart samlar centrala ekonomiflöden i en gemensam arbetsyta och hjälper företag och redovisningsbyråer att arbeta mer strukturerat och med mindre manuell administration.',
          points: [
            'Bokföring och verifikationsförslag',
            'Fakturor, betalstatus och kundreskontra',
            'Rapporter, moms och bokslutsunderlag',
            'Behörighetsstyrda arbetsytor för företag och byråer',
          ],
        },
        {
          title: 'Ansvar och transparens',
          body: 'Vi skiljer tydligt mellan produktnamnet Nordklart och den juridiska personen Gridex El AB. Det ska vara enkelt för kunder att förstå vem som levererar tjänsten, vem som är avtalspart och vart frågor ska riktas.',
          points: [
            'Tydlig bolagsinformation i sidfot och juridiska sidor',
            'Spårbara system- och bokföringsflöden',
            'Roll- och abonnemangsstyrd åtkomst',
          ],
        },
      ]}
    >
      <section className="px-5 pb-16 md:px-8">
        <div className="mx-auto grid max-w-5xl gap-5 md:grid-cols-3">
          {[
            { icon: Layers3, title: 'Produkten', body: 'Nordklart är namnet på systemet och användarupplevelsen.' },
            { icon: Building2, title: 'Bolaget', body: `${NORDKLART_LEGAL_NAME} är den juridiska leverantören.` },
            { icon: ShieldCheck, title: 'Avtalet', body: 'Villkor och personuppgiftsansvar anger rätt juridisk part.' },
          ].map(({ icon: Icon, title, body }) => (
            <article key={title} className="rounded-[2rem] border border-border bg-card/90 p-6 shadow-sm">
              <Icon className="h-6 w-6 text-primary" aria-hidden="true" />
              <h2 className="mt-5 text-xl font-semibold">{title}</h2>
              <p className="mt-3 leading-7 text-muted-foreground">{body}</p>
            </article>
          ))}
        </div>
      </section>
    </MarketingInfoPage>
  )
}
