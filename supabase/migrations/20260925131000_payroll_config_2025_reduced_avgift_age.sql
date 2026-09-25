-- salary_payroll_config 2025: the reduced arbetsgivaravgift (only
-- ålderspensionsavgift, 10,21 %) applied to employees who at the start of 2025
-- had turned 66 — born 1938–1958 (Skatteverket, "Belopp och procentsatser för
-- inkomståret 2025"). 20260925100000 seeded 67, the 2026 age, so an employee
-- born 1958 was charged the full 31,42 % on 2025 pay. From 2026 the age is 67
-- (still born 1938–1958), which the 2026 row already has.
--
-- lib/salary/personnummer.ts calculateAgeAtYearStart() now counts the age by
-- birth year alone, the way Skatteverket draws these tiers.
--
-- pg-test: tests/pg/salary-payroll-config.pg.test.ts

BEGIN;

UPDATE public.salary_payroll_config
   SET reduced_avgift_age = 66
 WHERE config_year = 2025
   AND reduced_avgift_age <> 66;

COMMIT;
