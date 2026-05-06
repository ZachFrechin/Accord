create table public.server_roles (
  id uuid primary key default gen_random_uuid(),
  server_id uuid not null references public.servers(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  color text not null default '#8b9cff' check (color ~ '^#[0-9A-Fa-f]{6}$'),
  mentionable boolean not null default true,
  position integer not null default 0,
  created_at timestamptz not null default now(),
  unique (server_id, name)
);

create table public.server_member_roles (
  server_id uuid not null,
  user_id uuid not null,
  role_id uuid not null references public.server_roles(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (server_id, user_id, role_id),
  foreign key (server_id, user_id)
    references public.server_members(server_id, user_id)
    on delete cascade
);

create table public.message_mentions (
  message_id uuid not null references public.messages(id) on delete cascade,
  mentioned_user_id uuid references public.profiles(id) on delete cascade,
  mentioned_role_id uuid references public.server_roles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint message_mentions_one_target check (
    (mentioned_user_id is not null and mentioned_role_id is null)
    or (mentioned_user_id is null and mentioned_role_id is not null)
  )
);

create index server_roles_server_idx on public.server_roles(server_id, position);
create index server_member_roles_user_idx on public.server_member_roles(server_id, user_id);
create index message_mentions_message_idx on public.message_mentions(message_id);

alter table public.server_roles enable row level security;
alter table public.server_member_roles enable row level security;
alter table public.message_mentions enable row level security;

create policy server_roles_member_select on public.server_roles
  for select using (
    exists (
      select 1 from public.server_members sm
      where sm.server_id = server_roles.server_id and sm.user_id = auth.uid()
    )
  );

create policy server_member_roles_member_select on public.server_member_roles
  for select using (
    exists (
      select 1 from public.server_members viewer
      where viewer.server_id = server_member_roles.server_id and viewer.user_id = auth.uid()
    )
  );

create policy message_mentions_channel_member_select on public.message_mentions
  for select using (
    exists (
      select 1
      from public.messages m
      join public.channels c on c.id = m.channel_id
      left join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
      left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = auth.uid()
      where m.id = message_mentions.message_id and (sm.user_id is not null or cm.user_id is not null)
    )
  );
