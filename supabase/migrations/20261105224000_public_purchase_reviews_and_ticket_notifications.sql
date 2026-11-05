-- Public-safe approved purchase reviews and customer notifications when reports change.
create or replace function public.get_public_purchase_reviews()
returns jsonb language sql stable security definer set search_path=''
as $$
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]'::jsonb)
 from (
  select r.id,p.product_name,r.rating,r.review_text,r.created_at,
   coalesce(nullif(split_part(btrim(pr.full_name),' ',1),''),'Customer') as display_name
  from public.purchase_reviews r join public.purchases p on p.id=r.purchase_id
  left join public.profiles pr on pr.id=r.user_id
  where r.status='approved' order by r.created_at desc limit 200
 ) x;
$$;
revoke all on function public.get_public_purchase_reviews() from public;
grant execute on function public.get_public_purchase_reviews() to anon,authenticated;
create or replace function public.dv_notify_purchase_ticket_update()
returns trigger language plpgsql security definer set search_path=''
as $$
begin
 if old.status is distinct from new.status then
  perform public.dv_create_event_notification(new.user_id,new.user_id,'Purchase report update',
   'Your purchase report status is now '||replace(new.status,'_',' ')||case when nullif(btrim(coalesce(new.admin_response,'')),'') is not null then '. Support has also replied. Open Purchase Protection to view the response.' else '. Open Purchase Protection for details.' end,
   'support','purchase-ticket:'||new.id::text||':'||new.status);
 end if;
 return new;
end $$;
create trigger dv_purchase_ticket_notification_trigger after update of status on public.purchase_support_tickets for each row execute function public.dv_notify_purchase_ticket_update();
revoke all on function public.dv_notify_purchase_ticket_update() from public,anon,authenticated;
