-- =============================================================================
-- Schablonintäkt på periodiseringsfonder: 100 % of statslåneräntan
--
-- 20260730170000 seeded schablonintakt_rate as statslåneräntan + 1
-- procentenhet (2,96 % for 2025, 3,55 % for 2026). That is the formula for
-- NEGATIVE räntefördelning, not for periodiseringsfonder. IL 30 kap. 6 a §:
-- the schablonintäkt is the funds at the start of the tax year times
-- statslåneräntan at the end of November the year before the tax year ends,
-- at least 0,5 %. Skatteverket's own worked example for 2025 is
-- 1,96 % × 400 000 = 7 840 kr, and the rate for tax years ending in 2026 is
-- 2,55 % (SLR 30 november 2025).
--
-- The overstatement flowed straight into INK2S 4.6a and the periodiseringsfond
-- cap, overtaxing every company carrying a fund by about 50 %.
--
-- Source: skatteverket.se → Periodiseringsfond (aktiebolag), checked 2026-09-24.
--
-- pg-test: covered-by tests/pg/year-end-rulesets.pg.test.ts
-- =============================================================================

BEGIN;

UPDATE public.year_end_rulesets
   SET schablonintakt_rate = 0.0196,
       version = 'se-ab-2025.2'
 WHERE tax_year = 2025;

UPDATE public.year_end_rulesets
   SET schablonintakt_rate = 0.0255,
       version = 'se-ab-2026.2'
 WHERE tax_year = 2026;

COMMIT;
