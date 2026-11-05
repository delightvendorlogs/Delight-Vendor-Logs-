-- Persist a customer's decision to leave a review prompt without a reminder.
alter table public.purchase_review_reminders
  add column if not exists dismissed_at timestamptz;

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
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and user_id = v_uid and status = 'completed';

  if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;

  if exists(select 1 from public.purchase_reviews where purchase_id = p_purchase_id and user_id = v_uid) then
    delete from public.purchase_review_reminders where purchase_id = p_purchase_id and user_id = v_uid;
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  insert into public.purchase_review_reminders(purchase_id,user_id,remind_after,snooze_count,dismissed_at)
  values(p_purchase_id,v_uid,v_remind_after,1,null)
  on conflict(purchase_id) do update
    set remind_after = excluded.remind_after,
        snooze_count = public.purchase_review_reminders.snooze_count + 1,
        dismissed_at = null,
        updated_at = now()
    where public.purchase_review_reminders.user_id = v_uid;

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
    delete from public.purchase_review_reminders where purchase_id = p_purchase_id and user_id = v_uid;
    return jsonb_build_object('ok', false, 'reason', 'already_reviewed');
  end if;

  insert into public.purchase_review_reminders(purchase_id,user_id,remind_after,snooze_count,dismissed_at)
  values(p_purchase_id,v_uid,now() + interval '100 years',0,now())
  on conflict(purchase_id) do update
    set dismissed_at = now(),
        updated_at = now()
    where public.purchase_review_reminders.user_id = v_uid;

  return jsonb_build_object('ok', true, 'dismissed', true);
end
$function$;

revoke all on function public.dv_dismiss_purchase_review(bigint) from public, anon;
grant execute on function public.dv_dismiss_purchase_review(bigint) to authenticated;
revoke all on function public.dv_snooze_purchase_review(bigint) from public, anon;
grant execute on function public.dv_snooze_purchase_review(bigint) to authenticated;
