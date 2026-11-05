-- Purchase protection and moderated purchase reviews for original Delight Vendor Logs.
-- Applied directly to Supabase; this file records the deployed schema and RPCs.
/* Tables and RLS */
create table if not exists public.purchase_reviews (
 id uuid primary key default gen_random_uuid(), purchase_id bigint not null references public.purchases(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete cascade, rating smallint not null check(rating between 1 and 5),
 review_text text not null check(char_length(btrim(review_text)) between 3 and 1200),
 status text not null default 'pending' check(status in ('pending','approved','rejected')), admin_note text,
 moderated_by uuid references auth.users(id), moderated_at timestamptz, created_at timestamptz not null default now(), unique(purchase_id)
);
create table if not exists public.purchase_review_reminders (
 purchase_id bigint primary key references public.purchases(id) on delete cascade, user_id uuid not null references auth.users(id) on delete cascade,
 remind_after timestamptz not null, snooze_count integer not null default 1 check(snooze_count>=1),
 created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists public.purchase_support_tickets (
 id uuid primary key default gen_random_uuid(), purchase_id bigint not null unique references public.purchases(id) on delete restrict,
 user_id uuid not null references auth.users(id) on delete cascade,
 issue_type text not null check(issue_type in ('not_received','wrong_item','invalid_content','other')),
 customer_message text not null check(char_length(btrim(customer_message)) between 10 and 2000),
 status text not null default 'open' check(status in ('open','in_review','resolved','rejected')), admin_response text,
 created_at timestamptz not null default now(), updated_at timestamptz not null default now(), resolved_at timestamptz
);
create index if not exists purchase_reviews_status_created_idx on public.purchase_reviews(status,created_at desc);
create index if not exists purchase_reviews_user_created_idx on public.purchase_reviews(user_id,created_at desc);
create index if not exists purchase_review_reminders_due_idx on public.purchase_review_reminders(user_id,remind_after);
create index if not exists purchase_support_tickets_status_created_idx on public.purchase_support_tickets(status,created_at desc);
create index if not exists purchase_support_tickets_user_created_idx on public.purchase_support_tickets(user_id,created_at desc);
alter table public.purchase_reviews enable row level security;
alter table public.purchase_review_reminders enable row level security;
alter table public.purchase_support_tickets enable row level security;
create policy purchase_reviews_read_own_or_admin on public.purchase_reviews for select to authenticated using(user_id=(select auth.uid()) or (select public.is_admin()) is true);
create policy purchase_review_reminders_read_own_or_admin on public.purchase_review_reminders for select to authenticated using(user_id=(select auth.uid()) or (select public.is_admin()) is true);
create policy purchase_support_tickets_read_own_or_admin on public.purchase_support_tickets for select to authenticated using(user_id=(select auth.uid()) or (select public.is_admin()) is true);
grant select on public.purchase_reviews,public.purchase_review_reminders,public.purchase_support_tickets to authenticated;
revoke insert,update,delete on public.purchase_reviews,public.purchase_review_reminders,public.purchase_support_tickets from anon,authenticated;
-- RPCs are defined in the next migration file to keep schema and routines separate.
