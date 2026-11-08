grant select on public.logsplug_orders, public.social_log_orders, public.boosting_orders to authenticated;

drop policy if exists logsplug_orders_customer_read_own on public.logsplug_orders;
create policy logsplug_orders_customer_read_own
on public.logsplug_orders for select to authenticated
using (user_id = (select auth.uid()));

drop policy if exists boosting_orders_customer_read_own on public.boosting_orders;
create policy boosting_orders_customer_read_own
on public.boosting_orders for select to authenticated
using (user_id = (select auth.uid()));