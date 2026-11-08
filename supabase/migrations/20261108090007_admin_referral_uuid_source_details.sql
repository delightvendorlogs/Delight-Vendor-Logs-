CREATE OR REPLACE FUNCTION public.admin_get_referral_data()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_result jsonb; v_user uuid:=auth.uid();
begin
  if v_user is null or not public.is_admin() then raise exception 'Not authorized'; end if;
  select jsonb_build_object(
    'default_commission_percent',(select default_commission_percent from public.referral_settings where id=1),
    'referrers',coalesce((select jsonb_agg(jsonb_build_object(
      'user_id',a.user_id,'name',coalesce(nullif(p.full_name,''),'Member'),'email',p.email,'referral_code',a.referral_code,'balance',a.balance,
      'commission_percent_override',a.commission_percent_override,
      'referred_count',(select count(*) from public.referral_accounts x where x.referred_by=a.user_id),
      'pending_withdrawals',(select count(*) from public.referral_withdrawals w where w.user_id=a.user_id and w.status='pending'),
      'referred_people',coalesce((select jsonb_agg(jsonb_build_object('user_id',x.user_id,'name',coalesce(nullif(px.full_name,''),'Member'),'email',px.email,'joined_at',x.created_at) order by x.created_at desc) from public.referral_accounts x left join public.profiles px on px.id=x.user_id where x.referred_by=a.user_id),'[]'::jsonb)
    ) order by a.created_at desc) from public.referral_accounts a left join public.profiles p on p.id=a.user_id),'[]'::jsonb),
    'withdrawals',coalesce((select jsonb_agg(jsonb_build_object('id',w.id,'user_id',w.user_id,'name',coalesce(nullif(p.full_name,''),'Member'),'email',p.email,'amount',w.amount,'payout_details',w.payout_details,'status',w.status,'admin_note',w.admin_note,'requested_at',w.requested_at) order by (w.status='pending') desc,w.requested_at desc) from public.referral_withdrawals w left join public.profiles p on p.id=w.user_id),'[]'::jsonb),
    'commissions',coalesce((select jsonb_agg(jsonb_build_object('id',c.id,'source_type',c.source_type,'source_id',c.source_id,'source_uuid',c.source_uuid,'referrer_id',c.referrer_id,'referrer_name',coalesce(nullif(pr.full_name,''),'Member'),'referred_user_id',c.referred_user_id,'referred_name',coalesce(nullif(pu.full_name,''),'Member'),'purchase_id',c.purchase_id,'purchase_amount',c.purchase_amount,'provider_cost_amount',coalesce(pd.provider_cost_amount,0),'profit_amount',coalesce(pd.profit_amount,0),'commission_percent',c.commission_percent,'commission_amount',c.commission_amount,'status',c.status,'created_at',c.created_at) order by c.created_at desc) from public.referral_commissions c left join public.referral_commission_profit_details pd on pd.commission_id=c.id left join public.profiles pr on pr.id=c.referrer_id left join public.profiles pu on pu.id=c.referred_user_id),'[]'::jsonb),
    'product_costs',coalesce((select jsonb_agg(jsonb_build_object('product_id',p.id,'product_name',p.name,'selling_price',p.price,'cost_price',r.cost_price,'commission_enabled',r.commission_enabled) order by p.name) from public.products p left join public.referral_product_cost_rules r on r.product_id=p.id),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(jsonb_build_object('id',l.id,'user_id',l.user_id,'name',coalesce(nullif(p.full_name,''),'Member'),'amount',l.amount,'entry_type',l.entry_type,'description',l.description,'created_at',l.created_at) order by l.created_at desc) from public.referral_ledger l left join public.profiles p on p.id=l.user_id),'[]'::jsonb)
  ) into v_result;
  return v_result;
end;
$function$
;