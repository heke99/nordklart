DO $nk_deploy$
DECLARE
  v_file       text := '20260821150000_fix_shared_annual_report_audit_trigger.sql';
  v_file_sha   text := '5d2fb71e4268339b816b4edbf6d05044a33e2ab011a40252f5c8d0a6c8f35951';
  v_exec_sha   text := '5a5aa8b2d611e5327704e0980e9cdd72356a8e3ddf6be3814a0ce2b7c413c742';
  v_chunks     integer := 1;
  v_staged     integer;
  v_sql        text;
  v_exec       text;
  v_actual     text;
BEGIN
  SELECT count(*), string_agg(body, '' ORDER BY idx)
    INTO v_staged, v_sql
    FROM public.nordklart_deploy_staging
   WHERE file = v_file;

  IF v_staged <> v_chunks THEN
    RAISE EXCEPTION 'staged % chunk(s), expected % — re-stage before deploying', v_staged, v_chunks;
  END IF;

  v_actual := encode(sha256(convert_to(v_sql, 'UTF8')), 'hex');
  IF v_actual <> v_file_sha THEN
    RAISE EXCEPTION 'staged content is not the file: sha256 %, expected %', v_actual, v_file_sha;
  END IF;

  v_exec := regexp_replace(v_sql, '(?n)^[ \t]*(BEGIN|COMMIT)[ \t]*;[ \t]*$', '', 'g');
  v_actual := encode(sha256(convert_to(v_exec, 'UTF8')), 'hex');
  IF v_actual <> v_exec_sha THEN
    RAISE EXCEPTION 'transaction-control stripping diverged: sha256 %, expected %', v_actual, v_exec_sha;
  END IF;

  IF EXISTS (SELECT 1 FROM public.nordklart_schema_migrations WHERE version = v_file) THEN
    RAISE EXCEPTION 'migration % is already recorded — refusing to re-run', v_file;
  END IF;

  EXECUTE v_exec;

  INSERT INTO public.nordklart_schema_migrations (version, checksum, source)
  VALUES (v_file, v_file_sha, 'mcp-deploy');

  DELETE FROM public.nordklart_deploy_staging WHERE file = v_file;

  RAISE NOTICE 'deployed % (sha256 %)', v_file, v_file_sha;
END
$nk_deploy$;
