import type { Metadata } from "next";
import { MarketingInfoPage } from "@/components/marketing/MarketingInfoPage";

export const metadata: Metadata = {
  title: "Systemdokumentation – Nordklart",
  description:
    "Systemdokumentation enligt bokföringslagen: hur Nordklart hanterar verifikationer, behandlingshistorik, automatisk bokföring, arkivering och säkerhet.",
};

/**
 * Public systemdokumentation page — the BFL 5 kap. 11 § description of how
 * the bookkeeping system works, plus the automation description and the
 * disclaimers for Skatteverket filing and BankID signing that the product
 * must never overstate.
 */
export default function SystemdokumentationPage() {
  return (
    <MarketingInfoPage
      eyebrow="Juridik & regelefterlevnad"
      title="Systemdokumentation"
      description="Bokföringslagen (1999:1078) kräver att det finns en beskrivning av bokföringssystemets organisation och uppbyggnad (5 kap. 11 §). Här beskrivs hur Nordklart uppfyller kraven."
      sections={[
        {
          title: "Verifikationer och verifikationskedja",
          body: "All bokföring sker med dubbel bokföring. Varje affärshändelse blir en verifikation med verifikationsnummerserie, löpnummer, verifikationsdatum, bokföringsdatum, beskrivning, källa och koppling till underlag.",
          points: [
            "Verifikationsnummer tilldelas atomiskt i obruten nummerserie per serie och räkenskapsår",
            "Bokförda verifikationer är oföränderliga — rättelse sker alltid genom rättelseverifikation (storno), aldrig genom ändring",
            "Luckor i nummerserien kräver dokumenterad förklaring (BFNAR 2013:2)",
            "Låsta perioder blockerar alla ändringar på databasnivå",
          ],
        },
        {
          title: "Behandlingshistorik",
          body: "Systemet för fullständig behandlingshistorik: vem som skapade, bokförde, rättade eller låste, när det skedde och vad som ändrades. Historiken är append-only och kan inte redigeras eller raderas.",
        },
        {
          title: "Automatisk bokföring — så fungerar den",
          body: "Nordklart kan föreslå och i vissa fall bokföra affärshändelser automatiskt (banktransaktioner, leverantörsfakturor, kvitton). Automatiken är regelstyrd och spårbar.",
          points: [
            "Varje förslag har en konfidensnivå och maskinläsbara orsakskoder som visar VARFÖR förslaget gavs",
            "Automatisk bokföring sker endast över den konfidensgräns företaget själv ställt in — allt annat hamnar i granskningskön",
            "Automatiskt bokförda verifikationer märks med systemet som avsändare och kan alltid granskas och rättas via storno",
            "Företaget kan stänga av automatisk bokföring helt eller per kategori i automationsinställningarna",
          ],
        },
        {
          title: "Arkivering och räkenskapsinformation",
          body: "Räkenskapsinformation bevaras i minst sju år (BFL 7 kap.). Ursprungliga underlag arkiveras oförändrade.",
          points: [
            "Underlagsdokument lagras med WORM-skydd — de kan inte ändras eller raderas när de kopplats till bokförd verifikation",
            "Exporterade betalfiler och mottagna e-fakturor bevaras som räkenskapsinformation",
            "SIE-export finns alltid, men utgör inte ensam ett komplett arkiv — dokumentunderlag exporteras separat via arkivexporten",
            "Säkerhetskopiering och återläsning finns dokumenterat för både molntjänsten och självhostad drift",
          ],
        },
        {
          title: "Friskrivning: Skatteverket",
          body: "Nordklart skapar underlag, validerar och kan ladda upp deklarationsutkast till Skatteverket där API-stöd finns. Nordklart lämnar ALDRIG in deklarationer för din räkning.",
          points: [
            "Inlämning och undertecknande sker alltid av behörig firmatecknare/ombud på Skatteverkets Mina sidor",
            "Statusen 'väntar på signering' i Nordklart betyder att du måste slutföra inlämningen hos Skatteverket",
            "Du ansvarar för att kontrollera underlaget innan inlämning",
          ],
        },
        {
          title: "Friskrivning: BankID-signering",
          body: "BankID används i Nordklart för identifiering och för att signera samtycken (t.ex. byrååtkomst, bankkoppling och finansieringsansökningar).",
          points: [
            "Signerade samtycken lagras med tidsstämpel, maskerat personnummer och signaturreferens och kan återkallas där det är rättsligt möjligt",
            "BankID-signering i Nordklart ersätter inte formkrav som gäller hos externa myndigheter eller motparter",
            "I produktionsmiljö krävs avtal med en BankID-ansluten identitetsleverantör",
          ],
        },
        {
          title: "Säkerhet",
          body: "Data skyddas med radnivåsäkerhet (RLS) per företag, krypterade integrationsuppgifter och fullständig granskningslogg.",
          points: [
            "API-nycklar lagras hashade och kan aldrig visas igen",
            "Integrationstokens och certifikat krypteras i vila",
            "Personnummer maskeras i gränssnitt och loggar",
            "Inloggning, signering, integrationsanslutningar, periodlåsningar och export av känsliga filer granskningsloggas",
          ],
        },
      ]}
    />
  );
}
