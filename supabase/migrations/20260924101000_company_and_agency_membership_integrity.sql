-- =============================================================================
-- Company identity and agency ownership integrity
--
-- Three gaps a signed-in user could reach directly through PostgREST:
--
-- 1. companies.org_number could be changed by any company admin at any time
--    (companies_update is a plain admin policy). The organisationsnummer is the
--    company's legal identity: SIE #ORGNR, SRU, AGI, momsdeklaration and the
--    Bolagsverket filing all key off it. Changing it re-points the whole ledger
--    at another legal person. The settings API refuses the change after
--    onboarding, but that check lived only in the route.
--
--    Now: once set, org_number is immutable for session callers. Setting it
--    for the first time (onboarding writes it right after
--    create_company_with_owner) is still allowed, but not to a number another
--    active company already carries. The onboarding action routes that case
--    to an access request; this makes the database agree, so a direct write
--    cannot squat a number either. Service role and SECURITY DEFINER paths
--    (support tooling, verified takeover) are unaffected.
--
-- 2. companies_insert allowed a direct INSERT with created_by = auth.uid(),
--    bypassing create_company_with_owner (team-membership check, owner row,
--    active-company preference). Nothing in the application inserts into
--    companies directly; the RPC is SECURITY DEFINER and is not subject to
--    this policy. The policy now refuses.
--
-- 3. agency_members_write was FOR ALL USING (user_is_agency_admin(agency_id)).
--    An agency_admin could promote themselves to agency_owner, demote or
--    remove the owner, or INSERT any user_id straight into the agency, skipping
--    the invitation and its email binding. company_members has had owner
--    protection triggers since 20260422130000; agencies had none.
--
--    Now, for session callers: no direct INSERT (staff join through the
--    invitation flow, which runs as service role); agency_id/user_id are
--    immutable; only an active agency_owner may grant, change or remove the
--    agency_owner role; and the last active owner cannot be removed or
--    demoted.
--
-- The session/non-session split mirrors enforce_company_member_role_transitions:
-- auth.uid() IS NULL means service role, a SECURITY DEFINER cascade from a
-- no-claims caller, or direct SQL.
--
-- pg-test: covered-by tests/pg/company-agency-integrity.pg.test.ts
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. org_number immutability + uniqueness for session callers
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_company_org_number_integrity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND OLD.org_number IS NOT NULL
     AND NEW.org_number IS DISTINCT FROM OLD.org_number THEN
    RAISE EXCEPTION 'Organisationsnumret kan inte ändras efter att det har registrerats.'
      USING ERRCODE = '42501',
            HINT = 'Kontakta supporten om organisationsnumret är fel.';
  END IF;

  IF NEW.org_number IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.org_number IS NULL)
     AND EXISTS (
       SELECT 1
         FROM public.companies c
        WHERE c.org_number = NEW.org_number
          AND c.id <> NEW.id
          AND c.archived_at IS NULL
     ) THEN
    RAISE EXCEPTION 'Organisationsnumret är redan registrerat i Nordklart.'
      USING ERRCODE = '23505',
            HINT = 'Begär åtkomst till det befintliga bolaget i stället.';
  END IF;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_company_org_number_integrity() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_company_org_number_integrity ON public.companies;
CREATE TRIGGER enforce_company_org_number_integrity
  BEFORE INSERT OR UPDATE OF org_number ON public.companies
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_company_org_number_integrity();

-- -----------------------------------------------------------------------------
-- 2. No direct company INSERT from sessions
-- -----------------------------------------------------------------------------
DROP POLICY IF EXISTS companies_insert ON public.companies;
CREATE POLICY companies_insert ON public.companies
  FOR INSERT
  WITH CHECK (false);

-- -----------------------------------------------------------------------------
-- 3. Agency owner protection
-- -----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_agency_member_role_transitions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_agency_id     uuid := COALESCE(NEW.agency_id, OLD.agency_id);
  v_caller_owner  boolean;
  v_other_owners  integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF TG_OP = 'INSERT' THEN
    RAISE EXCEPTION 'Byråpersonal läggs till via inbjudan.'
      USING ERRCODE = '42501';
  END IF;

  IF TG_OP = 'UPDATE'
     AND (NEW.agency_id IS DISTINCT FROM OLD.agency_id OR NEW.user_id IS DISTINCT FROM OLD.user_id) THEN
    RAISE EXCEPTION 'agency_id och user_id kan inte ändras på ett byråmedlemskap.'
      USING ERRCODE = '42501';
  END IF;

  -- Rows that neither are nor become an owner are governed by RLS alone.
  IF OLD.role <> 'agency_owner'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'agency_owner') THEN
    RETURN COALESCE(NEW, OLD);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.agency_members am
     WHERE am.agency_id = v_agency_id
       AND am.user_id = auth.uid()
       AND am.role = 'agency_owner'
       AND am.status = 'active'
  ) INTO v_caller_owner;

  IF NOT v_caller_owner AND NOT public.is_platform_admin() THEN
    RAISE EXCEPTION 'Endast byråns ägare kan ändra ägarrollen.'
      USING ERRCODE = '42501';
  END IF;

  -- Removing or demoting an owner must leave at least one active owner.
  IF OLD.role = 'agency_owner'
     AND OLD.status = 'active'
     AND (TG_OP = 'DELETE' OR NEW.role <> 'agency_owner' OR NEW.status <> 'active') THEN
    SELECT count(*) INTO v_other_owners
      FROM public.agency_members am
     WHERE am.agency_id = v_agency_id
       AND am.id <> OLD.id
       AND am.role = 'agency_owner'
       AND am.status = 'active';
    IF v_other_owners = 0 THEN
      RAISE EXCEPTION 'Byrån måste ha minst en aktiv ägare.'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

REVOKE ALL ON FUNCTION public.enforce_agency_member_role_transitions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_agency_member_role_transitions ON public.agency_members;
CREATE TRIGGER enforce_agency_member_role_transitions
  BEFORE INSERT OR UPDATE OR DELETE ON public.agency_members
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_agency_member_role_transitions();

COMMIT;
