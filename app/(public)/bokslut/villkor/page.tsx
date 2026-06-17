import type { Metadata } from "next";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";

export const metadata: Metadata = {
  title: "Villkor för bokslut – Nordklart",
  description: "Villkor och omfattning för Nordklart bokslut som engångsköp.",
};

export default function BokslutVillkorPage() {
  return (
    <MarketingInfoPage
      eyebrow="Bokslut"
      title="Villkor för bokslut som engångsköp"
      description="Bokslut kan köpas separat utan månadsabonnemang. Villkoren beskriver åtkomst, underlag, kontroller och export för valt räkenskapsår."
      sections={[
        {
          title: "Vad köpet gäller",
          body: "Engångsköpet gäller ett valt bolag och räkenskapsår. Det ger åtkomst till bokslutskontroller, justeringsflöden, rapportpaket och export för perioden.",
          points: [
            "SIE-import eller befintlig bokföring",
            "Kontroller och avvikelselista",
            "Exportpaket när bokslutet är klart",
          ],
        },
        {
          title: "Kundens ansvar",
          body: "Kunden ansvarar för att bokföringsunderlag, importerad SIE-fil och bolagsuppgifter är korrekta. Nordklart hjälper till med struktur och kontroller men ändrar inte historisk bokföring tyst.",
        },
        {
          title: "Åtkomst och export",
          body: "Åtkomst kan vara tidsbegränsad eller permanent enligt köpvillkoren. Exportfiler och rapporter ska kunna laddas ner så länge åtkomsten gäller.",
        },
      ]}
    />
  );
}
