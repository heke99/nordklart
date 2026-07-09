import type { Metadata } from "next";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";

export const metadata: Metadata = {
  title: "Prisvillkor – Nordklart",
  description:
    "Prisvillkor för Nordklarts abonnemang, tilläggstjänster och engångsköp: fakturering, prisändringar, uppgradering, nedgradering och uppsägning.",
};

export default function PrisvillkorPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Juridik"
      title="Prisvillkor"
      description="Dessa villkor beskriver hur priser, betalning och ändringar av abonnemang fungerar i Nordklart. Den version som accepteras vid teckning gäller alltid."
      sections={[
        {
          title: "Abonnemang och betalning",
          body: "Abonnemang tecknas per företag och faktureras i förskott per månad eller år via vår betalleverantör (Stripe). Priser anges exklusive moms om inget annat sägs.",
          points: [
            "Betalning sker med kort eller faktura enligt vald plan",
            "Kvitton och betalningshistorik finns i kontoinställningarna",
            "Utebliven betalning kan efter påminnelse leda till begränsad funktionalitet",
          ],
        },
        {
          title: "Uppgradering, nedgradering och uppsägning",
          body: "Planbyte kan göras när som helst. Uppgraderingar aktiveras direkt och prisjusteras proportionellt. Nedgraderingar och uppsägningar gäller från nästa betalperiod.",
          points: [
            "Uppsägning görs i inställningarna eller via kundportalen — ingen bindningstid utöver innevarande period",
            "Vid uppsägning behåller du läsåtkomst till din bokföring enligt arkiveringsvillkoren",
            "Bokföringsdata kan alltid exporteras (SIE med flera format) före och efter uppsägning",
          ],
        },
        {
          title: "Tilläggstjänster och engångsköp",
          body: "Vissa funktioner säljs som tillägg (t.ex. Bankgiro-hantering) eller engångsköp (t.ex. bokslutspaket). Vad som ingår, pris och period visas alltid innan köpet bekräftas.",
        },
        {
          title: "Prisändringar",
          body: "Prisändringar meddelas minst 30 dagar i förväg och gäller från nästa betalperiod. Vid prishöjning kan du säga upp abonnemanget innan ändringen träder i kraft.",
        },
        {
          title: "Byråer",
          body: "Redovisningsbyråer har separata byråvillkor med klientbaserad prissättning. Kontakta oss för byråavtal.",
        },
        {
          title: "Externa avtal ingår inte",
          body: "Vissa integrationer kräver egna avtal med tredje part som inte ingår i Nordklart-abonnemanget och betalas separat till respektive leverantör.",
          points: [
            "Bankgiro/Autogiro tecknas via din bank",
            "Peppol e-faktura i produktion kräver avtal med en accesspunkt",
            "Fakturafinansiering kräver avtal med finansieringspartnern",
          ],
        },
      ]}
    />
  );
}
