create or replace view public.customer_logsplug_order_history
with (security_barrier=true)
as
select id,user_id,log_id,provider_order_id,title_snapshot,category_name,
       customer_total,customer_unit_price,quantity,status,credentials,provider_response,created_at
from public.logsplug_orders
where user_id=auth.uid();

create or replace view public.customer_boosting_order_history
with (security_barrier=true)
as
select id,user_id,platform,service_name,link,quantity,customer_charge,status,created_at
from public.boosting_orders
where user_id=auth.uid();

revoke all on public.customer_logsplug_order_history from public,anon;
revoke all on public.customer_boosting_order_history from public,anon;
grant select on public.customer_logsplug_order_history to authenticated;
grant select on public.customer_boosting_order_history to authenticated;
