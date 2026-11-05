-- Purchase protection and review RPCs for original Delight Vendor Logs.
create or replace function public.dv_snooze_purchase_review(p_purchase_id bigint)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_purchase public.purchases%rowtype;
begin
 if v_uid is null then raise exception 'Please sign in first.'; end if;
 select * into v_purchase from public.purchases where id=p_purchase_id and user_id=v_uid and status='completed';
 if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;
 if exists(select 1 from public.purchase_reviews where purchase_id=p_purchase_id) then
  delete from public.purchase_review_reminders where purchase_id=p_purchase_id and user_id=v_uid;
  return jsonb_build_object('ok',false,'reason','already_reviewed');
 end if;
 insert into public.purchase_review_reminders(purchase_id,user_id,remind_after,snooze_count)
 values(p_purchase_id,v_uid,now()+interval '3 days',1)
 on conflict(purchase_id) do update set remind_after=excluded.remind_after,snooze_count=public.purchase_review_reminders.snooze_count+1,updated_at=now()
 where public.purchase_review_reminders.user_id=v_uid;
 return jsonb_build_object('ok',true,'remind_after',now()+interval '3 days');
end $$;
create or replace function public.dv_submit_purchase_review(p_purchase_id bigint,p_rating integer,p_review_text text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_purchase public.purchases%rowtype; v_id uuid;
begin
 if v_uid is null then raise exception 'Please sign in first.'; end if;
 if p_rating not between 1 and 5 then raise exception 'Choose between 1 and 5 stars.'; end if;
 if char_length(btrim(coalesce(p_review_text,''))) not between 3 and 1200 then raise exception 'Write between 3 and 1,200 characters.'; end if;
 select * into v_purchase from public.purchases where id=p_purchase_id and user_id=v_uid and status='completed' for share;
 if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;
 insert into public.purchase_reviews(purchase_id,user_id,rating,review_text) values(p_purchase_id,v_uid,p_rating,btrim(p_review_text))
 on conflict(purchase_id) do nothing returning id into v_id;
 if v_id is null then raise exception 'This purchase has already been reviewed.'; end if;
 delete from public.purchase_review_reminders where purchase_id=p_purchase_id and user_id=v_uid;
 return jsonb_build_object('ok',true,'review_id',v_id,'status','pending');
end $$;
create or replace function public.dv_create_purchase_support_ticket(p_purchase_id bigint,p_issue_type text,p_customer_message text)
returns jsonb language plpgsql security definer set search_path=''
as $$
declare v_uid uuid:=auth.uid(); v_purchase public.purchases%rowtype; v_id uuid;
begin
 if v_uid is null then raise exception 'Please sign in first.'; end if;
 if p_issue_type not in ('not_received','wrong_item','invalid_content','other') then raise exception 'Choose a valid issue type.'; end if;
 if char_length(btrim(coalesce(p_customer_message,''))) not between 10 and 2000 then raise exception 'Explain the issue in 10 to 2,000 characters.'; end if;
 select * into v_purchase from public.purchases where id=p_purchase_id and user_id=v_uid and status='completed' for share;
 if not found then raise exception 'Only your completed purchases can be reported.'; end if;
 insert into public.purchase_support_tickets(purchase_id,user_id,issue_type,customer_message) values(p_purchase_id,v_uid,p_issue_type,btrim(p_customer_message))
 on conflict(purchase_id) do nothing returning id into v_id;
 if v_id is null then raise exception 'A report already exists for this purchase. Check its status below.'; end if;
 return jsonb_build_object('ok',true,'ticket_id',v_id,'status','open');
end $$;
create or replace function public.dv_admin_moderate_purchase_review(p_review_id uuid,p_status text,p_admin_note text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
begin
 if auth.uid() is null or coalesce((select public.is_admin()),false) is not true then raise exception 'Administrator access required.'; end if;
 if p_status not in ('approved','rejected') then raise exception 'Choose approved or rejected.'; end if;
 update public.purchase_reviews set status=p_status,admin_note=nullif(btrim(coalesce(p_admin_note,'')),''),moderated_by=auth.uid(),moderated_at=now() where id=p_review_id;
 if not found then raise exception 'Review not found.'; end if;
 return jsonb_build_object('ok',true,'status',p_status);
end $$;
create or replace function public.dv_admin_update_purchase_ticket(p_ticket_id uuid,p_status text,p_admin_response text default null)
returns jsonb language plpgsql security definer set search_path=''
as $$
begin
 if auth.uid() is null or coalesce((select public.is_admin()),false) is not true then raise exception 'Administrator access required.'; end if;
 if p_status not in ('open','in_review','resolved','rejected') then raise exception 'Choose a valid ticket status.'; end if;
 update public.purchase_support_tickets set status=p_status,admin_response=nullif(btrim(coalesce(p_admin_response,'')),''),updated_at=now(),resolved_at=case when p_status in ('resolved','rejected') then now() else null end where id=p_ticket_id;
 if not found then raise exception 'Purchase report not found.'; end if;
 return jsonb_build_object('ok',true,'status',p_status);
end $$;
revoke all on function public.dv_snooze_purchase_review(bigint) from public,anon;
revoke all on function public.dv_submit_purchase_review(bigint,integer,text) from public,anon;
revoke all on function public.dv_create_purchase_support_ticket(bigint,text,text) from public,anon;
revoke all on function public.dv_admin_moderate_purchase_review(uuid,text,text) from public,anon;
revoke all on function public.dv_admin_update_purchase_ticket(uuid,text,text) from public,anon;
grant execute on function public.dv_snooze_purchase_review(bigint) to authenticated;
grant execute on function public.dv_submit_purchase_review(bigint,integer,text) to authenticated;
grant execute on function public.dv_create_purchase_support_ticket(bigint,text,text) to authenticated;
grant execute on function public.dv_admin_moderate_purchase_review(uuid,text,text) to authenticated;
grant execute on function public.dv_admin_update_purchase_ticket(uuid,text,text) to authenticated;
