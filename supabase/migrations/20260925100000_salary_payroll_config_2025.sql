-- Payroll configuration for inkomstår 2025, so salary runs and corrections
-- with a 2025 payment date do not fail with "configuration not found".
-- Sources (checked 2026-09-25): Skatteverket "Belopp och procentsatser för
-- inkomstår 2025", "Arbetsgivaravgifter", "Traktamenten", "Bilförmån";
-- Försäkringskassan (SGI-tak 10 PBB). No youth reduction exists in 2025.
INSERT INTO public.salary_payroll_config (
  config_year,
  avgifter_total, avgifter_alderspension, avgifter_sjukforsakring,
  avgifter_foraldraforsakring, avgifter_efterlevandepension,
  avgifter_arbetsmarknad, avgifter_arbetsskada, avgifter_allman_loneavgift,
  avgifter_reduced_65plus, avgifter_youth_rate, avgifter_youth_salary_cap,
  avgifter_vaxa_stod_rate, avgifter_vaxa_stod_cap, avgifter_minimum_annual,
  egenavgifter_total, slp_rate,
  prisbasbelopp, inkomstbasbelopp, max_pgi, sgi_ceiling, statlig_skatt_brytpunkt,
  traktamente_heldag, traktamente_halvdag, traktamente_natt,
  milersattning_egen_bil, milersattning_formansbil_fossil, milersattning_formansbil_el,
  kostforman_heldag, kostforman_lunch, kostforman_frukost,
  friskvard_cap, bilforman_slr,
  sjuklon_rate, karensavdrag_factor, max_karensavdrag_per_year,
  reduced_avgift_age
) VALUES (
  2025,
  0.3142, 0.1021, 0.0355,
  0.0200, 0.0030,
  0.0264, 0.0010, 0.1262,
  0.1021, NULL, NULL,
  0.1021, 35000, 1000,
  0.2897, 0.2426,
  58800, 80600, 604500, 588000, 643100,
  290, 145, 145,
  25, 12, 9.50,
  300, 120, 60,
  5000, 0.0196,
  0.80, 0.20, 10,
  67
)
ON CONFLICT (config_year) DO NOTHING;
