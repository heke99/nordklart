# Systemdokumentation

**Mall for användare av nordklart**
Upprättad i enlighet med 5 kap. 11 § BFL och BFNAR 2013:2 kapitel 9

---

## Instruktioner

Varje bokföringsskyldig ska upprätta en systemdokumentation som beskriver bokföringssystemets organisation och uppbyggnad. Dokumentationen ska göra det möjligt att utan svårighet överblicka systemet och förstå hur bokföringen är organiserad (BFNAR 2013:2 punkt 9.1).

Denna mall är förifylld med uppgifter som gäller för nordklart. Avsnitt markerade med hakparenteser ska anpassas till ditt företags förhållanden. Radera denna instruktionssektion innan du arkiverar dokumentet.

Systemdokumentationen ska förvaras tillsammans med övrig räkenskapsinformation under hela arkiveringsperioden (7 år).

---

## 1. Företagsuppgifter

| Fält | Uppgift |
|---|---|
| Företagsnamn | [FÖRETAGSNAMN] |
| Organisationsnummer | [ORG-NR] |
| Företagsform | [ ] Enskild firma  [ ] Aktiebolag |
| Räkenskapsår | [STARTMÅNAD] - [SLUTMÅNAD] |
| Tillämpat K-regelverk | [ ] K1 (förenklat årsbokslut, EF under 3 MSEK)  [ ] K2 (årsredovisning, mindre AB)  [ ] K3 (årsredovisning, huvudregelverk) |

## 2. Bokföringsprogram

| Fält | Uppgift |
|---|---|
| Programnamn | nordklart |
| Version | [ANGE VERSION, t.ex. 1.0] |
| Leverantör | [BOLAGSNAMN], org.nr [ORG-NR] |
| Webbplats | [DOMÄN] |
| Typ | Molnbaserad SaaS-tjänst (webbläsarbaserad) |
| Databasplattform | PostgreSQL via Supabase (AWS, EU-region) |
| Autentisering | Magic link via e-post (lösenordsfri) |

## 3. Kontoplan (BFNAR 2013:2 punkt 9.2)

3.1. Kontoplanen bygger på BAS-kontoplanen (BAS 2025/2026) utgiven av BAS-intressenternas Förening.

3.2. Kontona är indelade i klasser enligt BAS-standard:

| Klass | Beskrivning | Exempel på konton |
|---|---|---|
| 1 | Tillgångar | 1510 Kundfordringar, 1930 Företagskonto |
| 2 | Eget kapital och skulder | 2013 Egna uttag (EF), 2440 Leverantörsskulder, 2611-2631 Utgående moms, 2641 Ingående moms |
| 3 | Intäkter | 3001 Försäljning 25%, 3002 Försäljning 12%, 3003 Försäljning 6%, 3305 Exportförsäljning |
| 4-7 | Kostnader | Konfigureras efter verksamhet |
| 8 | Finansiella poster och skatt | Konfigureras efter verksamhet |

3.3. Kontoplanen kan ses och exporteras i nordklart under Inställningar > Kontoplan.

3.4. Företagsspecifika anpassningar av kontoplanen:
[BESKRIV EVENTUELLA TILLAGDA ELLER BORTTAGNA KONTON, t.ex. "Konto 4010 Inköp varor, 5010 Lokalhyra har lagts till. Inga standardkonton har tagits bort."]

## 4. Samlingsplan (BFNAR 2013:2 punkt 9.3-9.5)

Samlingsplanen beskriver hur bokföringen är organiserad i form av delsystem, grundbokföring och huvudbokföring.

### 4.1 Översikt

```
Affärshändelse
    |
    v
Verifikation skapas (manuellt eller automatiskt)
    |
    v
Journalpost registreras (grundbokföring, registreringsordning)
    |
    v
Konteras på BAS-konton (huvudbokföring, systematisk ordning)
    |
    v
Status: Utkast (draft)
    |
    v
Bekräftas av användaren
    |
    v
Status: Bokförd (posted), verifikationsnummer tilldelas
```

### 4.2 Grundbokföring (registreringsordning)

Samtliga affärshändelser registreras kronologiskt i nordklart journalen. Varje post innehåller:
- Verifikationsnummer (sekventiellt, tilldelat automatiskt vid bokföring)
- Registreringsdatum (datum då posten skapades i systemet)
- Bokföringsdatum (datum för affärshändelsen)
- Beskrivning
- Konteringsrader med konto, debet, kredit

Grundbokföringen kan visas under Bokföring > Journal i nordklart.

### 4.3 Huvudbokföring (systematisk ordning)

Huvudbokföringen presenterar affärshändelserna sorterade per konto. Varje konto visar ingående saldo, periodens transaktioner och utgående saldo.

Huvudbokföringen kan visas och exporteras under Rapporter > Huvudbok i nordklart.

### 4.4 Delsystem

Följande delsystem matar journalen:

| Delsystem | Beskrivning | Automatisk kontering |
|---|---|---|
| Kundfakturering | Utgående fakturor med per-rad momssats | Debet 1510, kredit 30xx + 26xx |
| Kundbetalningar | Inbetalningar mot fakturor | Debet 1930, kredit 1510 |
| Leverantörsfakturor | Inkommande fakturor, registrering och betalning | Debet kostnadskonto + 2641, kredit 2440 |
| Leverantörsbetalningar | Utbetalningar mot leverantörsfakturor | Debet 2440, kredit 1930 |
| Banktransaktioner | Synkroniserade via PSD2 (Enable Banking) | Kontering via kategoriseringsregler |
| Kvittohantering | OCR-bearbetade kvitton | Kontering efter granskning |
| Kreditnotor | Kreditering av utgående fakturor | Omvänd kontering av originalfaktura |

### 4.5 Avstämningsordning

Bankkonto 1930 avstäms via nordklart bankavstämningsmodul (4-stegs matchning: exakt belopp+datum, referensmatchning, datumintervall, fuzzy-matchning).

## 5. Verifikationer (BFNAR 2013:2 punkt 9.6-9.8)

### 5.1 Verifikationsnumrering

Verifikationsnummer tilldelas sekventiellt av systemet vid bokföring. Numreringen är unik per räkenskapsår och användare. Numren tilldelas via databas-RPC (concurrent-safe) och kan inte sättas manuellt.

En enda verifikationsnummerserie används: [A1, A2, A3, ...].

[OM FÖRETAGET ANVÄNDER FLERA SERIER, BESKRIV HÄR.]

### 5.2 Verifikationens innehåll

Varje verifikation i nordklart innehåller:
- Verifikationsnummer
- Bokföringsdatum (affärshändelsens datum)
- Registreringsdatum (datum då posten skapades)
- Beskrivning av affärshändelsen
- Konteringsrader (konto, debet, kredit)
- Referens till underlag (bifogat dokument, fakturanummer, etc.)
- Status (utkast / bokförd / reverserad)
- Vid rättelse: referens till reverserad/reverserande verifikation

### 5.3 Underlag

Underlag kopplas till verifikationer som bifogade dokument (PDF, bild). Dokumenten lagras i nordklart dokumentarkiv med SHA-256 checksumma for integritetskontroll.

Typer av underlag:
- Kundfakturor (genererade i systemet)
- Leverantörsfakturor (uppladdade)
- Kvitton (fotograferade/skannade)
- Bankbekräftelser (synkroniserade)
- Övriga avtal och dokument (uppladdade)

## 6. Rättelser (BFNAR 2013:2 punkt 9.9)

6.1. Bokförda verifikationer (status: posted) kan inte ändras eller raderas. Detta upprätthålls av databastriggrar i enlighet med bokföringslagens krav på oföränderlighet.

6.2. Rättelse sker genom stornobokning: en ny verifikation skapas som reverserar den felaktiga posten (byter debet/kredit). Den nya verifikationen länkas till originalet via referens (reverses_id / reversed_by_id).

6.3. Därefter skapas en ny korrekt verifikation vid behov.

6.4. Rättelseverifikationen innehåller uppgift om vilken verifikation som rättats, när rättelsen gjordes, och vem som utförde rättelsen (BFNAR 2013:2 punkt 2.17).

## 7. Periodavstängning

7.1. Räkenskapsperioder kan stängas (låsas) i nordklart. En låst period tillåter inte nya bokföringsposter. Periodlåsning upprätthålls av databastriggrar (enforce_period_lock).

7.2. Årsbokslut registreras som bokföringsposter i systemet.

## 8. Momshantering

8.1. Följande momssatser hanteras:

| Momssats | Beskrivning | Utgående moms-konto | Ingående moms-konto |
|---|---|---|---|
| 25 % | Standardsats | 2611 | 2641 |
| 12 % | Reducerad (livsmedel, hotell m.m.) | 2621 | 2641 |
| 6 % | Reducerad (böcker, tidningar, kultur m.m.) | 2631 | 2641 |
| 0 % (export) | Varuexport utanför EU | - | 2641 |
| 0 % (omvänd skattskyldighet) | Försäljning med omvänd skattskyldighet | - | 2641/2645 |
| Momsfri | Undantagna transaktioner | - | - |

*Notering: Livsmedel sänks till 6 % från 1 april 2026 t.o.m. 31 december 2027.*

8.2. Fakturor stödjer blandade momssatser (per fakturarad).

8.3. Momsrapport genereras under Rapporter > Momsdeklaration och mappas till Skatteverkets rutor.

## 9. Behandlingshistorik (BFNAR 2013:2 punkt 9.16)

9.1. nordklart registrerar automatiskt en behandlingshistorik som inkluderar:
- Registreringsdatum och tidpunkt for varje journalpost
- Tidpunkt för statusändring (utkast till bokförd)
- Vem som utförde bokningen (användar-ID kopplat till e-postadress)
- Stornobokningar med referens till originalverifikation
- Tidpunkt och utförare av periodlåsning

9.2. Behandlingshistoriken genereras automatiskt av systemet och kan inte ändras av användaren.

9.3. Behandlingshistoriken kan exporteras under Rapporter > Audit trail.

## 10. Import och export

| Funktion | Format | Beskrivning |
|---|---|---|
| SIE-import | SIE4 | Import av bokföringsdata från annat system |
| Bankfil-import | CSV (10 svenska bankformat) | Import av banktransaktioner |
| SIE-export | SIE4 | Export av komplett bokföring per räkenskapsår |
| Huvudbok | PDF/skärm | Export av huvudbok |
| Resultaträkning | PDF/skärm | Export av resultaträkning |
| Balansräkning | PDF/skärm | Export av balansräkning |
| Momsdeklaration | PDF/skärm | Underlag för momsdeklaration |
| SRU-export | SRU | Export for inkomstdeklaration |
| NE-bilaga | PDF/skärm | Bilaga till inkomstdeklaration (EF) |
| Verifikationsunderlag | PDF/bild | Nedladdning av bifogade dokument |

## 11. Integrationer

| Integration | Beskrivning | Dataflöde |
|---|---|---|
| Enable Banking (PSD2) | Bankkontosynkronisering | Bank -> nordklart (läsning av transaktioner och saldon) |
| Anthropic API | AI-kategorisering av transaktioner, OCR | nordklart -> Anthropic -> nordklart (transaktionsdata skickas, kategoriseringsförslag returneras) |
| OpenAI API | Embeddingar for likhetsmatchning | nordklart -> OpenAI -> nordklart (transaktionsbeskrivningar skickas, vektorer returneras) |
| Resend | E-postutskick | nordklart -> Resend -> mottagare (fakturor, påminnelser) |

[ANGE YTTERLIGARE INTEGRATIONER OM TILLÄMPLIGT]

## 12. Behörigheter och åtkomstkontroll

12.1. Varje konto i nordklart är isolerat via Row Level Security (RLS) i databasen. En användare kan enbart se och redigera sin egen data.

12.2. Nuvarande behörighetsstruktur:

| Roll | Beskrivning |
|---|---|
| Kontoägare | Full åtkomst till all data och funktionalitet |

[OM YTTERLIGARE ROLLER FINNS, BESKRIV HÄR]

12.3. Ansvarig for att tilldela och granska behörigheter: [NAMN]

## 13. Uppdatering av systemdokumentationen

Systemdokumentationen ska uppdateras vid:
- Byte eller uppgradering av bokföringsprogram
- Ändringar i kontoplan
- Ändringar i momshantering
- Nya integrationer eller delsystem
- Minst en gång per räkenskapsår

| Datum | Ändring | Utförd av |
|---|---|---|
| [DATUM] | Första version upprättad | [NAMN] |
| | | |

---

*Denna systemdokumentation uppfyller kraven i 5 kap. 11 § BFL och BFNAR 2013:2 kapitel 9 (punkterna 9.1-9.16) samt Exempel 9.1-9.4 i vägledningen. Anpassa innehållet till ditt företags specifika förhållanden.*
