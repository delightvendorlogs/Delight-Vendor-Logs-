-- Once a customer submits any purchase review, clear every older snoozed reminder.
-- A new completed purchase can then start the next review prompt cycle.
create or replace function public.dv_submit_purchase_review(p_purchase_id bigint,p_rating integer,p_review_text text)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_uid uuid := auth.uid();
  v_purchase public.purchases%rowtype;
  v_id uuid;
begin
  if v_uid is null then raise exception 'Please sign in first.'; end if;
  if p_rating not between 1 and 5 then raise exception 'Choose between 1 and 5 stars.'; end if;
  if char_length(btrim(coalesce(p_review_text,''))) not between 3 and 1200 then
    raise exception 'Write between 3 and 1,200 characters.';
  end if;

  select * into v_purchase
  from public.purchases
  where id = p_purchase_id and user_id = v_uid and status = 'completed'
  for share;

  if not found then raise exception 'Only your completed purchases can be reviewed.'; end if;

  insert into public.purchase_reviews(purchase_id,user_id,rating,review_text)
  values(p_purchase_id,v_uid,p_rating,btrim(p_review_text))
  on conflict(purchase_id) do nothing
  returning id into v_id;

  if v_id is null then raise exception 'This purchase has already been reviewed.'; end if;

  delete from public.purchase_review_reminders where user_id = v_uid;

  return jsonb_build_object('ok',true,'review_id',v_id,'status','pending');
end
$function$;

revoke all on function public.dv_submit_purchase_review(bigint,integer,text) from public, anon;
grant execute on function public.dv_submit_purchase_review(bigint,integer,text) to authenticated;
