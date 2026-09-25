-- Booking a salary run is one transaction.
--
-- The book routes used to commit up to four verifikationer one at a time
-- (salary, arbetsgivaravgifter, semesteravsättning, pension) and only then
-- flip the run to 'booked'. A failure after the first commit left posted,
-- immutable vouchers behind a run that still said 'paid'; the retry posted
-- the salary a second time.
--
-- lib/salary/salary-entries.ts now creates all vouchers as drafts first and
-- calls book_salary_run(), which — under a row lock on the run — requires it
-- to be 'paid' and unbooked, commits every draft through
-- commit_journal_entry (voucher numbers, balance and period-lock triggers
-- unchanged) and links them to the run, all or nothing. On failure the
-- drafts are cancelled by the caller; nothing is posted.
--
-- pg-test: tests/pg/book-salary-run-atomic.pg.test.ts

BEGIN;

CREATE OR REPLACE FUNCTION public.book_salary_run(
  p_company_id uuid,
  p_run_id uuid,
  p_salary_entry_id uuid,
  p_avgifter_entry_id uuid,
  p_vacation_entry_id uuid,
  p_pension_entry_id uuid,
  p_booked_by uuid,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_run public.salary_runs%ROWTYPE;
  v_entry_id uuid;
BEGIN
  IF auth.uid() IS NOT NULL AND NOT public.user_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'write access required' USING ERRCODE = '42501';
  END IF;
  IF p_salary_entry_id IS NULL THEN
    RAISE EXCEPTION 'salary entry required' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_run FROM public.salary_runs
   WHERE id = p_run_id AND company_id = p_company_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'salary run not found' USING ERRCODE = 'P0002';
  END IF;
  IF v_run.status <> 'paid' OR v_run.salary_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'salary run is not awaiting booking (status %)', v_run.status USING ERRCODE = '55000';
  END IF;

  FOREACH v_entry_id IN ARRAY ARRAY[p_salary_entry_id, p_avgifter_entry_id, p_vacation_entry_id, p_pension_entry_id] LOOP
    CONTINUE WHEN v_entry_id IS NULL;
    IF NOT EXISTS (
      SELECT 1 FROM public.journal_entries je
       WHERE je.id = v_entry_id
         AND je.company_id = p_company_id
         AND je.status = 'draft'
         AND je.source_type = 'salary_payment'
         AND je.source_id = p_run_id
    ) THEN
      RAISE EXCEPTION 'voucher % is not a draft of salary run %', v_entry_id, p_run_id USING ERRCODE = '22023';
    END IF;
    PERFORM public.commit_journal_entry(p_company_id, v_entry_id, NULL, NULL, p_actor_type, p_actor_label);
  END LOOP;

  UPDATE public.salary_runs r
     SET status = 'booked',
         salary_entry_id = p_salary_entry_id,
         avgifter_entry_id = p_avgifter_entry_id,
         vacation_entry_id = p_vacation_entry_id,
         pension_entry_id = p_pension_entry_id,
         booked_at = now(),
         booked_by = p_booked_by
   WHERE r.id = p_run_id AND r.company_id = p_company_id
  RETURNING * INTO v_run;

  RETURN to_jsonb(v_run);
END;
$$;

REVOKE ALL ON FUNCTION public.book_salary_run(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_salary_run(uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text) TO authenticated, service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
