-- Salary runs: one transaction per write phase.
--
-- 1. create_salary_run_with_employees(): the run, one salary_run_employees
--    row per active employee whose employment overlaps the period, and the
--    base salary line. Previously lib/salary/create-run.ts inserted the run
--    and then two rows per employee in separate requests (2N+2 round trips)
--    with a best-effort compensating delete.
--
-- 2. persist_salary_run_calculation(): everything "Beräkna" writes — for each
--    employee the derived line items (hours, absence, benefits, OB/övertid,
--    semesterersättning) are replaced and the per-employee snapshot updated,
--    then the run totals and calculation_params. Previously ~10 separate
--    writes per employee; a failure half-way left some employees recalculated
--    and others not, with run totals from a previous calculation. Now it is
--    all or nothing, and only while the run is still 'draft' (row-locked, so
--    a concurrent approve cannot interleave).
--
-- Both are SECURITY INVOKER: RLS on every table still applies to the caller,
-- and each also requires user_can_write_company() for authenticated callers.
--
-- pg-test: tests/pg/salary-run-atomic-writes.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.create_salary_run_with_employees(
  p_company_id uuid,
  p_user_id uuid,
  p_period_year integer,
  p_period_month integer,
  p_payment_date date
)
RETURNS TABLE (run jsonb, employee_count integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.salary_runs%ROWTYPE;
  v_period_start date := make_date(p_period_year, p_period_month, 1);
  v_period_end date := (make_date(p_period_year, p_period_month, 1) + interval '1 month - 1 day')::date;
  v_count integer;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'write access required' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.salary_runs (company_id, user_id, period_year, period_month, payment_date)
  VALUES (p_company_id, p_user_id, p_period_year, p_period_month, p_payment_date)
  RETURNING * INTO v_run;

  WITH eligible AS (
    SELECT e.*
      FROM public.employees e
     WHERE e.company_id = p_company_id
       AND e.is_active
       AND (e.employment_start IS NULL OR e.employment_start <= v_period_end)
       AND (e.employment_end IS NULL OR e.employment_end >= v_period_start)
  ), sre AS (
    INSERT INTO public.salary_run_employees (
      salary_run_id, employee_id, company_id, employment_degree, monthly_salary,
      salary_type, tax_table_number, tax_column
    )
    SELECT v_run.id, e.id, p_company_id, e.employment_degree, coalesce(e.monthly_salary, 0),
           e.salary_type, e.tax_table_number, e.tax_column
      FROM eligible e
    RETURNING id, employee_id
  )
  INSERT INTO public.salary_line_items (
    salary_run_employee_id, company_id, item_type, description, amount,
    is_taxable, is_avgift_basis, is_vacation_basis, account_number, sort_order
  )
  SELECT s.id, p_company_id,
         CASE WHEN e.salary_type = 'monthly' THEN 'monthly_salary' ELSE 'hourly_salary' END,
         CASE WHEN e.salary_type = 'monthly' THEN 'Grundlön' ELSE 'Timlön' END,
         CASE WHEN e.salary_type = 'monthly'
              THEN round(coalesce(e.monthly_salary, 0) * e.employment_degree / 100.0, 2)
              ELSE 0 END,
         true, true, true,
         -- lib/salary/account-mapping.ts getLineItemAccount(): 7210 löner till
         -- tjänstemän, 7220 löner till företagsledare, 7240 styrelsearvoden.
         CASE e.employment_type WHEN 'company_owner' THEN '7220' WHEN 'board_member' THEN '7240' ELSE '7210' END,
         0
    FROM sre s
    JOIN public.employees e ON e.id = s.employee_id;

  SELECT count(*)::integer INTO v_count
    FROM public.salary_run_employees
   WHERE salary_run_id = v_run.id;

  RETURN QUERY SELECT to_jsonb(v_run), v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.create_salary_run_with_employees(uuid, uuid, integer, integer, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_salary_run_with_employees(uuid, uuid, integer, integer, date) TO authenticated, service_role;


CREATE OR REPLACE FUNCTION public.persist_salary_run_calculation(
  p_company_id uuid,
  p_run_id uuid,
  p_employees jsonb,
  p_totals jsonb,
  p_calculation_params jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.salary_runs%ROWTYPE;
  v_emp jsonb;
  v_sre_id uuid;
  v_upd public.salary_run_employees%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'write access required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.salary_runs
   WHERE id = p_run_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status <> 'draft' THEN
    RAISE EXCEPTION 'salary run is not a draft (status %)', v_run.status USING ERRCODE = '55000';
  END IF;

  FOR v_emp IN SELECT * FROM jsonb_array_elements(coalesce(p_employees, '[]'::jsonb)) LOOP
    v_sre_id := (v_emp->>'salary_run_employee_id')::uuid;

    IF NOT EXISTS (
      SELECT 1 FROM public.salary_run_employees
       WHERE id = v_sre_id AND salary_run_id = p_run_id AND company_id = p_company_id
    ) THEN
      RAISE EXCEPTION 'employee % is not on salary run %', v_sre_id, p_run_id USING ERRCODE = '22023';
    END IF;

    -- Replace every derived line item type the calculation owns.
    DELETE FROM public.salary_line_items li
     WHERE li.salary_run_employee_id = v_sre_id
       AND li.company_id = p_company_id
       AND (
         li.item_type IN (SELECT jsonb_array_elements_text(coalesce(v_emp->'replace_item_types', '[]'::jsonb)))
         OR ((v_emp->>'replace_benefit_rows')::boolean IS TRUE AND li.source_benefit_id IS NOT NULL)
       );

    INSERT INTO public.salary_line_items (
      salary_run_employee_id, company_id, item_type, description, quantity, amount,
      is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction,
      account_number, sort_order, source_benefit_id
    )
    SELECT v_sre_id, p_company_id, r.item_type, r.description, r.quantity, r.amount,
           coalesce(r.is_taxable, true), coalesce(r.is_avgift_basis, true), coalesce(r.is_vacation_basis, true),
           coalesce(r.is_gross_deduction, false), coalesce(r.is_net_deduction, false),
           r.account_number, coalesce(r.sort_order, 0), r.source_benefit_id
      FROM jsonb_populate_recordset(NULL::public.salary_line_items, coalesce(v_emp->'insert_lines', '[]'::jsonb)) r;

    -- Keys absent from the payload keep their current value.
    SELECT * INTO v_upd FROM public.salary_run_employees WHERE id = v_sre_id;
    v_upd := jsonb_populate_record(v_upd, coalesce(v_emp->'update', '{}'::jsonb));
    UPDATE public.salary_run_employees s
       SET hours_worked = v_upd.hours_worked,
           gross_salary = v_upd.gross_salary,
           gross_deductions = v_upd.gross_deductions,
           benefit_values = v_upd.benefit_values,
           taxable_income = v_upd.taxable_income,
           tax_withheld = v_upd.tax_withheld,
           net_deductions = v_upd.net_deductions,
           net_salary = v_upd.net_salary,
           avgifter_rate = v_upd.avgifter_rate,
           avgifter_amount = v_upd.avgifter_amount,
           avgifter_basis = v_upd.avgifter_basis,
           avgifter_category = v_upd.avgifter_category,
           vacation_accrual = v_upd.vacation_accrual,
           vacation_accrual_avgifter = v_upd.vacation_accrual_avgifter,
           tax_table_number = v_upd.tax_table_number,
           tax_column = v_upd.tax_column,
           tax_table_year = v_upd.tax_table_year,
           sick_days = v_upd.sick_days,
           vab_days = v_upd.vab_days,
           parental_days = v_upd.parental_days,
           vacation_days_taken = v_upd.vacation_days_taken,
           calculation_breakdown = v_upd.calculation_breakdown,
           ytd_gross = v_upd.ytd_gross,
           ytd_tax = v_upd.ytd_tax,
           ytd_net = v_upd.ytd_net
     WHERE s.id = v_sre_id AND s.company_id = p_company_id;
  END LOOP;

  UPDATE public.salary_runs r
     SET total_gross = coalesce((p_totals->>'total_gross')::numeric, r.total_gross),
         total_tax = coalesce((p_totals->>'total_tax')::numeric, r.total_tax),
         total_net = coalesce((p_totals->>'total_net')::numeric, r.total_net),
         total_avgifter = coalesce((p_totals->>'total_avgifter')::numeric, r.total_avgifter),
         total_vacation_accrual = coalesce((p_totals->>'total_vacation_accrual')::numeric, r.total_vacation_accrual),
         total_employer_cost = coalesce((p_totals->>'total_employer_cost')::numeric, r.total_employer_cost),
         calculation_params = coalesce(p_calculation_params, r.calculation_params)
   WHERE r.id = p_run_id AND r.company_id = p_company_id
  RETURNING * INTO v_run;

  RETURN to_jsonb(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.persist_salary_run_calculation(uuid, uuid, jsonb, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_salary_run_calculation(uuid, uuid, jsonb, jsonb, jsonb) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
