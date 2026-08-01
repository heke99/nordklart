# Verifierad systeminventering – Nordklart produktionshärdning

Datum: 2026-08-01

Denna inventering är baserad på det uppladdade repot och genomfördes före och under implementationen. Den är avsiktligt avgränsad till de ekonomiska kärnflöden som berörs av patchen.

## Verifierade huvudmodeller

- Huvudbok: `journal_entries`, `journal_entry_lines`.
- Kundreskontra: `invoices`, `invoice_items`, `invoice_payments`, kundkreditmodeller och betalningskopplingar.
- Leverantörsreskontra: `supplier_invoices`, `supplier_invoice_items`, `supplier_invoice_payments`.
- Bank: `transactions`, bankmatchningar och kopplingar via `transaction_id`/verifikationsreferenser.
- Perioder och bokslut: `fiscal_periods`, year-end runs/previews/readiness, bokslutsjusteringar och nästa periods ingående balans.
- Engångsköp: checkout-/purchasemodeller, feature access och Stripe webhook-logg.
- Årsredovisning: `annual_report_versions` och snapshot/finaliseringsmigreringar, inklusive senaste verifierade migration `20260731171000_annual_report_finalization_and_controlled_reopen.sql`.

## Verifierade ekonomiska write-paths före patch

### Kundbetalning

Följande ytor gjorde tidigare flera oberoende Supabase-skrivningar:

- `app/api/invoices/[id]/mark-paid/route.ts`
- `app/api/v1/companies/[companyId]/invoices/[id]/mark-paid/route.ts`
- `app/api/transactions/[id]/match-invoice/route.ts`
- `app/api/v1/companies/[companyId]/transactions/[id]/match-invoice/route.ts`
- pending-operation-kommittering i `lib/pending-operations/commit.ts`

Det tidigare flödet kunde skapa en bokförd verifikation och därefter misslyckas med betalningsrad, fakturastatus eller banklänk. Vissa fel returnerades som varningar trots att reskontran inte var komplett.

### Leverantörsbetalning

Motsvarande risk fanns i:

- `app/api/supplier-invoices/[id]/mark-paid/route.ts`
- `app/api/v1/companies/[companyId]/supplier-invoices/[id]/mark-paid/route.ts`
- `app/api/transactions/[id]/match-supplier-invoice/route.ts`
- `app/api/v1/companies/[companyId]/transactions/[id]/match-supplier-invoice/route.ts`

Legacyflödet försökte i vissa races kompensera genom att sätta redan bokförda verifikationer till `cancelled`.

## Verifierade migreringsproblem

Repot innehåller 426 migrationsfiler efter patchen. Två äldre versionsnummer förekommer dubbelt:

- `20260629120000`
  - `20260629120000_accounting_intelligence_core.sql`
  - `20260629120000_opendataloader_ocr_foundation_and_founder_access.sql`
- `20260704120000`
  - `20260704120000_nordklart_sync_hardening_patch.sql`
  - `20260704120000_skatteverket_sysorg_api_contract.sql`

Filerna har inte döpts om eller raderats. De är markerade som `reconciliation-required` i manifest/ordningsdokument eftersom faktisk produktionshistorik måste jämföras före en framåtriktad reconciliation.

## Verifierade befintliga styrkor

- Bokslutsmotorn har redan advisory locks, readiness, preview-/ledger-hashar, failure-recording och kontroll av nästa period/IB i flera centrala delar.
- Årsredovisningsfinalisering och snapshotmodell finns redan.
- RLS, company-context, request-ID, audit/outbox och service-role-mönster finns och har återanvänts.
- Det finns pg-real-projekt och tester för bokslut, RLS och ekonomiska kontrakt, men de kunde inte köras i den här exekveringsmiljön.

## Kvarvarande legacy-/specialflöden som inte ska betraktas som atomiserade av denna patch

Följande kategorier kräver fortsatt separat implementation eller pg-real-verifiering:

- atomisk registrering av leverantörsfaktura och leverantörskredit;
- samtliga historiska AR/AP-settlementflöden efter SIE;
- append-only import av historiska bankkontoutdrag;
- samtliga voucher-link/reconciliation-specialverktyg;
- full atomisering av generell bankkategorisering;
- komplett moms-, periodiserings- och anläggningstillgångsmatris;
- full fresh-install/upgrade-schemajämförelse mot riktig PostgreSQL.
