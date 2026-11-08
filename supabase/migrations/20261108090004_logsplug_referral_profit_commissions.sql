alter table public.referral_commissions
  add column if not exists source_uuid uuid;

create unique index if not exists referral_commissions_source_uuid_unique
  on public.referral_commissions(source_type, source_uuid)
  where source_uuid is not null;

create or replace function public.process_referral_logsplug_order()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_referrer uuid;
  v_rate numeric(5,2);
  v_sale numeric(14,2);
  v_cost numeric(14,2);
  v_profit numeric(14,2);
  v_commission numeric(14,2);
  v_commission_id bigint;
  v_status text := lower(coalesce(new.status,''));
begin
  if v_status in ('failed','failed_refunded','cancelled','canceled','refunded','rejected') then
    update public.referral_commissions
      set status='reversed', reversed_at=now()
      where source_type='logsplug' and source_uuid=new.id and status='earned'
      returning referrer_id,commission_amount into v_referrer,v_commission;
    if found then
      update public.referral_accounts set balance=greatest(0,balance-v_commission)
        where user_id=v_referrer;
      insert into public.referral_ledger(user_id,amount,entry_type,description)
        values(v_referrer,-v_commission,'commission_reversal',
          'Referral commission reversed because the LogsPlug order failed or was refunded');
    end if;
    return new;
  end if;
  if v_status not in ('completed','success','successful','delivered','fulfilled') then return new; end if;
  select referred_by into v_referrer from public.referral_accounts where user_id=new.user_id;
  if v_referrer is null or v_referrer=new.user_id then return new; end if;
  v_sale := greatest(coalesce(new.customer_total,0),0);
  v_cost := greatest(coalesce(new.provider_unit_price,0),0)*greatest(coalesce(new.quantity,1),1);
  v_profit := round(greatest(v_sale-v_cost,0),2);
  if v_profit<=0 then return new; end if;
  select coalesce(a.commission_percent_override,s.default_commission_percent,10)
    into v_rate from public.referral_accounts a cross join public.referral_settings s
    where a.user_id=v_referrer and s.id=1;
  v_rate := coalesce(v_rate,10);
  v_commission := round(v_profit*v_rate/100.0,2);
  if v_commission<=0 then return new; end if;
  insert into public.referral_commissions(referrer_id,referred_user_id,purchase_id,source_type,source_id,source_uuid,purchase_amount,commission_percent,commission_amount,status)
  values(v_referrer,new.user_id,null,'logsplug',null,new.id,v_sale,v_rate,v_commission,'earned')
  on conflict (source_type,source_uuid) where source_uuid is not null do nothing
  returning id into v_commission_id;
  if v_commission_id is not null then
    insert into public.referral_commission_profit_details(commission_id,provider_cost_amount,profit_amount) values(v_commission_id,v_cost,v_profit);
    update public.referral_accounts set balance=balance+v_commission where user_id=v_referrer;
    insert into public.referral_ledger(user_id,amount,entry_type,description)
      values(v_referrer,v_commission,'commission','Referral commission earned from LogsPlug order profit');
  end if;
  return new;
end;
$$;

drop trigger if exists process_referral_logsplug_order on public.logsplug_orders;
create trigger process_referral_logsplug_order
after insert or update of status on public.logsplug_orders
for each row execute function public.process_referral_logsplug_order();
