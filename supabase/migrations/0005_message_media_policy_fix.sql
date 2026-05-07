create or replace function public.can_upload_message_media(channel_id_text text, user_id_text text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select
    case
      when channel_id_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then false
      when user_id_text <> auth.uid()::text then false
      else exists (
        select 1
        from public.channels c
        join public.server_members sm on sm.server_id = c.server_id
        where c.id = channel_id_text::uuid
          and sm.user_id = auth.uid()
      )
    end;
$$;

alter table public.messages
  drop constraint if exists public_message_has_content;

alter table public.messages
  add constraint public_message_payload_shape check (
    (privacy = 'public' and encrypted_payload is null)
    or (privacy = 'e2ee' and content is null and encrypted_payload is not null)
  );

drop policy if exists message_media_channel_member_insert on storage.objects;

create policy message_media_channel_member_insert on storage.objects
for insert with check (
  bucket_id = 'message-media'
  and public.can_upload_message_media(
    (storage.foldername(name))[1],
    (storage.foldername(name))[2]
  )
);
