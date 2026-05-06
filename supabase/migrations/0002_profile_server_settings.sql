alter table public.servers
  add column if not exists avatar_url text;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('profile-avatars', 'profile-avatars', true, 2097152, array['image/png', 'image/jpeg', 'image/webp']),
  ('server-icons', 'server-icons', true, 2097152, array['image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists profile_avatars_owner_insert on storage.objects;
drop policy if exists server_icons_manager_insert on storage.objects;

create or replace function public.can_upload_server_icon(target_server_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.server_members sm
    where sm.server_id = target_server_id
      and sm.user_id = auth.uid()
      and sm.role in ('owner', 'admin')
  );
$$;

create policy profile_avatars_owner_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'profile-avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy server_icons_manager_insert on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'server-icons'
    and public.can_upload_server_icon(((storage.foldername(name))[1])::uuid)
  );
