-- ============================================================================
-- Lucky Race Predictor — migration: usernames
-- Run in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to run more than once (IF NOT EXISTS / OR REPLACE throughout).
--
-- What it does:
--   1. Adds public.profiles.username (citext = case-insensitive text).
--   2. Unique index on username (so 'Taha' and 'taha' cannot both exist).
--   3. Format check: 3-20 letters, numbers or underscore.
--   4. Updates handle_new_user() so a username passed at sign-up
--      (options.data.username) is stored — and if it is taken or invalid,
--      the profile is still created WITHOUT a username, so sign-up never
--      fails because of a username clash. The user can pick another name
--      later from the Account tab.
--
-- After running it, deploy the matching app code (js/app.js) — the sign-up
-- form, the Account-tab username card and the admin search need it.
-- ============================================================================

create extension if not exists citext;

alter table public.profiles
  add column if not exists username citext;

create unique index if not exists profiles_username_unique
  on public.profiles (username);

alter table public.profiles
  drop constraint if exists profiles_username_format;
alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[A-Za-z0-9_]{3,20}$');

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
declare
  v_username citext;
begin
  v_username := nullif(btrim(new.raw_user_meta_data ->> 'username'), '');
  if v_username is not null then
    begin
      insert into public.profiles (id, email, username)
      values (new.id, new.email, v_username);
      return new;
    exception when unique_violation or check_violation then
      insert into public.profiles (id, email)
      values (new.id, new.email)
      on conflict (id) do nothing;
      return new;
    end;
  end if;
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

-- Verify: expect one row per user, username NULL for existing users.
--   select id, email, username, is_admin from public.profiles order by email;
