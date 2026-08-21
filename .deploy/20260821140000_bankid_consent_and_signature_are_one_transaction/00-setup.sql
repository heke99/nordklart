CREATE TABLE IF NOT EXISTS public.nordklart_deploy_staging (
  file text NOT NULL,
  idx integer NOT NULL,
  body text NOT NULL,
  expected_sha text NOT NULL,
  staged_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (file, idx)
);
ALTER TABLE public.nordklart_deploy_staging ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nordklart_deploy_staging FROM PUBLIC, anon, authenticated;
SELECT 'staging ready' AS ok;
