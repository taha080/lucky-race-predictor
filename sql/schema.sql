-- ============================================================================
-- Lucky Race Predictor — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- It creates: profiles, subscriptions, races, an is_admin() helper, RLS
-- policies, and a trigger that creates a profile row on every new sign-up.
-- No service_role key is needed by the app; everything runs as the user.
-- 2026-11-21: profiles gained username (citext, unique, 3-20 chars) and
-- hardened RLS (own-row reads, no self-admin); see
-- SECURITY_AUDIT_2026-11-21.md. Existing projects: run
-- sql/migration-username.sql and sql/migration-security-2026-11-21.sql
-- instead of re-running this file.
-- ============================================================================

-- NOTE: the profiles table MUST be created before is_admin() — Postgres
-- validates the function body at creation time, and is_admin() reads
-- public.profiles (running the function first fails with 42P01).

-- ---------- profiles --------------------------------------------------------
-- citext gives case-insensitive usernames: 'Taha' and 'taha' are the same.
create extension if not exists citext;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  username citext,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

-- Usernames: 3-20 letters, numbers or underscore; unique ignoring case.
create unique index if not exists profiles_username_unique
  on public.profiles (username);
alter table public.profiles
  drop constraint if exists profiles_username_format;
alter table public.profiles
  add constraint profiles_username_format
  check (username is null or username ~ '^[A-Za-z0-9_]{3,20}$');

alter table public.profiles enable row level security;

-- SECURITY FIX 2026-11-21: the old policy let ANY signed-in user read ALL
-- profiles (every user's email). Now: your own row, or any row if admin.
-- The admin panel still works (admins read all); nobody else can list users.
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()));

-- Users can insert their own profile row (also done by the trigger below).
-- SECURITY FIX 2026-11-21: the row must carry the caller's own id, their
-- own auth email, and is_admin = false — a user must not be able to
-- create a row that is already admin.
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid() and email = auth.email() and is_admin = false);

-- Users can update only their own row (username); admins can update any
-- row (e.g. to fix a username). is_admin and email are guarded by the
-- trigger below, never by the app.
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()))
  with check (id = auth.uid() or public.is_admin(auth.uid()));

-- ---------- Helper: is this user an admin? ---------------------------------
-- SECURITY DEFINER so RLS policies can call it without recursion.
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = uid and p.is_admin = true
  );
$$;

-- SECURITY FIX 2026-11-21: stop privilege escalation through profiles.
-- The old update policy let ANY user set their own is_admin = true (and
-- change their email to anyone's). This trigger blocks is_admin / email
-- changes unless the caller is an admin — or there is no auth user at all
-- (auth.uid() IS NULL: direct database access such as the SQL Editor or a
-- service_role key, which is how the owner makes someone admin).
create or replace function public.prevent_profile_privilege_change()
returns trigger
language plpgsql
security definer
as $$
begin
  if auth.uid() is not null and not public.is_admin(auth.uid()) then
    if old.is_admin is distinct from new.is_admin then
      raise exception 'Only an admin can change is_admin';
    end if;
    if old.email is distinct from new.email then
      raise exception 'Only an admin can change the profile email';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists prevent_profile_privilege_change on public.profiles;
create trigger prevent_profile_privilege_change
  before update on public.profiles
  for each row execute function public.prevent_profile_privilege_change();

-- Auto-create a profile row when a user signs up.
-- The username comes from the sign-up metadata (options.data.username);
-- if it is taken or invalid, the profile is still created WITHOUT a
-- username — sign-up must never fail because of a username clash.
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

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------- subscriptions ---------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null,
  status text not null default 'active' check (status in ('active', 'revoked', 'expired')),
  granted_by uuid references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (user_id)
);

alter table public.subscriptions enable row level security;

-- Owners read their own subscription; admins read all.
create policy "subscriptions_select_own_or_admin"
  on public.subscriptions for select
  to authenticated
  using (user_id = auth.uid() or public.is_admin(auth.uid()));

-- Only admins can grant / update / revoke subscriptions.
create policy "subscriptions_insert_admin"
  on public.subscriptions for insert
  to authenticated
  with check (public.is_admin(auth.uid()));

create policy "subscriptions_update_admin"
  on public.subscriptions for update
  to authenticated
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy "subscriptions_delete_admin"
  on public.subscriptions for delete
  to authenticated
  using (public.is_admin(auth.uid()));

-- ---------- races -----------------------------------------------------------
create table if not exists public.races (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles (id) on delete cascade,
  vehicles jsonb not null,          -- ["ORV", "SUV", "Monster Truck"]
  tracks jsonb not null,            -- ["Desert", "Bumpy", "Dirt"] (segments 1-3);
                                    -- any entry may be "unknown" when that
                                    -- segment's track was not shown/known
  patterns jsonb not null default '[]'::jsonb, -- hinted track types shown on screen
  winner text not null,
  how_won text,
  how_won_text text,
  odds jsonb not null default '{}'::jsonb,     -- {"ORV": 2.3, ...}
  created_at timestamptz not null default now()
);

alter table public.races enable row level security;

-- Each user sees / edits ONLY their own races.
create policy "races_select_own"
  on public.races for select
  to authenticated
  using (user_id = auth.uid());

create policy "races_insert_own"
  on public.races for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "races_update_own"
  on public.races for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

create policy "races_delete_own"
  on public.races for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------- Make the first admin -------------------------------------------
-- After you create your account in the app, run this (replace the email):
--   update public.profiles set is_admin = true where email = 'owner@example.com';
-- If you also listed the email in js/config.js ADMIN_EMAILS, the admin panel
-- shows even before this, but the database writes above need is_admin = true.
