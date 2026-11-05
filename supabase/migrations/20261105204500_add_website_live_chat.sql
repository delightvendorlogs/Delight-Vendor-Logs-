create table if not exists public.support_chat_conversations (
 id uuid primary key default gen_random_uuid(),
 customer_user_id uuid not null references auth.users(id) on delete cascade,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 last_message_at timestamptz not null default now(),
 last_message_preview text,
 bot_replied_at timestamptz,
 last_alert_at timestamptz
);
create index if not exists support_chat_conversations_customer_last_idx on public.support_chat_conversations(customer_user_id,last_message_at desc);
create index if not exists support_chat_conversations_last_idx on public.support_chat_conversations(last_message_at desc);

create table if not exists public.support_chat_messages (
 id uuid primary key default gen_random_uuid(),
 conversation_id uuid not null references public.support_chat_conversations(id) on delete cascade,
 sender_user_id uuid references auth.users(id) on delete set null,
 sender_role text not null check(sender_role in ('customer','admin','bot')),
 message_text text,
 image_path text,
 created_at timestamptz not null default now(),
 constraint support_chat_message_content_check check (
  (message_text is not null and length(trim(message_text)) between 1 and 4000)
  or image_path is not null
 )
);
create index if not exists support_chat_messages_conversation_created_idx on public.support_chat_messages(conversation_id,created_at);

create table if not exists public.support_chat_settings (
 id boolean primary key default true check(id),
 admin_last_seen_at timestamptz,
 away_after_minutes integer not null default 2 check(away_after_minutes between 1 and 60),
 welcome_message text not null default 'Hi! Thanks for contacting Delight Vendor Logs. Tell us what you need help with, and you can attach a screenshot here.',
 away_message text not null default 'Thanks for your message. Our support team is away right now, but you can leave the details here. We will reply in this conversation as soon as possible.',
 updated_at timestamptz not null default now()
);
insert into public.support_chat_settings(id) values(true) on conflict(id) do nothing;

alter table public.support_chat_conversations enable row level security;
alter table public.support_chat_messages enable row level security;
alter table public.support_chat_settings enable row level security;

drop policy if exists support_chat_conversations_read on public.support_chat_conversations;
create policy support_chat_conversations_read on public.support_chat_conversations for select to authenticated
 using ((select auth.uid())=customer_user_id or (select public.is_admin()));
drop policy if exists support_chat_conversations_create on public.support_chat_conversations;
create policy support_chat_conversations_create on public.support_chat_conversations for insert to authenticated
 with check ((select auth.uid())=customer_user_id);
drop policy if exists support_chat_messages_read on public.support_chat_messages;
create policy support_chat_messages_read on public.support_chat_messages for select to authenticated
 using ((select public.is_admin()) or exists (
  select 1 from public.support_chat_conversations c where c.id=support_chat_messages.conversation_id and c.customer_user_id=(select auth.uid())
 ));
drop policy if exists support_chat_messages_create on public.support_chat_messages;
create policy support_chat_messages_create on public.support_chat_messages for insert to authenticated
 with check (
  sender_user_id=(select auth.uid()) and (
   (sender_role='admin' and (select public.is_admin()))
   or (sender_role='customer' and exists (
    select 1 from public.support_chat_conversations c where c.id=support_chat_messages.conversation_id and c.customer_user_id=(select auth.uid())
   ))
  )
 );
drop policy if exists support_chat_settings_read on public.support_chat_settings;
create policy support_chat_settings_read on public.support_chat_settings for select to authenticated using (true);
drop policy if exists support_chat_settings_admin_update on public.support_chat_settings;
create policy support_chat_settings_admin_update on public.support_chat_settings for update to authenticated
 using ((select public.is_admin())) with check ((select public.is_admin()));

create or replace function public.update_support_chat_conversation_preview()
returns trigger language plpgsql security definer set search_path to ''
as $function$
begin
 update public.support_chat_conversations
 set last_message_at=new.created_at,updated_at=now(),
     last_message_preview=coalesce(nullif(left(trim(new.message_text),180),''),'📷 Image attachment'),
     bot_replied_at=case when new.sender_role='bot' then new.created_at else bot_replied_at end
 where id=new.conversation_id;
 return new;
end;
$function$;
revoke all on function public.update_support_chat_conversation_preview() from public,anon,authenticated;
drop trigger if exists support_chat_message_preview_trigger on public.support_chat_messages;
create trigger support_chat_message_preview_trigger after insert on public.support_chat_messages
 for each row execute function public.update_support_chat_conversation_preview();

grant usage on schema public to authenticated;
grant select,insert on public.support_chat_conversations to authenticated;
grant select,insert on public.support_chat_messages to authenticated;
grant select,update on public.support_chat_settings to authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('support-chat-images','support-chat-images',false,5242880,array['image/jpeg','image/png','image/webp','image/gif'])
on conflict(id) do update set public=false,file_size_limit=5242880,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists support_chat_images_read on storage.objects;
create policy support_chat_images_read on storage.objects for select to authenticated using (
 bucket_id='support-chat-images' and exists(
  select 1 from public.support_chat_conversations c where c.id::text=(storage.foldername(name))[1]
   and (c.customer_user_id=(select auth.uid()) or (select public.is_admin()))
 )
);
drop policy if exists support_chat_images_insert on storage.objects;
create policy support_chat_images_insert on storage.objects for insert to authenticated with check (
 bucket_id='support-chat-images' and exists(
  select 1 from public.support_chat_conversations c where c.id::text=(storage.foldername(name))[1]
   and ((c.customer_user_id=(select auth.uid()) and (storage.foldername(name))[2]=(select auth.uid())::text) or (select public.is_admin()))
 )
);
do $publication$
begin
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='support_chat_conversations') then alter publication supabase_realtime add table public.support_chat_conversations; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='support_chat_messages') then alter publication supabase_realtime add table public.support_chat_messages; end if;
 if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='support_chat_settings') then alter publication supabase_realtime add table public.support_chat_settings; end if;
end
$publication$;
