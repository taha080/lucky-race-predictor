-- ============================================================================
-- Lucky Race Predictor — migration: security hardening (2026-11-21)
-- Run in the Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to run more than once (DROP POLICY IF EXISTS / OR REPLACE).
--
-- Fixes two holes found in the 2026-11-21 audit (see
-- SECURITY_AUDIT_2026-11-21.md, findings S-01 and S-02):
--
--   S-01 CRITICAL — any signed-in user could make themselves admin:
--     profiles_update_own allowed updating is_admin on their own row.
--     Fixed by a trigger that blocks is_admin / email changes unless the
--     caller is an admin (or there is no auth user: SQL Editor /
--     service_role, which is how the owner makes someone admin).
--
--   S-02 HIGH — any signed-in user could list ALL users' emails:
--     profiles_select_authenticated used (true). Fixed: own row only,
--     or any row for admins. The admin panel still works.
--
-- Also tightens profiles_insert_own (own id + own auth email +
-- is_admin = false) and lets admins update any profile row (e.g. to fix
-- a username).
--
-- After running it, verify with the checks at the bottom. The matching
-- app code (js/app.js) renders emails/usernames as text, never as HTML.
-- ============================================================================

-- ---------- profiles: read only your own row (or any row if admin) --------
drop policy if exists "profiles_select_authenticated" on public.profiles;
create policy "profiles_select_authenticated"
  on public.profiles for select
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()));

-- ---------- profiles: inserts must be your own, non-admin row --------------
drop policy if exists "profiles_insert_own" on public.profiles;
create policy "profiles_insert_own"
  on public.profiles for insert
  to authenticated
  with check (id = auth.uid() and email = auth.email() and is_admin = false);

-- ---------- profiles: updates — own row, or any row if admin ---------------
drop policy if exists "profiles_update_own" on public.profiles;
create policy "profiles_update_own"
  on public.profiles for update
  to authenticated
  using (id = auth.uid() or public.is_admin(auth.uid()))
  with check (id = auth.uid() or public.is_admin(auth.uid()));

-- ---------- trigger: block is_admin / email changes by non-admins ---------
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

-- ---------- verify (run these and check the output) ------------------------
-- 1. Policies on profiles (expect select/insert/update as above):
--      select policyname, cmd, qual, with_check
--      from pg_policies where tablename = 'profiles' order by cmd;
-- 2. Trigger exists:
--      select trigger_name from information_schema.triggers
--      where event_object_table = 'profiles'
--        and trigger_name = 'prevent_profile_privilege_change';
-- 3. Admins are still admins (both owner accounts must show true):
--      select email, is_admin from public.profiles
--      where email in ('ahantaha16@gmail.com', 'ahsantaha16@gmail.com');
