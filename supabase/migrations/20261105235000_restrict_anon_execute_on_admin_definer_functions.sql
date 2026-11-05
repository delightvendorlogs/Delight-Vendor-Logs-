-- Restrict anonymous execution of admin-only SECURITY DEFINER RPCs.
-- Authenticated admin sessions retain EXECUTE; each function also performs its
-- own is_admin() authorization check. Existing customer-facing RPCs are untouched.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT p.oid::regprocedure AS signature
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.proname LIKE 'admin\_%' ESCAPE '\'
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', r.signature);
  END LOOP;
END
$$;
