-- Automatic in-app customer notifications for original Delight Vendor Logs.
alter table public.notifications add column if not exists category text;
alter table public.notifications add column if not exists event_key text;
create unique index if not exists notifications_event_key_unique on public.notifications(event_key) where event_key is not null;
create or replace function public.dv_create_event_notification(p_user_id uuid,p_created_by uuid,p_title text,p_message text,p_category text,p_event_key text)
returns void language plpgsql security definer set search_path=''
as $$
declare v_notification_id uuid;
begin
 if p_user_id is null or p_created_by is null or nullif(btrim(coalesce(p_title,'')),'') is null or nullif(btrim(coalesce(p_message,'')),'') is null then return; end if;
 insert into public.notifications(title,message,created_by,category,event_key)
 values(left(btrim(p_title),180),left(btrim(p_message),10000),p_created_by,p_category,p_event_key)
 on conflict(event_key) where event_key is not null do nothing returning id into v_notification_id;
 if v_notification_id is not null then
  insert into public.notification_recipients(notification_id,user_id) values(v_notification_id,p_user_id) on conflict(notification_id,user_id) do nothing;
 end if;
end $$;
create or replace function public.dv_notify_purchase_event()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status) then
  perform public.dv_create_event_notification(new.user_id,new.user_id,'Purchase successful','Your purchase of '||coalesce(new.product_name,'a product')||' was completed successfully. Open My Purchases to view the details.','purchase','purchase:'||new.id::text||':completed');
 end if;
 return new;
end $$;
create or replace function public.dv_notify_transaction_event()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_title text;v_message text;v_category text;
begin
 if new.status='completed' and (tg_op='INSERT' or old.status is distinct from new.status) and new.type in ('wallet_funding','refund','wallet_refund') then
  if new.type='wallet_funding' then v_title:='Wallet funding successful';v_message:='Your wallet has been funded with ₦'||to_char(coalesce(new.amount,0),'FM999,999,999,990.00');v_category:='wallet';
  else v_title:='Refund processed';v_message:='A refund of ₦'||to_char(coalesce(new.amount,0),'FM999,999,999,990.00')||' has been processed to your wallet.';v_category:='refund';end if;
  perform public.dv_create_event_notification(new.user_id,new.user_id,v_title,v_message,v_category,'transaction:'||new.id::text||':completed');
 end if;
 return new;
end $$;
create or replace function public.dv_notify_virtual_number_event()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if tg_op='INSERT' and new.status='waiting' then
  perform public.dv_create_event_notification(new.user_id,new.user_id,'Virtual number ready','Your virtual number order is active. Open My Purchases to view the number and expiry time.','virtual_number','virtual-number:'||new.id::text||':waiting');
 elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status='received' then
  perform public.dv_create_event_notification(new.user_id,new.user_id,'Verification code received','A verification code has arrived for your virtual number. Open My Purchases to view it.','virtual_number','virtual-number:'||new.id::text||':received');
 elsif tg_op='UPDATE' and old.status is distinct from new.status and new.status='cancelled' and new.refunded_at is not null then
  perform public.dv_create_event_notification(new.user_id,new.user_id,'Virtual number refund processed','Your virtual number order was cancelled and the refund has been processed.','refund','virtual-number:'||new.id::text||':refunded');
 end if;
 return new;
end $$;
create or replace function public.dv_notify_support_reply()
returns trigger language plpgsql security definer set search_path=''
as $$
declare v_customer uuid;v_preview text;
begin
 if new.sender_role not in ('admin','bot') then return new;end if;
 select customer_user_id into v_customer from public.support_chat_conversations where id=new.conversation_id;
 if v_customer is null then return new;end if;
 v_preview:=nullif(btrim(coalesce(new.message_text,'')),'');
 if v_preview is null then v_preview:='You have a new support message.';else v_preview:=left(v_preview,240);end if;
 perform public.dv_create_event_notification(v_customer,v_customer,case when new.sender_role='bot' then 'Support assistant replied' else 'Support replied' end,v_preview||' Open Live Chat to continue the conversation.','support','support-message:'||new.id::text);
 return new;
end $$;
create trigger dv_purchase_notification_trigger after insert or update of status on public.purchases for each row execute function public.dv_notify_purchase_event();
create trigger dv_transaction_notification_trigger after insert or update of status on public.transactions for each row execute function public.dv_notify_transaction_event();
create trigger dv_virtual_number_notification_trigger after insert or update of status on public.virtual_number_orders for each row execute function public.dv_notify_virtual_number_event();
create trigger dv_support_reply_notification_trigger after insert on public.support_chat_messages for each row execute function public.dv_notify_support_reply();
revoke all on function public.dv_create_event_notification(uuid,uuid,text,text,text,text) from public,anon,authenticated;
revoke all on function public.dv_notify_purchase_event() from public,anon,authenticated;
revoke all on function public.dv_notify_transaction_event() from public,anon,authenticated;
revoke all on function public.dv_notify_virtual_number_event() from public,anon,authenticated;
revoke all on function public.dv_notify_support_reply() from public,anon,authenticated;
