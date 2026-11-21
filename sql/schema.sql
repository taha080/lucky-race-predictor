-- ============================================================================
-- Lucky Race Predictor — Supabase schema
-- Run this in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- It creates: profiles, subscriptions, races, an is_admin() helper, RLS
-- policies, and a trigger that creates a profile row on every new sign-up.
-- No service_role key is needed by the app; everything runs as the user.
-- ============================================================================

-- NOTE: the profiles table MUST be created before is_admin() — Postgres
-- validates the function body at creation time, and is_admin() reads
-- public.profiles (running the function first fails with 42P01).

-- ---------- profiles --------------------------------------------------------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

-- Users can read all profiles (needed for the admin user list).
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (true);

-- Users can insert their own profile row (also done by the trigger below).
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid());

-- Users can update only their own row (email). is_admin is set by the owner
-- in the SQL editor, never by the app.
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

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

-- Auto-create a profile row when a user signs up.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
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
