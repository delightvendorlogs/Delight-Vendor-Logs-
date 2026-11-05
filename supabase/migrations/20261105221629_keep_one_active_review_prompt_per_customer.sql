-- Keep only one active review prompt/reminder per customer at a time.
-- Later creates one reminder due in three days; Leave suppresses all prompts
-- until a new successful purchase creates a new review cycle.
create or replace function public.dv_snooze_purchase_review(p_purchase_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_purchase public.purchases%rowtype;
  v_remind_after timestamptz := now() + interval '3 days';
  v_snooze_count integer := 1;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and user_id = v_uid and status = 'completed';

  if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;

  if exists(select 1 from public.purchase_reviews where purchase_id = p_purchase_id and user_id = v_uid) then
    delete from public.purchase_review_reminders where user_id = v_uid;
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  select coalesce(snooze_count,0) + 1 into v_snooze_count
  from public.purchase_review_reminders
  where purchase_id = p_purchase_id and user_id = v_uid;

  delete from public.purchase_review_reminders where user_id = v_uid;

  insert into public.purchase_review_reminders(purchase_id,user_id,remind_after,snooze_count,dismissed_at)
  values(p_purchase_id,v_uid,v_remind_after,coalesce(v_snooze_count,1),null);

  return jsonb_build_object('ok', true, 'remind_after', v_remind_after);
end
$function$;

create or replace function public.dv_dismiss_purchase_review(p_purchase_id bigint)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_purchase public.purchases%rowtype;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and user_id = v_uid and status = 'completed';

  if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;

  if exists(select 1 from public.purchase_reviews where purchase_id = p_purchase_id and user_id = v_uid) then
    delete from public.purchase_review_reminders where user_id = v_uid;
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  delete from public.purchase_review_reminders where user_id = v_uid;

  insert into public.purchase_review_reminders(purchase_id,user_id,remind_after,snooze_count,dismissed_at)
  values(p_purchase_id,v_uid,now() + interval '100 years',0,now());

  return jsonb_build_object('ok', true, 'dismissed', true);
end
$function$;

revoke all on function public.dv_dismiss_purchase_review(bigint) from public, anon;
grant execute on function public.dv_dismiss_purchase_review(bigint) to authenticated;
revoke all on function public.dv_snooze_purchase_review(bigint) from public, anon;
grant execute on function public.dv_snooze_purchase_review(bigint) to authenticated;
