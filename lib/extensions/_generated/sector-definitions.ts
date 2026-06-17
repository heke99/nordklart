// AUTO-GENERATED — do not edit. Run `npm run setup:extensions` to regenerate.
import type { ExtensionDefinition } from '../types'

export const EXTENSION_DEFINITIONS: Record<string, ExtensionDefinition[]> = {
  'general': [
      {
          "slug": "enable-banking",
          "sector": "general",
          "name": "Bankintegration (PSD2)",
          "category": "import",
          "icon": "Landmark",
          "dataPattern": "manual",
          "hasOwnData": true,
          "description": "Automatisk banktransaktionssynk via PSD2",
          "longDescription": "Koppla ditt bankkonto direkt och synka transaktioner automatiskt via säker PSD2-bankintegration. Stöder de flesta svenska banker.",
          "subscriptionNotice": "Denna integration kräver ett aktivt Enable Banking-abonnemang. Utan abonnemang kommer bankintegration inte att fungera."
      },
      {
          "slug": "email",
          "sector": "general",
          "name": "E-post (Resend)",
          "category": "operations",
          "icon": "Mail",
          "dataPattern": "core",
          "readsCoreTables": [
              "invoices",
              "customers",
              "company_settings"
          ],
          "description": "Skicka fakturor och påminnelser via e-post",
          "longDescription": "Aktiverar e-postfunktioner: skicka fakturor till kunder, automatiska betalningspåminnelser (15/30/45 dagar), och e-postmeddelanden. Kräver ett Resend-konto med verifierad domän."
      },
      {
          "slug": "nordklart-migration",
          "sector": "general",
          "name": "Systemmigration",
          "category": "import",
          "icon": "ArrowRightLeft",
          "dataPattern": "manual",
          "hasOwnData": false,
          "description": "Migrera bokföring från Fortnox, Visma, Bokio, Björn Lundén eller Briox",
          "longDescription": "Flytta all bokföringsdata från ditt gamla system till nordklart. Importerar kontoplan, verifikationer, kunder, leverantörer och öppna fakturor automatiskt via säker API-integration direkt med leverantören."
      },
      {
          "slug": "tic",
          "sector": "general",
          "name": "Bolagsuppgifter",
          "category": "import",
          "icon": "Building2",
          "dataPattern": "manual",
          "hasOwnData": true,
          "description": "Hämta företagsinformation automatiskt vid registrering",
          "longDescription": "Fyll i företagsuppgifter automatiskt genom att ange organisationsnummer. Hämtar adress, momsregistrering, F-skattestatus och bankuppgifter från offentliga register via TIC.",
          "quickAction": {
              "label": "Företagsprofil",
              "description": "Visa offentliga uppgifter",
              "icon": "Building2",
              "href": "/e/general/tic",
              "order": 10
          }
      },
      {
          "slug": "mcp-server",
          "sector": "general",
          "name": "MCP-server (API)",
          "category": "operations",
          "icon": "Terminal",
          "dataPattern": "manual",
          "hasOwnData": false,
          "description": "Gör bokföring via Claude, Cursor eller annan MCP-klient",
          "longDescription": "Exponerar nordklarts bokföringsmotor som MCP-verktyg (Model Context Protocol). Koppla din MCP-klient med en API-nyckel och gör bokföring genom konversation: visa okategoriserade transaktioner, bokför dem, skapa fakturor."
      },
      {
          "slug": "cloud-backup",
          "sector": "general",
          "name": "Molnsynkronisering",
          "category": "operations",
          "icon": "Cloud",
          "dataPattern": "manual",
          "hasOwnData": true,
          "description": "Synka säkerhetsbackup till din egen molnlagring",
          "longDescription": "Koppla ditt Google Drive-konto och ladda upp en fullständig säkerhetsbackup med ett klick. Nordklart skapar en ZIP med SIE-filer, kvitton och behandlingshistorik och laddar upp till en egen mapp i din Drive. Perfekt för att uppfylla egna krav på redundans.",
          "subscriptionNotice": "Kräver ett Google-konto. Uppladdningar sker direkt till din Drive — ingen data lagras hos tredje part utöver Google."
      },
      {
          "slug": "skatteverket",
          "sector": "general",
          "name": "Skatteverket Integration",
          "category": "operations",
          "icon": "FileCheck",
          "dataPattern": "core",
          "description": "Skicka momsdeklaration direkt till Skatteverket via BankID.",
          "longDescription": "Anslut till Skatteverket med BankID och skicka din momsdeklaration direkt från nordklart. Spara utkast, validera, lås och signera — utan att lämna appen."
      },
      {
          "slug": "invoice-inbox",
          "sector": "general",
          "name": "Dokumentinkorg",
          "category": "import",
          "icon": "Inbox",
          "dataPattern": "both",
          "hasOwnData": true,
          "readsCoreTables": [
              "document_attachments",
              "suppliers"
          ],
          "description": "Vidarebefordra leverantörsfakturor till en unik adress – dokumenten landar här med extraherade fält",
          "longDescription": "Varje bolag får en unik fakturainkorg-adress. Fakturor som skickas dit fångas automatiskt och fält som org.nr, OCR, bankgiro, belopp och förfallodatum extraheras deterministiskt från PDF-texten. Inga AI-anrop, inga molntjänster utöver Resend för e-postmottagning."
      },
      {
          "slug": "document-extraction",
          "sector": "general",
          "name": "AI-extrahering av underlag",
          "category": "accounting",
          "icon": "MessageCircle",
          "dataPattern": "both",
          "hasOwnData": false,
          "readsCoreTables": [
              "document_attachments",
              "invoice_inbox_items"
          ],
          "description": "Läser kvitton och fakturor med AI och fyller i leverantör, belopp, moms och datum automatiskt",
          "longDescription": "Lyssnar på document.uploaded-händelser och kör Sonnet 4.6 via AWS Bedrock på varje uppladdat kvitto eller faktura (PDF eller bild). De extraherade fälten skrivs till document_attachments.extracted_data så att den specialiserade bokföringsassistenten kan föreslå rätt BAS-konto utan att fråga användaren om sådant som redan står på underlaget. Hoppar över dokument som redan extraherats av andra extensions (t.ex. invoice-inbox) för att undvika dubbla AI-anrop."
      }
  ],
}
