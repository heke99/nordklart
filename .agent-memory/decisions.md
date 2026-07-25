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

