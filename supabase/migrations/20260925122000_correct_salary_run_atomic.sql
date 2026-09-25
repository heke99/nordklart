-- Correcting a booked salary run is one transaction.
--
-- app/api/salary/runs/[id]/correct reversed each voucher of the run in its
-- own call, then flipped the run to 'corrected' without checking the result,
-- then created the correction run and copied employees and line items one
-- row at a time, ignoring errors. A failure part-way left half the vouchers
-- reversed, or a 'corrected' run with no replacement, or a replacement with
-- only some employees.
--
-- correct_salary_run() does all of it under a row lock on the original run:
-- storno of every voucher through reverse_journal_entry_v2 (the same atomic
-- storno every other flow uses; BFL 5 kap. 5 §), the status flip, the new
-- draft run (is_correction, corrects_run_id) and a copy of every employee
-- row and line item. Service role only, like reverse_journal_entry_v2; the
-- actor's write access is re-checked inside.
--
-- pg-test: tests/pg/correct-salary-run-atomic.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.correct_salary_run(
  p_company_id uuid,
  p_actor_user_id uuid,
  p_run_id uuid,
  p_reversal_plans jsonb,
  p_reversal_date date
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_access record;
  v_run public.salary_runs%ROWTYPE;
  v_new public.salary_runs%ROWTYPE;
  v_entry_id uuid;
  v_status text;
  v_reversed integer := 0;
BEGIN
  PERFORM public.require_service_role();

  SELECT * INTO v_access FROM public.resolve_company_access_for_user(p_actor_user_id, p_company_id);
  IF NOT FOUND OR NOT coalesce(v_access.can_write, false) THEN
    RAISE EXCEPTION 'Actor cannot write this company.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_run FROM public.salary_runs
   WHERE id = p_run_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status <> 'booked' THEN
    RAISE EXCEPTION 'only a booked salary run can be corrected (status %)', v_run.status USING ERRCODE = '55000';
  END IF;

  FOREACH v_entry_id IN ARRAY ARRAY[v_run.salary_entry_id, v_run.avgifter_entry_id, v_run.vacation_entry_id, v_run.pension_entry_id] LOOP
    CONTINUE WHEN v_entry_id IS NULL;
    SELECT status INTO v_status FROM public.journal_entries WHERE id = v_entry_id AND company_id = p_company_id;
    CONTINUE WHEN v_status = 'reversed';
    IF p_reversal_plans->(v_entry_id::text) IS NULL THEN
      RAISE EXCEPTION 'no storno plan for voucher %', v_entry_id USING ERRCODE = '22023';
    END IF;
    PERFORM public.reverse_journal_entry_v2(
      p_company_id, p_actor_user_id, v_entry_id, p_reversal_plans->(v_entry_id::text), p_reversal_date, NULL, NULL
    );
    v_reversed := v_reversed + 1;
  END LOOP;

  UPDATE public.salary_runs SET status = 'corrected' WHERE id = v_run.id;

  INSERT INTO public.salary_runs (
    company_id, user_id, period_year, period_month, payment_date, voucher_series,
    is_correction, corrects_run_id, notes
  ) VALUES (
    p_company_id, p_actor_user_id, v_run.period_year, v_run.period_month, v_run.payment_date, v_run.voucher_series,
    true, v_run.id,
    format('Korrigering av lönekörning %s-%s', v_run.period_year, lpad(v_run.period_month::text, 2, '0'))
  )
  RETURNING * INTO v_new;

  WITH src AS (
    SELECT s.*, gen_random_uuid() AS new_id
      FROM public.salary_run_employees s
     WHERE s.salary_run_id = v_run.id AND s.company_id = p_company_id
  ), ins AS (
    INSERT INTO public.salary_run_employees (
      id, salary_run_id, employee_id, company_id, employment_degree, monthly_salary,
      salary_type, hours_worked, tax_table_number, tax_column
    )
    SELECT new_id, v_new.id, employee_id, p_company_id, employment_degree, monthly_salary,
           salary_type, hours_worked, tax_table_number, tax_column
      FROM src
    RETURNING id
  )
  INSERT INTO public.salary_line_items (
    salary_run_employee_id, company_id, item_type, description, quantity, unit_price, amount,
    is_taxable, is_avgift_basis, is_vacation_basis, is_gross_deduction, is_net_deduction,
    account_number, sort_order, source_benefit_id
  )
  SELECT src.new_id, p_company_id, li.item_type, li.description, li.quantity, li.unit_price, li.amount,
         li.is_taxable, li.is_avgift_basis, li.is_vacation_basis, li.is_gross_deduction, li.is_net_deduction,
         li.account_number, li.sort_order, li.source_benefit_id
    FROM src
    JOIN public.salary_line_items li ON li.salary_run_employee_id = src.id
   WHERE EXISTS (SELECT 1 FROM ins WHERE ins.id = src.new_id);

  RETURN jsonb_build_object('correction_run', to_jsonb(v_new), 'reversed_entry_count', v_reversed);
END;
$$;

REVOKE ALL ON FUNCTION public.correct_salary_run(uuid, uuid, uuid, jsonb, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.correct_salary_run(uuid, uuid, uuid, jsonb, date) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
