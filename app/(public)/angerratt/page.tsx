import type { Metadata } from "next";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";

export const metadata: Metadata = {
  title: "Ångerrätt – Nordklart",
  description:
    "Information om ångerrätt för Nordklarts digitala tjänster och engångsköp.",
};

export default function AngerrattPage() {
  return (
    <MarketingInfoPage
      showLegalEntity
      eyebrow="Juridik"
      title="Ångerrätt"
      description="Här sammanfattas hur ångerrätt hanteras för Nordklarts digitala tjänster. Den avtalade versionen som accepteras vid köp eller teckning gäller alltid."
      sections={[
        {
          title: "Digital tjänst",
          body: "Nordklart levereras digitalt. För vissa flöden kan tjänsten börja användas direkt efter att konto skapats, betalning genomförts eller åtkomst aktiverats.",
          points: [
            "Tydlig information visas innan köp",
            "Åtkomst och leverans loggas",
            "Köpta exportpaket och utförda tjänster kan omfattas av särskilda villkor",
          ],
        },
        {
          title: "Bokslut engångsköp",
          body: "För bokslut som engångsköp ska kunden se vad som ingår, vilken period köpet gäller och hur åtkomst/export hanteras innan köpet bekräftas.",
        },
        {
          title: "Kontakt",
          body: "Kontakta Nordklart om du vill utöva ångerrätt eller har frågor om ett köp. Ange e-post, bolag och vilket köp frågan gäller.",
        },
      ]}
    />
  );
}
