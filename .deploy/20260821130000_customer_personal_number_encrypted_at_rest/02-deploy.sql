DO $nk_deploy$
DECLARE
  v_file       text := '20260821130000_customer_personal_number_encrypted_at_rest.sql';
  v_file_sha   text := 'a05e2225eaeb190fb79f2e37972b4f9c144faa42449e73681e72aea720897102';
  v_exec_sha   text := '41c64e004755d1f9631780c99cbeecce14d783c9dd0b87d96b49b22693fa53db';
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
