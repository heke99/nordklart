# Nordklart Accounting Intelligence Core

Den här batchen gör bokföringsautomation säkrare genom att lägga ett regelnav mellan importerat underlag och faktisk verifikation.

## Grundprincip

```text
AI/OCR tolkar underlag
→ accounting rule engine klassificerar affärshändelsen
→ användaren/byrån kan ändra
→ riskändringar varnas och loggas
→ låsta perioder rättas med spårbar korrigering
```

AI får alltså hjälpa till med tolkning, men regelmotorn äger beslutet om konto, moms, avdrag, tillgång/review och krav på underlag.

## Nya koddelar

- `lib/accounting-rules/rule-engine.ts` — samlad beslutsmotor.
- `lib/accounting-rules/deductibility-engine.ts` — avdrag, privat/blandad användning, representation och risk.
- `lib/accounting-rules/asset-classification-engine.ts` — direktavdrag kontra anläggningstillgång.
- `lib/accounting-rules/vat-deduction-engine.ts` — momsbehandling och momsavdragsprocent.
- `lib/bokslut/assets/property-rules.ts` — fastighet/byggnad/mark/K3-komponentregler.
- `app/api/accounting-rules/evaluate` — utvärdera och valfritt spara regelbeslut.
- `app/api/accounting-rules/overrides` — spara manuell ändring med risknivå och kommentar.

## Fastighet och avskrivning

Fastighet får inte längre behandlas som vanlig inventarie utan kontroll. Vid byggnad används `building_value` som avskrivningsbas och `land_value` lämnas utanför avskrivningen. K3-byggnad kräver komponentanalys.

Viktiga fält på `assets`:

- `asset_subtype`
- `property_kind`
- `land_value`
- `building_value`
- `tax_depreciation_rate`
- `accounting_depreciation_rate`
- `accounting_depreciation_model`
- `business_use_percentage`
- `private_use_percentage`

## Direktavdrag och inventarier

Regelmotorn känner till 2026 års gräns för inventarier av mindre värde: 29 600 kr exklusive moms. Den tar också hänsyn till `naturalBundleTotalExVat`, så dator + skärm + docka inte bedöms fel var för sig när de hör ihop.

## Manuell ändring

Manuell ändring är tillåten, men ska gå via override-flödet:

- låg risk: konto/beskrivning/projekt
- medel risk: moms/konto som påverkar rapport
- hög risk: privat kostnad, representation, bil, fastighet, direktavdrag över gräns
- låst period: ska hanteras som rättelse/korrigering, inte tyst ändring

Alla ändringar sparas i `accounting_manual_overrides`.

## Review queue

Beslut med `warning`, `danger` eller `blocking` kan läggas i `accounting_review_queue`. Det gör att bokföringsförslag som ser automatiska ut men kräver bedömning inte tappas.

## Feature policy

`assets.*` och `accounting_rules.*` är kopplade till `bookkeeping.core` via `lib/platform/feature-policy.ts`. Scriptet `npm run check:feature-policy` söker efter skyddade API-routes utan server-side feature gate.
