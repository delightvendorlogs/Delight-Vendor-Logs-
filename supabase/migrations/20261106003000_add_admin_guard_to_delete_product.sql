CREATE OR REPLACE FUNCTION public.admin_delete_product(p_product_id bigint)
RETURNS json
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_exists boolean;
  v_orders integer;
BEGIN
  -- This RPC is callable by signed-in users, so enforce admin access inside
  -- the SECURITY DEFINER function before reading or changing marketplace data.
  IF NOT public.is_admin() THEN
    RAISE EXCEPTION 'Admin access required';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public."Product" WHERE id = p_product_id
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN json_build_object('success', false, 'message', 'Product not found');
  END IF;

  SELECT count(*) INTO v_orders
  FROM public.orders
  WHERE product_id = p_product_id;

  -- Preserve purchase history for products that already have orders.
  IF v_orders > 0 THEN
    UPDATE public."Product"
    SET status = 'Unavailable'
    WHERE id = p_product_id;

    RETURN json_build_object(
      'success', true,
      'deleted', false,
      'hidden', true,
      'message', 'Product has existing orders, so it was marked unavailable instead of deleting purchase history.'
    );
  END IF;

  DELETE FROM public.product_inventory WHERE product_id = p_product_id;
  DELETE FROM public."Product" WHERE id = p_product_id;

  RETURN json_build_object(
    'success', true,
    'deleted', true,
    'message', 'Product deleted successfully'
  );
END;
$function$;
