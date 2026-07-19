-- bank-files storage bucket (revision item K03).
--
-- Bank file import execute must work from the ARCHIVED original file, never
-- from a client-parsed transaction list. The parse endpoint archives the
-- uploaded file here ({company_id}/{file_hash}.dat) and execute re-parses it
-- server-side. WORM semantics: no UPDATE/DELETE policies (BFL 7 kap).
--
-- pg-test: skip (storage bucket + policies only; behaviour covered by route tests)

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'bank-files',
  'bank-files',
  false,
  10485760, -- 10 MB, matches the bank-file parse route ceiling
  ARRAY['text/plain', 'text/csv', 'application/xml', 'text/xml', 'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS bank_files_insert ON storage.objects;
DROP POLICY IF EXISTS bank_files_select ON storage.objects;

CREATE POLICY bank_files_insert
  ON storage.objects
  FOR INSERT
  TO authenticated
  WITH CHECK (
    bucket_id = 'bank-files'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.user_company_ids())
  );

CREATE POLICY bank_files_select
  ON storage.objects
  FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'bank-files'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.user_company_ids())
  );

-- No UPDATE or DELETE policies — WORM semantics.
