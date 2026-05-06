create extension if not exists pgcrypto;

create type public.channel_type as enum ('text', 'private_text', 'voice', 'direct_message');
create type public.message_privacy as enum ('public', 'e2ee');
create type public.member_role as enum ('owner', 'admin', 'member');

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.servers (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  owner_id uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.server_members (
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role public.member_role not null default 'member',
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

create table public.channels (
  id uuid primary key default gen_random_uuid(),
  server_id uuid references public.servers(id) on delete cascade,
  type public.channel_type not null,
  name text not null check (char_length(name) between 1 and 80),
  is_private boolean not null default false,
  created_at timestamptz not null default now(),
  constraint direct_message_has_no_server check (
    (type = 'direct_message' and server_id is null)
    or (type <> 'direct_message' and server_id is not null)
  )
);

create table public.channel_members (
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  added_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  author_id uuid not null references public.profiles(id) on delete restrict,
  privacy public.message_privacy not null,
  content text,
  encrypted_payload jsonb,
  created_at timestamptz not null default now(),
  edited_at timestamptz,
  constraint public_message_has_content check (
    (privacy = 'public' and content is not null and encrypted_payload is null)
    or (privacy = 'e2ee' and content is null and encrypted_payload is not null)
  )
);

create table public.attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  storage_path text not null,
  mime_type text not null,
  byte_size bigint not null check (byte_size > 0),
  is_e2ee boolean not null default false,
  encrypted_payload jsonb,
  created_at timestamptz not null default now()
);

create table public.invites (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  code text not null unique,
  created_by uuid not null references public.profiles(id) on delete restrict,
  expires_at timestamptz,
  used_by uuid references public.profiles(id) on delete set null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.crypto_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table public.e2ee_conversations (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null unique references public.channels(id) on delete cascade,
  current_key_version integer not null default 1,
  created_at timestamptz not null default now()
);

create table public.e2ee_conversation_keys (
  conversation_id uuid not null references public.e2ee_conversations(id) on delete cascade,
  device_id uuid not null references public.crypto_devices(id) on delete cascade,
  key_version integer not null check (key_version > 0),
  wrapped_key text not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, device_id, key_version)
);

create index messages_channel_created_at_idx on public.messages(channel_id, created_at desc);
create index server_members_user_idx on public.server_members(user_id);
create index channel_members_user_idx on public.channel_members(user_id);
create index invites_code_idx on public.invites(code);

alter table public.profiles enable row level security;
alter table public.servers enable row level security;
alter table public.server_members enable row level security;
alter table public.channels enable row level security;
alter table public.channel_members enable row level security;
alter table public.messages enable row level security;
alter table public.attachments enable row level security;
alter table public.invites enable row level security;
alter table public.crypto_devices enable row level security;
alter table public.e2ee_conversations enable row level security;
alter table public.e2ee_conversation_keys enable row level security;

create policy profiles_self_select on public.profiles
  for select using (id = auth.uid());

create policy servers_member_select on public.servers
  for select using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = servers.id and sm.user_id = auth.uid()
    )
  );

create policy server_members_member_select on public.server_members
  for select using (
    exists (
      select 1 from public.server_members viewer
      where viewer.server_id = server_members.server_id and viewer.user_id = auth.uid()
    )
  );

create policy channels_member_select on public.channels
  for select using (
    (server_id is not null and exists (
      select 1 from public.server_members sm
      where sm.server_id = channels.server_id and sm.user_id = auth.uid()
    ))
    or exists (
      select 1 from public.channel_members cm
      where cm.channel_id = channels.id and cm.user_id = auth.uid()
    )
  );

create policy channel_members_self_select on public.channel_members
  for select using (user_id = auth.uid());

create policy messages_channel_member_select on public.messages
  for select using (
    exists (
      select 1
      from public.channels c
      left join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
      left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = auth.uid()
      where c.id = messages.channel_id and (sm.user_id is not null or cm.user_id is not null)
    )
  );

create policy attachments_message_member_select on public.attachments
  for select using (
    exists (
      select 1 from public.messages m
      where m.id = attachments.message_id
    )
  );

create policy invites_creator_select on public.invites
  for select using (created_by = auth.uid());

create policy crypto_devices_owner_select on public.crypto_devices
  for select using (user_id = auth.uid());

create policy e2ee_conversations_member_select on public.e2ee_conversations
  for select using (
    exists (
      select 1 from public.channel_members cm
      where cm.channel_id = e2ee_conversations.channel_id and cm.user_id = auth.uid()
    )
  );

create policy e2ee_conversation_keys_device_select on public.e2ee_conversation_keys
  for select using (
    exists (
      select 1 from public.crypto_devices cd
      where cd.id = e2ee_conversation_keys.device_id and cd.user_id = auth.uid()
    )
  );
