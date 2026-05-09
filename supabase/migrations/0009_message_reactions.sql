create table if not exists public.message_reactions (
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  primary key (message_id, user_id, emoji)
);

create index if not exists message_reactions_message_idx
  on public.message_reactions(message_id);

alter table public.message_reactions enable row level security;

drop policy if exists message_reactions_channel_member_select on public.message_reactions;
create policy message_reactions_channel_member_select on public.message_reactions
  for select using (
    exists (
      select 1
      from public.messages m
      join public.channels c on c.id = m.channel_id
      left join public.server_members sm on sm.server_id = c.server_id and sm.user_id = auth.uid()
      left join public.channel_members cm on cm.channel_id = c.id and cm.user_id = auth.uid()
      where m.id = message_reactions.message_id and (sm.user_id is not null or cm.user_id is not null)
    )
  );
