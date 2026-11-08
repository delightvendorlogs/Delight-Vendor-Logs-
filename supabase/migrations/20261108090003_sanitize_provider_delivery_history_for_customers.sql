create or replace function public.customer_safe_delivery(p_payload jsonb)
returns jsonb
language sql
immutable
set search_path = ''
as $function$
  select case jsonb_typeof(p_payload)
    when 'object' then coalesce((
      select jsonb_object_agg(e.key,public.customer_safe_delivery(e.value))
      from jsonb_each(p_payload) e
      where lower(e.key) not in (
        'provider','provider_name','provider_order','provider_order_id',
        'provider_reference','provider_status','service_provider',
        'vendor','source','api_provider','provider_label','provider_code','raw_response'
      )
    ),'{}'::jsonb)
    when 'array' then coalesce((
      select jsonb_agg(public.customer_safe_delivery(a.value))
      from jsonb_array_elements(p_payload) a
    ),'[]'::jsonb)
    else p_payload
  end;
$function$;

revoke all on function public.customer_safe_delivery(jsonb) from public,anon;
grant execute on function public.customer_safe_delivery(jsonb) to authenticated;

create or replace view public.customer_logsplug_order_history
with (security_barrier=true)
as
select id,user_id,log_id,provider_order_id,title_snapshot,category_name,
       customer_total,customer_unit_price,quantity,status,
       public.customer_safe_delivery(credentials) as credentials,
       public.customer_safe_delivery(provider_response) as provider_response,
       created_at
from public.logsplug_orders
where user_id=auth.uid();

create or replace view public.customer_social_log_order_history
with (security_barrier=true)
as
select id,user_id,provider_order_id,service_id,service_name,category_id,
       customer_price,quantity,status,
       public.customer_safe_delivery(provider_response) as provider_response,
       created_at
from public.social_log_orders
where user_id=auth.uid();

revoke all on public.customer_logsplug_order_history from public,anon;
revoke all on public.customer_social_log_order_history from public,anon;
grant select on public.customer_logsplug_order_history to authenticated;
grant select on public.customer_social_log_order_history to authenticated;
