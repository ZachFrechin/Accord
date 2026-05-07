-- Make message-media bucket private: blobs are served via signed URLs only.
update storage.buckets
set public = false
where id = 'message-media';

-- Drop pre-existing permissive policies on storage.objects for this bucket if any.
drop policy if exists "message_media_public_select" on storage.objects;

-- SELECT: a user may download a blob from message-media only if they are a member of the
-- server that owns the channel encoded in the storage path ({channelId}/{userId}/{uuid}).
create policy "message_media_member_select" on storage.objects
  for select using (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and (
      -- Member of the server that owns the channel (server text channels)
      exists (
        select 1
        from public.channels c
        join public.server_members sm on sm.server_id = c.server_id
        where c.id::text = (storage.foldername(name))[1]
          and sm.user_id = auth.uid()
          and c.server_id is not null
      )
      or
      -- Direct channel member (DM channels)
      exists (
        select 1
        from public.channel_members cm
        where cm.channel_id::text = (storage.foldername(name))[1]
          and cm.user_id = auth.uid()
      )
    )
  );

-- INSERT: uploader must be the authenticated user whose id matches the second path segment.
-- They must also be a member of the channel (or its server).
create policy "message_media_member_insert" on storage.objects
  for insert with check (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and auth.uid()::text = (storage.foldername(name))[2]
    and (
      exists (
        select 1
        from public.channels c
        join public.server_members sm on sm.server_id = c.server_id
        where c.id::text = (storage.foldername(name))[1]
          and sm.user_id = auth.uid()
          and c.server_id is not null
      )
      or
      exists (
        select 1
        from public.channel_members cm
        where cm.channel_id::text = (storage.foldername(name))[1]
          and cm.user_id = auth.uid()
      )
    )
  );

-- DELETE: only the uploader may delete their own blobs.
create policy "message_media_owner_delete" on storage.objects
  for delete using (
    bucket_id = 'message-media'
    and auth.uid() is not null
    and auth.uid()::text = (storage.foldername(name))[2]
  );

-- Fix e2ee_conversations RLS: the previous policy only matched channel_members
-- (DM-style tables) and missed channels owned by servers (which use server_members).
drop policy if exists "e2ee_conversations_member_select" on public.e2ee_conversations;

create policy "e2ee_conversations_member_select" on public.e2ee_conversations
  for select using (
    -- Server channel: caller must be a server member
    exists (
      select 1
      from public.channels c
      join public.server_members sm on sm.server_id = c.server_id
      where c.id = e2ee_conversations.channel_id
        and sm.user_id = auth.uid()
        and c.server_id is not null
    )
    or
    -- DM channel: caller must be an explicit channel member
    exists (
      select 1 from public.channel_members cm
      where cm.channel_id = e2ee_conversations.channel_id
        and cm.user_id = auth.uid()
    )
  );

-- Performance indexes for hot E2EE lookup paths.
create index if not exists crypto_devices_user_revoked_idx
  on public.crypto_devices(user_id, revoked_at);

create index if not exists e2ee_conversation_keys_device_version_idx
  on public.e2ee_conversation_keys(device_id, key_version);
