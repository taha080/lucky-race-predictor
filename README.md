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

- **Predict tab (main)** — tap 3 vehicles, then set the track for any
  segment you can see (the shown segment can be first, second or third).
  Every segment defaults to **Unknown** and is never guessed — tap a track
  to hint it (with a rough chance: 10–90% or Pin 100%). A one-tap Reset
  sets all three segments back to Unknown. Optionally set odds with −/+
  steppers. The **top 2 picks** with a confidence % and a short reason
  appear **instantly on every tap** — no submit button. A 35-second
  betting timer is included as a visual aid.
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

## How the prediction works

1. **Time model.** A race has 3 segments of *unequal* length. A vehicle's time
   on a track assignment `(t1, t2, t3)` is
   `L1/speed[v][t1] + L2/speed[v][t2] + L3/speed[v][t3]`,
   where `L1, L2, L3` are the segment length weights (default
   `[0.157, 0.557, 0.286]`, editable in `js/config.js` as
   `SEGMENT_LENGTHS`; a missing or invalid value falls back to equal
   thirds). The lowest time wins that assignment (exact ties split the
   weight).

   The weights come from the 7 full-track races 21–27, whose notes give
   the share of the race each track covered: race 21 seg1 10%, rest Bumpy;
   race 22 seg1 10%, rest Expressway; race 23 90% Bumpy, seg3 10%; race 24
   5% Desert, 60–70% Dirt, rest Expressway; race 25 5% Bumpy, 80%
   Expressway, last bit Dirt; race 26 seg1 20%, rest Expressway; race 27
   10–20% Bumpy, mid Expressway, end a little Potholes. Where a note
   splits only one segment from "the rest", the remainder is split
   equally between the two unmeasured positions; ranges use their
   midpoint (60–70% → 65%, 10–20% → 15%) and "last bit" / "a little"
   count as 15%. Averaging the 7 races gives seg1 1.10/7 ≈ 0.157, seg2
   3.90/7 ≈ 0.557, seg3 2.00/7 ≈ 0.286 — the middle segment is by far
   the longest. As more full-track races are saved, re-average and update
   `SEGMENT_LENGTHS` to refine the model.
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
4. **History blend.** When **150+** races are saved, the speed model is
   blended with the actual win rate for the same 3-vehicle set + the same
   known (pinned) segments: `w = clamp((N_total − 150) / 350, 0, 0.5)`,
   applied only if at least **5** saved races match that exact set +
   known segments.
   `P_final = (1 − w) × P_model + w × P_hist`.
   The win counts behind `P_hist` are decay-weighted by recency (newest
   race weight 1.0, halving every `HISTORY_HALF_LIFE_RACES` races, see
   above); the 150-race gate and the 5-match minimum still use plain
   counts.
5. **Output.** Always the **top 2 of the 3** vehicles, each with a
   confidence % (its win probability) and a short reason (e.g. fastest on
   Desert, strong on likely hidden tracks).

## Subscriptions

- Users sign up with email + password (Supabase Auth).
- Predictions are gated: without an active subscription the Predict tab
  shows a locked screen.
- A subscription is a row in `subscriptions` with `expires_at`. **Every
  subscription automatically expires at the end of the calendar month**
  (the app checks `expires_at < now` on each prediction attempt).
- **Admins** (email in `js/config.js` `ADMIN_EMAILS` **and**
  `profiles.is_admin = true` in the database) can grant a subscription to
  any user (sets `expires_at` to the end of the current month) or revoke it,
  from the Account tab.

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
