# Lucky Race Predictor — Deep Security Audit

**Date:** 21 November 2026
**Auditor:** Muse (subagent, local code review only — no live database touched)
**Scope:** `~/workspace/lucky-race-predictor/` — `js/app.js` (2,002 lines), `js/config.js`,
`index.html`, `css/style.css`, `sql/schema.sql`, `README.md`
**Live site:** https://taha080.github.io/lucky-race-predictor/ (repo `taha080/lucky-race-predictor`)
**Supabase project:** `lucky-race-predictor`, ref `alqqhzbgcodgdbbcrinm` (Singapore, Free plan)

## Verdict

**19 findings: 1 Critical, 4 High, 8 Medium, 6 Low.** Everything fixable in code is
fixed in the local files in this folder. **Two fixes are NOT live yet and cannot be
fixed by code alone — they need the two migration files run in the Supabase SQL
Editor** (see "What still needs a dashboard action"). Until the security migration
runs, the live database still has the old, exploitable profiles policies — so run
it before (or together with) deploying the new code.

The app is **safe to keep using as-is for the owner** (he is admin; the holes mostly
let a *non-admin* user escalate or read other users' emails). It is **not safe to
onboard paying users at scale** until the migration is applied and a custom SMTP
provider is set up (the 2-emails/hour limit is already breaking sign-ups).

**Nothing was deployed by this audit. No live database change was made. No account
was created, deleted or modified. No password was set or changed. The 40 races
were not touched.**

---

## Findings

### CRITICAL

#### S-01 — Any signed-in user could make themselves admin (privilege escalation)
- **Where:** `sql/schema.sql` — old `profiles_update_own` policy
  (`using (id = auth.uid()) with check (id = auth.uid())`). Nothing in the
  policy restricted *which columns* could change, so any authenticated user
  could run `update profiles set is_admin = true where id = auth.uid()` and
  become admin — then grant/revoke premium for anyone and read every profile.
- **Fixed in code:** a database trigger blocks it — `prevent_profile_privilege_change()`
  (`sql/schema.sql:87-106`): a non-admin caller may not change `is_admin` or
  `email` on any profile row. Direct database access (SQL Editor / service_role,
  where `auth.uid()` is NULL) is still allowed — that is how the owner makes
  someone admin. The update policy was also tightened (`sql/schema.sql:61-65`).
- **Still needed:** run `sql/migration-security-2026-11-21.sql` in the SQL Editor.
  **Until it runs, the live database is still vulnerable to this.**

### HIGH

#### S-02 — Any signed-in user could list ALL users' emails
- **Where:** `sql/schema.sql` — old `profiles_select_authenticated`
  (`using (true)`). Every signed-in user could `select * from profiles` and
  harvest every customer's email address.
- **Fixed in code:** `using (id = auth.uid() or public.is_admin(auth.uid()))`
  (`sql/schema.sql:44-47`). Users read only their own row; admins read all
  (the admin panel still works).
- **Still needed:** run `sql/migration-security-2026-11-21.sql`. Until it runs,
  the live database still leaks the list.

#### S-03 — Demo-mode fallback unlocked the whole app if the Supabase CDN failed
- **Where:** `js/app.js` — old `initSupabase()` set `DEMO_MODE = true` when the
  Supabase JS library failed to load, and demo mode sets `subActive = true`
  (unlocked). Anyone could use the full app on the live site by blocking
  `cdn.jsdelivr.net`.
- **Fixed in code:** a failed CDN load on a *configured* site now sets
  `sbLoadFailed = true` (`js/app.js:147, 590-598`) instead of demo mode.
  `appAccessFor()` returns `{ok:false, reason:'offline'}` (`js/app.js:909`),
  the app shows "Could not reach the login server — check your connection and
  reload" (`js/app.js:1555, 1895`), and nothing is unlocked. Demo mode now
  applies only when Supabase was never configured at all (local development).

#### S-04 — Stored XSS: profile emails rendered as HTML in the admin panel
- **Where:** `js/app.js` — old `renderAdminPanel()` built rows with
  `row.innerHTML = '... ' + u.email + ' ...'`, and the owner/status cards used
  `innerHTML` with `currentUser.email`. A profile email is user-controlled
  data; a user could set their `profiles.email` to markup (e.g.
  `<img src=x onerror=...>`) and it would execute in the *owner's* browser
  when he opens the admin panel — inside his admin session.
- **Fixed in code:** all email/username rendering now uses `textContent`
  (`adminUserRow()`, `js/app.js:1784-1813`; owner/status cards in
  `renderAccount()`). The trigger in S-01 also blocks non-admins from changing
  their profile email at all. A grep confirms no `innerHTML` anywhere in
  `app.js` interpolates an email or username. (`toast()` already used
  `textContent`, `js/app.js:215-222`.)
- **Still needed:** the S-01 trigger (migration) for the email-change block.

#### S-05 — No password set/change flow existed at all
- **Where:** `js/app.js` — before this audit there was no `updateUser`, no
  `resetPasswordForEmail`, no `PASSWORD_RECOVERY` handler and no
  `onAuthStateChange`. A user who clicked a confirmation link and got signed
  in had **no way to set a password anywhere in the app**.
- **Fixed in code:**
  - "Forgot password?" link on the sign-in form → `resetPasswordForEmail(email,
    { redirectTo: 'https://taha080.github.io/lucky-race-predictor/' })`
    (`js/app.js:1643`), with a clear "check your inbox" message and visible
    errors (e.g. rate limit) in a toast.
  - Recovery handling on load: `onAuthStateChange` listens for
    `PASSWORD_RECOVERY` (`js/app.js:607`) and shows a "Set a new password"
    form (new password + confirm, min 6 chars) calling `updateUser({password})`
    (`js/app.js:1671`).
  - Signed-in "Change password" card in the Account tab (`js/app.js:1767`) —
    **this is how the owner sets his password from the confirmation-link
    session**, since no recovery email will be sent.
  - Expired/used links: the URL hash is parsed for an auth error
    (`parseAuthHashError()`, `js/app.js:247`) and the Account tab shows
    "This link has expired or was already used — request a new one" instead
    of silently showing the locked screen. Auth tokens are cleared from the
    URL hash after use (`clearAuthHash()`, `js/app.js:258`).

### MEDIUM

#### M-01 — Premium gate was UI-only; cloud race functions had no access check
- **Where:** `js/app.js:709, 727, 737` — `cloudInsertRace` / `cloudUpdateRace` /
  `cloudDeleteRace` checked only `sb` and `currentUser`, not premium. A
  non-premium user calling them from the browser console could save races.
- **Fixed in code:** all three now return early unless `appAccess().ok`.
  The gate is now enforced on every path: tab lock overlay
  (`applyTabLocks()`, `js/app.js:939`), prediction renderer
  (`predictionAllowed()`, `js/app.js:966`), the save/export/import action
  guards, and the cloud functions.
- **Residual (accepted risk, be honest about it):** the prediction maths is
  client-side, so a determined user with devtools could call
  `computePrediction` in the console against the public speed table. That is
  inherent to a client-side app — the gate blocks the app for normal users,
  and the valuable part (race history) is per-user and RLS-protected. A
  server-side gate would need a Supabase Edge Function; not built — say so
  if the owner asks for an airtight gate.

#### M-02 — Subscription was checked only at page load
- **Where:** `js/app.js` — `checkSubscription()` ran once at load. A
  subscription expiring mid-session (or a grant made by the owner while the
  user had the app open) went unnoticed until reload.
- **Fixed in code:** a 5-minute re-check while signed in (`js/app.js:1958`)
  — a grant unlocks the app without a reload, an expiry locks it again.
  `checkSubscription()` (`js/app.js:661`) now keeps the previous state on a
  network error instead of locking a paying user out on a blip.

#### M-03 — Stale localStorage race cache could show a previous user's races
- **Where:** `js/app.js` — the cached races were stored without an owner, so
  if cloud sync failed the app could show the last user's races to the next
  user on the same browser.
- **Fixed in code:** owner-tagged cache (`LS_RACES_OWNER`),
  `discardStaleRaceCache()` (`js/app.js:565`) runs after every sign-in and
  before every cloud sync, and sign-out now clears the cache
  (`races = []; saveLocalRaces()`) instead of reloading it.

#### M-04 — Auth tokens lingered in the URL hash after email links
- **Where:** `js/app.js` — after a confirmation/recovery link, the
  `access_token` stayed in the URL (copyable, could end up in logs).
- **Fixed in code:** `clearAuthHash()` is called after session restore in
  `init()` and on `PASSWORD_RECOVERY`.

#### M-05 — Sign-up failures were silent
- **Where:** `js/app.js` — old sign-up showed nothing useful when it failed
  (e.g. the 429 email rate limit), so "Create account" *seemed* broken even
  though the account record was created.
- **Fixed in code:** the sign-in/sign-up form now has a persistent inline
  message line (yellow, always visible — not just a 2.6 s toast),
  client-side validation (valid email, password ≥ 6 chars, matching
  confirmation), buttons disabled while a request is in flight, a
  "Account created — check your email" success message, and an
  "unconfirmed account" hint when sign-in fails because the email was never
  confirmed. Every Supabase error is shown as a clear message, never
  swallowed.

#### M-06 — Data visibility: all 40 races belong to the wrong account
- **Where:** live database (verified 21 Nov 13:57 PKT). All 40 races have
  `user_id = 04d9cfba-0714-4396-b0b6-5001090703c7` (ahantaha16); the main
  account ahsantaha16 (`31018cb1-5a42-4014-8898-05a964b48fac`, admin) has 0.
  RLS (`races_select_own`: `user_id = auth.uid()`) means signing in as
  ahsantaha16 shows no race data — the predictions would be made with no
  history.
- **NOT fixed by this audit.** The fix is a data move, pending the owner's
  say — it is a one-line SQL Editor update (`update public.races set
  user_id = '<ahsantaha16 id>' where user_id = '<ahantaha16 id>';`), to be
  run only after he approves. The 40 races were not touched.

#### M-07 — Email rate limit (2/hour, Supabase free tier) breaks sign-up UX
- **Where:** Supabase dashboard setting (field greyed out — cannot be raised
  in the dashboard). Verified 21 Nov 14:13 PKT: 429 "email rate limit
  exceeded" at 14:06:17 for the tahaahsan43 confirmation; same at 14:01:44
  and 14:02:48 for the ahsantaha16 recovery. The "Create account" button
  itself WORKS (it created the tahaahsan43 record) — the *email* is what
  fails, so nothing seems to happen, and sign-in then fails "Invalid login
  credentials" (unconfirmed).
- **Not fixable in code.** The limit is on *emails*, not on accounts — never
  "fix" it by disabling sign-ups or capping accounts. See dashboard actions
  (custom SMTP). The limit resets roughly hourly (~15:00-15:02 PKT on 21 Nov).

#### M-08 — Leaked-password protection is OFF
- **Where:** Supabase Auth settings (verified by the owner). Users can set
  passwords that have appeared in known data breaches.
- **Not fixable in code.** See dashboard actions — enable it.

### LOW

#### L-01 — No CAPTCHA: junk sign-ups are possible
- Sign-up is open with no bot check. The owner ordered **no limit on new
  accounts — unlimited, forever** — CAPTCHA is not a cap, it only filters
  bots, but it adds friction for real users too. Optional dashboard action;
  his call. Do not disable sign-ups to stop junk accounts.

#### L-02 — No server-side rate limiting on predictions
- Prediction is computed locally in the browser (< 2 ms with 40 races), so
  there is no server cost to abuse. Info only.

#### L-03 — Sign-up errors may reveal whether an email already exists
- The app surfaces Supabase's own sign-up error message. That is Supabase's
  default behaviour; changing it would need a custom auth flow. Low.

#### L-04 — No Content-Security-Policy header
- **Fixed in code:** a CSP meta tag was added (`index.html:11`) — scripts
  only from this site + the Supabase CDN, connections only to Supabase.
  This is defence-in-depth on top of the `textContent` rendering; it does
  not replace it. (A meta-tag CSP cannot cover everything a response header
  can, but GitHub Pages does not let us set response headers.)

#### L-05 — Admin panel had no way to find one user quickly
- **Fixed in code:** "Find user" search — exact email **or** exact username,
  case-insensitive — with Grant/Revoke for just that user, plus a
  total-registered-users count visible only in the admin panel
  (`renderAdminPanel()`, `js/app.js:1815`). The full user list stays.

#### L-06 — README said admin needs email in ADMIN_EMAILS *and* is_admin
- The code is OR, not AND. Fixed in `README.md`. `ADMIN_EMAILS` in
  `js/config.js:36-39` now also includes `ahsantaha16@gmail.com` (the main
  account was missing — only `ahantaha16@gmail.com` was listed).

---

## What was verified clean (no finding)

- **No secrets in the repo.** Grep of the whole tree: only the Supabase **anon
  key** in `js/config.js` (public by design — it is safe to ship in frontend
  code). No `service_role` key, password, token or other secret anywhere.
  The three grep hits for "service_role" are comments warning never to ship it.
- **Races RLS is solid.** All four policies (`races_select/insert/update/delete_own`,
  `sql/schema.sql`) require `user_id = auth.uid()` — each user sees and edits
  only their own races.
- **Subscriptions RLS is solid.** Reads are own-or-admin; inserts, updates and
  deletes are admin-only (`sql/schema.sql`, subscriptions section).
- **`is_admin()` is safe.** `SECURITY DEFINER`, reads `public.profiles` — it
  bypasses RLS by design, so policies calling it do not recurse.
- **CSV import:** odds JSON is sanitised, `how_won_text` is capped at 120 chars.
- **Speed table:** values are parsed as integers with a fallback to defaults —
  a tampered `localStorage` value never reaches the markup as raw text.
- **Race list:** race lines are rendered via `textContent`.
- **Prediction panel:** only fixed-list vehicle/track names and numbers reach
  `innerHTML` — no user input.
- **Anonymous sign-ins are OFF** (dashboard, verified by the owner).
- **Online-users counter:** skipped by the owner's decision (needs realtime
  presence and would expose other users' activity). The admin-only
  total-registered-users count is the only user count, in the admin panel.

---

## Premium gate — end-to-end verification

Walked the whole flow against the fixed code (no live test — the code is not
deployed yet):

| Step | What happens | Gate |
|---|---|---|
| Sign up | Client validation → `signUp` with optional username in metadata → "Account created — check your email", or a clear error | Sign-up never capped |
| Confirm link | Live site opens, session auto-detected, token cleared from URL hash | — |
| Set password | Change-password card (signed-in) or recovery form (from reset link) | — |
| Sign in | Validation + unconfirmed-account hint on failure | — |
| No premium | Predict / Log / Stats / Speeds tabs show the locked screen; `renderPrediction` refuses; save/export/import actions toast "Premium required"; cloud race functions refuse | Locked on every path |
| Premium granted | Owner grants by email or username; app unlocks within 5 minutes or on reload | — |
| Subscription expires | 5-minute re-check locks the app again | — |
| Admin / owner | Permanent access, no subscription check, OWNER badge in Account tab | — |

One honest limitation (M-01): the gate is enforced in the app, not by a server
function. A user with browser devtools could run the prediction maths in the
console — the speed table is public data in the repo. What they cannot get is
anyone else's race history (RLS) or the app experience. An Edge Function would
close even that; not built.

---

## Username feature (new)

- **Database:** `sql/migration-username.sql` (run in the SQL Editor; not applied
  by this audit). Adds `profiles.username` (`citext`, unique ignoring case),
  a format check (`^[A-Za-z0-9_]{3,20}$`), and updates `handle_new_user()` so
  a username passed at sign-up (`options.data.username`) is stored — and if
  it is taken or invalid, the profile is still created **without** a username,
  so sign-up never fails because of a username clash. The same change is in
  `sql/schema.sql:20-37, 113-141` for fresh installs.
- **App:** sign-up form gains an optional username field
  (`js/app.js:1629`, passed as `user_metadata`); the Account tab lets a
  signed-in user set/change their own username (`validateUsername()`,
  `js/app.js:227`; unique-violation error 23505 is caught and shown as
  "That username is taken — try another"); the admin panel search finds a
  user by exact email **or** exact username, case-insensitive.
- **Safety:** the update policy + trigger (S-01) mean a user can only change
  their *own* row's username — never another user's, never `is_admin`, never
  `email`. The unique index (case-insensitive) means two users cannot claim
  the same name in different cases.

---

## What still needs a dashboard action (owner / parent — not done by this audit)

### 1. Run the two migrations (SQL Editor) — REQUIRED before deploying
Dashboard → SQL Editor → New query. Run in this order, then run the
verification queries printed at the bottom of each file:
1. `sql/migration-security-2026-11-21.sql` — fixes S-01 (admin escalation)
   and S-02 (email list leak). **Until this runs, the live database is still
   vulnerable to both.**
2. `sql/migration-username.sql` — adds the username column and the updated
   sign-up trigger.

### 2. Enable leaked-password protection — RECOMMENDED
Dashboard → Authentication → Policies → **Leaked password protection → ON**.
Stops users setting passwords found in known data breaches. (M-08.)

### 3. Set up custom SMTP — REQUIRED for reliable sign-ups
Dashboard → Project Settings → Auth → SMTP Settings → **Enable custom SMTP**,
then enter a provider's host, port, username and password (any SMTP provider,
e.g. Resend, SendGrid, or a Gmail app password) and Save. This removes the
2-emails/hour Supabase limit that is currently breaking sign-ups (M-07).
Until then, confirmation/reset emails stop after 2 per hour and the limit
resets roughly hourly.

### 4. Optional: enable CAPTCHA if junk sign-ups appear
Dashboard → Authentication → Bot protection → Enable CAPTCHA (hCaptcha).
Only if bots start creating accounts. It filters bots — it does **not** cap
accounts, and sign-ups must stay unlimited. (L-01.)

### 5. Keep as-is (do NOT change)
- **Sign-up stays ON. Confirm email stays ON. Anonymous sign-ins stay OFF.**
  Never disable sign-ups or add an account cap to "fix" the email limit —
  the limit is on emails, not accounts.
- **Races move (M-06):** move the 40 races from ahantaha16 to ahsantaha16
  only when the owner says so. SQL (SQL Editor, after his OK):
  `update public.races set user_id = '31018cb1-5a42-4014-8898-05a964b48fac' where user_id = '04d9cfba-0714-4396-b0b6-5001090703c7';`

---

## Behaviour preserved (regression check)

- One-track prediction: pinning a second segment unpins the first (verified
  in Node smoke test).
- Unknown segment boxes, recency weighting (half-life 50), duplicate
  protection, segment lengths `[0.189, 0.511, 0.300]` (`js/config.js:29` —
  unchanged), MAIN PICK / BACKUP PICK output, premium + owner-permanent-access
  rules, all 40 races untouched.
- All 5 tabs present (`predict`, `log`, `stats`, `speeds`, `account`); the
  sign-in/sign-up form renders with the new fields.

## Test evidence

- `node --check js/app.js` — pass. `node --check js/config.js` — pass.
- Node smoke test (ad hoc, `/tmp/lrp-smoke.js`): prediction engine returns a
  ranked top-3; one-track enforcement holds; `appAccessFor` returns the right
  result for all 6 states (offline / premium / signin / admin / subscriber /
  demo); `validateUsername` passes 10 cases; duplicate detection and unknown
  tracks intact; half-life 50.
- `grep -rniE 'service_role|sk-|password\s*='` across the repo: no secrets
  (only the three documented warning comments).
- SQL files: `$$` delimiters balanced; migrations are idempotent
  (`IF NOT EXISTS` / `OR REPLACE` / `DROP ... IF EXISTS`).
- **Not tested live** (no deploy, no database access in this audit): the
  recovery-link click-through, the 5-minute re-check in a real browser, and
  the migrations themselves must be verified after deploy — run the
  verification queries at the bottom of each migration file.

## Files changed (local only — nothing deployed)

| File | Change |
|---|---|
| `js/app.js` | Password flows (forgot / recovery / change), auth error feedback, owner-tagged race cache + sign-out clear, `sbLoadFailed` lock, `onAuthStateChange`, hash-error parsing + clearing, premium checks in cloud race functions, 5-min subscription re-check, username form + card, admin search + textContent rows, `validateUsername` |
| `js/config.js` | `ADMIN_EMAILS` now includes `ahsantaha16@gmail.com` |
| `index.html` | CSP meta tag |
| `css/style.css` | `.auth-msg` (inline auth messages), `.admin-search` layout |
| `sql/schema.sql` | Username column + format check, hardened profiles RLS, privilege-change trigger, username-aware `handle_new_user()` |
| `sql/migration-username.sql` | **New** — username migration for the live DB |
| `sql/migration-security-2026-11-21.sql` | **New** — RLS + trigger migration for the live DB |
| `README.md` | Username + password flows, migrations note, security section, admin OR (not AND) fix |
| `SECURITY_AUDIT_2026-11-21.md` | **New** — this file |
