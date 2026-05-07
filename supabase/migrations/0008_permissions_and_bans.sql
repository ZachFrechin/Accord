alter table public.server_roles
  add column if not exists permissions text[] not null default '{}';

create table if not exists public.channel_permission_overwrites (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references public.channels(id) on delete cascade,
  target_type text not null check (target_type in ('everyone', 'role', 'member')),
  target_id uuid,
  allow_permissions text[] not null default '{}',
  deny_permissions text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint channel_permission_overwrites_target check (
    (target_type = 'everyone' and target_id is null)
    or (target_type in ('role', 'member') and target_id is not null)
  ),
  unique (channel_id, target_type, target_id)
);

create table if not exists public.server_bans (
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  banned_by uuid not null references public.profiles(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

create index if not exists channel_permission_overwrites_channel_idx
  on public.channel_permission_overwrites(channel_id);

create index if not exists server_bans_user_idx
  on public.server_bans(user_id);

alter table public.channel_permission_overwrites enable row level security;
alter table public.server_bans enable row level security;

drop policy if exists channel_permission_overwrites_member_select on public.channel_permission_overwrites;
create policy channel_permission_overwrites_member_select on public.channel_permission_overwrites
  for select using (
    exists (
      select 1
      from public.channels c
      join public.server_members sm on sm.server_id = c.server_id
      where c.id = channel_permission_overwrites.channel_id
        and sm.user_id = auth.uid()
    )
  );

drop policy if exists server_bans_member_select on public.server_bans;
create policy server_bans_member_select on public.server_bans
  for select using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = server_bans.server_id and sm.user_id = auth.uid()
    )
  );
