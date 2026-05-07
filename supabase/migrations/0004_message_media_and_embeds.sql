insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'message-media',
  'message-media',
  true,
  26214400,
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime'
  ]
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.attachments
  add column if not exists file_name text,
  add column if not exists width integer check (width is null or width > 0),
  add column if not exists height integer check (height is null or height > 0),
  add column if not exists duration_ms integer check (duration_ms is null or duration_ms > 0);

create table public.message_embeds (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  type text not null check (type in ('youtube', 'image', 'link')),
  url text not null,
  title text,
  description text,
  thumbnail_url text,
  provider text,
  embed_url text,
  created_at timestamptz not null default now()
);

create index message_embeds_message_idx on public.message_embeds(message_id);

alter table public.message_embeds enable row level security;

create policy message_embeds_channel_member_select on public.message_embeds
for select using (
  exists (
    select 1
    from public.messages m
    join public.channels c on c.id = m.channel_id
    left join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
    left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = auth.uid()
    where m.id = message_embeds.message_id and (sm.user_id is not null or cm.user_id is not null)
  )
);

drop policy if exists message_media_channel_member_insert on storage.objects;

create policy message_media_channel_member_insert on storage.objects
for insert with check (
  bucket_id = 'message-media'
  and (storage.foldername(name))[2] = auth.uid()::text
  and exists (
    select 1
    from public.channels c
    join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
    where c.id = ((storage.foldername(name))[1])::uuid
  )
);
