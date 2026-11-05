-- Trigger functions are executed by PostgreSQL triggers, not directly via RPC.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public'
      AND p.prosecdef
      AND p.prorettype IN ('trigger'::regtype,'event_trigger'::regtype)
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon, authenticated',r.signature);
  END LOOP;
END $$;

-- Pin trigger-function search paths to trusted catalog objects.
ALTER FUNCTION public.update_virtual_number_updated_at() SET search_path = pg_catalog;
ALTER FUNCTION public.gmail_set_updated_at() SET search_path = pg_catalog;
ALTER FUNCTION public.handle_ai_job_insert() SET search_path = pg_catalog;
ALTER FUNCTION public.set_youngpg_updated_at() SET search_path = pg_catalog;
