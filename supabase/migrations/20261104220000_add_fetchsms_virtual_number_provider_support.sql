-- Fetch SMS USA support for Delight Vendor Logs.
-- Adds provider-scoped fixed selling prices and permits Fetch SMS orders
-- to use the existing wallet/order/refund RPC workflow.

ALTER TABLE public.virtual_number_price_overrides
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'textverified';

CREATE UNIQUE INDEX IF NOT EXISTS virtual_number_price_overrides_provider_country_service_uidx
  ON public.virtual_number_price_overrides (provider, country_id, service_code);

DROP POLICY IF EXISTS "Admins can insert virtual number price overrides" ON public.virtual_number_price_overrides;
CREATE POLICY "Admins can insert virtual number price overrides"
  ON public.virtual_number_price_overrides
  FOR INSERT TO authenticated
  WITH CHECK ((SELECT public.is_admin_user()));

DROP POLICY IF EXISTS "Admins can update virtual number price overrides" ON public.virtual_number_price_overrides;
CREATE POLICY "Admins can update virtual number price overrides"
  ON public.virtual_number_price_overrides
  FOR UPDATE TO authenticated
  USING ((SELECT public.is_admin_user()))
  WITH CHECK ((SELECT public.is_admin_user()));

DROP POLICY IF EXISTS "Admins can delete virtual number price overrides" ON public.virtual_number_price_overrides;
CREATE POLICY "Admins can delete virtual number price overrides"
  ON public.virtual_number_price_overrides
  FOR DELETE TO authenticated
  USING ((SELECT public.is_admin_user()));

INSERT INTO public.virtual_number_markup_rules
  (server, country_id, country_key, service_code, markup_percent, is_active)
SELECT 'fetchsms', 187, 'US', NULL, 100, true
WHERE NOT EXISTS (
  SELECT 1 FROM public.virtual_number_markup_rules
  WHERE server = 'fetchsms'
    AND country_id = 187
    AND service_code IS NULL
    AND is_active = true
);

CREATE OR REPLACE FUNCTION public.reserve_virtual_number_order(
  p_user_id uuid,
  p_provider_key text,
  p_idempotency_key text,
  p_service_code text,
  p_service_name text,
  p_country_id bigint,
  p_country_name text,
  p_customer_price_ngn numeric,
  p_exchange_rate numeric DEFAULT NULL::numeric,
  p_provider_cost_usd numeric DEFAULT NULL::numeric,
  p_provider_cost_ngn numeric DEFAULT NULL::numeric
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_wallet_id uuid;
  v_balance numeric;
  v_order_id bigint;
  v_existing public.virtual_number_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL
     AND auth.uid() <> p_user_id
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_provider_key NOT IN ('textverified', 'virtualsms', 'fetchsms') THEN
    RAISE EXCEPTION 'Unsupported provider';
  END IF;

  IF p_idempotency_key IS NULL
     OR length(trim(p_idempotency_key)) < 8
     OR length(p_idempotency_key) > 200 THEN
    RAISE EXCEPTION 'A valid idempotency key is required';
  END IF;

  IF p_service_code IS NULL OR trim(p_service_code) = ''
     OR p_customer_price_ngn IS NULL
     OR p_customer_price_ngn <= 0 THEN
    RAISE EXCEPTION 'Invalid service or purchase price';
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(
      p_user_id::text || ':' || p_provider_key || ':' || p_idempotency_key, 0
    )
  );

  SELECT *
  INTO v_existing
  FROM public.virtual_number_orders
  WHERE user_id = p_user_id
    AND provider_key = p_provider_key
    AND idempotency_key = p_idempotency_key
  LIMIT 1;

  IF FOUND THEN
    RETURN jsonb_build_object(
      'success', true, 'existing', true,
      'order_id', v_existing.id, 'status', v_existing.status
    );
  END IF;

  SELECT id, COALESCE(balance, 0)
  INTO v_wallet_id, v_balance
  FROM public.wallet
  WHERE "user-id" = p_user_id
  FOR UPDATE;

  IF v_wallet_id IS NULL THEN
    RAISE EXCEPTION 'Wallet not found';
  END IF;

  IF v_balance < p_customer_price_ngn THEN
    RETURN jsonb_build_object(
      'success', false, 'error', 'insufficient_wallet_balance',
      'required', p_customer_price_ngn, 'balance', v_balance,
      'shortfall', p_customer_price_ngn - v_balance
    );
  END IF;

  INSERT INTO public.virtual_number_orders (
    user_id, service_code, service_name, country_id, country_name,
    provider_cost_usd, exchange_rate, provider_cost_ngn, customer_price_ngn,
    status, server, provider_key, idempotency_key, provider_state
  )
  VALUES (
    p_user_id, p_service_code, p_service_name, p_country_id, p_country_name,
    p_provider_cost_usd, p_exchange_rate, p_provider_cost_ngn, p_customer_price_ngn,
    'waiting', p_provider_key, p_provider_key, p_idempotency_key, 'reserved'
  )
  RETURNING id INTO v_order_id;

  UPDATE public.wallet
  SET balance = COALESCE(balance, 0) - p_customer_price_ngn
  WHERE id = v_wallet_id;

  INSERT INTO public.transactions (
    user_id, type, amount, status, description, reference
  )
  VALUES (
    p_user_id, 'virtual_number_purchase', -p_customer_price_ngn,
    'pending', 'Virtual number purchase', 'VNUM-' || v_order_id::text
  );

  SELECT COALESCE(balance, 0) INTO v_balance
  FROM public.wallet WHERE id = v_wallet_id;

  RETURN jsonb_build_object(
    'success', true, 'existing', false, 'order_id', v_order_id,
    'status', 'waiting', 'wallet_balance', v_balance
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.attach_virtual_number_provider_order(
  p_order_id bigint,
  p_user_id uuid,
  p_provider_key text,
  p_provider_order_id text,
  p_number text,
  p_provider_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone,
  p_provider_state text DEFAULT 'waiting'::text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_order public.virtual_number_orders%ROWTYPE;
BEGIN
  IF auth.uid() IS NOT NULL
     AND auth.uid() <> p_user_id
     AND NOT public.is_admin() THEN
    RAISE EXCEPTION 'Not authorized';
  END IF;

  IF p_provider_key NOT IN ('textverified', 'virtualsms', 'fetchsms')
     OR p_provider_order_id IS NULL
     OR trim(p_provider_order_id) = ''
     OR p_number IS NULL
     OR trim(p_number) = '' THEN
    RAISE EXCEPTION 'Invalid provider order details';
  END IF;

  SELECT * INTO v_order
  FROM public.virtual_number_orders
  WHERE id = p_order_id AND user_id = p_user_id
    AND provider_key = p_provider_key
  FOR UPDATE;

  IF NOT FOUND THEN RAISE EXCEPTION 'Order not found'; END IF;

  IF v_order.provider_order_id IS NOT NULL
     AND v_order.provider_order_id <> p_provider_order_id THEN
    RAISE EXCEPTION 'Provider order already attached';
  END IF;

  UPDATE public.virtual_number_orders
  SET provider_order_id = p_provider_order_id,
      number = p_number,
      provider_expires_at = p_provider_expires_at,
      provider_state = p_provider_state,
      updated_at = now()
  WHERE id = p_order_id;

  RETURN jsonb_build_object('success', true, 'order_id', p_order_id);
END;
$function$;
