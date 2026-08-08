# Aktiva beslut

## 2026-07-25 — Auktoritativ featureåtkomst

`company_feature_access` och `checkFeatureAccess` är sanningskällor. Sidor får
inte härleda åtkomst enbart från aktiv plan.

## 2026-07-25 — Full Access och Bankgiro

Kompletterande Full Access ger katalogens normala features men Bankgiro förblir
ett separat tillägg.

## 2026-07-25 — Tekniskt fel är inte produktavslag

RPC-/databasfel klassificeras som `database_error`; de får inte omvandlas till
`missing_entitlement` eller uppgraderings-CTA.

## 2026-07-25 — Periodbundet bokslutsköp

Ett giltigt engångsköp för exakt räkenskapsperiod kan ge bokslutsåtkomst även om
företagets feature-resolver misslyckas.


## 2026-08-07 — H-03 betalningsatomicitet: design och kvarvarande steg

### Kartlagd call graph (verifierad, inga andra flöden)

Kund: `markInvoicePaid()` i `lib/invoices/mark-paid-service.ts`, 6 call sites
(4 routes + 2 i `lib/pending-operations/commit.ts`).
Leverantör: `settleSupplierInvoiceAtomic()` i `lib/supplier-invoices/mark-paid-service.ts`,
4 call sites. Det finns **inget** parallellt legacy-betalningsflöde.

Kedjan i dag:

    route → service → get_financial_operation_result (replay)
          → createDraftEntry()            ← ENDA steget utanför transaktionen
          → settle_customer_invoice(...)  ← allt annat, en transaktion
          → compensating cancel av draften om RPC:n failar

`settle_customer_invoice` är i övrigt välbyggd: `require_service_role()`,
advisory lock på (company:invoice) och (company:idempotency:key), `FOR UPDATE`
på idempotensrad och faktura, valutakontroll, `p_expected_remaining_amount`-
racekontroll, commit av verifikatet, betalningsrad, aggregat, outbox, audit.

### Beslut: skicka rader som data, skapa verifikatet i RPC:n

Radgenereringen är TS-domänlogik i fyra grenar (custom lines, överbetalning →
kundtillgodo, kontantmetod, normal betalning) och får **inte** reimplementeras i
PL/pgSQL — det skulle skapa dubbel domänsanning, vilket projektets regler
förbjuder.

Rätt lösning:

1. Exponera en `plan`-variant av `createInvoicePaymentJournalEntry()` och
   `createInvoiceCashEntry()` som returnerar `CreateJournalEntryInput` i stället
   för att persistera. De persisterande wrapparna behålls för övriga anropare.
2. `markInvoicePaid()` bygger planen för alla fyra grenar — inga skrivningar.
3. Ny RPC `settle_customer_invoice_v2(..., p_journal jsonb)` som skapar
   journal_entries + journal_entry_lines från planen och sedan kör exakt samma
   sekvens som i dag. `p_draft_journal_entry_id` utgår.
4. Motsvarande för leverantör.
5. Kompenserande cleanup får finnas kvar som defense-in-depth men är då inte
   längre den primära garantin.

Efter detta finns inget ekonomiskt objekt före RPC:n och därmed inget tredje
tillstånd.

### Status

Ej implementerat. Blockerande fynd som åtgärdades först: båda settlement-RPC:erna
committade med `commit_method` som deras egen CHECK-constraint förbjöd, så
**varje** kund- och leverantörsbetalning failade i produktion (20260807180000).
Den buggen låg dold eftersom pg-real bara körde rollback-vägen; happy path testas
nu i `settlement-atomicity.pg.test.ts`.
