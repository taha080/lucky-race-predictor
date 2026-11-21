# Lucky Race Predictor

A fast, mobile-first web app that predicts the winner of the **Lucky Race**
mini-game (the racing game inside live-streaming apps like Chamat, TikTok
Live, Poco, Matmat). The game has no website or API, so all data is entered
by the user — every input is a tap, and the prediction appears instantly.

> **Disclaimer:** This is an independent fan-made tool. It is not affiliated
> with Chamat or any streaming app, and it does not use any of their art,
> images, or code. Predictions are probabilities based on vehicle speeds and
> your logged races — never a guarantee. Never bet more than you can afford
> to lose.

## Live demo

GitHub Pages URL (after deployment): `https://taha080.github.io/lucky-race-predictor/`

Without Supabase configured, the app runs in **demo mode**: races and the
speed table live in `localStorage` and predictions work with no account.

## Features

- **Predict tab (main)** — a step-by-step wizard: **START** → pick 3
  vehicles → pin the ONE track the game shows (the shown segment can be
  first, second or third; the other two stay **Unknown**, never guessed)
  → **RUN**. The **top 2 picks** with a confidence % and a short reason
  appear when you tap RUN — the whole START-to-RUN path is a few taps,
  well inside the 35-second betting timer (shown on every step). There
  is no odds step: odds only track how people bet, so they do not feed
  the prediction. Under the result, **feedback** asks "Was this
  prediction right?" — Correct saves the race with the MAIN pick as
  winner, Wrong asks which vehicle actually won and saves that. The
  last run stays on screen (even across reloads) so feedback can be
  given after the race finishes. A 35-second betting timer is included
  as a visual aid.
- **Log Race tab** — fast logging of past races: 3 vehicles, 3 segment
  tracks (any segment may be left **Unknown** — stored as the real value
  `"unknown"`), on-screen patterns, winner, how it won, odds. Edit /
  delete any race. Every saved race teaches the model.
- **Stats tab** — win rate per vehicle, win rate per vehicle per track,
  track frequency per segment, CSV export + import.
- **Speed Table tab** — the full 9×6 speed table, every value editable,
  with reset to the game defaults.
- **Account tab** — email/password sign-up & sign-in (Supabase Auth),
  subscription status, and an admin panel to grant / revoke subscriptions.

## The game (data from the in-game screenshots)

**Vehicles (9)** — overall win rate / odds:

| Vehicle | Win rate | Odds |
|---|---|---|
| ORV | 42.1% | 2.3 |
| Monster Truck | 41.7% | 2.4 |
| SUV | 37.1% | 2.6 |
| Stock Car | 36.7% | 2.7 |
| Car | 36.6% | 2.7 |
| ATV | 30.0% | 3.3 |
| Motorcycle | 29.0% | 3.4 |
| Sports Car | 26.3% | 3.7 |
| Supercar | 19.8% | 5.0 |

**Speeds** (vehicle × track — Expressway, Highway, Desert, Bumpy, Potholes, Dirt):

| Vehicle | Expressway | Highway | Desert | Bumpy | Potholes | Dirt |
|---|---|---|---|---|---|---|
| Supercar | 390 | 320 | 40 | 60 | 32 | 100 |
| Sports Car | 300 | 240 | 45 | 66 | 36 | 120 |
| Car | 235 | 180 | 50 | 75 | 45 | 130 |
| SUV | 180 | 143 | 57 | 76 | 48 | 134 |
| ORV | 140 | 112 | 70 | 91 | 49 | 92 |
| Monster Truck | 110 | 99 | 55 | 99 | 77 | 66 |
| Stock Car | 100 | 100 | 80 | 80 | 60 | 80 |
| Motorcycle | 94 | 89 | 63 | 81 | 68 | 81 |
| ATV | 80 | 80 | 72 | 72 | 72 | 76 |

**Duplicate protection.** A race is never added twice: a new race is a duplicate when a saved race already has the same 3 vehicles (in any order), the same 3 tracks (exact, including `"unknown"` entries), the same winner, and the same note (`how_won_text`). A different note or a different winner makes it a different race. The check runs when saving from the Log tab (a duplicate shows "This race is already saved." and is not stored) and when importing a CSV (duplicate rows are skipped and counted in the import toast). Editing a race never flags the race itself as a duplicate.

**Vehicle name aliases (CSV import).** CSV rows may use `motor` for Motorcycle and `normal` for Car (case-insensitive); they are converted to the full vehicle names on import. Full names still import unchanged. No vehicle is dropped or renamed — the Log tab uses tap-to-select cards with the full names.

**Track name aliases (CSV import).** CSV rows may use `petrol` or `pathole` for Potholes (case-insensitive; `pathole` is the user's spelling); they are converted to Potholes on import. Full track names still import unchanged. No track is dropped or renamed — the Predict tab's track chips already use the full names.

## How the prediction works

1. **Time model.** A race has 3 segments of *unequal* length. A vehicle's time
   on a track assignment `(t1, t2, t3)` is
   `L1/speed[v][t1] + L2/speed[v][t2] + L3/speed[v][t3]`,
   where `L1, L2, L3` are the segment length weights (default
   `[0.189, 0.511, 0.300]`, editable in `js/config.js` as
   `SEGMENT_LENGTHS`; a missing or invalid value falls back to equal
   thirds). The lowest time wins that assignment (exact ties split the
   weight).

   The weights come from the 9 full-track races 21–29, whose notes give
   the share of the race each track covered: race 21 seg1 10%, rest Bumpy;
   race 22 seg1 10%, rest Expressway; race 23 90% Bumpy, seg3 10%; race 24
   5% Desert, 60–70% Dirt, rest Expressway; race 25 5% Bumpy, 80%
   Expressway, last bit Dirt; race 26 seg1 20%, rest Expressway; race 27
   10–20% Bumpy, mid Expressway, end a little Potholes; race 28 40% Dirt,
   10% Bumpy, rest Highway; race 29 ~20% Potholes, 60% Highway, end 20%
   Bumpy. Where a note splits only one segment from "the rest", the
   remainder is split equally between the two unmeasured positions;
   ranges use their midpoint (60–70% → 65%, 10–20% → 15%) and "last bit"
   / "a little" count as 15%. Averaging the 9 races gives seg1 1.70/9 ≈
   0.189, seg2 4.60/9 ≈ 0.511, seg3 2.70/9 = 0.300 — the middle segment
   is by far the longest. As more full-track races are saved, re-average
   and update `SEGMENT_LENGTHS` to refine the model.
2. **Unknown segments.** Any segment can be Unknown — the shown segment
   may be in any position (first, second or third), or no segment may be
   shown at all. All track combinations (up to 6×6×6 = 216) are
   enumerated, each weighted by `P(t1) × P(t2) × P(t3)`.
3. **Segment probabilities.** For each segment that is not pinned, in order:
   - **Pinned** track → probability 1.0.
   - **Hinted** track with chance `p` (tap 10/20/30/50/70/90%) → the hinted
     track gets `p`; the remaining `1 − p` is shared over the other 5 tracks
     by historical frequency.
   - Otherwise the **historical frequency** of that track for that segment
     position, conditioned on the segments that are pinned (known) —
     learned from your saved races. Saved races with `"unknown"` at a
     position carry no track information for that position.
   - **Equal probability (1/6)** when there is no data at all.

   **Recency weighting.** Both the historical frequencies above and the
   win-rate history in the blend (step 4) use exponential decay over
   saved races: the newest race has weight 1.0 and the weight halves
   every `HISTORY_HALF_LIFE_RACES` races (default **50**, editable in
   `js/config.js` — set it to any number of races > 0; a missing or
   invalid value falls back to 50). Recent races therefore count more
   than old ones, so patterns that change over time are picked up faster.

   **A hint is a likelihood, never a certainty.** A pattern hinting at Dirt
   might mean only a 10–20% chance of Dirt, not a guaranteed Dirt segment.
   Patterns change every round — the app never assumes a fixed daily
   pattern, and it relearns from every newly saved race.
4. **History blend.** When **30+** races are saved, the speed model is
   blended with the actual win rate for the same 3-vehicle set + the same
   known (pinned) segments: `w = clamp((N_total − 30) / 120, 0, 0.5)`,
   applied only if at least **5** saved races match that exact set +
   known segments. At 57 saved races the weight is 0.225 — real but
   modest, so the speed model still decides and history only nudges it.
   (The gate was 150 races until 21 Nov 2026; it came down to 30 so
   every prediction uses all 57 saved races.)
   `P_final = (1 − w) × P_model + w × P_hist`.
   The win counts behind `P_hist` are decay-weighted by recency (newest
   race weight 1.0, halving every `HISTORY_HALF_LIFE_RACES` races, see
   above); the 30-race gate and the 5-match minimum still use plain
   counts. Note: with 57 races no vehicle set repeats 5 times yet
   (the most common set appears 3 times), so the blend does not fire
   on the current data — it starts engaging as soon as any set reaches
   5 saved races, which the Predict feedback flow now feeds on every
   confirmed prediction.
5. **Output.** Always the **top 2 of the 3** vehicles, each with a
   confidence % (its win probability) and a short reason (e.g. fastest on
   Desert, strong on likely hidden tracks). The #1 vehicle is shown as
   the big highlighted **MAIN PICK**, and #2 below it as the smaller
   **BACKUP PICK**.

### One-track rule

The game shows exactly **one** track before you bet — all three tracks
appear only in the result after the race ends. So the Predict tab allows
only **one pinned segment** at a time: pinning a second segment unpins
the first, and the other two segments stay Unknown. Hints (a rough
chance, not a certainty) still work on any segment, and the unknown
segments are predicted from history frequency conditioned on the one
pinned segment. The engine enforces the same rule: if a prediction input
somehow carries two or three pins, only the first (lowest index) is kept
and the others are treated as Unknown. The Log Race tab is unchanged —
after the result you still enter all 3 tracks there, so the learning data
keeps growing.

## Subscriptions (Premium)

- Users sign up with email + password (Supabase Auth).
- **The whole app is premium-only:** without an active subscription the
  Predict, Log Race, Stats and Speeds tabs all show a locked screen
  ("Premium required — subscriptions end at the end of each calendar
  month — ask the owner to grant you premium"). The Account tab always
  stays open (sign in, subscription status, admin panel).
- A subscription is a row in `subscriptions` with `expires_at`. **Every
  subscription automatically expires at the end of the calendar month**
  (the app checks `expires_at < now` on each use).
- **Owner (admin) access is permanent:** admins (email in `js/config.js`
  `ADMIN_EMAILS` **or** `profiles.is_admin = true` in the database)
  bypass every subscription check entirely — the owner never needs a
  subscription and no expiry is checked for admins. The Account tab shows
  a distinct **Owner** card (email + OWNER badge) at the top for admins.
- **Admins** can grant premium to any user from their own account (sets
  `expires_at` to the end of the current month) or revoke it, from the
  Account tab's "Grant premium" users list. Revoking blocks the whole app
  for that user immediately. The admin panel also has a **Find user**
  search (exact email **or** username) and shows the total number of
  registered users.
- **Usernames (optional):** a user can pick a username (3-20 letters,
  numbers or `_`, unique ignoring case) at sign-up or later from the
  Account tab. The owner can grant premium by username or by email.
- **Passwords:** a signed-in user can set/change their password from the
  Account tab ("Change password"). A logged-out user can use "Forgot
  password?" on the sign-in form — a reset link is emailed, and clicking
  it opens a "Set a new password" form in the app. Expired or already-used
  links show a clear message instead of silently failing.
- **No limit on accounts:** anyone can create an account, unlimited.
  (Supabase's free email service sends at most 2 account emails per hour
  — that limit is on *emails*, not on accounts. If confirmation/reset
  emails stop arriving, wait for the next hour, or set up a custom SMTP
  provider in the Supabase dashboard: Authentication → Emails → Enable
  custom SMTP.)

## Security

See `SECURITY_AUDIT_2026-11-21.md` for the full audit (21 Nov 2026):
profiles RLS is hardened (users read only their own profile row; admins
read all), a database trigger blocks non-admins from changing `is_admin`
or `email`, emails/usernames are rendered as text (never HTML), and the
app stays locked if the Supabase library fails to load on the configured
site (it never falls back to unlocked demo mode). The premium gate is
enforced on every path: the tab lock overlay, the prediction renderer,
the save/export/import actions, and the cloud race functions — and the
subscription is re-checked every 5 minutes while signed in, so a grant
unlocks the app without a reload and an expiry locks it again.

## Tech

- **Frontend:** vanilla HTML/CSS/JS — no build step, loads in under 2s.
  Prediction is computed in the browser (36 combos, well under 100ms).
- **Backend:** Supabase free tier — Auth, Postgres tables (`profiles`,
  `subscriptions`, `races`), Row Level Security. No file storage.
- **Hosting:** GitHub Pages (free), deployed by GitHub Actions on push to
  `main`.
- Only the **Supabase anon key** is in the frontend config. The
  **service_role key is never committed or used by the app.**

## Setup

### 1. Supabase project (free tier)

1. Create a project at https://supabase.com/dashboard.
2. Open **SQL Editor → New query**, paste `sql/schema.sql`, and run it.
   This creates the tables, RLS policies, the `is_admin()` helper, and the
   profile-creation trigger.
   - Already have a live database? Run the migrations instead (in order):
     `sql/migration-security-2026-11-21.sql`, then
     `sql/migration-username.sql`. Never re-run the full `schema.sql` on a
     live database that already has data.
3. Go to **Project Settings → API** and copy:
   - **Project URL** → `SUPABASE_URL`
   - **anon public key** → `SUPABASE_ANON_KEY`
4. In `js/config.js`, replace the two `YOUR_...` placeholders with those
   values. Add your email to `ADMIN_EMAILS`.
5. Create your account in the app (Account tab → Create account), then in
   the SQL Editor run:
   ```sql
   update public.profiles set is_admin = true where email = 'you@example.com';
   ```

### 2. GitHub Pages deployment

1. Create a public repo (e.g. `taha080/lucky-race-predictor`) and push
   this folder's contents to the `main` branch.
2. In the repo: **Settings → Pages → Build and deployment → Source:
   GitHub Actions**. The workflow in `.github/workflows/deploy.yml`
   deploys automatically on every push to `main`.
3. The site goes live at `https://<username>.github.io/lucky-race-predictor/`.

### 3. Local use (no deploy)

Just open `index.html` in a browser, or serve the folder:
```bash
python3 -m http.server 8000
# then open http://localhost:8000
```
Without Supabase values in `js/config.js` it runs in demo mode.

## File list

```
index.html                  — app shell, 5 tabs (Predict / Log / Stats / Speeds / Account)
css/style.css               — dark blue/purple theme, mobile-first, 48px tap targets
js/config.js                — Supabase URL + anon key placeholders, admin emails
js/app.js                   — data, prediction engine, storage, Supabase, all UI
sql/schema.sql              — profiles, subscriptions, races + RLS + trigger
sql/migration-username.sql  — add usernames to an existing database
sql/migration-security-2026-11-21.sql — RLS hardening for an existing database
SECURITY_AUDIT_2026-11-21.md — full security audit (21 Nov 2026)
.github/workflows/deploy.yml — GitHub Pages deploy on push to main
README.md                   — this file
```

## Testing the prediction engine

```bash
node --check js/app.js
node test-predict.js   # sample round (see below)
```

`test-predict.js` (not shipped — run ad hoc):
```js
const m = require('./js/app.js');
const r = m.computePrediction({
  vehicles: ['ORV', 'SUV', 'Monster Truck'],
  seg1Hint: { mode: 'pin', track: 'Desert' },
  seg2Hint: { mode: 'unknown' },
  seg3Hint: { mode: 'unknown' },
  speeds: m.DEFAULT_SPEEDS,
  races: []
});
console.log(r.ranked);
```

## License

MIT — free to use and modify. Not affiliated with Chamat or any
live-streaming app.
