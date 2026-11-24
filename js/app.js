/* ============================================================================
   Lucky Race Predictor — app.js (vanilla JS, no build step)
   Prediction runs entirely in the browser (<100ms for 36 combos).
   ----------------------------------------------------------------------------
   PREDICTION MODEL (see README.md for the full description):
   - 3 segments with length weights SEGMENT_LENGTHS (default [0.189, 0.511,
     0.300], editable in js/config.js; equal thirds if unset).
     Time(v) = L1/speed[v][t1] + L2/speed[v][t2] + L3/speed[v][t3].
   - Any segment can be Unknown: the shown segment may be in ANY position
     (first, second or third) — or no segment may be shown at all. Unknown
     segments are never guessed: enumerate all track combos (up to 6x6x6),
     weight each by P(t1) * P(t2) * P(t3), winner = lowest time
     (exact ties split the weight equally).
   - P(segment) comes from, in order:
       (a) user-pinned track          -> 1.0 for that track (the game showed
                                        it, so it is a fact, not a guess —
                                        there is no percentage choice)
       (b) historical frequency of that track for that segment position,
           learned from saved races, conditioned on the segments that ARE
           known (pinned) — "unknown" entries in saved races are ignored
       (c) equal probability (1/6) when there is no data at all
     Patterns change every round — never assume a fixed daily pattern.
     The model relearns from every newly saved race.
   - HISTORY BLEND: when 30+ races are saved, blend the speed model with
     the actual win rate for the same 3-vehicle set + the same known
     (pinned) segments.
       w = clamp((N_total - 30) / 120, 0, 0.5)
     applied only if >= 5 saved races match that exact set + known segments.
       P_final = (1 - w) * P_model + w * P_hist
     At 57 saved races the weight is 0.225 — real but modest, so the
     speed model still decides and history only nudges it. The gate was
     150 races until 21 Nov 2026; the user asked every prediction to use
     all 57 saved races, so the gate came down to 30.
   - ONE-TRACK RULE: the game shows exactly ONE track before the bet, so
     at most ONE segment may be pinned (known). Pinning a second
     segment unpins the first; the other two stay Unknown.
     The engine enforces this too: if the input somehow carries two or
     three pins, only the first (lowest index) is kept and the others are
     treated as Unknown.
   - LIVE AUTO-PREDICT (lrp-v17): the Android Live Reader upserts one row
     per user into public.live_bets (see sql/migration-live-bets.sql) when
     a new bet appears; the app subscribes over Supabase Realtime and
     auto-drives the wizard from the row (vehicles + the one shown track
     + the synced countdown). The countdown is age-adjusted (timer_seconds
     minus the time since updated_at); a bet arriving with under 10 s left
     is still predicted but marked LATE. Pure validators/deciders
     are unit-tested in scripts/test-lrp-v16.js and scripts/test-lrp-v17.js.
   - LIVE HARDENING (lrp-v21): Realtime is NOT trusted alone — a 4 s REST
     poll re-fetches the live row while live mode is on, a dead Realtime
     channel is torn down and re-subscribed on backoff, returning to the
     Predict tab or to a visible tab re-fetches at once, and a live bet
     always wins over an unfinished manual pick (steps 1–2 with no run
     yet) instead of being dropped as 'manual-busy'. Pure helpers are
     unit-tested in scripts/test-lrp-v21.js.
   - SPEEDS + FULL-HISTORY BLEND (lrp-v22 — the user's order, 24 Nov
     2026, reversing the v19 data-only order): the ranking blends the
     game's own speed table (DEFAULT_SPEEDS, canonical — never a user's
     localStorage edits) for the shown track with the full saved history,
     first bet to last, via the v19 hierarchical back-off, now with the
     recency decay (halves every 50 races) weighting the history counts.
     Speed weight V22_SPEED_WEIGHT (default 0.6), chosen by replay on
     the 346 local races — see scripts/replay-blend-v22.js. The
     confidence guard is applied again in computePrediction (it was
     dropped from the ranking path in v19). Pure helpers are unit-tested
     in scripts/test-lrp-v22.js.
     Deploy note (24 Nov): Pages run #84 failed on a GitHub-side artifact
     error — this line re-triggers a fresh deploy; no ranking change.
   ========================================================================== */

'use strict';

/* Running version, shown on screen (header badge) so the user can see
   at a glance which deploy he is on — a cached old version is visible
   instead of silent. Bump on every deploy. */
var APP_VERSION = 'v22';

/* ---------------- Static game data (from the game screenshots) ------------ */

var TRACKS = ['Expressway', 'Highway', 'Desert', 'Bumpy', 'Potholes', 'Dirt'];

var VEHICLES = [
  { name: 'ORV',           winRate: 42.1, odds: 2.3, color: '#8a9a3b', glyph: 'orv' },
  { name: 'Monster Truck', winRate: 41.7, odds: 2.4, color: '#2e9e4f', glyph: 'monster' },
  { name: 'SUV',           winRate: 37.1, odds: 2.6, color: '#8e44ad', glyph: 'suv' },
  { name: 'Stock Car',     winRate: 36.7, odds: 2.7, color: '#e67e22', glyph: 'stock' },
  { name: 'Car',           winRate: 36.6, odds: 2.7, color: '#e84393', glyph: 'sedan' },
  { name: 'ATV',           winRate: 30.0, odds: 3.3, color: '#e74c3c', glyph: 'atv' },
  { name: 'Motorcycle',    winRate: 29.0, odds: 3.4, color: '#27ae60', glyph: 'bike' },
  { name: 'Sports Car',    winRate: 26.3, odds: 3.7, color: '#2980b9', glyph: 'sport' },
  { name: 'Supercar',      winRate: 19.8, odds: 5.0, color: '#bdc3c7', glyph: 'super' }
];

var DEFAULT_SPEEDS = {
  'Supercar':      { Expressway: 390, Highway: 320, Desert: 40, Bumpy: 60, Potholes: 32, Dirt: 100 },
  'Sports Car':    { Expressway: 300, Highway: 240, Desert: 45, Bumpy: 66, Potholes: 36, Dirt: 120 },
  'Car':           { Expressway: 235, Highway: 180, Desert: 50, Bumpy: 75, Potholes: 45, Dirt: 130 },
  'SUV':           { Expressway: 180, Highway: 143, Desert: 57, Bumpy: 76, Potholes: 48, Dirt: 134 },
  'ORV':           { Expressway: 140, Highway: 112, Desert: 70, Bumpy: 91, Potholes: 49, Dirt: 92 },
  'Monster Truck': { Expressway: 110, Highway: 99,  Desert: 55, Bumpy: 99, Potholes: 77, Dirt: 66 },
  'Stock Car':     { Expressway: 100, Highway: 100, Desert: 80, Bumpy: 80, Potholes: 60, Dirt: 80 },
  'Motorcycle':    { Expressway: 94,  Highway: 89,  Desert: 63, Bumpy: 81, Potholes: 68, Dirt: 81 },
  'ATV':           { Expressway: 80,  Highway: 80,  Desert: 72, Bumpy: 72, Potholes: 72, Dirt: 76 }
};

var HOW_WON_OPTIONS = [
  'Led all the way',
  'Overtook on segment 2',
  'Overtook on segment 3',
  'Photo finish',
  'Other'
];

// Stored value for a segment whose track is not known. Saved races keep
// 'unknown' as a real value — it is never converted to a track type.
var UNKNOWN_TRACK = 'unknown';

function normalizeTracksForSave(tracks) {
  return (tracks || []).map(function (t) { return t || UNKNOWN_TRACK; });
}

// Vehicle name aliases for CSV import (case-insensitive): "motor" means
// Motorcycle and "normal" means Car. Full names are used everywhere in
// the app; the Log tab uses tap-to-select cards with the full names, so
// aliases only matter for imported CSV rows. No vehicle is dropped or
// renamed by this.
var VEHICLE_ALIASES = { motor: 'Motorcycle', normal: 'Car' };
function resolveVehicleName(name) {
  var key = (name || '').trim().toLowerCase();
  return VEHICLE_ALIASES[key] || (name || '').trim();
}

// Track name aliases for imported CSV rows: the user writes "petrol"
// or "pathole" (his spelling) for Potholes. Case-insensitive; like the
// vehicle aliases, they only matter for imported CSV rows. No track is
// dropped or renamed by this.
var TRACK_ALIASES = { petrol: 'Potholes', pathole: 'Potholes' };
function resolveTrackName(name) {
  var key = (name || '').trim().toLowerCase();
  return TRACK_ALIASES[key] || (name || '').trim();
}

/* Duplicate rule: a race is a duplicate of a saved race when it has the
   same 3 vehicles (order-insensitive), the same tracks (exact, including
   'unknown' entries), the same winner, AND the same how_won_text.
   A different note or a different winner makes it a different race.
   `ignoreId` skips one race id (used when editing, so the race being
   edited never counts as a duplicate of itself). */
function isDuplicateRace(candidate, raceList, ignoreId) {
  if (!candidate || !Array.isArray(candidate.vehicles) || !Array.isArray(candidate.tracks)) return false;
  var candVehicles = candidate.vehicles.slice().sort().join('|');
  var candTracks = normalizeTracksForSave(candidate.tracks).join('|');
  var candWinner = candidate.winner || '';
  var candNote = (candidate.how_won_text || '').trim();
  return (raceList || []).some(function (r) {
    if (ignoreId !== undefined && ignoreId !== null && String(r.id) === String(ignoreId)) return false;
    if (!Array.isArray(r.vehicles) || !Array.isArray(r.tracks)) return false;
    return r.vehicles.slice().sort().join('|') === candVehicles &&
      normalizeTracksForSave(r.tracks).join('|') === candTracks &&
      (r.winner || '') === candWinner &&
      (r.how_won_text || '').trim() === candNote;
  });
}

var HISTORY_BLEND_MIN_TOTAL = 30;    // start blending at 30 saved races
var HISTORY_BLEND_MIN_MATCHES = 5;   // need >= 5 races of the same set + seg1

/* History-blend weight (pure, unit-tested): 0 below HISTORY_BLEND_MIN_TOTAL
   races, then ramping to the 0.5 cap. At 57 races the weight is 0.225 —
   real but modest, so the speed model still decides and history only
   nudges it. The ramp denominator (120) is what sets that: (57-30)/120. */
function historyBlendWeight(total) {
  return clamp((total - HISTORY_BLEND_MIN_TOTAL) / 120, 0, 0.5);
}

/* ---------------- Config / environment ------------------------------------ */

var CONFIG = (typeof window !== 'undefined' && window.LRP_CONFIG) ? window.LRP_CONFIG : {};
/* Configured = a real Supabase project is set in js/config.js. Demo mode
   applies ONLY when the config is genuinely unconfigured (placeholders).
   If the project IS configured but the Supabase library fails to load,
   the app must NOT silently fall back to unlocked demo mode (that would
   let anyone use the full app by blocking the CDN) — see sbLoadFailed. */
var SUPABASE_CONFIGURED = !!(CONFIG.SUPABASE_URL && CONFIG.SUPABASE_URL.indexOf('YOUR_') !== 0);
var DEMO_MODE = !SUPABASE_CONFIGURED;

var sb = null;          // Supabase client (null in demo mode)
var sbLoadFailed = false; // configured, but the Supabase JS library did not load
var currentUser = null; // { id, email } when signed in (Supabase mode)
var currentUsername = null; // the signed-in user's username (profiles.username)
var isAdmin = false;
var subActive = false;  // active subscription? (demo mode: always true)
var subExpiresAt = null;
var recoveryMode = false; // a PASSWORD_RECOVERY session is active: show set-password form
var authLinkError = null; // parsed from the URL hash: an expired/invalid auth link

/* ---------------- Local state ---------------------------------------------- */

var races = [];         // saved races: {id, vehicles[3], tracks[3], patterns[], winner, how_won, how_won_text, odds{}, created_at}
var speeds = cloneSpeeds(DEFAULT_SPEEDS);

var pred = {           // Predict tab state
  vehicles: [],        // up to 3 names
  // All three segments behave the same: { mode, track, chance }.
  // mode: unknown|pin. Default is Unknown for every segment — never
  // pre-select or auto-fill a track, including segment 1. Tapping a
  // track pins it (known, 100%) — the game showed it, so it is a fact.
  // ONE-TRACK RULE: at most ONE segment may be pinned at a time (see
  // applySinglePin / oneTrackHints below) — the game shows only one
  // track before the bet.
  seg1: { mode: 'unknown', track: null, chance: 50 },
  seg2: { mode: 'unknown', track: null, chance: 50 }, // mode: unknown|hint|pin
  seg3: { mode: 'unknown', track: null, chance: 50 },
  odds: {}             // name -> number
};

var logForm = {        // Log Race tab state
  vehicles: [],
  tracks: [null, null, null],
  patterns: [],
  winner: null,
  howWon: null,
  howWonText: '',
  odds: {},
  editId: null
};

/* ---------------- Predict wizard state ------------------------------------- */
/* The Predict tab is a staged wizard, not one long page:
     step 0 = START screen (big START button; the 35s timer stays visible)
     step 1 = pick 3 vehicles
     step 2 = pin the ONE track the game shows (others stay Unknown)
     step 3 = RUN result + feedback ("Was this prediction right?")
   The odds step was removed 21 Nov 2026 (user's order: odds only track
   how people bet, so they must not feed the prediction) — the odds engine
   code stays, it just gets no odds input from this flow.
   The whole START-to-RUN path is a few taps, well inside the 35s timer.
   The last run is kept (vehicles + tracks + result + feedback) so the
   feedback can be given after the race finishes — even if the user
   leaves the tab or reloads the page. It is stored in localStorage
   (LS_WIZARD) and restored on init; starting a new run clears it. */
var LS_WIZARD = 'lrp_wizard_v1';
var wizard = {
  step: 0,
  ran: false,
  lastRun: null,      // { vehicles[3], tracks[3], main, result, ms }
  feedback: null,     // null | { rank: 1|2|3, winner: name } — which pick won:
                       // 1 = HIGH (main), 2 = MID (backup), 3 = JACKPOT (3rd car).
                       // Legacy saves ('correct' / { wrong, winner }) are
                       // migrated by migrateFeedback() on restore.
  feedbackSaved: false,
  feedbackSaving: false // a save is in flight — blocks double taps (see answerFeedback)
};
function saveWizard() {
  lsSet(LS_WIZARD, JSON.stringify({
    step: wizard.step,
    ran: wizard.ran,
    lastRun: wizard.lastRun,
    feedback: wizard.feedback,
    feedbackSaved: wizard.feedbackSaved,
    vehicles: pred.vehicles,
    seg1: pred.seg1, seg2: pred.seg2, seg3: pred.seg3
  }));
}
/* Restore the wizard + the Predict picks from localStorage (no DOM yet —
   call before the first renders in init). A corrupt or foreign save is
   ignored, never fatal. Returns true when a run was restored. */
function loadWizardState() {
  try {
    var raw = lsGet(LS_WIZARD);
    if (!raw) return false;
    var s = JSON.parse(raw);
    if (!s || typeof s !== 'object') return false;
    if (Array.isArray(s.vehicles)) {
      pred.vehicles = s.vehicles.filter(function (v) { return vehicleByName(v); }).slice(0, 3);
    }
    [1, 2, 3].forEach(function (n) {
      var st = s['seg' + n];
      if (st && (st.mode === 'unknown' || st.mode === 'pin') &&
          (st.mode === 'unknown' || TRACKS.indexOf(st.track) !== -1)) {
        pred['seg' + n] = { mode: st.mode, track: st.mode === 'pin' ? st.track : null, chance: 50 };
      }
    });
    /* The one-track rule must still hold after a restore (an old save
       could carry two pins) — keep only the first pinned segment. */
    var states = oneTrackHints([pred.seg1, pred.seg2, pred.seg3]);
    pred.seg1 = states[0]; pred.seg2 = states[1]; pred.seg3 = states[2];
    pred.odds = {};
    wizard.step = (typeof s.step === 'number' && s.step >= 0 && s.step <= 3) ? s.step : 0;
    wizard.ran = !!s.ran;
    wizard.lastRun = (s.lastRun && Array.isArray(s.lastRun.vehicles) && s.lastRun.vehicles.length === 3 &&
      Array.isArray(s.lastRun.tracks) && s.lastRun.tracks.length === 3 &&
      s.lastRun.result && Array.isArray(s.lastRun.result.ranked)) ? s.lastRun : null;
    if (!wizard.lastRun) wizard.ran = false;
    wizard.feedback = migrateFeedback(s.feedback, wizard.lastRun);
    wizard.feedbackSaved = !!s.feedbackSaved;
    if (wizard.feedbackSaved && !wizard.ran) wizard.feedbackSaved = false;
    return wizard.ran;
  } catch (e) { return false; }
}

/* ---------------- Small helpers -------------------------------------------- */

function $(id) { return document.getElementById(id); }
function el(tag, cls, text) {
  var n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
}
function cloneSpeeds(src) {
  var out = {};
  Object.keys(src).forEach(function (v) { out[v] = Object.assign({}, src[v]); });
  return out;
}
function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function vehicleByName(name) {
  for (var i = 0; i < VEHICLES.length; i++) if (VEHICLES[i].name === name) return VEHICLES[i];
  return null;
}
function endOfCurrentMonth() {
  var now = new Date();
  return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
}
function fmtDate(iso) {
  if (!iso) return '—';
  var d = new Date(iso);
  return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
var toastTimer = null;
function toast(msg) {
  if (typeof document === 'undefined') return;
  var t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { t.classList.add('hidden'); }, 2600);
}

/* Usernames: 3-20 characters, letters, numbers and underscore only.
   Uniqueness is case-insensitive (citext in the database). Returns
   { ok: true } or { ok: false, reason: '...' }. */
function validateUsername(name) {
  var v = (name || '').trim();
  if (!v) return { ok: false, reason: 'Enter a username.' };
  if (v.length < 3 || v.length > 20) return { ok: false, reason: 'Username must be 3-20 characters.' };
  if (!/^[A-Za-z0-9_]+$/.test(v)) return { ok: false, reason: 'Username may only use letters, numbers and _.' };
  return { ok: true, value: v };
}

/* The URL to send the user back to after an auth email link (confirmation
   or password recovery). Only for http(s) pages — never for file://. */
function authRedirectUrl() {
  if (typeof window === 'undefined' || !window.location) return undefined;
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') return undefined;
  return window.location.origin + window.location.pathname;
}

/* Supabase puts auth-link errors in the URL hash, e.g.
   #error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired
   Parse them so the app can explain the problem instead of silently
   showing the locked screen. */
function parseAuthHashError() {
  if (typeof window === 'undefined' || !window.location.hash) return null;
  var params = new URLSearchParams(window.location.hash.substring(1));
  var err = params.get('error');
  if (!err) return null;
  return { error: err, code: params.get('error_code'), desc: params.get('error_description') };
}

/* Remove the auth hash from the address bar (it can contain a live
   access token after a confirmation/recovery link — it must not linger
   where it can be copied or logged). */
function clearAuthHash() {
  if (typeof window === 'undefined' || !window.history || !window.history.replaceState) return;
  if (!window.location.hash) return;
  window.history.replaceState(null, '', window.location.pathname + window.location.search);
}

/* ============================================================================
   PREDICTION ENGINE (pure functions — also unit-tested in Node, see bottom)
   ========================================================================== */

/* Recency weighting for history: exponential decay over saved races.
   The half-life (in races) is editable in js/config.js as
   HISTORY_HALF_LIFE_RACES (default 50). Age is the race's index in the
   newest-first list: 0 = newest race (weight 1.0), age == half-life
   gives weight 0.5. Invalid or missing config falls back to 50. */
function historyHalfLife() {
  var h = CONFIG && CONFIG.HISTORY_HALF_LIFE_RACES;
  if (typeof h === 'number' && isFinite(h) && h > 0) return h;
  return 50;
}
function decayWeight(ageInRaces, halfLife) {
  return Math.pow(0.5, ageInRaces / halfLife);
}

/* Segment length weights: how much of a race each segment covers
   (fractions summing to 1). Editable in js/config.js as SEGMENT_LENGTHS
   (default [0.189, 0.511, 0.300], derived from full-track races 21-29 —
   see README: seg1 1.70/9, seg2 4.60/9, seg3 2.70/9). Must be 3 finite
   positive numbers, else equal thirds. Values are normalised to sum to 1. */
function segmentLengths() {
  var s = CONFIG && CONFIG.SEGMENT_LENGTHS;
  if (Array.isArray(s) && s.length === 3 &&
      s.every(function (x) { return typeof x === 'number' && isFinite(x) && x > 0; })) {
    var sum = s[0] + s[1] + s[2];
    return [s[0] / sum, s[1] / sum, s[2] / sum];
  }
  return [1 / 3, 1 / 3, 1 / 3];
}

/* Odds blend weight: how much the game's odds move the prediction %
   (editable in js/config.js as ODDS_BLEND_WEIGHT, default 0.1).
   Invalid or missing config falls back to 0.1; 0 = odds ignored. */
function oddsBlendWeight() {
  var w = CONFIG && CONFIG.ODDS_BLEND_WEIGHT;
  if (typeof w === 'number' && isFinite(w) && w >= 0 && w <= 1) return w;
  return 0.1;
}

/* Historical frequency of a track type for a segment position (index 0, 1
   or 2), conditioned on the segments that ARE known (pinned).
   knownSegs = { segmentIndex: track } for pinned segments only.
   Falls back to all races for that position, then to equal probability
   (1/6) when there is no data. Saved races with 'unknown' at this position
   are excluded from the counts — they carry no track information.
   Counts are decay-weighted by recency (newest race weight 1.0, halving
   every HISTORY_HALF_LIFE_RACES races), so recent races count more. */
function historicalFreq(segIndex, knownSegs, raceList) {
  var dist = {};
  TRACKS.forEach(function (t) { dist[t] = 0; });
  knownSegs = knownSegs || {};
  var knownKeys = Object.keys(knownSegs);
  var halfLife = historyHalfLife();
  // Races matching the pinned segments, each carrying its decay weight
  // from its index in the newest-first list (index 0 = newest).
  var pool = [];
  raceList.forEach(function (r, i) {
    if (!r.tracks) return;
    if (knownKeys.every(function (k) { return r.tracks[k] === knownSegs[k]; })) {
      pool.push({ race: r, weight: decayWeight(i, halfLife) });
    }
  });
  if (!pool.length) {
    raceList.forEach(function (r, i) {
      if (r.tracks) pool.push({ race: r, weight: decayWeight(i, halfLife) });
    });
  }
  var totalWeight = 0;
  pool.forEach(function (entry) {
    var t = entry.race.tracks[segIndex];
    if (dist[t] !== undefined) { dist[t] += entry.weight; totalWeight += entry.weight; }
  });
  if (!totalWeight) {
    TRACKS.forEach(function (t) { dist[t] = 1 / TRACKS.length; });
    return dist;
  }
  TRACKS.forEach(function (t) { dist[t] = dist[t] / totalWeight; });
  return dist;
}

/* Probability distribution over the 6 tracks for one segment.
   hint = { mode: 'unknown' | 'hint' | 'pin', track, chance } */
function segmentDistribution(segIndex, knownSegs, hint, raceList) {
  if (hint && hint.mode === 'pin' && hint.track) {
    var pinned = {};
    TRACKS.forEach(function (t) { pinned[t] = (t === hint.track) ? 1 : 0; });
    return pinned;
  }
  var hist = historicalFreq(segIndex, knownSegs, raceList);
  if (hint && hint.mode === 'hint' && hint.track) {
    var p = clamp((hint.chance || 50) / 100, 0, 1);
    var others = TRACKS.filter(function (t) { return t !== hint.track; });
    var sum = others.reduce(function (s, t) { return s + hist[t]; }, 0);
    var dist = {};
    dist[hint.track] = p;
    others.forEach(function (t) {
      dist[t] = (1 - p) * (sum > 0 ? hist[t] / sum : 1 / others.length);
    });
    return dist;
  }
  return hist;
}

/* Segments the user has pinned (knows exactly), as { segmentIndex: track }. */
function pinnedSegments(hints) {
  var known = {};
  (hints || []).forEach(function (h, i) {
    if (h && h.mode === 'pin' && h.track) known[i] = h.track;
  });
  return known;
}

/* ONE-TRACK RULE (pure helper, unit-tested in Node).
   The game shows exactly ONE track before the bet, so at most one segment
   may be pinned. Given the three segment states and the index being
   pinned, return new states where only that segment stays pinned: any
   OTHER pinned segment goes back to Unknown. Hints on other segments are
   left alone — a hint is a guess, not a known track. */
function applySinglePin(hints, pinIndex) {
  return (hints || []).map(function (h, i) {
    if (i === pinIndex) return h;
    if (h && h.mode === 'pin') return { mode: 'unknown', track: null, chance: 50 };
    return h;
  });
}

/* Apply the one-track rule to the live Predict tab state: segment segNum
   (1-based) is being pinned — unpin any other pinned segment. */
function pinSegment(segNum) {
  var states = applySinglePin([pred.seg1, pred.seg2, pred.seg3], segNum - 1);
  pred.seg1 = states[0]; pred.seg2 = states[1]; pred.seg3 = states[2];
}

/* Engine-side enforcement of the one-track rule: if the input somehow
   carries two or three pins, keep only the FIRST pinned segment (lowest
   index) and treat the others as Unknown. With at most one pin this is a
   no-op. */
function oneTrackHints(hints) {
  var seenPin = false;
  return (hints || []).map(function (h) {
    if (h && h.mode === 'pin' && h.track) {
      if (seenPin) return { mode: 'unknown', track: null, chance: 50 };
      seenPin = true;
    }
    return h;
  });
}

/* Confidence guard (unit-tested in Node via scripts/test-confidence-guard.js).
   Called from computePrediction right after the odds blend, with
   unknownCount = number of segments not pinned (3 minus pinned count).
   While segments are only guessed, no vehicle may look certain: shrink
   every % toward 1/3 (0.2 per unknown segment), then clamp — [0.05, 0.90]
   with any unknown segment, [0.02, 0.95] with all three known — then
   renormalise so the three still sum to 1, then clamp once more so the
   cap holds exactly (renormalising a capped value can push it just over
   the cap again, e.g. [1, 0, 0] -> 95.96% without this step). The final
   clamp means the displayed total can be 99-100% in degenerate cases.
   Mutates `final` in place. */
function applyConfidenceGuard(final, unknownCount) {
  var vehicles = Object.keys(final);
  var shrink = 0.2 * unknownCount;
  if (shrink > 0) {
    vehicles.forEach(function (v) {
      final[v] = (1 - shrink) * final[v] + shrink * (1 / 3);
    });
  }
  var guardLo = unknownCount > 0 ? 0.05 : 0.02;
  var guardHi = unknownCount > 0 ? 0.90 : 0.95;
  vehicles.forEach(function (v) {
    final[v] = clamp(final[v], guardLo, guardHi);
  });
  var guardTotal = vehicles.reduce(function (s, v) { return s + final[v]; }, 0);
  vehicles.forEach(function (v) { final[v] = final[v] / guardTotal; });
  // Final clamp: renormalising can push a capped value just over the cap
  // again ([1,0,0] -> 95.96% without this). No second renormalise — the
  // displayed total may then be 99-100% in degenerate cases, which is fine.
  vehicles.forEach(function (v) {
    final[v] = clamp(final[v], guardLo, guardHi);
  });
}

/* ============================================================================
   DATA-ONLY RANKING (lrp-v19 — the user's order, 23 Nov 2026)
   Rank the 3 vehicles PURELY from the saved races: no speeds, no segment
   lengths, no odds, nothing invented. Hierarchical back-off — use the
   most specific level with enough matches:
     L1: same 3 vehicles + same known segment + same known track
     L2: same 3 vehicles + same known track (any segment)
     L3: same 3 vehicles (any tracks)
     L4: each vehicle's overall win rate across all saved races
   DATA_ONLY_MIN_MATCHES (2): a level fires only with at least this many
   matching races, else fall to the next level. Chosen by replay on the
   346 local races (thresholds mode): minMatches 2 + alpha 2 scored
   best (HIGH 39.2%, top-2 69.2%) of the four combos tested. At the chosen level the
   win share is Laplace-smoothed toward the next level's share
   (DATA_ONLY_ALPHA = 2 pseudo-races) so a small sample can never show
   100% or 0% — the % stays traceable to the data. Plain counts, no
   recency decay: with opts.decay the win counts are decay-weighted
   (newest race weight 1.0, halving every HISTORY_HALF_LIFE_RACES races)
   so recent races count more while every race — first bet to last —
   still contributes; without it, plain counts: every saved race counts
   the same. Shares are clamped
   to [1%, 99%] and renormalised so the three sum to exactly 1.
   Returns { ranked: [{vehicle, prob, wins}], dataInfo } where dataInfo
   is { level, levelLabel, matches, counts, shares, overallWins,
   overallAppearances, overallRates }. */
var DATA_ONLY_MIN_MATCHES = 2;
var DATA_ONLY_ALPHA = 2;

function dataOnlyRank(vehicles, knownSeg, knownTrack, raceList, opts) {
  var minMatches = (opts && typeof opts.minMatches === 'number') ? opts.minMatches : DATA_ONLY_MIN_MATCHES;
  var alpha = (opts && typeof opts.alpha === 'number') ? opts.alpha : DATA_ONLY_ALPHA;
  var races = raceList || [];
  // lrp-v22: opts.decay weights the win counts by recency — the weight
  // of a race is decayWeight(age, halfLife) with age = its index in the
  // newest-first list (0 = newest race, weight 1.0). The weight never
  // reaches 0, so the first bet still counts; decay only weights. Off
  // by default, so the v19 plain-counts behaviour is unchanged.
  var useDecay = !!(opts && opts.decay);
  var halfLife = historyHalfLife();
  function raceWeight(r) {
    if (!useDecay) return 1;
    var i = races.indexOf(r);
    return i < 0 ? 1 : decayWeight(i, halfLife);
  }
  var setKey = vehicles.slice().sort().join('|');
  function setOf(r) {
    return r && Array.isArray(r.vehicles) && r.vehicles.length === 3
      ? r.vehicles.slice().sort().join('|') : '';
  }
  function hasTrack(r, t) {
    return r && Array.isArray(r.tracks) && r.tracks.indexOf(t) !== -1;
  }
  var l1 = [], l2 = [], l3 = [];
  var overallWins = {}, overallApp = {};
  var overallWinsW = {}, overallAppW = {};
  vehicles.forEach(function (v) { overallWins[v] = 0; overallApp[v] = 0; overallWinsW[v] = 0; overallAppW[v] = 0; });
  races.forEach(function (r) {
    if (!r || !Array.isArray(r.vehicles)) return;
    var wgt = raceWeight(r);
    vehicles.forEach(function (v) {
      if (r.vehicles.indexOf(v) !== -1) {
        overallApp[v] += 1;
        overallAppW[v] += wgt;
        if (r.winner === v) { overallWins[v] += 1; overallWinsW[v] += wgt; }
      }
    });
    if (setOf(r) !== setKey) return;
    l3.push(r);
    if (knownTrack && hasTrack(r, knownTrack)) l2.push(r);
    if (knownSeg !== null && knownSeg !== undefined && knownTrack &&
        Array.isArray(r.tracks) && r.tracks[knownSeg] === knownTrack) l1.push(r);
  });
  function winsOf(list, weighted) {
    var c = {};
    vehicles.forEach(function (v) { c[v] = 0; });
    list.forEach(function (r) { if (c[r.winner] !== undefined) c[r.winner] += weighted ? raceWeight(r) : 1; });
    return c;
  }
  function totalOf(counts) {
    return vehicles.reduce(function (s, v) { return s + (counts[v] || 0); }, 0);
  }
  function normalize(shares) {
    var total = vehicles.reduce(function (s, v) { return s + (shares[v] || 0); }, 0);
    var out = {};
    vehicles.forEach(function (v) { out[v] = total > 0 ? shares[v] / total : 1 / vehicles.length; });
    return out;
  }
  // L4 — overall win rates, smoothed toward uniform 1/3, then shares.
  // With decay on, the rates come from the decay-weighted wins and
  // appearances (identical to the plain counts when decay is off).
  var rate4 = {};
  vehicles.forEach(function (v) {
    rate4[v] = (overallWinsW[v] + alpha / vehicles.length) / (overallAppW[v] + alpha);
  });
  var share4 = normalize(rate4);
  function smooth(counts, n, prior) {
    var s = {};
    vehicles.forEach(function (v) {
      s[v] = (counts[v] + alpha * prior[v]) / (n + alpha);
    });
    return normalize(s);
  }
  // counts* are RAW win counts (shown in the UI as "Won X of N races");
  // wcounts* are the decay-weighted counts that drive the shares.
  var counts3 = winsOf(l3), counts2 = winsOf(l2), counts1 = winsOf(l1);
  var wcounts3 = winsOf(l3, true), wcounts2 = winsOf(l2, true), wcounts1 = winsOf(l1, true);
  var share3 = smooth(wcounts3, totalOf(wcounts3), share4);
  var share2 = knownTrack ? smooth(wcounts2, totalOf(wcounts2), share3) : share3;
  var share1 = (knownSeg !== null && knownSeg !== undefined && knownTrack)
    ? smooth(wcounts1, totalOf(wcounts1), share2) : share2;
  var level = 4, levelLabel = 'overall win rates', matches = races.length, counts = overallWins, shares = share4;
  if (l3.length >= minMatches) { level = 3; levelLabel = 'same cars'; matches = l3.length; counts = counts3; shares = share3; }
  if (knownTrack && l2.length >= minMatches) { level = 2; levelLabel = 'same cars + ' + knownTrack + ' anywhere'; matches = l2.length; counts = counts2; shares = share2; }
  if (knownSeg !== null && knownSeg !== undefined && knownTrack && l1.length >= minMatches) { level = 1; levelLabel = 'same cars + Seg ' + (knownSeg + 1) + ' ' + knownTrack; matches = l1.length; counts = counts1; shares = share1; }
  var overallRates = {};
  vehicles.forEach(function (v) { overallRates[v] = overallApp[v] > 0 ? overallWins[v] / overallApp[v] : 0; });
  // Clamp to [1%, 99%] then renormalise so the three sum to exactly 1.
  var clamped = {};
  vehicles.forEach(function (v) { clamped[v] = clamp(shares[v], 0.01, 0.99); });
  shares = normalize(clamped);
  var ranked = vehicles.map(function (v, i) {
    return { vehicle: v, prob: shares[v], wins: counts[v] || 0, index: i };
  }).sort(function (a, b) {
    if (b.prob !== a.prob) return b.prob - a.prob;
    if (share4[b.vehicle] !== share4[a.vehicle]) return share4[b.vehicle] - share4[a.vehicle];
    return a.index - b.index;
  }).map(function (r) { return { vehicle: r.vehicle, prob: r.prob, wins: r.wins }; });
  return {
    ranked: ranked,
    dataInfo: {
      level: level, levelLabel: levelLabel, matches: matches, counts: counts, shares: shares,
      overallWins: overallWins, overallAppearances: overallApp, overallRates: overallRates
    }
  };
}

/* lrp-v22 — SPEEDS + FULL-HISTORY BLEND.
   The user's order (24 Nov 2026): use the game's own speeds AND the
   full saved history — first bet to last — to predict. This replaces
   the v19 data-only ranking.
   - Speed share: the canonical DEFAULT_SPEEDS table (the game's own
     speeds per track), NEVER a user's localStorage edits — those are
     per-user, local-only, and the app's speed table is user-editable,
     so they cannot be the shared ranking. For the pinned track, the
     share is each vehicle's speed on that track over the three speeds.
     With no track pinned, each vehicle's EXPECTED speed is the plain
     mean of its per-track speeds (no track is more likely than another
     before the bet shows one).
   - History share: dataOnlyRank with the recency decay ON (halves
     every 50 races — every race still counts, recent ones count more).
   - Blend: final = V22_SPEED_WEIGHT * speed + (1 - V22_SPEED_WEIGHT)
     * history. The weight is 0.6 (speed-primary): on the 346 local
     races the replay at 0.5 let thin history overrule the speed table
     in the user's own Desert example (Stock Car is fastest on Desert
     per the table, yet SUV had the only Desert wins) — 0.6 is the
     lowest weight that puts Stock Car first there, while 0.7 gave up
     too much of the history signal. See scripts/replay-blend-v22.js.
   - The blended ranking carries the dataOnlyRank wins and level so
     the UI reason ("Won X of N races") and the feedback counters keep
     working, and the confidence guard is applied in computePrediction
     after the blend (it was dropped from the ranking path in v19). */
var V22_SPEED_WEIGHT = 0.6;

function speedShares(vehicles, knownSeg, knownTrack) {
  var speeds = {};
  vehicles.forEach(function (v) {
    var t = DEFAULT_SPEEDS[v] || {};
    if (knownTrack && typeof t[knownTrack] === 'number') {
      speeds[v] = t[knownTrack];
    } else {
      // No track pinned: expected speed is the plain mean of the
      // vehicle's per-track speeds — before the bet shows a track,
      // no track is more likely than another.
      var sum = 0, n = 0;
      TRACKS.forEach(function (tr) {
        if (typeof t[tr] === 'number') { sum += t[tr]; n += 1; }
      });
      speeds[v] = n > 0 ? sum / n : 0;
    }
  });
  var sum = vehicles.reduce(function (s, v) { return s + speeds[v]; }, 0);
  var shares = {};
  vehicles.forEach(function (v) { shares[v] = sum > 0 ? speeds[v] / sum : 1 / vehicles.length; });
  return { shares: shares, speeds: speeds };
}

function blendedRank(vehicles, knownSeg, knownTrack, raceList, opts) {
  var w = (opts && typeof opts.speedWeight === 'number') ? opts.speedWeight : V22_SPEED_WEIGHT;
  if (w < 0) w = 0;
  if (w > 1) w = 1;
  var data = dataOnlyRank(vehicles, knownSeg, knownTrack, raceList, { decay: true });
  var speed = speedShares(vehicles, knownSeg, knownTrack);
  var blended = {};
  vehicles.forEach(function (v) {
    blended[v] = w * speed.shares[v] + (1 - w) * data.dataInfo.shares[v];
  });
  var total = vehicles.reduce(function (s, v) { return s + blended[v]; }, 0);
  if (total > 0) vehicles.forEach(function (v) { blended[v] = blended[v] / total; });
  var dataByVehicle = {};
  data.ranked.forEach(function (r) { dataByVehicle[r.vehicle] = r; });
  var ranked = vehicles.map(function (v, i) {
    return { vehicle: v, prob: blended[v], wins: (dataByVehicle[v] && dataByVehicle[v].wins) || 0, index: i };
  }).sort(function (a, b) {
    if (b.prob !== a.prob) return b.prob - a.prob;
    // Tie-break: the data share, then input order (same as dataOnlyRank).
    var da = data.dataInfo.shares[a.vehicle], db = data.dataInfo.shares[b.vehicle];
    if (db !== da) return db - da;
    return a.index - b.index;
  }).map(function (r) { return { vehicle: r.vehicle, prob: r.prob, wins: r.wins }; });
  return {
    ranked: ranked,
    dataInfo: data.dataInfo,
    blendInfo: {
      speedWeight: w, speedShares: speed.shares, speeds: speed.speeds,
      historyShares: data.dataInfo.shares
    }
  };
}

/* Short human reason for a blended pick: the speed table AND the saved
   races, in one line. blendInfo is the blendedRank result info. */
function buildBlendReason(vehicle, dataInfo, blendInfo) {
  if (!blendInfo || !dataInfo) return 'Ranked from speeds and the saved races.';
  var w = (dataInfo.counts && dataInfo.counts[vehicle]) || 0;
  var m = dataInfo.matches || 0;
  var lvl = dataInfo.level;
  var speedPct = Math.round((blendInfo.speedShares[vehicle] || 0) * 100);
  var histPct = Math.round((blendInfo.historyShares[vehicle] || 0) * 100);
  var base;
  if (lvl === 1) base = 'Won ' + w + ' of ' + m + ' same cars + ' + dataInfo.levelLabel.replace('same cars + ', '') + ' races';
  else if (lvl === 2 || lvl === 3) base = 'Won ' + w + ' of ' + m + ' ' + dataInfo.levelLabel + ' races';
  else base = 'Overall win rate ' + Math.round((dataInfo.overallRates[vehicle] || 0) * 100) + '% across ' + (dataInfo.overallAppearances[vehicle] || 0) + ' races';
  return base + ' — speeds ' + speedPct + '%, history ' + histPct + '%.';
}

/* Short human reason for a data-only pick: what the saved races say.
   dataInfo is the dataOnlyRank result info. */
function buildDataReason(vehicle, dataInfo) {
  if (!dataInfo) return 'Ranked from the saved races.';
  var w = (dataInfo.counts && dataInfo.counts[vehicle]) || 0;
  var n = dataInfo.matches || 0;
  if (dataInfo.level === 4) {
    var app4 = (dataInfo.overallAppearances && dataInfo.overallAppearances[vehicle]) || 0;
    var rate = (dataInfo.overallRates && dataInfo.overallRates[vehicle]) || 0;
    if (app4 <= 0) return 'No saved races for this vehicle yet — ranked on the overall picture.';
    return 'Overall win rate ' + Math.round(rate * 100) + '% across ' + app4 + ' races';
  }
  if (n <= 0) return 'No matching races yet — ranked on overall win rate.';
  if (w > 0) return 'Won ' + w + ' of ' + n + ' ' + dataInfo.levelLabel + ' races';
  return 'No wins in ' + n + ' ' + dataInfo.levelLabel + ' races — ranked on overall win rate';
}

/* Core prediction. Returns { ranked: [{vehicle, prob, wins}], dist1, dist2, dist3, histInfo: null, oddsInfo: null, dataInfo, blendInfo }.
   lrp-v22: ranking is the SPEEDS + FULL-HISTORY BLEND — see blendedRank.
   dist1/2/3 are the empirical per-segment track distributions (kept for
   the return shape); they do NOT influence the ranking. The confidence
   guard is applied to the blended ranking AFTER the blend: with any
   track unknown it shrinks each % toward 1/3, so an unknown track can
   never show over 90% (or under 5%) — the guard was dropped from the
   ranking path in v19 and is restored here. */
function computePrediction(input) {
  var vehicles = input.vehicles;
  var raceList = input.races || [];
  // lrp-v22: ranking blends the canonical DEFAULT_SPEEDS table with the
  // full saved history (first bet to last, decay-weighted). input.speeds
  // (a user's localStorage edits) is accepted and IGNORED — the shared
  // ranking must come from the game's own speed table, not one phone's
  // edits. input.odds is accepted and ignored — odds stay in Log only.
  var hints = oneTrackHints([input.seg1Hint, input.seg2Hint, input.seg3Hint]);
  var knownSegs = pinnedSegments(hints);
  var knownKeys = Object.keys(knownSegs);
  var knownSeg = knownKeys.length ? parseInt(knownKeys[0], 10) : null;
  var knownTrack = knownSeg !== null ? knownSegs[knownSeg] : null;
  var dists = hints.map(function (h, i) { return segmentDistribution(i, knownSegs, h, raceList); });
  var res = blendedRank(vehicles, knownSeg, knownTrack, raceList, { speedWeight: input.speedWeight });
  // Confidence guard, restored in v22 (it was dropped from the ranking
  // path in v19): unknownCount = segments not pinned (3 minus the one
  // pinned segment, or 3 with no pin). The guard mutates a
  // {vehicle: prob} map in place, so build the map, guard it, then map
  // back to the ranked array and re-sort (the guard is monotonic, so
  // the order only changes on an exact tie at the cap).
  var guardMap = {};
  res.ranked.forEach(function (r) { guardMap[r.vehicle] = r.prob; });
  var unknownCount = hints.filter(function (h) { return !(h && h.mode === 'pin' && h.track); }).length;
  applyConfidenceGuard(guardMap, unknownCount);
  var ranked = res.ranked.map(function (r) {
    return { vehicle: r.vehicle, prob: guardMap[r.vehicle], wins: r.wins };
  }).sort(function (a, b) { return b.prob - a.prob; });
  return { ranked: ranked, dist1: dists[0], dist2: dists[1], dist3: dists[2], histInfo: null, oddsInfo: null, dataInfo: res.dataInfo, blendInfo: res.blendInfo };
}
/* Short human reason for a pick, given the distributions used.
   knownSegs = { segmentIndex: track } for pinned segments.
   dists = [dist1, dist2, dist3] probability distributions per segment. */
function buildReason(vehicle, others, knownSegs, dists, speedsMap) {
  var parts = [];
  var contenders = [vehicle].concat(others);

  function isFastest(v, track) {
    var best = null, bestSpeed = -1;
    contenders.forEach(function (c) {
      var s = speedsMap[c][track] || 0;
      if (s > bestSpeed) { bestSpeed = s; best = c; }
    });
    return best === v;
  }

  knownSegs = knownSegs || {};
  Object.keys(knownSegs).forEach(function (k) {
    var track = knownSegs[k];
    if (isFastest(vehicle, track)) parts.push('fastest on ' + track + ' (seg ' + (parseInt(k, 10) + 1) + ')');
  });
  var likely = [];
  (dists || []).forEach(function (d, i) {
    if (knownSegs[i] || !d) return;
    // Name a "likely" track only when the distribution actually favours one.
    // With a flat (uniform) distribution every track is equally likely, so
    // naming one would be a guess, not a likelihood.
    var top = TRACKS.slice().sort(function (a, b) { return d[b] - d[a]; })[0];
    if (d[top] > 1 / TRACKS.length + 0.05 && likely.indexOf(top) === -1) likely.push(top);
  });
  var strong = likely.filter(function (t) { return isFastest(vehicle, t); });
  if (strong.length) parts.push('strong on likely ' + strong.join(' / '));
  var vr = vehicleByName(vehicle).winRate;
  var maxVr = Math.max.apply(null, contenders.map(function (c) { return vehicleByName(c).winRate; }));
  if (vr === maxVr) parts.push('highest overall win rate (' + vr + '%)');
  if (!parts.length) parts.push('best all-round speed across the likely tracks');
  return parts.join('; ');
}

function formatDist(dist) {
  return TRACKS
    .map(function (t) { return { t: t, p: dist[t] || 0 }; })
    .filter(function (x) { return x.p >= 0.005; })
    .sort(function (a, b) { return b.p - a.p; })
    .map(function (x) { return x.t + ' ' + Math.round(x.p * 100) + '%'; })
    .join(', ');
}

/* ---------------- Local storage (cache + demo-mode store) ------------------ */

var LS_RACES = 'lrp_races_v1';
var LS_SPEEDS = 'lrp_speeds_v1';
/* Owner tag for the local race cache: the cache belongs to one user id.
   Without it, a second user signing in on the same browser could be
   shown the previous user's races if the cloud sync failed. */
var LS_RACES_OWNER = 'lrp_races_owner_v1';

function lsGet(key) {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch (e) { return null; }
}
function lsSet(key, val) {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(key, val);
  } catch (e) { /* storage full / private mode — ignore */ }
}
function loadLocalRaces() {
  try {
    var raw = lsGet(LS_RACES);
    return raw ? JSON.parse(raw) : [];
  } catch (e) { return []; }
}
function saveLocalRaces() {
  lsSet(LS_RACES, JSON.stringify(races));
  lsSet(LS_RACES_OWNER, currentUser ? currentUser.id : '');
}

/* Drop the local race cache when it belongs to a different user than the
   one now signed in (or when signed out). Call after refreshSession(). */
function discardStaleRaceCache() {
  if (DEMO_MODE) return;
  var owner = lsGet(LS_RACES_OWNER);
  if (owner && (!currentUser || owner !== currentUser.id)) {
    races = [];
    saveLocalRaces();
  }
}
function loadLocalSpeeds() {
  try {
    var raw = lsGet(LS_SPEEDS);
    if (!raw) return cloneSpeeds(DEFAULT_SPEEDS);
    var parsed = JSON.parse(raw);
    // Merge over defaults so new vehicles/tracks never break old saves.
    var merged = cloneSpeeds(DEFAULT_SPEEDS);
    Object.keys(parsed).forEach(function (v) {
      if (merged[v]) Object.assign(merged[v], parsed[v]);
    });
    return merged;
  } catch (e) { return cloneSpeeds(DEFAULT_SPEEDS); }
}
function saveLocalSpeeds() { lsSet(LS_SPEEDS, JSON.stringify(speeds)); }

/* ---------------- Supabase (auth, subscriptions, race sync) --------------- */

function initSupabase() {
  if (DEMO_MODE) return;
  if (typeof window === 'undefined' || !window.supabase) {
    /* SECURITY: the project IS configured, but the Supabase library did
       not load (CDN blocked/offline). Do NOT fall back to unlocked demo
       mode — that would let anyone use the full app by blocking the CDN.
       Stay locked and tell the user to reload. */
    console.warn('Supabase JS not loaded — staying locked (not demo mode).');
    sbLoadFailed = true;
    return;
  }
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
  /* Listen for auth events the app must react to:
     - PASSWORD_RECOVERY: the user arrived from a password-recovery email
       link — show the "Set new password" form.
     - SIGNED_OUT: reset to the signed-out state immediately (e.g. the
       session was revoked elsewhere). */
  sb.auth.onAuthStateChange(function (event, session) {
    if (event === 'PASSWORD_RECOVERY') {
      recoveryMode = true;
      if (session && session.user) currentUser = session.user;
      clearAuthHash();
      /* Refresh admin/subscription state so the first paint is correct,
         then show the set-new-password form. */
      checkAdmin().then(function () { return checkSubscription(); }).then(function () {
        showTab('account');
        renderAccount();
        applyTabLocks();
        maybeSubscribeLiveBets();
      });
    } else if (event === 'SIGNED_OUT') {
      unsubscribeLiveBets();
      liveLastBet = null; // the last bet belonged to the signed-out user
      currentUser = null; currentUsername = null; subActive = false; isAdmin = false;
      recoveryMode = false;
      races = []; saveLocalRaces();
      resetPrediction(); // the run belonged to the signed-out user
      renderAccount();
      renderPrediction();
      applyTabLocks();
    }
  });
}

async function refreshSession() {
  if (!sb) {
    if (SUPABASE_CONFIGURED) {
      /* Library failed to load on a configured site: locked, no session. */
      currentUser = null; currentUsername = null; subActive = false; isAdmin = false;
      return;
    }
    subActive = true; return; // demo mode: predictions unlocked
  }
  var res = await sb.auth.getSession();
  var session = res && res.data ? res.data.session : null;
  currentUser = session ? session.user : null;
  if (!currentUser) { subActive = false; isAdmin = false; return; }
  await checkAdmin();
  await checkSubscription();
}

async function checkAdmin() {
  isAdmin = false;
  currentUsername = null;
  if (!currentUser) return;
  if ((CONFIG.ADMIN_EMAILS || []).indexOf(currentUser.email) !== -1) isAdmin = true;
  try {
    var res = await sb.from('profiles').select('is_admin, username').eq('id', currentUser.id).maybeSingle();
    if (res && res.data) {
      if (res.data.is_admin) isAdmin = true;
      currentUsername = res.data.username || null;
    }
  } catch (e) { /* profiles table may not exist yet — config list still works for UI */ }
}

async function checkSubscription() {
  if (!currentUser) { subActive = false; subExpiresAt = null; return; }
  try {
    var res = await sb.from('subscriptions')
      .select('expires_at')
      .eq('user_id', currentUser.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res.error) throw new Error(res.error.message);
    if (res.data) {
      subActive = true;
      subExpiresAt = res.data.expires_at;
    } else {
      subActive = false;
      subExpiresAt = null;
    }
  } catch (e) {
    /* Network/table error: keep the previous subscription state instead
       of locking a paying user out on a blip. The next check retries. */
    console.warn('Subscription check failed:', e);
  }
}

/* Races: Supabase is the source of truth when signed in; localStorage is cache.
   Returns true when the cloud sync succeeded (or was not needed). */
async function syncRacesFromCloud() {
  if (!sb || !currentUser) return true;
  try {
    var res = await sb.from('races')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (res.error) { console.warn('Race sync failed:', res.error.message); return false; }
    races = (res.data || []).map(function (r) {
      return {
        id: r.id, vehicles: r.vehicles, tracks: r.tracks, patterns: r.patterns || [],
        winner: r.winner, how_won: r.how_won, how_won_text: r.how_won_text || '',
        odds: r.odds || {}, created_at: r.created_at
      };
    });
    saveLocalRaces();
    return true;
  } catch (e) { console.warn('Race sync failed:', e); return false; }
}

async function cloudInsertRace(race) {
  if (!sb || !currentUser) return null;
  /* Premium gate at the data layer too: a non-premium user must not be
     able to save races even by calling this from the console. */
  if (!appAccess().ok) return null;
  var res = await sb.from('races').insert({
    user_id: currentUser.id,
    vehicles: race.vehicles,
    tracks: race.tracks,
    patterns: race.patterns,
    winner: race.winner,
    how_won: race.how_won,
    how_won_text: race.how_won_text,
    odds: race.odds
  }).select('id, created_at').single();
  if (res.error) { console.warn('Cloud insert failed:', res.error.message); return null; }
  return res.data;
}
async function cloudUpdateRace(race) {
  if (!sb || !currentUser) return false;
  if (!appAccess().ok) return false;
  var res = await sb.from('races').update({
    vehicles: race.vehicles, tracks: race.tracks, patterns: race.patterns,
    winner: race.winner, how_won: race.how_won, how_won_text: race.how_won_text,
    odds: race.odds
  }).eq('id', race.id).eq('user_id', currentUser.id);
  return !res.error;
}
async function cloudDeleteRace(id) {
  if (!sb || !currentUser) return false;
  if (!appAccess().ok) return false;
  var res = await sb.from('races').delete().eq('id', id).eq('user_id', currentUser.id);
  return !res.error;
}

/* ============================================================================
   UI — tabs
   ========================================================================== */

function showTab(name) {
  document.querySelectorAll('.tab').forEach(function (s) { s.classList.remove('active'); });
  var sec = $('tab-' + name);
  if (sec) sec.classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-tab') === name);
  });
  if (name === 'stats') renderStats();
  if (name === 'log') renderRaceList();
  if (name === 'account') renderAccount();
  /* lrp-v21: coming back to Predict re-fetches the live row at once —
     a bet that arrived (or was missed) while the user was on another
     tab is picked up immediately instead of waiting for START. The
     in-flight guard in fetchLatestLiveBet makes this safe to call
     from handleLiveBet's own showTab('predict'). */
  if (name === 'predict') fetchLatestLiveBet();
  applyTabLocks();
  window.scrollTo(0, 0);
}

/* Vehicle pictures — detailed ORIGINAL illustrations drawn in-code as
   inline SVG (game art is copyrighted: no screenshots, no copied art).
   Each vehicle has its own shape in its own colour, with glass, lights,
   shadow and tread; body uses currentColor, shared classes (.w, .hub,
   .glass, .light, .tread, ...) are styled in style.css. viewBox 0 0 120 64. */
var GLYPH_SVG = {
  sedan: '<ellipse class="shadow" cx="60" cy="58" rx="50" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M8 46 L13 33 Q15 29 21 28 L35 25 Q43 13 59 12 L79 12 Q93 14 101 25 L109 28 Q116 30 116 37 L116 46 Q116 49 112 49 L10 49 Q8 49 8 46 Z"/>' +
    '<path class="glass" d="M40 25 Q46 15 58 14 L74 14 Q86 15 92 25 Z"/>' +
    '<path class="shine" d="M48 23 L56 15 L60 15 L52 23 Z"/>' +
    '<path class="line" d="M62 26 L62 46"/>' +
    '<circle class="light" cx="112" cy="38" r="3"/>' +
    '<circle class="tail" cx="10" cy="38" r="2.5"/>' +
    '<circle class="w" cx="32" cy="49" r="9"/><circle class="w" cx="92" cy="49" r="9"/>' +
    '<circle class="hub" cx="32" cy="49" r="3.5"/><circle class="hub" cx="92" cy="49" r="3.5"/>',
  suv: '<ellipse class="shadow" cx="60" cy="58" rx="52" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M8 48 L10 27 Q11 23 16 22 L27 20 Q33 9 47 9 L86 9 Q97 9 101 19 L105 22 Q114 24 114 33 L114 48 Q114 51 110 51 L10 51 Q8 51 8 48 Z"/>' +
    '<path class="rail" d="M34 9 L34 5 M84 9 L84 5 M30 5 L88 5"/>' +
    '<path class="glass" d="M32 20 Q37 11 47 11 L82 11 Q92 11 95 20 Z"/>' +
    '<path class="shine" d="M40 18 L48 12 L52 12 L44 18 Z"/>' +
    '<path class="line" d="M60 22 L60 48"/>' +
    '<circle class="light" cx="110" cy="36" r="3"/>' +
    '<circle class="tail" cx="11" cy="36" r="2.5"/>' +
    '<circle class="w" cx="30" cy="51" r="10"/><circle class="w" cx="92" cy="51" r="10"/>' +
    '<circle class="hub" cx="30" cy="51" r="4"/><circle class="hub" cx="92" cy="51" r="4"/>',
  sport: '<ellipse class="shadow" cx="60" cy="58" rx="50" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M6 48 L15 38 Q19 34 27 33 L47 30 Q57 18 73 18 L87 18 Q101 20 107 30 L113 34 Q118 36 118 42 L118 48 Q118 51 114 51 L8 51 Q6 51 6 48 Z"/>' +
    '<path class="glass" d="M52 30 Q60 20 72 20 L84 20 Q94 21 99 30 Z"/>' +
    '<path class="shine" d="M58 28 L66 21 L70 21 L62 28 Z"/>' +
    '<path class="line" d="M100 40 Q106 40 110 44"/>' +
    '<ellipse class="light" cx="112" cy="40" rx="4" ry="2.5"/>' +
    '<circle class="w" cx="34" cy="51" r="8"/><circle class="w" cx="94" cy="51" r="8"/>' +
    '<circle class="hub" cx="34" cy="51" r="3"/><circle class="hub" cx="94" cy="51" r="3"/>',
  super: '<ellipse class="shadow" cx="60" cy="58" rx="52" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M4 38 L20 31 L22 35 L6 42 Z"/>' +
    '<path class="bd" fill="currentColor" d="M4 50 L17 40 Q23 36 35 34 L55 30 Q69 20 87 20 L95 20 Q107 22 111 30 L116 36 Q119 40 119 46 L119 50 Q119 52 116 52 L6 52 Q4 52 4 50 Z"/>' +
    '<path d="M6 46 L114 46 L114 50 Q114 52 112 52 L8 52 Q6 52 6 50 Z" fill="rgba(0,0,0,.12)"/>' +
    '<path class="glass" d="M60 30 Q70 22 85 22 L92 22 Q100 23 104 30 Z"/>' +
    '<path class="shine" d="M66 28 L74 23 L78 23 L70 28 Z"/>' +
    '<path class="light" d="M108 38 Q114 38 116 42 L110 43 Q106 42 106 40 Z"/>' +
    '<circle class="w" cx="34" cy="52" r="8"/><circle class="w" cx="94" cy="52" r="8"/>' +
    '<circle class="hub" cx="34" cy="52" r="3"/><circle class="hub" cx="94" cy="52" r="3"/>',
  stock: '<ellipse class="shadow" cx="60" cy="58" rx="50" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M8 36 L22 30 L24 34 L10 40 Z"/>' +
    '<path class="bd" fill="currentColor" d="M8 46 L13 33 Q15 29 21 28 L35 25 Q43 13 59 12 L79 12 Q93 14 101 25 L109 28 Q116 30 116 37 L116 46 Q116 49 112 49 L10 49 Q8 49 8 46 Z"/>' +
    '<path class="glass" d="M40 25 Q46 15 58 14 L74 14 Q86 15 92 25 Z"/>' +
    '<circle cx="62" cy="35" r="8.5" fill="#ffffff" stroke="rgba(0,0,0,.2)"/>' +
    '<text x="62" y="39" font-size="11" font-weight="900" text-anchor="middle" fill="#101a3a">7</text>' +
    '<circle class="light" cx="112" cy="38" r="3"/>' +
    '<circle class="tail" cx="10" cy="38" r="2.5"/>' +
    '<circle class="w" cx="32" cy="49" r="9"/><circle class="w" cx="92" cy="49" r="9"/>' +
    '<circle class="hub" cx="32" cy="49" r="3.5"/><circle class="hub" cx="92" cy="49" r="3.5"/>',
  orv: '<ellipse class="shadow" cx="60" cy="58" rx="52" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M8 48 L12 32 Q14 28 20 27 L30 25 Q36 12 52 12 L84 12 Q96 14 100 25 L110 28 Q116 30 116 38 L116 48 Q116 51 112 51 L10 51 Q8 51 8 48 Z"/>' +
    '<path class="rack" d="M44 12 L44 5 M88 12 L88 5 M38 5 L94 5"/>' +
    '<path class="glass" d="M36 25 Q42 14 52 14 L80 14 Q90 15 94 25 Z"/>' +
    '<path class="shine" d="M44 23 L52 15 L56 15 L48 23 Z"/>' +
    '<path class="line" d="M60 26 L60 48"/>' +
    '<path class="line" d="M110 34 L110 46 M114 36 L114 44"/>' +
    '<circle class="light" cx="111" cy="37" r="3"/>' +
    '<circle class="tail" cx="11" cy="37" r="2.5"/>' +
    '<circle class="w" cx="30" cy="51" r="10"/><circle class="w" cx="92" cy="51" r="10"/>' +
    '<circle class="hub" cx="30" cy="51" r="4"/><circle class="hub" cx="92" cy="51" r="4"/>',
  atv: '<ellipse class="shadow" cx="60" cy="58" rx="50" ry="4"/>' +
    '<path class="bd" fill="currentColor" d="M16 44 L22 30 Q24 26 30 26 L46 24 Q52 14 64 14 L80 14 Q92 16 96 26 L106 28 Q114 30 114 38 L114 44 Q114 47 110 47 L18 47 Q16 47 16 44 Z"/>' +
    '<path d="M46 24 L40 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M60 22 L76 22" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
    '<circle class="w" cx="32" cy="47" r="11"/><circle class="tread" cx="32" cy="47" r="11"/>' +
    '<circle class="w" cx="92" cy="47" r="11"/><circle class="tread" cx="92" cy="47" r="11"/>' +
    '<circle class="hub" cx="32" cy="47" r="4"/><circle class="hub" cx="92" cy="47" r="4"/>',
  monster: '<ellipse class="shadow" cx="60" cy="58" rx="54" ry="4.5"/>' +
    '<path class="bd" fill="currentColor" d="M12 40 L16 24 Q18 20 24 20 L34 18 Q40 8 54 8 L82 8 Q94 10 98 20 L106 22 Q114 24 114 32 L114 40 Q114 43 110 43 L14 43 Q12 43 12 40 Z"/>' +
    '<path class="glass" d="M38 18 Q44 10 54 10 L78 10 Q88 10 92 18 Z"/>' +
    '<path class="shine" d="M46 16 L52 11 L56 11 L50 16 Z"/>' +
    '<path class="line" d="M30 43 L30 37 M88 43 L88 37"/>' +
    '<circle class="light" cx="110" cy="32" r="3"/>' +
    '<circle class="tail" cx="14" cy="32" r="2.5"/>' +
    '<circle class="w" cx="34" cy="45" r="14"/><circle class="tread" cx="34" cy="45" r="14"/>' +
    '<circle class="w" cx="90" cy="45" r="14"/><circle class="tread" cx="90" cy="45" r="14"/>' +
    '<circle class="hub" cx="34" cy="45" r="5"/><circle class="hub" cx="90" cy="45" r="5"/>',
  bike: '<ellipse class="shadow" cx="60" cy="58" rx="48" ry="4"/>' +
    '<path class="glass" d="M50 24 L44 12 L50 12 L56 24 Z"/>' +
    '<path d="M28 48 L54 26 L86 26 L92 48" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M54 26 L46 15" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>' +
    '<path d="M60 24 L78 24" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round"/>' +
    '<circle cx="58" cy="38" r="5" fill="currentColor"/>' +
    '<path d="M80 46 L96 44" fill="none" stroke="#9aa3b2" stroke-width="3" stroke-linecap="round"/>' +
    '<circle class="light" cx="88" cy="28" r="2.5"/>' +
    '<circle class="w" cx="28" cy="48" r="11"/><circle class="w" cx="92" cy="48" r="11"/>' +
    '<circle class="hub" cx="28" cy="48" r="4"/><circle class="hub" cx="92" cy="48" r="4"/>'
};

function glyphHtml(v) {
  return '<svg class="v-glyph" viewBox="0 0 120 64" style="color:' + v.color + '" aria-hidden="true">' +
    (GLYPH_SVG[v.glyph] || GLYPH_SVG.sedan) + '</svg>';
}

/* ============================================================================
   UI — Predict tab
   ========================================================================== */

/* ============================================================================
   UI — Predict tab
   ========================================================================== */

/* ---------------- Live auto-predict (lrp-v17) ---------------------------- */
/* The Android Live Reader watches the game screen and upserts ONE row per
   user into public.live_bets (see sql/migration-live-bets.sql) each time
   a new bet appears. This app subscribes to that table over Supabase
   Realtime and auto-drives the Predict wizard from the row — no taps
   needed inside the 35-second betting timer.
     - The subscription is per-user (filter user_id=eq.<own id>); RLS on
       live_bets is own-row only, so nobody else's bets can arrive here.
     - A row is only acted on when it is fresh (updated_at within 60 s),
       has exactly 3 known vehicles, and has at least one known track.
     - DEDUP: a row with the same vehicles + shown track as the last
       auto-run bet is a refresh of the same screen — UNLESS it is the
       NEXT race with the identical line-up. isNewLiveBet tells them
       apart: updated_at at least LIVE_NEW_BET_GAP_MS (40 s) newer
       than the last processed row (one screen lives at most 35 s),
       or the timer jumped back up near 35 after counting down
       (timer reset = new screen). Without this, two consecutive
       identical bets would lose the second prediction.
     - The shown countdown is age-adjusted: timer_seconds minus the time
       since updated_at (liveRemainingSeconds). A bet arriving with under
       10 s left is still predicted but marked LATE on the result.
     - A live bet ALWAYS wins over an unfinished manual pick (wizard
       steps 1–2 with no run yet — lrp-v21): the manual pick is for the
       same race and is at most 4 taps, while dropping the live bet is
       exactly what the user reported ("the Predictor never auto-shows
       a bet"). The old 'manual-busy' drop is gone — decideLiveBet no
       longer takes a manual-busy flag. A finished manual run (step 3)
       is still replaced by the next live bet, as before.
     - Realtime is NOT trusted alone (lrp-v21): a 4 s REST poll
       re-fetches the live row while live mode is on; a dead Realtime
       channel is torn down and re-subscribed on backoff; returning to
       the Predict tab, or to a visible tab, re-fetches at once.
     - The wizard is driven with the existing functions only
       (resetPrediction -> applyLiveBet -> runPrediction); the prediction
       model, odds blend, confidence guard and duplicate protection are
       untouched, and the 3-button feedback saves exactly as today.
     - The result stays on screen until the next bet replaces it.
     - The toggle defaults ON and is persisted in localStorage; when OFF
       the channel is removed and nothing auto-drives. Manual
       START / pick / pin / RUN keeps working exactly as before. */
var LS_LIVE = 'lrp_live_v1';
var LIVE_STALE_MS = 60000; // a bet older than this is finished — never auto-run it
var LIVE_LATE_SECONDS = 10; // under this many seconds left when a bet arrives: still predict, but mark it LATE
var liveEnabled = (function () {
  var raw = lsGet(LS_LIVE);
  return raw === null ? true : raw === '1';
})();
var liveChannel = null;  // active Realtime channel (null when off / signed out)
var liveActive = false;  // a live subscription is currently open
var liveLastBet = null; // { key, updatedAtMs, timerSeconds } of the last
                       // bet we auto-ran (dedup re-fires). The key alone
                       // cannot tell two CONSECUTIVE IDENTICAL bets apart,
                       // so the dedup also remembers WHEN the bet was
                       // processed and what the timer read (isNewLiveBet).

/* Bet identity: the 3 vehicles (order-insensitive) + the 3 tracks in
   order, with missing entries read as 'unknown'. Two rows have the
   same key when this matches, even if updated_at moved (the Reader
   re-sends the same bet screen while the timer ticks). The key alone
   is NOT enough to call two rows the same bet: the NEXT race can
   have the identical line-up (same 3 vehicles + same shown track —
   roughly 1 in 500 bets), so decideLiveBet also checks the
   updated_at gap and the timer reset (isNewLiveBet). Pure —
   unit-tested. */
function liveBetKey(row) {
  if (!row || !Array.isArray(row.vehicles) || !Array.isArray(row.tracks)) return '';
  return row.vehicles.slice().sort().join('|') + '||' +
    normalizeTracksForSave(row.tracks).join('|');
}

/* updated_at (else created_at) of a live_bets row as epoch ms, or null
   when the row carries no parseable timestamp. Pure — unit-tested. */
function liveRowUpdatedAtMs(row) {
  if (!row) return null;
  var ts = Date.parse(row.updated_at || row.created_at || '');
  return isNaN(ts) ? null : ts;
}

/* Gap that proves a row is a NEW bet screen, not a refresh of the one
   already processed: 40 s. One bet screen lives at most 35 s (the
   betting timer) — two updates of the SAME screen can never be more
   than 35 s apart in updated_at — so 40 s is the 35 s screen lifetime
   plus 5 s of delivery slack. A new bet only appears after the race
   itself has run, so its first update is normally a full minute or
   more after the previous bet's last update. Pure — unit-tested. */
var LIVE_NEW_BET_GAP_MS = 40000;
/* Timer-reset detection: a fresh bet screen reads near 35 s again.
   LIVE_TIMER_RESET_MIN is the lowest timer a fresh screen is still
   read at (the Reader reads the screen as soon as it appears, so it
   is normally 33–35); LIVE_TIMER_RESET_JUMP is the smallest jump up
   that counts — on one screen the timer only ever counts DOWN, so a
   jump of 5 s or more cannot be the same screen (a 1–2 s wobble from
   a re-read is not a reset). Both must hold. Pure — unit-tested. */
var LIVE_TIMER_RESET_MIN = 30;
var LIVE_TIMER_RESET_JUMP = 5;

/* Is this row a NEW bet, or a re-fire / refresh of `lastBet`?
   `lastBet` is the record of the last bet we auto-ran:
   { key, updatedAtMs, timerSeconds } — or a bare betKey string
   (legacy callers, e.g. the v16 tests), or '' / null when no bet has
   been auto-run yet. Returns true when:
     (a) the vehicles/tracks differ from the last bet, or there is no
         last bet at all (a genuinely new line-up is always new);
     (b) the same line-up, but updated_at is at least
         LIVE_NEW_BET_GAP_MS newer than the last processed row — two
         updates of one bet screen can never be that far apart;
     (c) the same line-up, but the timer jumped back up near 35 after
         having counted down — a fresh bet screen appeared.
   A same-bet refresh — small updated_at gap, monotonically decreasing
   timer, same vehicles/tracks — fails all three and returns false.
   With a bare string lastBet there is no timing to compare, so only
   (a) applies and a matching key is the same bet (legacy behaviour).
   Pure — unit-tested. */
function isNewLiveBet(row, lastBet) {
  if (!lastBet) return true;
  var key = liveBetKey(row);
  if (typeof lastBet === 'string') return !lastBet || key !== lastBet;
  if (!lastBet.key || key !== lastBet.key) return true;
  var ts = liveRowUpdatedAtMs(row);
  if (ts !== null && typeof lastBet.updatedAtMs === 'number' && !isNaN(lastBet.updatedAtMs)) {
    if (ts - lastBet.updatedAtMs >= LIVE_NEW_BET_GAP_MS) return true;
  }
  var cur = row ? row.timer_seconds : null;
  var prev = lastBet.timerSeconds;
  if (typeof cur === 'number' && isFinite(cur) &&
      typeof prev === 'number' && isFinite(prev) &&
      cur >= LIVE_TIMER_RESET_MIN && cur - prev >= LIVE_TIMER_RESET_JUMP) return true;
  return false;
}

/* Synced countdown seconds from a live-bet row, or null when the row
   carries no usable timer (null / non-numeric timer_seconds) or is
   stale (> 60 s old). The caller falls back to the local countdown
   when this returns null. Pure — unit-tested. */
function liveTimerSeconds(row, nowMs) {
  if (!row) return null;
  var s = row.timer_seconds;
  if (typeof s !== 'number' || !isFinite(s)) return null;
  var now = (typeof nowMs === 'number') ? nowMs : Date.now();
  var ts = Date.parse(row.updated_at || row.created_at || '');
  if (!isNaN(ts) && now - ts > LIVE_STALE_MS) return null;
  return clamp(Math.round(s), 0, 35);
}

/* Countdown remaining at `nowMs` for a timer read at `receivedAtMs`
   (pure clock arithmetic — the live equivalent of the local timer
   ticking down once a second). Returns null for an unusable timer,
   0 once it has run out. Pure — unit-tested. */
function liveCountdownAt(timerSeconds, receivedAtMs, nowMs) {
  if (typeof timerSeconds !== 'number' || !isFinite(timerSeconds)) return null;
  if (typeof receivedAtMs !== 'number' || typeof nowMs !== 'number') return null;
  var left = Math.round(timerSeconds) - Math.floor((nowMs - receivedAtMs) / 1000);
  return left > 0 ? left : 0;
}

/* Seconds actually left on a live bet's countdown at `nowMs`: the
   timer_seconds the Reader read, minus the time since the row was
   written (updated_at). Without this the displayed countdown would be
   too generous by however long the row took to arrive — a bet read at
   33 s but delivered 8 s later really has 25 s left, not 33. Returns
   null when the row carries no usable timer or is stale (> 60 s old).
   When updated_at is missing/unparseable the raw timer_seconds is
   used as-is (best effort). Pure — unit-tested. */
function liveRemainingSeconds(row, nowMs) {
  var s = liveTimerSeconds(row, nowMs);
  if (s === null) return null;
  var now = (typeof nowMs === 'number') ? nowMs : Date.now();
  var ts = Date.parse(row.updated_at || row.created_at || '');
  if (isNaN(ts)) return s;
  return liveCountdownAt(s, ts, now);
}

/* Segment states for a live bet's 3 tracks: the FIRST known track is
   pinned (the game shows only one track before the bet — one-track
   rule), the other two stay Unknown, even if the row somehow names
   more than one track. Pure — unit-tested. */
function liveBetSegments(tracks) {
  var norm = normalizeTracksForSave(tracks);
  var pinned = false;
  return [0, 1, 2].map(function (i) {
    var t = norm[i];
    if (!pinned && t && t !== UNKNOWN_TRACK && TRACKS.indexOf(t) !== -1) {
      pinned = true;
      return { mode: 'pin', track: t, chance: 100 };
    }
    return { mode: 'unknown', track: null, chance: 50 };
  });
}

/* Validate a live_bets row. Returns { ok: true, vehicles[3], tracks[3],
   knownSegIndex, knownTrack, timerSeconds, remainingSeconds } or
   { ok: false, reason }. timerSeconds is the raw value the Reader read;
   remainingSeconds is age-adjusted (see liveRemainingSeconds) — the
   countdown the app actually shows.
   Reasons: 'empty' | 'vehicles' (not exactly 3 known, distinct
   vehicles) | 'tracks' (not 3 entries of a known track / 'unknown') |
   'no-known-track' (all three segments unknown — nothing was shown) |
   'stale' (updated_at older than 60 s). Pure — unit-tested. */
function validateLiveBet(row, nowMs) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'empty' };
  if (!Array.isArray(row.vehicles) || row.vehicles.length !== 3) return { ok: false, reason: 'vehicles' };
  var names = [];
  for (var i = 0; i < 3; i++) {
    var v = resolveVehicleName(row.vehicles[i]);
    if (!vehicleByName(v)) return { ok: false, reason: 'vehicles' };
    names.push(v);
  }
  if (names[0] === names[1] || names[0] === names[2] || names[1] === names[2]) {
    return { ok: false, reason: 'vehicles' };
  }
  if (!Array.isArray(row.tracks) || row.tracks.length !== 3) return { ok: false, reason: 'tracks' };
  var norm = normalizeTracksForSave(row.tracks.map(function (t) { return resolveTrackName(t); }));
  for (var j = 0; j < 3; j++) {
    if (TRACKS.indexOf(norm[j]) === -1 && norm[j] !== UNKNOWN_TRACK) return { ok: false, reason: 'tracks' };
  }
  var knownIdx = -1;
  for (var k = 0; k < 3; k++) {
    if (norm[k] !== UNKNOWN_TRACK) { knownIdx = k; break; }
  }
  if (knownIdx === -1) return { ok: false, reason: 'no-known-track' };
  var now = (typeof nowMs === 'number') ? nowMs : Date.now();
  var ts = Date.parse(row.updated_at || row.created_at || '');
  if (!isNaN(ts) && now - ts > LIVE_STALE_MS) return { ok: false, reason: 'stale' };
  return {
    ok: true,
    vehicles: names,
    tracks: norm,
    knownSegIndex: knownIdx,
    knownTrack: norm[knownIdx],
    timerSeconds: liveTimerSeconds(row, now),
    remainingSeconds: liveRemainingSeconds(row, now)
  };
}

/* Identity of the bet currently displayed: the frozen lastRun when a
   run is on screen, else the manual picks + pin ('' when nothing is
   picked yet). Used to ignore a live row that matches what is already
   shown. Pure (reads pred / wizard globals) — unit-tested. */
function currentBetKey() {
  if (wizard.ran && wizard.lastRun && Array.isArray(wizard.lastRun.vehicles)) {
    return wizard.lastRun.vehicles.slice().sort().join('|') + '||' +
      normalizeTracksForSave(wizard.lastRun.tracks).join('|');
  }
  if (pred.vehicles.length === 3) {
    var tracks = [pred.seg1, pred.seg2, pred.seg3].map(function (s) {
      return (s.mode === 'pin' && s.track) ? s.track : UNKNOWN_TRACK;
    });
    return pred.vehicles.slice().sort().join('|') + '||' + tracks.join('|');
  }
  return '';
}

/* Decide what to do with one live-bet row. `accessOk` is appAccess().ok;
   `lastBet` is liveLastBet — the record of the last bet already
   auto-run ({ key, updatedAtMs, timerSeconds }), or a bare betKey
   string / '' for legacy callers. Returns
     { action: 'run', vehicles, tracks, timerSeconds, remainingSeconds,
       late, key } — auto-drive it; `late` is true when under
       LIVE_LATE_SECONDS were left when the bet arrived (still predict,
       but mark it LATE)
     { action: 'ignore', reason } — stale / invalid / duplicate /
       already shown; nothing to do
     { action: 'premium', reason: 'premium' } — signed in but no premium:
       do NOT auto-run; the caller toasts instead.
   lrp-v21: there is NO manual-busy drop any more. A live bet always
   wins over an unfinished manual pick (wizard steps 1–2, no run yet):
   the pick is for the same race and is at most 4 taps, while dropping
   the bet is exactly the failure the user reported. (v17–v20 dropped
   it as 'manual-busy'; that guard is deleted, not bypassed.)
   DEDUP: a row whose vehicles + shown track match the last auto-run
   bet is a duplicate — UNLESS isNewLiveBet says it is the NEXT race
   with the identical line-up (updated_at gap >= LIVE_NEW_BET_GAP_MS,
   or the timer reset near 35). The same override applies when the
   matching run on screen IS that last auto-run bet; a MANUAL run of
   the same line-up stays ignored ('already-shown'), because the user
   already predicted this exact race by hand.
   Pure — unit-tested. */
function decideLiveBet(row, accessOk, nowMs, lastBet) {
  if (accessOk === false) return { action: 'premium', reason: 'premium' };
  var v = validateLiveBet(row, nowMs);
  if (!v.ok) return { action: 'ignore', reason: v.reason };
  var key = liveBetKey({ vehicles: v.vehicles, tracks: v.tracks });
  var lastIsSame = (typeof lastBet === 'string')
    ? (!!lastBet && lastBet === key)
    : (!!lastBet && lastBet.key === key);
  if (lastIsSame) {
    /* Same line-up as the last auto-run bet: a refresh of the same bet
       screen, or the NEXT race with the identical line-up.
       isNewLiveBet tells them apart (updated_at gap / timer reset)
       when the caller passed the full last-bet record; with a bare
       string key there is nothing to compare, so it stays a duplicate
       (legacy behaviour — see scripts/test-lrp-v16.js). */
    if (typeof lastBet === 'object' && lastBet && isNewLiveBet(row, lastBet)) {
      /* New race, identical line-up — fall through to run below. */
    } else {
      return { action: 'ignore', reason: 'duplicate' };
    }
  } else if (key && key === currentBetKey()) {
    /* The run on screen already has this line-up. That is the last
       auto-run bet in the consecutive-identical-bets case — handled
       by the branch above — so reaching here means the displayed run
       is a MANUAL run of this exact race: the user already predicted
       it by hand, ignore the row. */
    return { action: 'ignore', reason: 'already-shown' };
  }
  var remaining = (typeof v.remainingSeconds === 'number') ? v.remainingSeconds : v.timerSeconds;
  return {
    action: 'run', reason: '',
    vehicles: v.vehicles, tracks: v.tracks,
    timerSeconds: v.timerSeconds, remainingSeconds: remaining,
    late: (typeof remaining === 'number' && remaining < LIVE_LATE_SECONDS),
    key: key
  };
}

/* Apply a validated live bet to the Predict state: the 3 vehicles and
   exactly one pinned segment (the first known track), the other two
   Unknown. No DOM, no prediction — the caller renders and runs.
   Returns { ok: true, ... } or { ok: false, reason }. Unit-tested. */
function applyLiveBet(row, nowMs) {
  var v = validateLiveBet(row, nowMs);
  if (!v.ok) return { ok: false, reason: v.reason };
  pred.vehicles = v.vehicles.slice();
  var segs = liveBetSegments(v.tracks);
  pred.seg1 = segs[0]; pred.seg2 = segs[1]; pred.seg3 = segs[2];
  pred.odds = {};
  /* The Reader also sends odds, but the wizard has no odds step and
     runPrediction passes no odds — so Reader odds are deliberately NOT
     copied into pred.odds. The prediction is identical to a manual
     RUN with the same vehicles + pin. */
  return { ok: true, vehicles: v.vehicles, tracks: v.tracks, timerSeconds: v.timerSeconds, key: liveBetKey({ vehicles: v.vehicles, tracks: v.tracks }) };
}

/* LIVE badge + status line under the timer. Shown while a live
   subscription is open; the toggle always reflects the saved choice. */
function setLiveBadge() {
  if (typeof document === 'undefined') return;
  var badge = $('liveBadge');
  if (badge) badge.classList.toggle('hidden', !liveActive);
  var status = $('liveStatus');
  if (status) {
    status.textContent = liveActive
      ? 'Live auto-predict ON — watching for the next bet.'
      : (liveEnabled ? 'Live auto-predict ON — waiting for the Reader…' : 'Live auto-predict off.');
  }
  var toggle = $('liveToggle');
  if (toggle) toggle.checked = liveEnabled;
  updateLiveFreshness();
}

/* Live-bet freshness indicator (lrp-v20): when the last live bet was
   received, so the user can SEE on screen whether live data is
   arriving or late. liveLastRowAtMs is the updated_at of the last
   live_bets row the app saw (Realtime event or START/subscribe
   fetch) — the honest freshness signal: a row the Reader wrote
   10 hours ago stays 10 hours old no matter how often the app
   re-fetches it. The text ticks every second (see init). */
var liveLastRowAtMs = null;
var liveLastRowSummary = '';

/* One-line summary of a live_bets row: vehicles + the one known
   track, e.g. 'SUV/ATV/Sports Car · Dirt'. Pure — unit-tested. */
function liveRowSummary(row) {
  if (!row || !Array.isArray(row.vehicles) || !row.vehicles.length) return '';
  var names = row.vehicles.map(function (v) { return resolveVehicleName(v); });
  var known = '';
  if (Array.isArray(row.tracks)) {
    for (var i = 0; i < row.tracks.length; i++) {
      var t = resolveTrackName(row.tracks[i]);
      if (t && t !== UNKNOWN_TRACK) { known = t; break; }
    }
  }
  return names.join('/') + (known ? ' · ' + known : '');
}

/* Age of a timestamp in whole seconds, formatted for a phone screen:
   '45s', '2m', '10h 23m'. Pure — unit-tested. */
function formatAgeSeconds(ageSeconds) {
  var age = Math.max(0, Math.floor(ageSeconds));
  if (age < 60) return age + 's';
  if (age < 3600) return Math.floor(age / 60) + 'm';
  return Math.floor(age / 3600) + 'h ' + Math.floor((age % 3600) / 60) + 'm';
}

/* Text for the freshness line. Pure — unit-tested.
   - no row ever seen: 'No live bet yet — check the Reader is ON.'
   - row fresh (age <= 60 s): 'Last live bet 12:36:33 · 45s ago · SUV/ATV/Sports Car · Dirt'
   - row stale (age > 60 s): 'Last live bet 02:17:07 · 10h 23m ago — Reader isn't sending bets. Check the Reader is ON.' */
function liveFreshnessText(rowAtMs, summary, nowMs) {
  var now = (typeof nowMs === 'number') ? nowMs : Date.now();
  if (typeof rowAtMs !== 'number' || isNaN(rowAtMs)) return 'No live bet yet — check the Reader is ON.';
  var age = Math.max(0, Math.floor((now - rowAtMs) / 1000));
  var d = new Date(rowAtMs);
  var hh = ('0' + d.getHours()).slice(-2);
  var mm = ('0' + d.getMinutes()).slice(-2);
  var ss = ('0' + d.getSeconds()).slice(-2);
  var base = 'Last live bet ' + hh + ':' + mm + ':' + ss + ' · ' + formatAgeSeconds(age) + ' ago' +
    (summary ? ' · ' + summary : '');
  if (age > LIVE_STALE_MS / 1000) return base + " — Reader isn't sending bets. Check the Reader is ON.";
  return base;
}

/* Write the freshness line (DOM). No-op without a DOM (Node tests).
   Warn styling when no bet has ever arrived or the last one is
   older than LIVE_STALE_MS. */
function updateLiveFreshness() {
  if (typeof document === 'undefined') return;
  var el = $('liveFreshness');
  if (!el) return;
  el.textContent = liveFreshnessText(liveLastRowAtMs, liveLastRowSummary);
  var stale = liveLastRowAtMs === null || (Date.now() - liveLastRowAtMs > LIVE_STALE_MS);
  el.classList.toggle('warn', stale);
  /* lrp-v21: a fresh bet reads as fresh, not just "not stale" — green
     tint + bold, so a working live flow is obvious at a glance. */
  el.classList.toggle('fresh', !stale);
}

/* Remember the last live_bets row the app saw, for the freshness
   line. Called for every row arrival (Realtime event or fetch). */
function recordLiveBetSeen(row) {
  if (!row || typeof row !== 'object') return;
  var ts = liveRowUpdatedAtMs(row);
  if (ts !== null) liveLastRowAtMs = ts;
  liveLastRowSummary = liveRowSummary(row);
  updateLiveFreshness();
}

/* Synced countdown from the Reader's timer_seconds. Reuses the same
   timer row / interval as the manual 35 s timer: the synced value
   replaces the local countdown and ticks down once a second. When
   timer_seconds is null/stale the caller does not call this at all, so
   the local countdown keeps running as before. */
var liveTimerReceivedAt = 0;
function startLiveCountdown(seconds) {
  if (typeof document === 'undefined') return;
  if (typeof seconds !== 'number' || !isFinite(seconds)) return;
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  timerLeft = clamp(Math.round(seconds), 0, 35);
  liveTimerReceivedAt = Date.now();
  renderTimer();
  if (timerLeft <= 0) return;
  timerInterval = setInterval(function () {
    timerLeft -= 1;
    if (timerLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      timerLeft = 0;
      renderTimer();
      toast('Betting closed — race started.');
      return;
    }
    renderTimer();
  }, 1000);
}

/* LATE marker on the result (step 3): shown when a live bet arrived
   with under LIVE_LATE_SECONDS left — the prediction is still shown,
   but the user must know the timer was nearly gone. Empty text hides
   it. No-op without a DOM (Node tests). */
function setLiveLateNote(text) {
  if (typeof document === 'undefined') return;
  var note = $('liveLateNote');
  if (!note) return;
  note.textContent = text || '';
  note.classList.toggle('hidden', !text);
}

/* One live-bet row arrived (Realtime event or the fetch on subscribe):
   decide, then auto-drive the wizard. The live result stays on screen
   until the next bet replaces it; feedback saves exactly as today.
   The countdown starts from the AGE-ADJUSTED remaining seconds
   (decision.remainingSeconds), not the raw timer_seconds — a bet read
   at 33 s but delivered 8 s later really has 25 s left.
   Returns 'ran' when a new prediction auto-ran and is on screen,
   'shown' when this bet's result was already on screen (a refresh of
   the same bet — duplicate / already-shown), and false otherwise
   (live off, stale / invalid row, premium). START-immediate
   (lrp-v18) reads this so START knows whether a live result is showing. */
function handleLiveBetInner(row) {
  if (!liveEnabled) return false;
  /* lrp-v21: NO manual-busy drop — a live bet always wins over an
     unfinished manual pick (steps 1–2, no run yet). See decideLiveBet. */
  var decision = decideLiveBet(row, appAccess().ok, Date.now(), liveLastBet);
  if (decision.action === 'premium') { toast('Premium required for live predictions.'); return false; }
  if (decision.action !== 'run') {
    /* Duplicate / already-shown: this bet was already auto-run, so its
       result may still be on screen — START should stay on it instead
       of dropping to manual picking. Only when the displayed run really
       is this bet (the user may have run a different race by hand
       since, or reset the wizard). */
    if (decision.reason === 'duplicate' || decision.reason === 'already-shown') {
      var v = validateLiveBet(row, Date.now());
      if (v.ok && wizard.ran &&
          currentBetKey() === liveBetKey({ vehicles: v.vehicles, tracks: v.tracks })) {
        return 'shown';
      }
    }
    return false;
  }
  /* Remember WHEN this bet was processed and what the timer read:
     decideLiveBet needs both to tell the NEXT race with the identical
     line-up apart from a refresh of this same bet screen
     (isNewLiveBet — updated_at gap / timer reset). */
  liveLastBet = {
    key: decision.key,
    updatedAtMs: liveRowUpdatedAtMs(row),
    timerSeconds: decision.timerSeconds
  };
  resetPrediction();
  var applied = applyLiveBet(row);
  if (!applied.ok) return false; // validated a moment ago — never expected
  renderPredictVehicles();
  renderPredictSeg(1); renderPredictSeg(2); renderPredictSeg(3);
  var countdownFrom = (typeof decision.remainingSeconds === 'number') ? decision.remainingSeconds : decision.timerSeconds;
  if (typeof countdownFrom === 'number') startLiveCountdown(countdownFrom);
  showTab('predict');
  runPrediction();
  if (decision.late) {
    setLiveLateNote('LATE — only ' + countdownFrom + 's left when this bet arrived. Bet fast, or skip it.');
    var st = $('liveStatus');
    if (st) st.textContent = 'Live auto-predict ON — last bet arrived LATE (' + countdownFrom + 's left).';
  }
  toast(decision.late ? 'Live bet received late — prediction ready, timer nearly gone.' : 'Live bet received — prediction ready.');
  return 'ran';
}

/* Wrapper around the inner handler: when a live bet actually runs
   (or is already shown), wake any START that is waiting for one
   (see waitForLiveBet). Returns what the inner handler returned
   ('ran' | 'shown' | false). */
function handleLiveBet(row) {
  recordLiveBetSeen(row);
  var result = handleLiveBetInner(row);
  if (result === 'ran' || result === 'shown') notifyLiveWaiters(result);
  return result;
}

/* The bet that may already be live when the app opens / subscribes:
   fetch the user's single live_bets row once and handle it like any
   other row (the 60 s staleness check drops it when the bet is over).
   Returns what handleLiveBet returned ('ran' | 'shown' | false) so
   START-immediate knows whether a live result is on screen.
   lrp-v21: an in-flight guard stops overlapping fetches (poll +
   START + tab-switch can all fire at once), and consecutive network
   failures are counted — after 3 the status line says the table
   cannot be reached, instead of failing exactly like "no live bet". */
async function fetchLatestLiveBet() {
  if (!sb || !currentUser) return false;
  if (liveFetchInFlight) return false;
  liveFetchInFlight = true;
  var row = null;
  try {
    var res = await sb.from('live_bets').select('*').eq('user_id', currentUser.id).maybeSingle();
    liveFetchFails = 0;
    row = (res && res.data) ? res.data : null;
  } catch (e) {
    /* Network / server error — NOT "no live bet". Count it so the
       status line can say so after a few in a row. */
    liveFetchFails += 1;
    if (liveFetchFails >= 3 && liveEnabled) {
      var st = $('liveStatus');
      if (st) st.textContent = 'Couldn\'t reach the live-bet table — check your connection.';
    }
  } finally {
    liveFetchInFlight = false;
  }
  if (row) return handleLiveBet(row);
  return false;
}

/* START-immediate decision (pure, unit-tested): what START does after
   the live-bet fetch. 'live' = the current live bet's result is on
   screen — stay there. 'manual' = go to step 1 (pick the 3 vehicles).
   fetchResult is 'ran' | 'shown' | false from fetchLatestLiveBet. */
function startLiveDecision(liveOn, signedIn, accessOk, fetchResult) {
  if (liveOn && signedIn && accessOk && (fetchResult === 'ran' || fetchResult === 'shown')) return 'live';
  return 'manual';
}

/* How long START waits for a live bet to arrive before going manual
   (lrp-v19: 5 s; lrp-v20: 10 s). The Reader needs a few seconds to
   spot the bet screen stably and push it — a push landing 6–10 s
   after START is still 25+ s inside the 35 s betting window, so
   waiting 10 s still leaves plenty of time to bet. With 5 s, a slow
   push arrived after START had already dropped to manual picking,
   and the (since removed, lrp-v21) manual-busy guard then threw the
   bet away. */
var LIVE_START_WAIT_MS = 10000;

/* Waiters for a live bet: START registers here while it waits, and
   handleLiveBet wakes them when a bet actually runs (or is shown).
   Pure apart from the timer — unit-tested in Node. */
var liveStartWaiters = [];
function notifyLiveWaiters(result) {
  if (!liveStartWaiters.length) return;
  var ws = liveStartWaiters.slice(); liveStartWaiters = [];
  ws.forEach(function (fn) { try { fn(result); } catch (e) {} });
}
function waitForLiveBet(ms) {
  return new Promise(function (resolve) {
    var timer = setTimeout(function () {
      liveStartWaiters = liveStartWaiters.filter(function (fn) { return fn !== onResult; });
      resolve(false);
    }, ms);
    function onResult(result) {
      clearTimeout(timer);
      resolve(result);
    }
    liveStartWaiters.push(onResult);
  });
}

/* What the live_bets table actually holds right now, so START can say
   WHY there is no bet instead of going silent. States: 'signed-out' |
   'none' | 'fresh' | 'stale' | 'no-known-track' | 'vehicles' |
   'tracks' | 'error'. 'fresh' means a runnable bet is in the table
   (validateLiveBet passed). */
async function liveBetStatus() {
  if (!sb || !currentUser) return { state: 'signed-out', ageSeconds: null };
  try {
    var res = await sb.from('live_bets').select('*').eq('user_id', currentUser.id).maybeSingle();
    if (!res || !res.data) return { state: 'none', ageSeconds: null };
    var row = res.data;
    var ts = Date.parse(row.updated_at || row.created_at || '');
    var age = isNaN(ts) ? null : Math.max(0, Math.round((Date.now() - ts) / 1000));
    var v = validateLiveBet(row, Date.now());
    if (v.ok) return { state: 'fresh', ageSeconds: age };
    if (v.reason === 'stale') return { state: 'stale', ageSeconds: age };
    return { state: v.reason, ageSeconds: age };
  } catch (e) { return { state: 'error', ageSeconds: null }; }
}

/* Plain-English reason for a liveBetStatus state (pure, unit-tested). */
function liveBetStatusText(state, ageSeconds) {
  var age = (typeof ageSeconds === 'number') ? ageSeconds : null;
  if (state === 'none') return 'No live bet yet — the Reader hasn\'t sent a bet. Check the Reader is ON.';
  if (state === 'stale') return 'Last live bet ' + (age === null ? 'a while' : age + 's') + ' ago — the Reader isn\'t sending bets right now. Check the Reader is ON.';
  if (state === 'no-known-track') return 'Reader sent a bet but no track was read — waiting for the next bet.';
  if (state === 'vehicles' || state === 'tracks') return 'Reader sent a bet the app can\'t read — waiting for the next bet.';
  if (state === 'signed-out') return 'Sign in to use live predictions.';
  if (state === 'error') return 'Couldn\'t reach the live-bet table — check your connection.';
  return 'No live bet yet — waiting for the Reader…';
}

/* START-immediate (lrp-v18, user's order): pressing START first pulls
   the latest live bet and runs it at once — no waiting for the next
   Realtime event. When there is no fresh live bet, say so plainly
   instead of waiting silently, and go to manual picking as before.
   The manual flow is untouched: live off, signed out, or no access
   all fall through to step 1 exactly as START behaved before. */
/* START (lrp-v19 — robust, user's order): pressing START first pulls
   the latest live bet and runs it at once — no waiting for the next
   Realtime event. When the table holds no fresh bet, START waits up to
   LIVE_START_WAIT_MS for one to arrive (covers a bet landing a second
   later and a Realtime subscription that was slow to wake), then
   re-fetches once (covers a dead subscription), and only then falls
   back to manual picking — with the specific reason shown, never
   silence. (v20 also dropped a late bet as 'manual-busy' when START
   had already fallen through to step 1 with picks; lrp-v21 removed
   that drop, so the wait is now a belt-and-braces path, not the only
   way a late bet can run.) The manual flow is untouched: live off,
   signed out, or no access all fall through to step 1 exactly as
   START behaved before. */
async function startWithLiveBet() {
  var canFetch = liveEnabled && sb && currentUser && appAccess().ok;
  var fetchResult = false;
  if (canFetch) fetchResult = await fetchLatestLiveBet();
  if (startLiveDecision(liveEnabled, !!currentUser, appAccess().ok, fetchResult) === 'live') {
    if (fetchResult === 'shown') { showTab('predict'); showWizardStep(3); }
    return;
  }
  if (canFetch) {
    /* Nothing fresh in the table — a bet may be arriving right now
       (the Reader pushes during play), so wait briefly for a Realtime
       event, then re-fetch once in case the subscription is dead. */
    await waitForLiveBet(LIVE_START_WAIT_MS);
    fetchResult = await fetchLatestLiveBet();
    if (startLiveDecision(liveEnabled, !!currentUser, appAccess().ok, fetchResult) === 'live') {
      if (fetchResult === 'shown') { showTab('predict'); showWizardStep(3); }
      return;
    }
    var status = await liveBetStatus();
    var text = liveBetStatusText(status.state, status.ageSeconds);
    toast(text + ' Pick the 3 vehicles yourself.');
    var st = $('liveStatus');
    if (st) st.textContent = text;
  }
  showWizardStep(1);
}

/* Subscribe to the user's own live_bets row over Realtime. No-op when
   live mode is off, signed out, or already subscribed.
   lrp-v21: a dead channel is NOT left in place. The subscribe callback
   handles failure states (CHANNEL_ERROR / TIMED_OUT / CLOSED) by
   tearing the channel down and scheduling a retry on backoff — the
   poll tick drives the retry, so a dropped socket recovers on its own
   instead of silently starving the tab. liveActive stays false until
   SUBSCRIBED confirms: the badge must never claim a live subscription
   that never opened. */
function subscribeLiveBets() {
  if (typeof document === 'undefined') return false;
  if (!liveEnabled || !sb || !currentUser) return false;
  if (liveChannel) {
    /* A channel object sitting there does NOT mean a live subscription:
       it may be a zombie (open but never confirmed SUBSCRIBED). A
       healthy confirmed channel returns true; a zombie past its window
       is torn down and re-subscribed below; a fresh attempt still in
       flight returns true. Without this, every entry point that calls
       subscribeLiveBets (toggle, auth refresh) would silently no-op on
       the dead object — the v20 bug. */
    if (liveActive) return true;
    if (Date.now() - liveLastSubscribeAtMs > LIVE_RESUBSCRIBE_ZOMBIE_MS) teardownLiveChannel();
    else return true;
  }
  var userId = currentUser.id;
  liveLastSubscribeAtMs = Date.now();
  liveChannel = sb.channel('live-bets')
    .on('postgres_changes',
      { event: '*', schema: 'public', table: 'live_bets', filter: 'user_id=eq.' + userId },
      function (payload) {
        if (payload && payload.new) handleLiveBet(payload.new);
      });
  liveChannel.subscribe(function (status) {
    if (status === 'SUBSCRIBED') {
      liveActive = true;
      liveSubscribeFails = 0;
      liveNextRetryAtMs = 0;
      setLiveBadge();
      fetchLatestLiveBet();
      return;
    }
    if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
      liveSubscribeFails += 1;
      liveNextRetryAtMs = Date.now() + liveBackoffMs(liveSubscribeFails);
      teardownLiveChannel();
    }
    setLiveBadge();
  });
  setLiveBadge();
  startLivePoll();
  return true;
}

/* Tear the Realtime channel down without touching the poll or the
   saved toggle: the next poll tick re-subscribes when the backoff
   allows. No-op without a DOM (Node tests). */
function teardownLiveChannel() {
  if (liveChannel && sb) {
    try { sb.removeChannel(liveChannel); } catch (e) { /* already gone */ }
  }
  liveChannel = null;
  liveActive = false;
  setLiveBadge();
}

function unsubscribeLiveBets() {
  stopLivePoll();
  liveSubscribeFails = 0;
  liveNextRetryAtMs = 0;
  if (liveChannel && sb) {
    try { sb.removeChannel(liveChannel); } catch (e) { /* already gone */ }
  }
  liveChannel = null;
  liveActive = false;
  setLiveBadge();
}

/* ---------------- Live poll fallback + Realtime recovery (lrp-v21) -------- */
/* Realtime is a convenience, not a guarantee: sockets drop, events get
   missed, and a tab can sit for hours on a dead channel. So while live
   mode is on, the app ALSO polls the live_bets row every few seconds
   and heals its own subscription — a bet can never hide for longer
   than one poll interval, whatever state the socket is in. */
var LIVE_POLL_MS = 4000; // REST poll while live is on
var LIVE_RESUBSCRIBE_ZOMBIE_MS = 15000; // channel open but never confirmed SUBSCRIBED for this long = dead
var livePollTimer = null;
var liveFetchInFlight = false; // one live_bets fetch at a time (poll + START + tab-switch overlap)
var liveFetchFails = 0; // consecutive network failures on the live fetch
var liveSubscribeFails = 0; // consecutive Realtime subscribe failures
var liveNextRetryAtMs = 0; // earliest time a failed subscribe may be retried
var liveLastSubscribeAtMs = 0; // when the current subscribe attempt started

/* Backoff before the next Realtime re-subscribe after a failure:
   2s, 5s, 10s, 20s, then 30s. Pure — unit-tested. */
function liveBackoffMs(fails) {
  if (fails <= 1) return 2000;
  if (fails === 2) return 5000;
  if (fails === 3) return 10000;
  if (fails === 4) return 20000;
  return 30000;
}

/* What should the app do about its Realtime subscription right now?
   Pure — unit-tested. `st` is { channel, active, lastSubscribeAtMs,
   nextRetryAtMs }; `nowMs` is Date.now().
     'ok' — subscribed and confirmed, nothing to do
     'subscribe' — no channel and the retry time has come
     'wait' — no channel but still in backoff, or channel open but not
       yet confirmed and still inside the zombie window
     'teardown-subscribe' — channel open but unconfirmed past the
       zombie window: tear it down and subscribe fresh */
function liveSubscriptionAction(st, nowMs) {
  if (!st.channel) return (typeof nowMs === 'number' && nowMs >= st.nextRetryAtMs) ? 'subscribe' : 'wait';
  if (st.active) return 'ok';
  if (typeof nowMs === 'number' && typeof st.lastSubscribeAtMs === 'number' &&
      nowMs - st.lastSubscribeAtMs > LIVE_RESUBSCRIBE_ZOMBIE_MS) return 'teardown-subscribe';
  return 'wait';
}

/* Make sure a live subscription exists (or is retried when its backoff
   allows). Called on every poll tick, on tab-visible and on reconnect
   — so a dead channel can never sit unnoticed. Returns the action
   taken ('ok' | 'subscribe' | 'wait' | 'teardown-subscribe').
   No-op without a DOM (Node tests). */
function ensureLiveSubscription(nowMs) {
  if (typeof document === 'undefined') return 'wait';
  if (!liveEnabled || !sb || !currentUser) return 'wait';
  var now = (typeof nowMs === 'number') ? nowMs : Date.now();
  var action = liveSubscriptionAction({
    channel: !!liveChannel, active: liveActive,
    lastSubscribeAtMs: liveLastSubscribeAtMs, nextRetryAtMs: liveNextRetryAtMs
  }, now);
  if (action === 'teardown-subscribe') teardownLiveChannel();
  if (action === 'subscribe' || action === 'teardown-subscribe') subscribeLiveBets();
  return action;
}

/* One poll tick: fetch the live row (the Realtime safety net) and heal
   the subscription if it is down. Skipped while the tab is hidden —
   the visibility handler re-fetches the moment it shows again.
   Returns false when skipped, else what fetchLatestLiveBet returned. */
async function livePollTick() {
  if (typeof document === 'undefined') return false;
  if (!liveEnabled || !sb || !currentUser) return false;
  if (document.hidden) return false;
  var result = await fetchLatestLiveBet();
  ensureLiveSubscription(Date.now());
  return result;
}

function startLivePoll() {
  if (typeof document === 'undefined') return;
  if (livePollTimer) return;
  livePollTimer = setInterval(function () { livePollTick(); }, LIVE_POLL_MS);
}
function stopLivePoll() {
  if (livePollTimer) { clearInterval(livePollTimer); livePollTimer = null; }
}

/* Toggle handler: persist the choice; subscribing starts live mode,
   unsubscribing stops it (and never auto-drives again while off). */
function setLiveEnabled(enabled) {
  liveEnabled = !!enabled;
  lsSet(LS_LIVE, liveEnabled ? '1' : '0');
  setLiveBadge();
  if (liveEnabled) subscribeLiveBets();
  else unsubscribeLiveBets();
}

function maybeSubscribeLiveBets() {
  if (liveEnabled && sb && currentUser) subscribeLiveBets();
}

function renderPredictVehicles() {
  var grid = $('predictVehicles');
  grid.innerHTML = '';
  VEHICLES.forEach(function (v) {
    var card = el('div', 'vehicle-card' + (pred.vehicles.indexOf(v.name) !== -1 ? ' picked' : ''));
    card.innerHTML = glyphHtml(v) +
      '<div class="v-name">' + v.name + '</div>' +
      '<div class="v-meta">Win ' + v.winRate + '% · Odds ' + v.odds + '</div>';
    card.addEventListener('click', function () { togglePredictVehicle(v.name); });
    grid.appendChild(card);
  });
  $('pickCount').textContent = pred.vehicles.length + '/3';
  /* The Next button only works once 3 vehicles are picked. */
  var next = $('toPinBtn');
  if (next) next.disabled = pred.vehicles.length !== 3;
}

function togglePredictVehicle(name) {
  var i = pred.vehicles.indexOf(name);
  if (i !== -1) {
    pred.vehicles.splice(i, 1);
  } else {
    if (pred.vehicles.length >= 3) { toast('Only 3 vehicles per round.'); return; }
    pred.vehicles.push(name);
  }
  /* Changing the picks after a RUN invalidates that run's result. */
  invalidateRun();
  renderPredictVehicles();
  saveWizard();
}

function renderTrackRow(containerId, selected, onPick, includeUnknown) {
  var row = $(containerId);
  row.innerHTML = '';
  TRACKS.forEach(function (t) {
    var b = el('button', 'track-btn' + (selected === t ? ' selected' : ''), t);
    b.addEventListener('click', function () { onPick(t); });
    row.appendChild(b);
  });
  if (includeUnknown) {
    var u = el('button', 'track-btn unknown-btn' + (!selected ? ' selected' : ''), '? Unknown');
    u.addEventListener('click', function () { onPick(null); });
    row.appendChild(u);
  }
}

/* One renderer for all three Predict segment boxes (1, 2 and 3 behave the
   same): tap a track to mark it KNOWN — the game shows exactly one track
   before the bet, and a shown track is a fact, never a guess, so there is
   no percentage choice at all. Tap "? Unknown" to leave it unknown.
   Pinning one segment unpins any other (one-track rule). */
function renderPredictSeg(segNum) {
  var state = pred['seg' + segNum];
  var rowId = 'seg' + segNum + 'Tracks';
  renderTrackRow(rowId, state.mode === 'unknown' ? null : state.track, function (t) {
    if (t === null) {
      state.mode = 'unknown'; state.track = null;
    } else {
      state.mode = 'pin'; state.track = t; state.chance = 100;
      // ONE-TRACK RULE: pinning this segment unpins any other pinned
      // segment — re-render all three boxes so the change shows.
      pinSegment(segNum);
    }
    renderPredictSeg(1); renderPredictSeg(2); renderPredictSeg(3);
    /* Changing the pin after a RUN invalidates that run's result. */
    invalidateRun();
    saveWizard();
  }, true);
}

/* One-tap reset: vehicles and all three segment boxes cleared, and the
   wizard goes back to the START screen, so the next bet starts from a
   clean slate — no manual unselecting. Also used when the 35s timer is
   reset (a new bet) and on sign-out (the run belonged to that user). */
function resetPrediction() {
  pred.vehicles = [];
  pred.odds = {};
  [1, 2, 3].forEach(function (n) {
    pred['seg' + n] = { mode: 'unknown', track: null, chance: 50 };
    renderPredictSeg(n);
  });
  wizard.step = 0; wizard.ran = false; wizard.lastRun = null;
  wizard.feedback = null; wizard.feedbackSaved = false; wizard.feedbackSaving = false;
  setLiveLateNote('');
  renderPredictVehicles();
  renderPrediction();
  renderFeedback();
  showWizardStep(0);
}

/* Picks or pins changed after a RUN: the shown result belongs to the old
   picks, so drop it (and any unsubmitted feedback) instead of showing a
   stale prediction. */
function invalidateRun() {
  if (!wizard.ran && !wizard.lastRun) return;
  wizard.ran = false; wizard.lastRun = null;
  wizard.feedback = null; wizard.feedbackSaved = false; wizard.feedbackSaving = false;
  saveWizard();
}

/* ---------------- Predict wizard ------------------------------------------- */

/* Show exactly one wizard step; the others hide. The 35s timer row sits
   above the steps, so it stays visible on every step. */
function showWizardStep(n) {
  wizard.step = n;
  ['wizStart', 'wizPick', 'wizPin', 'wizResult'].forEach(function (id, i) {
    var stepEl = $(id);
    if (stepEl) stepEl.classList.toggle('hidden', i !== n);
  });
  saveWizard();
  window.scrollTo(0, 0);
}

/* RUN: compute the prediction for the current picks and show step 3.
   No odds are passed — the wizard has no odds step, and lrp-v19 ranks
   purely from the saved races (no odds blend, no speeds). Compute is
   ~2ms; no artificial delay is added. The result is snapshotted
   (wizard.lastRun): later renderPrediction() calls re-render the same
   run instead of silently changing the numbers when new data arrives. */
/* Repeat-history note under a prediction result (display-only — it never
   changes the prediction). Finds past saved races with the SAME segment
   number + SAME track in that segment + the SAME 3 vehicles
   (order-insensitive). The other two segments are ignored: the match is
   about the one pinned segment the user actually saw. Returns '' when
   nothing matches (no note is shown) or when no segment is pinned.
   Otherwise e.g. "Seen before: 2 times — ATV won 1, Sports Car won 1".
   Pure — unit-tested in Node. */
function repeatHistoryNote(segNum, track, vehicles, raceList) {
  if (!segNum || !track || track === UNKNOWN_TRACK) return '';
  if (!Array.isArray(vehicles) || vehicles.length !== 3) return '';
  var wanted = vehicles.slice().sort();
  var wins = {};
  var times = 0;
  (raceList || []).forEach(function (r) {
    if (!r || !Array.isArray(r.vehicles) || r.vehicles.length !== 3) return;
    if (!Array.isArray(r.tracks) || r.tracks.length !== 3) return;
    if (r.tracks[segNum - 1] !== track) return;
    var set = r.vehicles.slice().sort();
    if (set[0] !== wanted[0] || set[1] !== wanted[1] || set[2] !== wanted[2]) return;
    times += 1;
    wins[r.winner] = (wins[r.winner] || 0) + 1;
  });
  if (!times) return '';
  var parts = Object.keys(wins).sort(function (a, b) {
    return wins[b] - wins[a] || (a < b ? -1 : a > b ? 1 : 0);
  }).map(function (w) {
    return w + ' won ' + wins[w];
  });
  return 'Seen before: ' + times + (times === 1 ? ' time' : ' times') + ' — ' + parts.join(', ');
}

/* HIGH / MID / JACKPOT — the three picks as the user and his friends
   call them when they play live together:
     HIGH    = main bet, the vehicle best for the shown track (rank 1)
     MID     = backup, second most likely (rank 2)
     JACKPOT = least likely of the 3 (rank 3), kept last for its high
               return — the long shot.
   rank is 1-based. Pure — unit-tested in Node. */
function rankName(rank) {
  return rank === 1 ? 'HIGH' : rank === 2 ? 'MID' : 'JACKPOT';
}

/* One-line bet suggestion for the top of the result, so it is
   unmistakable which pick is HIGH (main bet), which is MID (backup)
   and which is JACKPOT (long shot) — the same words the feedback
   buttons use. Pure — unit-tested in Node. Returns '' when the ranked
   list is unusable. */
function suggestionLine(ranked) {
  if (!Array.isArray(ranked) || ranked.length < 3) return '';
  var names = ranked.slice(0, 3).map(function (r) { return r && r.vehicle; });
  if (names.indexOf(undefined) !== -1 || names.indexOf(null) !== -1) return '';
  return 'Suggested bet: HIGH — ' + names[0] + ' · MID — ' + names[1] + ' · JACKPOT — ' + names[2];
}

/* Rank (1/2/3) of a winner inside a ranked list, or null when the winner
   is not one of the ranked vehicles (bad imported data — seen in 2
   Scribd rows). Pure — unit-tested in Node. */
function rankOfWinner(ranked, winner) {
  if (!Array.isArray(ranked)) return null;
  for (var i = 0; i < ranked.length; i++) {
    if (ranked[i].vehicle === winner) return i + 1;
  }
  return null;
}

/* Hints for a replay, built from a saved race's tracks: a known track is
   a pin, 'unknown' (or a missing/invalid entry) stays Unknown. The
   engine's one-track rule (oneTrackHints) still applies inside
   computePrediction — with 3 known tracks only the first stays pinned,
   which is the model's own rule, not a choice made here. Pure. */
function hintsFromTracks(tracks) {
  return [0, 1, 2].map(function (i) {
    var t = tracks && tracks[i];
    if (t && t !== UNKNOWN_TRACK && TRACKS.indexOf(t) !== -1) return { mode: 'pin', track: t, chance: 100 };
    return { mode: 'unknown', track: null, chance: 50 };
  });
}

/* Scribd-sheet rows are a friend's sheet, not bets the user played —
   their how_won_text starts with 'Scribd sheet'. They were also
   bulk-inserted, so they carry the insert time as created_at and would
   swamp any "last N bets" window. The jackpot streak below therefore
   looks at the user's OWN bets only. */
function isScribdRace(r) {
  return !!(r && typeof r.how_won_text === 'string' && r.how_won_text.indexOf('Scribd sheet') === 0);
}

/* Jackpot streak watch (display-only — never changes the picks).
   Looks at the last 15 OWN bets (see isScribdRace). For each one the
   model is replayed with the history available BEFORE that race
   (computePrediction, history = everything older in the list), and the
   actual winner is ranked 1st (HIGH), 2nd (MID) or 3rd (JACKPOT).
   Returns the watch note when JACKPOT won ZERO times in the last 15,
   otherwise '' — and '' when fewer than 15 own bets exist yet (not
   enough history for a 15-streak). Pure — unit-tested in Node. */
var JACKPOT_STREAK_WINDOW = 15;
function jackpotStreakNote(raceList, speedsMap) {
  var own = (raceList || []).filter(function (r) { return !isScribdRace(r); });
  if (own.length < JACKPOT_STREAK_WINDOW) return '';
  var windowRaces = own.slice(0, JACKPOT_STREAK_WINDOW); // newest-first
  var jackpotWins = 0;
  windowRaces.forEach(function (race) {
    if (!Array.isArray(race.vehicles) || race.vehicles.length !== 3) return;
    if (!race.winner) return;
    /* History before this race: everything older in the full list.
       `own` is newest-first, so older races sit at higher indices;
       history must stay newest-first too (the model weights by recency). */
    var idx = (raceList || []).indexOf(race);
    var historyBefore = idx >= 0 ? raceList.slice(idx + 1) : [];
    var hints = hintsFromTracks(race.tracks);
    var res;
    try {
      res = computePrediction({
        vehicles: race.vehicles,
        seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
        speeds: speedsMap, races: historyBefore
      });
    } catch (e) { return; }
    if (rankOfWinner(res.ranked, race.winner) === 3) jackpotWins += 1;
  });
  if (jackpotWins > 0) return '';
  return 'Jackpot watch: no JACKPOT win in the last 15 — you could try JACKPOT for the next 1–2 bets. (Streaks don\'t change the odds — your call.)';
}

/* Prediction accuracy, replayed over saved races: for each race (oldest
   first, up to `limit` most recent) the model re-predicts it from the
   history available BEFORE that race, and the actual winner is counted
   as a HIGH (rank 1), MID (rank 2) or JACKPOT (rank 3) win. Races whose
   winner is not one of the 3 vehicles (bad imported data) are skipped,
   never counted. This is a backtest, not a live prediction — it uses the
   data available before each race, so it is a fair backtest of the
   CURRENT model. Pure — unit-tested in Node. */
var PREDICTION_ACCURACY_LIMIT = 300;
function predictionAccuracy(raceList, speedsMap, limit) {
  var out = { total: 0, high: 0, mid: 0, jackpot: 0, skipped: 0, window: 0 };
  var list = (raceList || []).slice(); // newest-first, as the app holds it
  if (typeof limit === 'number' && limit > 0) list = list.slice(0, limit);
  out.window = list.length;
  var chrono = list.slice().reverse(); // oldest first
  chrono.forEach(function (race, j) {
    if (!Array.isArray(race.vehicles) || race.vehicles.length !== 3) { out.skipped += 1; return; }
    if (!race.winner) { out.skipped += 1; return; }
    /* This race's position in the newest-first list: chrono index j is
       newest-first index (list.length - 1 - j); history before it is
       everything after that position. */
    var newestIdx = list.length - 1 - j;
    var historyBefore = list.slice(newestIdx + 1);
    var hints = hintsFromTracks(race.tracks);
    var res;
    try {
      res = computePrediction({
        vehicles: race.vehicles,
        seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
        speeds: speedsMap, races: historyBefore
      });
    } catch (e) { out.skipped += 1; return; }
    var rank = rankOfWinner(res.ranked, race.winner);
    if (rank === null) { out.skipped += 1; return; }
    out.total += 1;
    if (rank === 1) out.high += 1;
    else if (rank === 2) out.mid += 1;
    else out.jackpot += 1;
  });
  return out;
}

/* Feedback answer for a rank: which vehicle won, given the run's ranked
   list. rank 1 = HIGH (main), 2 = MID (backup), 3 = JACKPOT (the third
   vehicle). Pure — unit-tested in Node. Returns null for a bad rank or
   a run without a ranked list. */
function feedbackForRank(lastRun, rank) {
  if (!lastRun || !lastRun.result || !Array.isArray(lastRun.result.ranked)) return null;
  if (rank !== 1 && rank !== 2 && rank !== 3) return null;
  var entry = lastRun.result.ranked[rank - 1];
  if (!entry || !entry.vehicle) return null;
  return { rank: rank, winner: entry.vehicle };
}

/* Migrate a saved feedback value (localStorage) to the 3-button shape
   { rank, winner }. Legacy shapes: 'correct' (MAIN won) and
   { wrong: true, winner } (the winner was picked from the 3 vehicles —
   its rank is read off the run's ranked list, or 3 when it is not in
   the list). Returns null when the value is unusable. Pure — unit-tested. */
function migrateFeedback(feedback, lastRun) {
  if (!feedback) return null;
  if (feedback === 'correct') {
    return lastRun && lastRun.main ? { rank: 1, winner: lastRun.main } : null;
  }
  if (typeof feedback === 'object') {
    if ((feedback.rank === 1 || feedback.rank === 2 || feedback.rank === 3) && feedback.winner) {
      if (lastRun && lastRun.vehicles && lastRun.vehicles.indexOf(feedback.winner) !== -1) {
        return { rank: feedback.rank, winner: feedback.winner };
      }
      return null;
    }
    if (feedback.wrong && feedback.winner && lastRun) {
      var rank = rankOfWinner(lastRun.result && lastRun.result.ranked, feedback.winner);
      return { rank: rank === null ? 3 : rank, winner: feedback.winner };
    }
  }
  return null;
}

function runPrediction() {
  setLiveLateNote(''); // a manual RUN never shows a stale LATE note; handleLiveBet sets it again after RUN when the bet really was late
  var gate = predictionAllowed();
  if (!gate.ok) {
    showWizardStep(3);
    renderPrediction();
    return;
  }
  if (pred.vehicles.length !== 3) { toast('Pick 3 vehicles first.'); return; }
  var t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
  var result = computePrediction({
    vehicles: pred.vehicles,
    seg1Hint: pred.seg1,
    seg2Hint: pred.seg2,
    seg3Hint: pred.seg3,
    speeds: speeds,
    races: races
  });
  var t1 = (typeof performance !== 'undefined') ? performance.now() : 0;
  /* Repeat-history note: the one pinned segment (if any) + its track +
     the 3 picked vehicles, matched against saved races. Computed once
     at RUN time and frozen with the result — later saves never change it. */
  var pinnedSeg = 0, pinnedTrack = null;
  [pred.seg1, pred.seg2, pred.seg3].forEach(function (s, i) {
    if (s.mode === 'pin' && s.track) { pinnedSeg = i + 1; pinnedTrack = s.track; }
  });
  wizard.lastRun = {
    vehicles: pred.vehicles.slice(),
    tracks: [pred.seg1, pred.seg2, pred.seg3].map(function (s) {
      return s.mode === 'pin' && s.track ? s.track : UNKNOWN_TRACK;
    }),
    main: result.ranked[0].vehicle,
    result: result,
    repeatNote: repeatHistoryNote(pinnedSeg, pinnedTrack, pred.vehicles, races),
    /* Jackpot streak watch: replay the last 15 own bets and say whether
       JACKPOT won at all. Computed once at RUN time and frozen with the
       result — later saves never change it. */
    streakNote: jackpotStreakNote(races, speeds),
    ms: Math.max(0, Math.round(t1 - t0))
  };
  wizard.ran = true;
  wizard.feedback = null;
  wizard.feedbackSaved = false;
  wizard.feedbackSaving = false;
  saveWizard();
  showWizardStep(3);
  renderPrediction();
  renderFeedback();
}

/* Build the race object a feedback answer saves. Pure — unit-tested in
   Node. Returns null when the run or the winner is not usable. */
function buildFeedbackRace(lastRun, winner) {
  if (!lastRun || !Array.isArray(lastRun.vehicles) || lastRun.vehicles.length !== 3) return null;
  if (!Array.isArray(lastRun.tracks) || lastRun.tracks.length !== 3) return null;
  if (lastRun.vehicles.indexOf(winner) === -1) return null;
  return {
    id: 'local-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
    vehicles: lastRun.vehicles.slice(),
    tracks: normalizeTracksForSave(lastRun.tracks),
    patterns: [],
    winner: winner,
    how_won: 'Other',
    how_won_text: '',
    odds: {},
    created_at: new Date().toISOString()
  };
}

/* Feedback box under the result (step 3). Three buttons — one per pick:
     HIGH won (the main pick), MID won (the backup pick), JACKPOT won
     (the third vehicle, which was neither the main nor the backup pick).
   Before this, feedback was only Correct/Wrong, so a backup win had to
   be reported as Wrong — which counted a right backup call as a miss.
   Tapping a button saves the race with that pick's vehicle as the winner
   (same insert path + duplicate protection as Log Race). After saving,
   the buttons hide and a short confirmation line shows instead.
   The box is only meaningful after a RUN; it is hidden otherwise.
   Button labels carry the actual vehicle names from the run, so there
   is no guessing which button is which. */
function renderFeedback() {
  var box = $('feedbackBox');
  if (!box) return;
  box.classList.toggle('hidden', !wizard.ran);
  if (!wizard.ran) return;
  var btns = $('feedbackBtns');
  var savedMsg = $('fbSavedMsg');
  var answered = !!wizard.feedback;
  if (btns) {
    btns.classList.toggle('hidden', answered);
    /* Buttons carry the vehicle names and are disabled the moment an
       answer is in flight, so a tap always shows a pressed state
       instead of looking dead. */
    [['fbHighBtn', 1], ['fbMidBtn', 2], ['fbJackpotBtn', 3]].forEach(function (pair) {
      var b = $(pair[0]);
      if (!b) return;
      b.disabled = answered || wizard.feedbackSaving;
      if (!answered && wizard.lastRun && wizard.lastRun.result && Array.isArray(wizard.lastRun.result.ranked)) {
        var ranked = wizard.lastRun.result.ranked;
        if (ranked[pair[1] - 1]) b.textContent = rankName(pair[1]) + ' won — ' + ranked[pair[1] - 1].vehicle;
      }
    });
  }
  if (savedMsg) {
    if (wizard.feedbackSaved && wizard.feedback) {
      var w = wizard.feedback.winner;
      var msg;
      if (wizard.feedback.rank === 1) msg = 'Saved — ' + w + ' won, the HIGH pick was right. The model learned from this race.';
      else if (wizard.feedback.rank === 2) msg = 'Saved — ' + w + ' won, the MID pick was right. The model learned from this race.';
      else msg = 'Saved — ' + w + ' won (JACKPOT). Neither the HIGH nor the MID pick won. The model learned from this race.';
      savedMsg.textContent = msg;
      savedMsg.classList.remove('hidden');
    } else if (answered) {
      savedMsg.textContent = 'Saving…';
      savedMsg.classList.remove('hidden');
    } else {
      savedMsg.textContent = '';
      savedMsg.classList.add('hidden');
    }
  }
}

/* One feedback answer: tap which rank won (1 = HIGH, 2 = MID,
   3 = JACKPOT). Saves the race with that rank's vehicle as the winner.
   EVERY tap answers visibly: the old code returned silently when there
   was no run, when the race was already saved, or when the ranked list
   was missing — on the user's phone a tap did nothing at all, no toast,
   no state change. Every path below either proceeds or toasts why not.
   feedbackSaving blocks double taps while the async save runs. */
function answerFeedback(rank) {
  if (!wizard.ran || !wizard.lastRun) { toast('Tap RUN first, then tell us which pick won.'); return; }
  if (wizard.feedbackSaved) { toast('This race is already saved.'); return; }
  if (wizard.feedbackSaving || wizard.feedback) { toast('Saving… please wait.'); return; }
  var fb = feedbackForRank(wizard.lastRun, rank);
  if (!fb) { toast('No result to answer for — tap RUN again.'); return; }
  wizard.feedback = fb;
  wizard.feedbackSaving = true;
  saveWizard();
  renderFeedback();   // shows 'Saving…' and disables the buttons at once
  saveFeedbackRace(fb.winner);
}

/* Save the last run as a race, from the feedback box. The winner is the
   vehicle of the rank the user tapped (HIGH / MID / JACKPOT). Tracks are
   the run's tracks with unknowns stored as 'unknown'; patterns/odds are
   empty, how_won is 'Other'. Same insert path + duplicate protection as
   Log Race. The shown result is NOT recomputed after saving — it stays
   frozen for this run; the new race counts from the next run. */
async function saveFeedbackRace(winner) {
  if (!wizard.ran || !wizard.lastRun || wizard.feedbackSaved) { wizard.feedbackSaving = false; return; }
  if (!appAccess().ok) {
    toast('Premium required to use this app.');
    wizard.feedback = null; wizard.feedbackSaving = false; saveWizard(); renderFeedback();
    return;
  }
  var race = buildFeedbackRace(wizard.lastRun, winner);
  if (!race) {
    toast('Could not save this race.');
    wizard.feedback = null; wizard.feedbackSaving = false; saveWizard(); renderFeedback();
    return;
  }
  if (isDuplicateRace(race, races)) {
    toast('This race is already saved.');
    wizard.feedbackSaved = true; wizard.feedbackSaving = false;
    renderFeedback(); saveWizard();
    return;
  }
  /* A rejected cloud insert used to leave the box stuck on 'Saving…'
     forever (feedbackSaved never set, buttons hidden, no retry). Now a
     failure clears the answer so the user can tap again — the race is
     only kept once the save actually lands. A null result (demo mode /
     offline cache) still saves locally, as before. */
  var saved = null;
  try {
    saved = await cloudInsertRace(race);
  } catch (e) {
    console.warn('Cloud insert failed:', e && e.message ? e.message : e);
    toast('Could not reach the server — check connection and tap again.');
    wizard.feedback = null; wizard.feedbackSaving = false; saveWizard(); renderFeedback();
    return;
  }
  if (saved) { race.id = saved.id; race.created_at = saved.created_at || race.created_at; }
  races.unshift(race);
  saveLocalRaces();
  wizard.feedbackSaved = true; wizard.feedbackSaving = false;
  renderFeedback(); saveWizard();
  toast('Race saved. Model updated.');
}

/* Long-press stepper: one tap = one step; hold = repeat fast (first
   repeat after 350 ms, then every 90 ms), so odds can be adjusted
   quickly before the 35 s timer ends. Pointer events cover touch
   and mouse. The step updates the value in place (no full re-render),
   so the held button is never destroyed mid-press. A click after a
   pointerdown is skipped (already stepped); a click with no
   pointerdown (keyboard) still steps once. */
function bindStepper(btn, stepFn) {
  var timer = null, handled = false;
  function clear() { if (timer) { clearTimeout(timer); timer = null; } }
  function repeat() { if (!btn.isConnected) { clear(); return; } stepFn(); timer = setTimeout(repeat, 90); }
  btn.addEventListener('pointerdown', function (e) {
    e.preventDefault();
    handled = true;
    stepFn();
    clear();
    timer = setTimeout(repeat, 350);
  });
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
    btn.addEventListener(ev, clear);
  });
  btn.addEventListener('click', function () {
    if (handled) { handled = false; return; }
    stepFn();
  });
}

/* Full-app premium gate.
   Who can use the software:
   - Demo mode (Supabase unconfigured): everyone, predictions unlocked.
   - Admins / owner (ADMIN_EMAILS in js/config.js or profiles.is_admin):
     PERMANENT access. The owner NEVER needs a subscription — the bypass
     is by admin/owner status, never by a subscription row (an admin's
     subscription row, if one exists, is irrelevant to their own access).
   - Global free-use window (21-24 Nov 2026): every SIGNED-IN user can
     use the app free until FREE_UNTIL in js/config.js (24 Nov 2026,
     23:59 PKT). Logged-out users still have to sign in first.
   - After the cutoff: an active subscription is required to use any tab.
     Anyone who creates an account after 24 Nov gets NO free usage — they
     hit the lock immediately unless they have premium.
   Pure core (appAccessFor) is unit-tested in Node; appAccess() reads the
   live session state. Returns { ok: true } or
   { ok: false, reason: 'signin' | 'premium' }. */
function isFreeWindowActive(freeUntilIso, nowMs) {
  /* Time source: the client clock (Date.now()). A user who sets their
     device clock back could stretch the window — a server-time check can
     be added later if the owner wants it. Missing/invalid FREE_UNTIL
     means NO free window (fail closed: premium rules apply). */
  if (!freeUntilIso) return false;
  var end = Date.parse(freeUntilIso);
  if (isNaN(end)) return false;
  return nowMs < end;
}
function appAccessFor(s) {
  if (s.loadFailed) return { ok: false, reason: 'offline' };
  if (s.demo) return { ok: true };
  if (!s.user) return { ok: false, reason: 'signin' };
  if (s.admin) return { ok: true };
  if (s.sub) return { ok: true };
  if (s.free) return { ok: true };
  return { ok: false, reason: 'premium' };
}
function appAccess() {
  return appAccessFor({ demo: DEMO_MODE, loadFailed: sbLoadFailed, admin: isAdmin, user: currentUser, sub: subActive, free: isFreeWindowActive(CONFIG.FREE_UNTIL, Date.now()) });
}
/* Buy Premium — WhatsApp, never a payment page. There is no checkout
   in this app: the buyer messages the owner on WhatsApp and the owner
   grants premium from his account. The number is the owner's
   +92 308 7215460; wa.me format drops the "+" and the leading 0 after
   the country code: 92 + 3087215460 = 923087215460. The display number
   is always shown as plain text too, so a user can copy it manually if
   WhatsApp does not open. Pure helpers, unit-tested in Node
   (scripts/test-buy-premium.js); the link is built from CONFIG with a
   literal fallback so it still works if the config is missing. */
function whatsappNumber() {
  return CONFIG.OWNER_WHATSAPP_NUMBER || '923087215460';
}
function whatsappDisplayNumber() {
  return CONFIG.OWNER_WHATSAPP_DISPLAY || '+92 308 7215460';
}
function whatsappBuyMessage(username) {
  var msg = 'Assalam-o-Alaikum, I want to buy Lucky Race Predictor Premium (Rs 3,000).';
  if (username) msg += ' My username is ' + username + '.';
  return msg;
}
function whatsappBuyUrl(username) {
  return 'https://wa.me/' + whatsappNumber() + '?text=' + encodeURIComponent(whatsappBuyMessage(username));
}
/* The Buy Premium view shown inside the app (lock panel + Account tab):
   price, the owner's WhatsApp number as plain text, and a Contact button
   that opens the wa.me link in a new tab. Never a dead button, never a
   payment page. */
function buyPremiumHtml(username) {
  return '<div class="buy-premium"><h3>Buy Premium — Rs 3,000</h3>' +
    '<p>Message the owner on WhatsApp to buy premium. Premium lasts until the end of the calendar month.</p>' +
    '<p>WhatsApp: <b>' + whatsappDisplayNumber() + '</b></p>' +
    '<a class="btn btn-yellow btn-block buy-whatsapp-btn" href="' + whatsappBuyUrl(username) + '" target="_blank" rel="noopener">Contact on WhatsApp</a></div>';
}
function lockedHtml(reason) {
  if (reason === 'offline') {
    return '<div class="locked-panel"><h3>Could not reach the login server</h3>' +
      '<p>The login service did not load. Check your connection and reload the page. Predictions stay locked until the server is reachable.</p>' +
      '<button class="btn btn-yellow goto-account-btn">Go to Account</button></div>';
  }
  return '<div class="locked-panel"><h3>Premium required</h3>' +
    (reason === 'signin'
      ? '<p>Sign in from the Account tab to use this app.</p>'
      : '<p>Free use ended on 24 Nov. Buy Premium (Rs 3,000) to keep using the app — premium lasts until the end of the calendar month.</p>' +
        '<button class="btn btn-yellow buy-premium-btn">Buy Premium (Rs 3,000)</button>') +
    '<button class="btn btn-yellow goto-account-btn">Go to Account</button></div>';
}

/* Wire the buttons inside a lock panel (used by the tab-lock overlay and
   the Predict result panel): "Go to Account" and "Buy Premium". Buy
   Premium swaps the panel for the in-app buy view (owner's WhatsApp
   number + Contact button); Back restores the lock panel for the same
   reason it had before. */
function wireLockedPanel(container, reason) {
  var go = container.querySelector('.goto-account-btn');
  if (go) go.addEventListener('click', function () { showTab('account'); });
  var buy = container.querySelector('.buy-premium-btn');
  if (buy) buy.addEventListener('click', function () {
    container.innerHTML = buyPremiumHtml(currentUsername) +
      '<button class="btn btn-ghost buy-back-btn">Back</button>';
    var back = container.querySelector('.buy-back-btn');
    if (back) back.addEventListener('click', function () {
      container.innerHTML = lockedHtml(reason);
      wireLockedPanel(container, reason);
    });
  });
}

/* Hides the content of the gated tabs (Predict, Log Race, Stats, Speeds)
   behind the premium lock overlay, and restores it when access is granted.
   The Account tab is never locked. The overlay div is created once per
   tab; the section's real content is only hidden, never removed, so all
   event listeners survive. */
var GATED_TABS = ['predict', 'log', 'stats', 'speeds'];
function applyTabLocks() {
  if (typeof document === 'undefined') return;
  var access = appAccess();
  GATED_TABS.forEach(function (name) {
    var sec = $('tab-' + name);
    if (!sec) return;
    if (!access.ok) {
      var overlay = sec.querySelector('.tab-lock');
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'tab-lock';
        sec.appendChild(overlay);
      }
      overlay.innerHTML = lockedHtml(access.reason);
      wireLockedPanel(overlay, access.reason);
      sec.classList.add('locked');
    } else {
      sec.classList.remove('locked');
    }
  });
}

function predictionAllowed() {
  return appAccess();
}

function renderPrediction() {
  var panel = $('resultPanel');
  var line = $('assumedLine');
  line.textContent = '';

  /* START screen: how much data every prediction analyses. */
  var sc = $('wizStartCount');
  if (sc) sc.textContent = races.length + ' saved races — every prediction analyses all of them.';

  var gate = predictionAllowed();
  if (!gate.ok) {
    panel.innerHTML = lockedHtml(gate.reason);
    wireLockedPanel(panel, gate.reason);
    return;
  }

  /* The wizard computes on RUN and shows a frozen snapshot: later calls
     (new race saved, speeds changed, tab revisited) re-render the same
     run instead of silently changing the numbers under the user. */
  if (!wizard.ran || !wizard.lastRun || !wizard.lastRun.result) {
    panel.innerHTML = '<p class="result-empty">Tap RUN to see the prediction.</p>';
    return;
  }

  var result = wizard.lastRun.result;
  var vehicles = wizard.lastRun.vehicles;
  var ms = wizard.lastRun.ms || 0;

  var knownSegs = {};
  wizard.lastRun.tracks.forEach(function (t, i) {
    if (t !== UNKNOWN_TRACK) knownSegs[i] = t;
  });
  var knownParts = [];
  Object.keys(knownSegs).forEach(function (k) {
    knownParts.push('Seg ' + (parseInt(k, 10) + 1) + ' ' + knownSegs[k]);
  });
  var html = '<div class="result-title">Top picks' +
    (knownParts.length ? ' — known: ' + knownParts.join(', ') : ' — all segments unknown') + '</div>';
  /* Suggestion line above the cards (user's ask, 22 Nov 2026): one line
     that says plainly which pick is the HIGH bet, which is MID and which
     is JACKPOT — the same words the feedback buttons use below. */
  var suggest = suggestionLine(result.ranked);
  if (suggest) html += '<div class="suggest-line">' + suggest + '</div>';
  /* All three picks as cards: #1 HIGH (big, highlighted), #2 MID
     (smaller), #3 JACKPOT (smallest) — the least likely vehicle, the
     long shot. Percentages are unchanged. */
  result.ranked.forEach(function (r, idx) {
    var others = vehicles.filter(function (v) { return v !== r.vehicle; });
    var pct = Math.min(99, Math.round(r.prob * 100));
    var label, cls;
    if (idx === 0) { label = 'HIGH · MAIN BET'; cls = 'rank-1 main-pick'; }
    else if (idx === 1) { label = 'MID · BACKUP'; cls = 'rank-2 backup-pick'; }
    else { label = 'JACKPOT'; cls = 'rank-3 jackpot-pick'; }
    /* The jackpot card gets no speed reason — a "fastest on X" line
       would read as a recommendation for the least likely pick. Instead
       it states plainly that it is the long shot, with the game's own
       odds for that vehicle (the same odds shown on the vehicle cards). */
    var reason = (result.dataInfo)
      ? (idx === 2
          ? 'Least likely of the 3 — ' + buildDataReason(r.vehicle, result.dataInfo) + ' (game odds ' + vehicleByName(r.vehicle).odds + '×).'
          : buildDataReason(r.vehicle, result.dataInfo))
      : (idx === 2
          ? 'Least likely of the 3 — the long shot (game odds ' + vehicleByName(r.vehicle).odds + '×).'
          : buildReason(r.vehicle, others, knownSegs, [result.dist1, result.dist2, result.dist3], speeds));
    html += '<div class="result-card ' + cls + '">' +
      '<div class="result-label">' + label + '</div>' +
      '<div class="result-head"><span class="result-name">' + r.vehicle + '</span>' +
      '<span class="result-conf">' + pct + '%</span></div>' +
      '<div class="conf-bar"><div class="conf-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="result-reason">' + reason + '</div></div>';
  });
  html += '<div class="result-foot">' +
    (result.dataInfo ? 'Data: ' + result.dataInfo.levelLabel + ' · n=' + result.dataInfo.matches + ' races · ' :
      (result.histInfo ? 'Blended with history (' + result.histInfo.matches + ' matching races, weight ' +
      Math.round(result.histInfo.weight * 100) + '%) · ' : '')) +
    'computed in ' + ms + ' ms</div>';
  /* Repeat-history note, frozen at RUN time ('' = never seen before). */
  if (wizard.lastRun.repeatNote) {
    html += '<div class="repeat-note">' + wizard.lastRun.repeatNote + '</div>';
  }
  /* Jackpot streak note, frozen at RUN time ('' = a jackpot won in the
     last 15 own bets, so nothing to watch). */
  if (wizard.lastRun.streakNote) {
    html += '<div class="jackpot-note">' + wizard.lastRun.streakNote + '</div>';
  }
  panel.innerHTML = html;

  line.textContent = result.dataInfo
    ? buildBlendReason(result.ranked[0].vehicle, result.dataInfo, result.blendInfo) + ' No odds — the % blends the speed table with the saved races.'
    : 'Assumed tracks — Seg 1: ' + formatDist(result.dist1) +
      ' · Seg 2: ' + formatDist(result.dist2) +
      ' · Seg 3: ' + formatDist(result.dist3) +
      '. These are probabilities from saved races and your hints, not certainties.';
}

/* 35-second betting timer (visual aid only). */
var timerInterval = null;
var timerLeft = 35;
function renderTimer() {
  var d = $('timerDisplay');
  d.textContent = timerLeft + 's';
  d.classList.toggle('low', timerLeft <= 10);
  $('timerBtn').textContent = timerInterval ? 'Reset timer' : 'Start 35s timer';
}
function startTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
    timerLeft = 35;
    renderTimer();
    // Resetting the timer means the next bet: clear the picked vehicles
    // and segments too, so the user never has to unselect cards by hand.
    resetPrediction();
    return;
  }
  timerLeft = 35;
  renderTimer();
  timerInterval = setInterval(function () {
    timerLeft -= 1;
    if (timerLeft <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      timerLeft = 0;
      renderTimer();
      toast('Betting closed — race started.');
      return;
    }
    renderTimer();
  }, 1000);
}

/* ============================================================================
   UI — Log Race tab
   ========================================================================== */

function renderLogVehicles() {
  var grid = $('logVehicles');
  grid.innerHTML = '';
  VEHICLES.forEach(function (v) {
    var card = el('div', 'vehicle-card' + (logForm.vehicles.indexOf(v.name) !== -1 ? ' picked' : ''));
    card.innerHTML = glyphHtml(v) +
      '<div class="v-name">' + v.name + '</div>' +
      '<div class="v-meta">Win ' + v.winRate + '%</div>';
    card.addEventListener('click', function () {
      var i = logForm.vehicles.indexOf(v.name);
      if (i !== -1) {
        logForm.vehicles.splice(i, 1);
        delete logForm.odds[v.name];
        if (logForm.winner === v.name) logForm.winner = null;
      } else {
        if (logForm.vehicles.length >= 3) { toast('Only 3 vehicles per race.'); return; }
        logForm.vehicles.push(v.name);
        logForm.odds[v.name] = v.odds;
      }
      renderLogForm();
    });
    grid.appendChild(card);
  });
  $('logPickCount').textContent = logForm.vehicles.length + '/3';
}

function renderLogSegments() {
  [0, 1, 2].forEach(function (idx) {
    renderTrackRow('logSeg' + (idx + 1), logForm.tracks[idx], function (t) {
      logForm.tracks[idx] = t;
      renderLogSegments();
    }, true); // every segment offers "? Unknown", default Unknown
  });
}

function renderLogPatterns() {
  var row = $('logPatterns');
  row.innerHTML = '';
  TRACKS.forEach(function (t) {
    var sel = logForm.patterns.indexOf(t) !== -1;
    var b = el('button', 'track-btn' + (sel ? ' selected' : ''), t);
    b.addEventListener('click', function () {
      var i = logForm.patterns.indexOf(t);
      if (i !== -1) logForm.patterns.splice(i, 1);
      else logForm.patterns.push(t);
      renderLogPatterns();
    });
    row.appendChild(b);
  });
  var none = el('button', 'track-btn unknown-btn' + (logForm.patterns.length === 0 ? ' selected' : ''), 'None');
  none.addEventListener('click', function () { logForm.patterns = []; renderLogPatterns(); });
  row.appendChild(none);
}

function renderLogWinner() {
  var row = $('logWinner');
  row.innerHTML = '';
  if (logForm.vehicles.length === 0) {
    row.appendChild(el('p', 'help-text', 'Pick 3 vehicles first.'));
    return;
  }
  logForm.vehicles.forEach(function (name) {
    var b = el('button', 'track-btn' + (logForm.winner === name ? ' selected' : ''), name);
    b.addEventListener('click', function () {
      logForm.winner = name;
      renderLogWinner();
    });
    row.appendChild(b);
  });
}

function renderLogHowWon() {
  var row = $('logHowWon');
  row.innerHTML = '';
  HOW_WON_OPTIONS.forEach(function (h) {
    var b = el('button', 'track-btn' + (logForm.howWon === h ? ' selected' : ''), h);
    b.addEventListener('click', function () {
      logForm.howWon = h;
      $('logHowText').classList.toggle('hidden', h !== 'Other');
      renderLogHowWon();
    });
    row.appendChild(b);
  });
}

function renderLogOdds() {
  var box = $('logOdds');
  box.innerHTML = '';
  if (logForm.vehicles.length === 0) return;
  logForm.vehicles.forEach(function (name) {
    var row = el('div', 'odds-row');
    row.appendChild(el('span', 'odds-name', name));
    var minus = el('button', 'stepper', '−');
    var val = el('span', 'odds-val', (logForm.odds[name] || 0).toFixed(1));
    var plus = el('button', 'stepper', '+');
    bindStepper(minus, function () {
      logForm.odds[name] = Math.max(1.0, Math.round(((logForm.odds[name] || 2) - 0.1) * 10) / 10);
      val.textContent = logForm.odds[name].toFixed(1);
    });
    bindStepper(plus, function () {
      logForm.odds[name] = Math.min(20, Math.round(((logForm.odds[name] || 2) + 0.1) * 10) / 10);
      val.textContent = logForm.odds[name].toFixed(1);
    });
    row.appendChild(minus); row.appendChild(val); row.appendChild(plus);
    box.appendChild(row);
  });
}

function renderLogForm() {
  renderLogVehicles();
  renderLogSegments();
  renderLogPatterns();
  renderLogWinner();
  renderLogHowWon();
  renderLogOdds();
  $('logHowText').classList.toggle('hidden', logForm.howWon !== 'Other');
  $('logHowText').value = logForm.howWonText || '';
  $('saveRaceBtn').textContent = logForm.editId ? 'Update race' : 'Save race';
  $('cancelEditBtn').classList.toggle('hidden', !logForm.editId);
}

function resetLogForm() {
  logForm = { vehicles: [], tracks: [null, null, null], patterns: [], winner: null, howWon: null, howWonText: '', odds: {}, editId: null };
  renderLogForm();
}

async function saveRace() {
  if (!appAccess().ok) { toast('Premium required to use this app.'); return; }
  if (logForm.vehicles.length !== 3) { toast('Pick 3 vehicles first.'); return; }
  if (!logForm.winner) { toast('Pick the winner.'); return; }
  if (!logForm.howWon) { toast('Pick how it won.'); return; }
  var howText = logForm.howWon === 'Other' ? ($('logHowText').value || '').trim() : '';
  var race = {
    id: logForm.editId || ('local-' + Date.now() + '-' + Math.floor(Math.random() * 1000)),
    vehicles: logForm.vehicles.slice(),
    // Unknown segments are stored as the real value 'unknown' — never
    // converted to a guessed track type.
    tracks: normalizeTracksForSave(logForm.tracks),
    patterns: logForm.patterns.slice(),
    winner: logForm.winner,
    how_won: logForm.howWon,
    how_won_text: howText,
    odds: Object.assign({}, logForm.odds),
    created_at: new Date().toISOString()
  };

  if (logForm.editId) {
    if (isDuplicateRace(race, races, logForm.editId)) { toast('This race is already saved.'); return; }
    var idx = races.findIndex(function (r) { return String(r.id) === String(logForm.editId); });
    if (idx !== -1) races[idx] = race;
    await cloudUpdateRace(race);
    toast('Race updated.');
  } else {
    if (isDuplicateRace(race, races)) { toast('This race is already saved.'); return; }
    var saved = await cloudInsertRace(race);
    if (saved) { race.id = saved.id; race.created_at = saved.created_at || race.created_at; }
    races.unshift(race);
    toast('Race saved. Model updated.');
  }
  saveLocalRaces();
  resetLogForm();
  renderRaceList();
  renderPrediction(); // new data changes track probabilities
}

function renderRaceList() {
  var list = $('raceList');
  list.innerHTML = '';
  $('raceCount').textContent = races.length ? '(' + races.length + ')' : '';
  if (!races.length) {
    list.appendChild(el('p', 'help-text', 'No races logged yet. Log races to teach the model the real track frequencies and win rates.'));
    return;
  }
  races.slice(0, 100).forEach(function (r) {
    var item = el('div', 'race-item');
    var line1 = el('div', 'r-line');
    /* Winner/vehicles are rendered as text, never as HTML: race data can
       carry arbitrary strings (e.g. from a CSV import), and innerHTML
       here would turn them into live markup. */
    line1.appendChild(el('b', null, r.winner || ''));
    line1.appendChild(document.createTextNode(' won — ' + (r.vehicles || []).join(' vs ')));
    var meta = el('div', 'r-meta',
      (r.tracks || []).join(' → ') +
      (r.patterns && r.patterns.length ? ' · Patterns: ' + r.patterns.join(', ') : '') +
      ' · ' + (r.how_won || '') + (r.how_won_text ? ' (' + r.how_won_text + ')' : '') +
      ' · ' + fmtDate(r.created_at));
    var actions = el('div', 'race-actions');
    var editBtn = el('button', 'btn btn-ghost', 'Edit');
    editBtn.addEventListener('click', function () {
      logForm = {
        vehicles: (r.vehicles || []).slice(),
        // Stored 'unknown' segments come back as null (Unknown) in the form.
        tracks: (r.tracks || []).map(function (t) { return t === UNKNOWN_TRACK ? null : t; }),
        patterns: (r.patterns || []).slice(),
        winner: r.winner,
        howWon: r.how_won,
        howWonText: r.how_won_text || '',
        odds: Object.assign({}, r.odds || {}),
        editId: r.id
      };
      renderLogForm();
      window.scrollTo(0, 0);
    });
    var delBtn = el('button', 'btn btn-ghost', 'Delete');
    delBtn.addEventListener('click', async function () {
      races = races.filter(function (x) { return String(x.id) !== String(r.id); });
      saveLocalRaces();
      await cloudDeleteRace(r.id);
      renderRaceList();
      renderPrediction();
      toast('Race deleted.');
    });
    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    item.appendChild(line1);
    item.appendChild(meta);
    item.appendChild(actions);
    list.appendChild(item);
  });
  if (races.length > 100) {
    list.appendChild(el('p', 'help-text', 'Showing the latest 100 of ' + races.length + ' races. Export CSV for the full set.'));
  }
}

/* ============================================================================
   UI — Stats tab + CSV
   ========================================================================== */

function computeStats() {
  var perVehicle = {};
  VEHICLES.forEach(function (v) { perVehicle[v.name] = { races: 0, wins: 0 }; });
  var perTrack = {}; // vehicle -> track -> {races, wins}
  VEHICLES.forEach(function (v) {
    perTrack[v.name] = {};
    TRACKS.forEach(function (t) { perTrack[v.name][t] = { races: 0, wins: 0 }; });
  });
  var freq = [ {}, {}, {} ]; // per segment index: track -> count
  TRACKS.forEach(function (t) { freq[0][t] = 0; freq[1][t] = 0; freq[2][t] = 0; });

  races.forEach(function (r) {
    (r.vehicles || []).forEach(function (v) {
      if (perVehicle[v]) perVehicle[v].races += 1;
    });
    if (perVehicle[r.winner]) perVehicle[r.winner].wins += 1;
    (r.tracks || []).forEach(function (t, i) {
      if (freq[i] && freq[i][t] !== undefined) freq[i][t] += 1;
      (r.vehicles || []).forEach(function (v) {
        if (perTrack[v] && perTrack[v][t]) {
          perTrack[v][t].races += 1;
          if (r.winner === v) perTrack[v][t].wins += 1;
        }
      });
    });
  });
  return { perVehicle: perVehicle, perTrack: perTrack, freq: freq, total: races.length };
}

function renderStats() {
  var s = computeStats();
  $('statsSummary').innerHTML =
    '<div class="stat-chip"><div class="num">' + s.total + '</div><div class="lbl">Races logged</div></div>' +
    '<div class="stat-chip"><div class="num">' + (s.total >= 30 ? 'ON' : 'OFF') + '</div><div class="lbl">History blend (30+)</div></div>' +
    '<div class="stat-chip"><div class="num">' + VEHICLES.length + '</div><div class="lbl">Vehicles</div></div>';

  var vBox = $('statsVehicles');
  vBox.innerHTML = '';
  VEHICLES.slice().sort(function (a, b) {
    var ra = s.perVehicle[a.name], rb = s.perVehicle[b.name];
    var pa = ra.races ? ra.wins / ra.races : -1, pb = rb.races ? rb.wins / rb.races : -1;
    return pb - pa;
  }).forEach(function (v) {
    var st = s.perVehicle[v.name];
    var pct = st.races ? Math.round(st.wins / st.races * 100) + '%' : '—';
    var row = el('div', 'stat-row');
    row.innerHTML = '<span class="s-name">' + v.name + ' <span style="color:var(--muted);font-weight:400">(overall ' + v.winRate + '%)</span></span>' +
      '<span>' + st.wins + '/' + st.races + '</span><span class="s-val">' + pct + '</span>';
    vBox.appendChild(row);
  });

  var tBox = $('statsPerTrack');
  var html = '<table class="data"><thead><tr><th>Vehicle</th>';
  TRACKS.forEach(function (t) { html += '<th>' + t + '</th>'; });
  html += '</tr></thead><tbody>';
  VEHICLES.forEach(function (v) {
    html += '<tr><td>' + v.name + '</td>';
    TRACKS.forEach(function (t) {
      var st = s.perTrack[v.name][t];
      html += '<td>' + (st.races ? Math.round(st.wins / st.races * 100) + '% (' + st.wins + '/' + st.races + ')' : '—') + '</td>';
    });
    html += '</tr>';
  });
  tBox.innerHTML = html + '</tbody></table>';

  var fBox = $('statsFreq');
  fBox.innerHTML = '';
  var colors = ['#ffd21f', '#8b3dff', '#2ecc71', '#ff8a5a', '#4fc3f7', '#e84393'];
  [0, 1, 2].forEach(function (i) {
    var wrap = el('div', 'freq-row');
    wrap.appendChild(el('h4', null, 'Segment ' + (i + 1)));
    var bar = el('div', 'freq-bar');
    var total = s.total || 1;
    TRACKS.forEach(function (t, ti) {
      var c = s.freq[i][t] || 0;
      if (!c) return;
      var seg = el('span', null, t.slice(0, 4) + ' ' + Math.round(c / total * 100) + '%');
      seg.style.width = (c / total * 100) + '%';
      seg.style.background = colors[ti % colors.length];
      seg.title = t + ': ' + c + ' races';
      bar.appendChild(seg);
    });
    if (!s.total) bar.appendChild(el('span', null, 'No data yet'));
    wrap.appendChild(bar);
    fBox.appendChild(wrap);
  });

  /* Prediction accuracy (HIGH / MID / JACKPOT split), replayed: the
     model re-predicts each saved race from the races before it, and the
     actual winner is counted as a HIGH, MID or JACKPOT win. This is the
     three-way split the 3-button feedback feeds — before it, a backup
     win was reported as "Wrong" and the split could not be measured.
     The replay is the heaviest thing on this tab (one full prediction
     per race), so it only runs while the Stats tab is actually open —
     renderStats also runs at startup, when the Predict tab is showing. */
  var aBox = $('statsAccuracy');
  if (aBox) {
    var statsActive = (function () {
      var sec = $('tab-stats');
      return sec && sec.classList.contains('active');
    })();
    if (!statsActive) {
      aBox.innerHTML = '';
    } else {
      var acc = null;
      try { acc = predictionAccuracy(races, speeds, PREDICTION_ACCURACY_LIMIT); } catch (e) { acc = null; }
      aBox.innerHTML = '';
      if (acc && acc.total > 0) {
        var accPct = function (n) { return acc.total ? Math.round(n / acc.total * 100) + '%' : '—'; };
        [['HIGH won', acc.high], ['MID won', acc.mid], ['JACKPOT won', acc.jackpot]].forEach(function (row) {
          var r = el('div', 'stat-row');
          r.innerHTML = '<span class="s-name">' + row[0] + '</span>' +
            '<span>' + row[1] + '/' + acc.total + '</span><span class="s-val">' + accPct(row[1]) + '</span>';
          aBox.appendChild(r);
        });
        aBox.appendChild(el('p', 'help-text',
          'Replayed over the last ' + acc.window + ' saved races: the model re-predicts each race from the races before it. ' +
          'HIGH + MID won ' + accPct(acc.high + acc.mid) + ' of races.' +
          (acc.skipped ? ' (' + acc.skipped + ' skipped: the winner was not one of the 3 vehicles.)' : '')));
      } else {
        aBox.appendChild(el('p', 'help-text', 'Not enough races yet to replay predictions.'));
      }
    }
  }
}

function racesToCsv() {
  var header = ['id', 'vehicles', 'track1', 'track2', 'track3', 'patterns', 'winner', 'how_won', 'how_won_text', 'odds', 'created_at'];
  function q(v) {
    var s = (v === undefined || v === null) ? '' : String(v);
    return '"' + s.replace(/"/g, '""') + '"';
  }
  var lines = [header.join(',')];
  races.forEach(function (r) {
    lines.push([
      q(r.id), q((r.vehicles || []).join('|')), q(r.tracks && r.tracks[0]), q(r.tracks && r.tracks[1]), q(r.tracks && r.tracks[2]),
      q((r.patterns || []).join('|')), q(r.winner), q(r.how_won), q(r.how_won_text || ''),
      q(JSON.stringify(r.odds || {})), q(r.created_at)
    ].join(','));
  });
  return lines.join('\n');
}

function downloadCsv() {
  if (!appAccess().ok) { toast('Premium required to use this app.'); return; }
  var blob = new Blob([racesToCsv()], { type: 'text/csv' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'lucky-race-races.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  toast('CSV exported (' + races.length + ' races).');
}

function parseCsvLine(line) {
  var out = [], cur = '', inQ = false;
  for (var i = 0; i < line.length; i++) {
    var ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/* A saved race's 3 tracks are valid when each is one of the 6 track types
   or the real value 'unknown'. */
function isValidRaceTracks(tracks) {
  return Array.isArray(tracks) && tracks.length === 3 &&
    tracks.every(function (t) { return TRACKS.indexOf(t) !== -1 || t === UNKNOWN_TRACK; });
}

async function importCsv(file) {
  if (!appAccess().ok) { toast('Premium required to use this app.'); return; }
  var text = await file.text();
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
  if (lines.length < 2) { toast('CSV is empty.'); return; }
  var header = parseCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
  var idx = {};
  header.forEach(function (h, i) { idx[h] = i; });
  var added = 0, skipped = 0;
  for (var li = 1; li < lines.length; li++) {
    var c = parseCsvLine(lines[li]);
    var vehicles = (c[idx.vehicles] || '').split('|').map(function (s) { return resolveVehicleName(s); }).filter(Boolean);
    var tracks = [c[idx.track1], c[idx.track2], c[idx.track3]].map(function (s) { return resolveTrackName(s); });
    var winner = resolveVehicleName(c[idx.winner] || '');
    var ok = vehicles.length === 3 &&
      vehicles.every(function (v) { return vehicleByName(v); }) &&
      isValidRaceTracks(tracks) &&
      vehicles.indexOf(winner) !== -1;
    if (!ok) { skipped += 1; continue; }
    var race = {
      id: 'local-' + Date.now() + '-' + li + '-' + Math.floor(Math.random() * 1000),
      vehicles: vehicles,
      tracks: tracks,
      patterns: (c[idx.patterns] || '').split('|').map(function (s) { return s.trim(); }).filter(function (s) { return TRACKS.indexOf(s) !== -1; }),
      winner: winner,
      how_won: (c[idx.how_won] || '').trim() || 'Other',
      how_won_text: (c[idx.how_won_text] || '').trim().slice(0, 120),
      odds: {},
      created_at: (c[idx.created_at] || '').trim() || new Date().toISOString()
    };
    // Duplicate rows are skipped and counted, like invalid rows — a race
    // already in the dataset is never added twice (also catches a
    // duplicate row earlier in the same file, since `races` grows as
    // rows are imported).
    if (isDuplicateRace(race, races)) { skipped += 1; continue; }
    try {
      var rawOdds = JSON.parse(c[idx.odds] || '{}');
      /* Keep only sane odds: known vehicles, finite numbers 1-20.
         Anything else in the file is dropped, never stored. */
      if (rawOdds && typeof rawOdds === 'object') {
        Object.keys(rawOdds).forEach(function (k) {
          var v = Number(rawOdds[k]);
          if (vehicleByName(k) && isFinite(v) && v >= 1 && v <= 20) race.odds[k] = v;
        });
      }
    } catch (e) { race.odds = {}; }
    var saved = await cloudInsertRace(race);
    if (saved) { race.id = saved.id; race.created_at = saved.created_at || race.created_at; }
    races.unshift(race);
    added += 1;
  }
  saveLocalRaces();
  renderRaceList();
  renderStats();
  renderPrediction();
  toast('Imported ' + added + ' races' + (skipped ? ' (' + skipped + ' skipped)' : '') + '.');
}

/* ============================================================================
   UI — Speed table tab
   ========================================================================== */

function renderSpeedTable() {
  var box = $('speedTable');
  var html = '<table class="data"><thead><tr><th>Vehicle</th>';
  TRACKS.forEach(function (t) { html += '<th>' + t.slice(0, 5) + '</th>'; });
  html += '</tr></thead><tbody>';
  VEHICLES.forEach(function (v) {
    html += '<tr><td>' + v.name + '</td>';
    TRACKS.forEach(function (t) {
      /* Numbers only: a tampered localStorage value must never reach the
         markup as raw text. */
      var val = parseInt(speeds[v.name][t], 10);
      if (!isFinite(val) || val < 1) val = DEFAULT_SPEEDS[v.name][t];
      html += '<td><input type="number" min="1" max="999" step="1" value="' + val +
        '" data-vehicle="' + v.name + '" data-track="' + t + '"></td>';
    });
    html += '</tr>';
  });
  box.innerHTML = html + '</tbody></table>';
}

function saveSpeeds() {
  if (!appAccess().ok) { toast('Premium required to use this app.'); return; }
  var inputs = document.querySelectorAll('#speedTable input');
  var next = cloneSpeeds(speeds);
  inputs.forEach(function (inp) {
    var v = inp.getAttribute('data-vehicle');
    var t = inp.getAttribute('data-track');
    var val = parseInt(inp.value, 10);
    if (next[v] && !isNaN(val) && val > 0) next[v][t] = val;
  });
  speeds = next;
  saveLocalSpeeds();
  renderPrediction();
  toast('Speeds saved.');
}

/* ============================================================================
   UI — Account tab (auth, subscription, admin)
   ========================================================================== */

function renderAccount() {
  var box = $('accountContent');
  box.innerHTML = '';

  if (DEMO_MODE) {
    var demo = el('div', 'acct-card');
    demo.innerHTML = '<h3>Demo mode</h3>' +
      '<p>Supabase is not configured, so the app runs locally: races and speeds are stored in this browser only, and predictions are unlocked.</p>' +
      '<p>To enable real accounts and subscriptions, create a free Supabase project, run <b>sql/schema.sql</b>, and fill in <b>js/config.js</b>. See README.md.</p>' +
      '<p>Subscription status: <span class="sub-active">Demo — predictions unlocked</span></p>';
    box.appendChild(demo);
    return;
  }

  if (sbLoadFailed) {
    var fail = el('div', 'acct-card');
    fail.innerHTML = '<h3>Could not reach the login server</h3>' +
      '<p>The login service did not load. Check your connection and reload the page. Nothing is unlocked until the server is reachable.</p>';
    box.appendChild(fail);
    return;
  }

  /* An expired / already-used email link: say so plainly, with a way to
     request a new one, instead of silently showing the locked screen. */
  if (authLinkError) {
    var linkErr = el('div', 'acct-card');
    var linkMsg = (authLinkError.code === 'otp_expired')
      ? 'This link has expired or was already used. Request a new one below — links work once and expire quickly.'
      : 'This sign-in link did not work' + (authLinkError.desc ? ': ' + authLinkError.desc : '.') + ' Request a new one below.';
    linkErr.appendChild(el('h3', null, 'Sign-in link problem'));
    linkErr.appendChild(el('p', null, linkMsg));
    var dismiss = el('button', 'btn btn-ghost', 'Dismiss');
    dismiss.addEventListener('click', function () { authLinkError = null; renderAccount(); });
    linkErr.appendChild(dismiss);
    box.appendChild(linkErr);
  }

  if (!currentUser) {
    /* Athera-style auth: centred card, Sign in / Sign up tabs,
       labelled fields, show/hide password, inline errors. Same auth
       rules as before (email + password min 6; username optional). */
    var wrap = el('div', 'auth-wrap');
    var brand = el('div', 'auth-brand');
    brand.innerHTML = '<div class="auth-logo">LUCKY <span>RACE</span></div>' +
      '<div class="auth-name">Lucky Race Predictor</div>' +
      '<p class="auth-sub">Smart picks from your saved races</p>';
    wrap.appendChild(brand);

    var auth = el('div', 'auth-card');
    var title = el('h1', 'auth-title', 'Sign in');
    auth.appendChild(title);

    var tabs = el('div', 'auth-tabs');
    tabs.setAttribute('role', 'tablist');
    var tabIn = el('button', 'auth-tab active', 'Sign in');
    var tabUp = el('button', 'auth-tab', 'Sign up');
    tabIn.type = 'button'; tabUp.type = 'button';
    tabs.appendChild(tabIn); tabs.appendChild(tabUp);
    auth.appendChild(tabs);

    auth.appendChild(el('p', 'auth-note', isFreeWindowActive(CONFIG.FREE_UNTIL, Date.now())
      ? 'Free to use until 24 Nov 2026, 23:59 PKT. After that, predictions need an active subscription (Rs 3,000).'
      : 'Predictions need an account with an active subscription (Rs 3,000).'));

    /* Username — sign-up only */
    var userBlock = el('div', 'auth-field-block');
    userBlock.style.display = 'none';
    var userLabel = el('label', 'auth-label', 'Username');
    userLabel.appendChild(el('span', 'auth-hint', 'optional'));
    var userField = el('input', 'auth-input'); userField.type = 'text'; userField.placeholder = 'yourname'; userField.id = 'authUsername'; userField.maxLength = 20; userField.autocomplete = 'username';
    userBlock.appendChild(userLabel); userBlock.appendChild(userField);
    auth.appendChild(userBlock);

    /* Email */
    var emailBlock = el('div', 'auth-field-block');
    emailBlock.appendChild(el('label', 'auth-label', 'Email'));
    var email = el('input', 'auth-input'); email.type = 'email'; email.placeholder = 'you@example.com'; email.id = 'authEmail'; email.autocomplete = 'email';
    var emailErr = el('span', 'auth-field-error'); emailErr.style.display = 'none';
    emailBlock.appendChild(email); emailBlock.appendChild(emailErr);
    auth.appendChild(emailBlock);

    /* Password + show/hide */
    var passBlock = el('div', 'auth-field-block');
    var passLabel = el('label', 'auth-label', 'Password');
    var passHint = el('span', 'auth-hint', 'At least 6 characters');
    passHint.style.display = 'none';
    passLabel.appendChild(passHint);
    var passWrap = el('span', 'auth-field-wrap');
    var pass = el('input', 'auth-input'); pass.type = 'password'; pass.placeholder = '••••••••'; pass.id = 'authPass'; pass.autocomplete = 'current-password';
    var showBtn = el('button', 'auth-show', 'Show'); showBtn.type = 'button';
    showBtn.addEventListener('click', function () {
      var show = pass.type === 'password';
      pass.type = show ? 'text' : 'password';
      showBtn.textContent = show ? 'Hide' : 'Show';
    });
    passWrap.appendChild(pass); passWrap.appendChild(showBtn);
    var passErr = el('span', 'auth-field-error'); passErr.style.display = 'none';
    passBlock.appendChild(passLabel); passBlock.appendChild(passWrap); passBlock.appendChild(passErr);
    auth.appendChild(passBlock);

    /* Confirm password — sign-up only */
    var confBlock = el('div', 'auth-field-block');
    confBlock.style.display = 'none';
    confBlock.appendChild(el('label', 'auth-label', 'Confirm password'));
    var confWrap = el('span', 'auth-field-wrap');
    var conf = el('input', 'auth-input'); conf.type = 'password'; conf.placeholder = '••••••••'; conf.autocomplete = 'new-password';
    var showConf = el('button', 'auth-show', 'Show'); showConf.type = 'button';
    showConf.addEventListener('click', function () {
      var show = conf.type === 'password';
      conf.type = show ? 'text' : 'password';
      showConf.textContent = show ? 'Hide' : 'Show';
    });
    confWrap.appendChild(conf); confWrap.appendChild(showConf);
    var confErr = el('span', 'auth-field-error'); confErr.style.display = 'none';
    confBlock.appendChild(confWrap); confBlock.appendChild(confErr);
    auth.appendChild(confBlock);

    /* Error / info boxes (Athera-style tinted boxes) */
    var errBox = el('p', 'auth-error'); errBox.style.display = 'none';
    var infoBox = el('p', 'auth-info'); infoBox.style.display = 'none';
    auth.appendChild(errBox); auth.appendChild(infoBox);
    function setErr(text) { errBox.textContent = text || ''; errBox.style.display = text ? '' : 'none'; if (text) infoBox.style.display = 'none'; }
    function setInfo(text) { infoBox.textContent = text || ''; infoBox.style.display = text ? '' : 'none'; if (text) errBox.style.display = 'none'; }
    function setFieldErr(node, text) { node.textContent = text || ''; node.style.display = text ? '' : 'none'; }

    var submitBtn = el('button', 'btn btn-yellow btn-block', 'Sign in');
    var forgotBtn = el('button', 'auth-secondary', 'Forgot password?');
    auth.appendChild(submitBtn); auth.appendChild(forgotBtn);

    var mode = 'sign-in';
    function setMode(m) {
      mode = m;
      title.textContent = m === 'sign-up' ? 'Create your account' : 'Sign in';
      tabIn.classList.toggle('active', m === 'sign-in');
      tabUp.classList.toggle('active', m === 'sign-up');
      userBlock.style.display = m === 'sign-up' ? '' : 'none';
      confBlock.style.display = m === 'sign-up' ? '' : 'none';
      passHint.style.display = m === 'sign-up' ? '' : 'none';
      pass.autocomplete = m === 'sign-up' ? 'new-password' : 'current-password';
      submitBtn.textContent = m === 'sign-up' ? 'Create account' : 'Sign in';
      forgotBtn.style.display = m === 'sign-in' ? '' : 'none';
      setErr(''); setInfo('');
      setFieldErr(emailErr, ''); setFieldErr(passErr, ''); setFieldErr(confErr, '');
    }
    tabIn.addEventListener('click', function () { setMode('sign-in'); });
    tabUp.addEventListener('click', function () { setMode('sign-up'); });

    function setBusy(busy) { submitBtn.disabled = busy; forgotBtn.disabled = busy; tabIn.disabled = busy; tabUp.disabled = busy; }

    function validEmail() {
      var em = email.value.trim();
      if (!em || em.indexOf('@') === -1) { setFieldErr(emailErr, 'Enter a valid email address.'); return null; }
      setFieldErr(emailErr, '');
      return em;
    }
    function validPass() {
      if (!pass.value || pass.value.length < 6) { setFieldErr(passErr, 'Password must be at least 6 characters.'); return false; }
      setFieldErr(passErr, '');
      return true;
    }

    submitBtn.addEventListener('click', async function () {
      var em = validEmail();
      if (!em || !validPass()) return;
      if (mode === 'sign-up') {
        if (!conf.value || pass.value !== conf.value) { setFieldErr(confErr, 'Those passwords do not match.'); return; }
        setFieldErr(confErr, '');
        var uname = userField.value.trim();
        var meta = {};
        if (uname) {
          var check = validateUsername(uname);
          if (!check.ok) { setErr(check.reason); return; }
          meta.username = check.value;
        }
        setErr(''); setInfo(''); setBusy(true);
        var upRes = await sb.auth.signUp({
          email: em, password: pass.value,
          options: { data: meta, emailRedirectTo: authRedirectUrl() }
        });
        setBusy(false);
        if (upRes.error) { setErr(upRes.error.message); toast(upRes.error.message); return; }
        setInfo('Account created. Check your email for the confirmation link, then sign in — the link opens this app and signs you in. If no email arrives, wait a little before trying again (only a few account emails can be sent per hour).');
        toast('Account created — check your email.');
        await afterAuth();
        return;
      }
      setErr(''); setInfo(''); setBusy(true);
      var res = await sb.auth.signInWithPassword({ email: em, password: pass.value });
      setBusy(false);
      if (res.error) {
        var hint = /invalid login/i.test(res.error.message)
          ? 'Wrong email or password — or the account is not confirmed yet. Check your inbox for the confirmation link, then try again.'
          : res.error.message;
        setErr(hint);
        toast(res.error.message);
        return;
      }
      authLinkError = null;
      await afterAuth();
    });

    forgotBtn.addEventListener('click', async function () {
      var em = validEmail();
      if (!em) { setErr('Enter your email above first, then tap "Forgot password?".'); return; }
      setErr(''); setInfo(''); setBusy(true);
      var res = await sb.auth.resetPasswordForEmail(em, { redirectTo: authRedirectUrl() });
      setBusy(false);
      if (res.error) { setErr(res.error.message); toast(res.error.message); return; }
      setInfo('Reset link sent to ' + em + ' — check your inbox (and spam). The link signs you in and lets you set a new password. Only a few account emails can be sent per hour, so if you requested links recently, wait a bit before trying again.');
      toast('Reset link sent — check your email.');
    });

    wrap.appendChild(auth);
    wrap.appendChild(el('p', 'auth-footer', 'Created by Taha Ahsan'));
    box.appendChild(wrap);
    return;
  }

  /* Set-new-password form: shown when the user arrived from a password-
     recovery email link (PASSWORD_RECOVERY session). Same Athera-style
     card as the sign-in form. */
  if (recoveryMode) {
    var recWrap = el('div', 'auth-wrap');
    var recBrand = el('div', 'auth-brand');
    recBrand.innerHTML = '<div class="auth-logo">LUCKY <span>RACE</span></div>' +
      '<div class="auth-name">Lucky Race Predictor</div>' +
      '<p class="auth-sub">Smart picks from your saved races</p>';
    recWrap.appendChild(recBrand);
    var rec = el('div', 'auth-card');
    rec.appendChild(el('h1', 'auth-title', 'Set a new password'));
    rec.appendChild(el('p', 'auth-note', 'You arrived from a password-reset link. Choose a new password below — you stay signed in.'));
    var recPassBlock = el('div', 'auth-field-block');
    recPassBlock.appendChild(el('label', 'auth-label', 'New password'));
    var recPassWrap = el('span', 'auth-field-wrap');
    var recPass = el('input', 'auth-input'); recPass.type = 'password'; recPass.placeholder = '••••••••';
    var recShow = el('button', 'auth-show', 'Show'); recShow.type = 'button';
    recShow.addEventListener('click', function () {
      var s = recPass.type === 'password';
      recPass.type = s ? 'text' : 'password';
      recShow.textContent = s ? 'Hide' : 'Show';
    });
    recPassWrap.appendChild(recPass); recPassWrap.appendChild(recShow);
    recPassBlock.appendChild(recPassWrap);
    rec.appendChild(recPassBlock);
    var recPass2Block = el('div', 'auth-field-block');
    recPass2Block.appendChild(el('label', 'auth-label', 'Repeat new password'));
    var recPass2Wrap = el('span', 'auth-field-wrap');
    var recPass2 = el('input', 'auth-input'); recPass2.type = 'password'; recPass2.placeholder = '••••••••';
    var recShow2 = el('button', 'auth-show', 'Show'); recShow2.type = 'button';
    recShow2.addEventListener('click', function () {
      var s = recPass2.type === 'password';
      recPass2.type = s ? 'text' : 'password';
      recShow2.textContent = s ? 'Hide' : 'Show';
    });
    recPass2Wrap.appendChild(recPass2); recPass2Wrap.appendChild(recShow2);
    recPass2Block.appendChild(recPass2Wrap);
    rec.appendChild(recPass2Block);
    var recMsg = el('p', 'auth-error'); recMsg.style.display = 'none';
    rec.appendChild(recMsg);
    var recBtn = el('button', 'btn btn-yellow btn-block', 'Set new password');
    recBtn.addEventListener('click', async function () {
      if (!recPass.value || recPass.value.length < 6) { recMsg.textContent = 'Password must be at least 6 characters.'; recMsg.style.display = ''; return; }
      if (recPass.value !== recPass2.value) { recMsg.textContent = 'The two passwords do not match.'; recMsg.style.display = ''; return; }
      recBtn.disabled = true;
      var recRes = await sb.auth.updateUser({ password: recPass.value });
      recBtn.disabled = false;
      if (recRes.error) { recMsg.textContent = recRes.error.message; recMsg.style.display = ''; toast(recRes.error.message); return; }
      recoveryMode = false;
      clearAuthHash();
      toast('Password set. You are signed in.');
      await afterAuth();
    });
    rec.appendChild(recBtn);
    recWrap.appendChild(rec);
    recWrap.appendChild(el('p', 'auth-footer', 'Created by Taha Ahsan'));
    box.appendChild(recWrap);
  }

  /* Owner profile: a distinct card at the top of the Account tab for the
     admin/owner, with his email and an OWNER badge. His access is
     permanent — he never needs a subscription. */
  if (isAdmin) {
    var owner = el('div', 'acct-card owner-card');
    var oh = el('h3');
    oh.appendChild(el('span', 'owner-badge', 'OWNER'));
    oh.appendChild(document.createTextNode(' ' + currentUser.email));
    owner.appendChild(oh);
    owner.appendChild(el('p', null, 'Your access is permanent — as the owner you never need a subscription. Grant premium to anyone from the users list below. Only users with an active subscription can use this app.'));
    box.appendChild(owner);
  }

  var status = el('div', 'acct-card');
  status.appendChild(el('h3', null, currentUser.email));
  var subLine = el('p');
  subLine.appendChild(document.createTextNode('Subscription: '));
  subLine.appendChild(el('span', subActive ? 'sub-active' : (isAdmin ? 'sub-active' : 'sub-expired'),
    subActive ? 'Active until ' + fmtDate(subExpiresAt)
      : (isAdmin ? 'Owner — permanent access, no subscription needed'
        : 'Expired / none — subscriptions end at the end of each calendar month.')));
  status.appendChild(subLine);
  /* Free-use window + Buy Premium (WhatsApp). Non-premium users see the
     free window while it lasts ("Free use until 24 Nov") and the premium
     prompt after it. The Buy button opens the in-app buy view (owner's
     WhatsApp number + Contact button) — never a dead button, never a
     payment page. The owner never sees this: his access is permanent. */
  if (!isAdmin && !subActive) {
    if (isFreeWindowActive(CONFIG.FREE_UNTIL, Date.now())) {
      status.appendChild(el('p', null, 'Free use until 24 Nov 2026, 23:59 PKT — after that, premium (Rs 3,000) is needed to keep using the app.'));
    } else {
      status.appendChild(el('p', null, 'Free use ended on 24 Nov — buy premium (Rs 3,000) to keep using the app.'));
    }
    var buyBtn = el('button', 'btn btn-yellow btn-block', 'Buy Premium (Rs 3,000)');
    buyBtn.addEventListener('click', function () {
      if ($('buyPremiumCard')) return; // already open
      var card = el('div', 'acct-card');
      card.id = 'buyPremiumCard';
      card.innerHTML = buyPremiumHtml(currentUsername);
      var hideBtn = el('button', 'btn btn-ghost', 'Hide');
      hideBtn.addEventListener('click', function () { card.remove(); });
      card.appendChild(hideBtn);
      box.appendChild(card);
      card.scrollIntoView();
    });
    status.appendChild(buyBtn);
  }
  if (isAdmin) status.appendChild(el('p', null, 'You are the owner of this app.'));
  if (currentUsername) status.appendChild(el('p', null, 'Username: ' + currentUsername));
  var outBtn = el('button', 'btn btn-ghost', 'Sign out');
  outBtn.addEventListener('click', async function () {
    unsubscribeLiveBets();
    await sb.auth.signOut();
    currentUser = null; currentUsername = null; subActive = false; isAdmin = false;
    recoveryMode = false;
    /* Clear the local race cache on sign-out: it belongs to the user who
       just left, and must not be shown to the next user on this browser. */
    races = []; saveLocalRaces();
    resetPrediction(); // the run belonged to the signed-out user
    renderAccount();
    renderPrediction();
    applyTabLocks();
    toast('Signed out.');
  });
  status.appendChild(outBtn);
  box.appendChild(status);

  /* Your username: shown to the owner in the admin panel and usable for
     granting premium. Any signed-in user can set or change their own. */
  var unameCard = el('div', 'acct-card');
  unameCard.appendChild(el('h3', null, 'Your username'));
  unameCard.appendChild(el('p', null, currentUsername
    ? 'Your username is ' + currentUsername + '. The owner can grant you premium with it, and it shows in the admin users list.'
    : 'No username set yet. Pick one (3-20 letters, numbers or _) so the owner can find you by username as well as by email.'));
  var unameInput = el('input', 'field'); unameInput.type = 'text';
  unameInput.placeholder = 'Username (3-20 letters, numbers, _)'; unameInput.maxLength = 20;
  unameInput.value = currentUsername || '';
  var unameMsg = el('p', 'help-text'); unameMsg.style.display = 'none';
  var unameBtn = el('button', 'btn btn-yellow btn-block', 'Save username');
  unameBtn.addEventListener('click', async function () {
    var check = validateUsername(unameInput.value);
    if (!check.ok) { unameMsg.textContent = check.reason; unameMsg.style.display = ''; return; }
    unameBtn.disabled = true;
    var upRes = await sb.from('profiles').update({ username: check.value }).eq('id', currentUser.id);
    unameBtn.disabled = false;
    if (upRes.error) {
      var uMsg = upRes.error.message || '';
      if (upRes.error.code === '23505' || /duplicate/i.test(uMsg)) uMsg = 'That username is taken — try another.';
      unameMsg.textContent = uMsg; unameMsg.style.display = ''; toast(uMsg);
      return;
    }
    currentUsername = check.value;
    toast('Username saved.');
    renderAccount();
  });
  unameCard.appendChild(unameInput); unameCard.appendChild(unameBtn); unameCard.appendChild(unameMsg);
  box.appendChild(unameCard);

  /* Change password while signed in — this is how the owner sets a
     password after arriving from a confirmation-link session. */
  var pwCard = el('div', 'acct-card');
  pwCard.appendChild(el('h3', null, 'Change password'));
  pwCard.appendChild(el('p', null, 'Set a new password for this account. You stay signed in.'));
  var pwNew = el('input', 'field'); pwNew.type = 'password'; pwNew.placeholder = 'New password (min 6 characters)';
  var pwNew2 = el('input', 'field'); pwNew2.type = 'password'; pwNew2.placeholder = 'Repeat new password';
  var pwMsg = el('p', 'help-text'); pwMsg.style.display = 'none';
  var pwBtn = el('button', 'btn btn-yellow btn-block', 'Change password');
  pwBtn.addEventListener('click', async function () {
    if (!pwNew.value || pwNew.value.length < 6) { pwMsg.textContent = 'Password must be at least 6 characters.'; pwMsg.style.display = ''; return; }
    if (pwNew.value !== pwNew2.value) { pwMsg.textContent = 'The two passwords do not match.'; pwMsg.style.display = ''; return; }
    pwBtn.disabled = true;
    var pwRes = await sb.auth.updateUser({ password: pwNew.value });
    pwBtn.disabled = false;
    if (pwRes.error) { pwMsg.textContent = pwRes.error.message; pwMsg.style.display = ''; toast(pwRes.error.message); return; }
    pwNew.value = ''; pwNew2.value = '';
    toast('Password changed.');
    pwMsg.textContent = 'Password changed. Use the new password next time you sign in.'; pwMsg.style.display = '';
  });
  pwCard.appendChild(pwNew); pwCard.appendChild(pwNew2); pwCard.appendChild(pwBtn); pwCard.appendChild(pwMsg);
  box.appendChild(pwCard);

  if (isAdmin) renderAdminPanel(box);
}

/* Build one admin user row (email/username, subscription state, Grant and
   Revoke buttons). Emails and usernames are rendered as TEXT, never as
   HTML: a profile email is user-controlled data, and innerHTML here used
   to be a stored-XSS hole into the owner's session. */
function adminUserRow(u, subByUser) {
  var row = el('div', 'user-row');
  var sub = subByUser[u.id];
  var active = sub && new Date(sub.expires_at) > new Date();
  var label = u.email + (u.username ? ' (' + u.username + ')' : '') + (u.is_admin ? ' (admin)' : '');
  row.appendChild(el('span', 'u-email', label));
  row.appendChild(el('span', 'u-sub', active ? 'Active to ' + fmtDate(sub.expires_at) : 'No active sub'));
  var grantBtn = el('button', 'btn btn-yellow', 'Grant premium');
  grantBtn.addEventListener('click', async function () {
    var res = await sb.from('subscriptions').upsert({
      user_id: u.id,
      expires_at: endOfCurrentMonth().toISOString(),
      status: 'active',
      granted_by: currentUser.id
    }, { onConflict: 'user_id' });
    if (res.error) { toast('Grant failed: ' + res.error.message); return; }
    toast('Premium granted to ' + u.email + '.');
    renderAccount();
  });
  var revokeBtn = el('button', 'btn btn-ghost', 'Revoke premium');
  revokeBtn.addEventListener('click', async function () {
    var res = await sb.from('subscriptions').update({ status: 'revoked' }).eq('user_id', u.id).eq('status', 'active');
    if (res.error) { toast('Revoke failed: ' + res.error.message); return; }
    toast('Premium revoked for ' + u.email + '.');
    renderAccount();
  });
  row.appendChild(grantBtn);
  row.appendChild(revokeBtn);
  return row;
}

async function renderAdminPanel(box) {
  var card = el('div', 'acct-card');
  card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3><p>Grant premium to any user from your own account. A grant lasts until the end of the current calendar month. Revoking blocks the whole app for that user immediately.</p><p class="help-text">Loading users…</p>';
  box.appendChild(card);
  try {
    var profs = await sb.from('profiles').select('id, email, username, is_admin').order('email');
    var subs = await sb.from('subscriptions').select('user_id, expires_at, status').eq('status', 'active');
    if (profs.error) throw new Error(profs.error.message);
    var subByUser = {};
    (subs.data || []).forEach(function (s) {
      if (!subByUser[s.user_id] || new Date(s.expires_at) > new Date(subByUser[s.user_id].expires_at)) {
        subByUser[s.user_id] = s;
      }
    });
    var users = profs.data || [];
    card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3><p>Grant premium to any user from your own account. A grant lasts until the end of the current calendar month. Revoking blocks the whole app for that user immediately.</p>' +
      '<p class="help-text">Total registered users: ' + users.length + '</p>';
    /* Find one user by exact email OR exact username (case-insensitive)
       and grant/revoke for just that user — no need to scroll the list. */
    var searchRow = el('div', 'admin-search');
    var searchInput = el('input', 'field'); searchInput.type = 'text';
    searchInput.placeholder = 'Find user by email or username';
    var searchBtn = el('button', 'btn btn-yellow', 'Find user');
    var searchMsg = el('p', 'help-text'); searchMsg.style.display = 'none';
    var searchResult = el('div');
    searchBtn.addEventListener('click', function () {
      var q = searchInput.value.trim().toLowerCase();
      searchResult.innerHTML = '';
      if (!q) { searchMsg.textContent = 'Type an email or a username first.'; searchMsg.style.display = ''; return; }
      var found = users.filter(function (u) {
        return (u.email && u.email.toLowerCase() === q) ||
          (u.username && u.username.toLowerCase() === q);
      });
      if (!found.length) { searchMsg.textContent = 'No user found for "' + searchInput.value.trim() + '".'; searchMsg.style.display = ''; return; }
      searchMsg.style.display = 'none';
      found.forEach(function (u) { searchResult.appendChild(adminUserRow(u, subByUser)); });
    });
    searchRow.appendChild(searchInput); searchRow.appendChild(searchBtn);
    card.appendChild(searchRow); card.appendChild(searchMsg); card.appendChild(searchResult);
    if (!users.length) {
      card.appendChild(el('p', 'help-text', 'No users found.'));
      return;
    }
    users.forEach(function (u) { card.appendChild(adminUserRow(u, subByUser)); });
  } catch (e) {
    card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3>';
    card.appendChild(el('p', 'help-text', 'Could not load users: ' + e.message +
      '. Make sure profiles.is_admin = true for your account (see README.md).'));
  }
}

async function afterAuth() {
  authLinkError = null;
  await refreshSession();
  discardStaleRaceCache();
  await syncRacesFromCloud();
  renderAccount();
  renderPrediction();
  renderRaceList();
  applyTabLocks();
  maybeSubscribeLiveBets();
}

/* ============================================================================
   Init
   ========================================================================== */

function init() {
  if (typeof document === 'undefined') return;
  /* An expired/used auth link leaves its error in the URL hash — parse it
     now so the Account tab can explain it, and drop the hash. */
  authLinkError = parseAuthHashError();
  if (authLinkError) clearAuthHash();
  races = loadLocalRaces();
  speeds = loadLocalSpeeds();
  /* Restore the wizard's last run (if any) before the first renders, so
     a pending feedback survives a reload. */
  loadWizardState();
  initSupabase();
  if (DEMO_MODE) {
    var banner = $('demoBanner');
    if (banner) banner.classList.remove('hidden');
    subActive = true;
  }
  if (sbLoadFailed) {
    var banner2 = $('demoBanner');
    if (banner2) {
      banner2.textContent = 'Could not reach the login server — check your connection and reload.';
      banner2.classList.remove('hidden');
    }
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  renderPredictVehicles();
  renderPredictSeg(1);
  renderPredictSeg(2);
  renderPredictSeg(3);
  renderPrediction();
  renderFeedback();
  renderLogForm();
  renderRaceList();
  renderStats();
  renderSpeedTable();
  renderTimer();
  /* Running version, on screen: a cached old deploy is visible at a
     glance instead of silent (the user opened his tab right as v20
     deployed and may still have been on v19). */
  var verEl = $('appVersion');
  if (verEl) verEl.textContent = APP_VERSION;
  setLiveBadge();
  updateLiveFreshness();
  setInterval(updateLiveFreshness, 1000); // the freshness age ticks live
  /* lrp-v21: a tab that sat hidden (or offline) may hold a dead socket
     — the moment it shows again (or the network returns), heal the
     subscription and re-fetch, so a live bet is never missed for a
     stale tab. */
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { ensureLiveSubscription(Date.now()); fetchLatestLiveBet(); }
  });
  window.addEventListener('online', function () {
    ensureLiveSubscription(Date.now()); fetchLatestLiveBet();
  });
  showWizardStep(wizard.step);

  $('timerBtn').addEventListener('click', startTimer);
  var liveToggle = $('liveToggle');
  if (liveToggle) {
    liveToggle.checked = liveEnabled;
    liveToggle.addEventListener('change', function (e) { setLiveEnabled(e.target.checked); });
  }
  $('startBtn').addEventListener('click', startWithLiveBet);
  $('toPinBtn').addEventListener('click', function () { showWizardStep(2); });
  $('backToStartBtn').addEventListener('click', function () { showWizardStep(0); });
  $('backToPickBtn').addEventListener('click', function () { showWizardStep(1); });
  $('runBtn').addEventListener('click', runPrediction);
  $('newPredBtn').addEventListener('click', resetPrediction);
  /* Feedback buttons: ONE delegated listener on the box, not three
     direct bindings. Direct bindings die silently when the buttons are
     re-created or when an older cached app.js runs against newer HTML —
     the exact failure the user hit: visible buttons that did nothing.
     Delegation survives re-renders, and the guard inside answerFeedback
     makes double taps harmless. */
  var fbBox = $('feedbackBox');
  if (fbBox) {
    fbBox.addEventListener('click', function (e) {
      var t = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!t) return;
      if (t.id === 'fbHighBtn') answerFeedback(1);
      else if (t.id === 'fbMidBtn') answerFeedback(2);
      else if (t.id === 'fbJackpotBtn') answerFeedback(3);
    });
  }
  $('saveRaceBtn').addEventListener('click', saveRace);
  $('cancelEditBtn').addEventListener('click', function () { resetLogForm(); });
  $('logHowText').addEventListener('input', function (e) { logForm.howWonText = e.target.value; });
  $('exportCsvBtn').addEventListener('click', downloadCsv);
  $('importCsvInput').addEventListener('change', function (e) {
    var f = e.target.files && e.target.files[0];
    if (f) importCsv(f);
    e.target.value = '';
  });
  $('saveSpeedsBtn').addEventListener('click', saveSpeeds);
  $('resetSpeedsBtn').addEventListener('click', function () {
    speeds = cloneSpeeds(DEFAULT_SPEEDS);
    saveLocalSpeeds();
    renderSpeedTable();
    renderPrediction();
    toast('Speeds reset to game defaults.');
  });

  // Supabase mode: restore session, then sync races.
  (async function () {
    await refreshSession();
    /* The login service may have left an access token in the URL hash
       (confirmation/recovery link) — the session is stored now, so drop
       the hash before it can be copied or logged. */
    clearAuthHash();
    discardStaleRaceCache();
    await syncRacesFromCloud();
    renderAccount();
    renderPrediction();
    renderRaceList();
    renderStats();
    applyTabLocks();
    maybeSubscribeLiveBets();
  })();

  /* Re-check the subscription every 5 minutes while signed in: a grant
     made by the owner unlocks the app without a reload, and an expired
     subscription locks it again. Network errors keep the current state. */
  setInterval(async function () {
    if (!sb || !currentUser || isAdmin || DEMO_MODE) return;
    await checkSubscription();
    applyTabLocks();
    renderPrediction();
  }, 5 * 60 * 1000);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}

/* Node export for testing (node --check + prediction unit test). */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    VEHICLES: VEHICLES,
    TRACKS: TRACKS,
    DEFAULT_SPEEDS: DEFAULT_SPEEDS,
    UNKNOWN_TRACK: UNKNOWN_TRACK,
    normalizeTracksForSave: normalizeTracksForSave,
    isDuplicateRace: isDuplicateRace,
    isValidRaceTracks: isValidRaceTracks,
    computePrediction: computePrediction,
    dataOnlyRank: dataOnlyRank,
    DATA_ONLY_MIN_MATCHES: DATA_ONLY_MIN_MATCHES,
    DATA_ONLY_ALPHA: DATA_ONLY_ALPHA,
    buildDataReason: buildDataReason,
    blendedRank: blendedRank,
    speedShares: speedShares,
    buildBlendReason: buildBlendReason,
    V22_SPEED_WEIGHT: V22_SPEED_WEIGHT,
    applyConfidenceGuard: applyConfidenceGuard,
    segmentDistribution: segmentDistribution,
    historicalFreq: historicalFreq,
    pinnedSegments: pinnedSegments,
    applySinglePin: applySinglePin,
    pinSegment: pinSegment,
    oneTrackHints: oneTrackHints,
    decayWeight: decayWeight,
    historyHalfLife: historyHalfLife,
    historyBlendWeight: historyBlendWeight,
    buildFeedbackRace: buildFeedbackRace,
    repeatHistoryNote: repeatHistoryNote,
    rankName: rankName,
    suggestionLine: suggestionLine,
    answerFeedback: answerFeedback,
    wizard: wizard,
    pred: pred,
    validateLiveBet: validateLiveBet,
    liveBetKey: liveBetKey,
    liveRowUpdatedAtMs: liveRowUpdatedAtMs,
    isNewLiveBet: isNewLiveBet,
    LIVE_NEW_BET_GAP_MS: LIVE_NEW_BET_GAP_MS,
    LIVE_TIMER_RESET_MIN: LIVE_TIMER_RESET_MIN,
    LIVE_TIMER_RESET_JUMP: LIVE_TIMER_RESET_JUMP,
    liveBetSegments: liveBetSegments,
    liveTimerSeconds: liveTimerSeconds,
    liveRemainingSeconds: liveRemainingSeconds,
    liveCountdownAt: liveCountdownAt,
    LIVE_LATE_SECONDS: LIVE_LATE_SECONDS,
    currentBetKey: currentBetKey,
    decideLiveBet: decideLiveBet,
    applyLiveBet: applyLiveBet,
    handleLiveBet: handleLiveBet,
    fetchLatestLiveBet: fetchLatestLiveBet,
    startLiveDecision: startLiveDecision,
    startWithLiveBet: startWithLiveBet,
    LIVE_STALE_MS: LIVE_STALE_MS,
    LIVE_START_WAIT_MS: LIVE_START_WAIT_MS,
    liveBetStatus: liveBetStatus,
    liveBetStatusText: liveBetStatusText,
    liveFreshnessText: liveFreshnessText,
    liveRowSummary: liveRowSummary,
    formatAgeSeconds: formatAgeSeconds,
    APP_VERSION: APP_VERSION,
    LIVE_POLL_MS: LIVE_POLL_MS,
    LIVE_RESUBSCRIBE_ZOMBIE_MS: LIVE_RESUBSCRIBE_ZOMBIE_MS,
    liveBackoffMs: liveBackoffMs,
    liveSubscriptionAction: liveSubscriptionAction,
    livePollTick: livePollTick,
    startLivePoll: startLivePoll,
    stopLivePoll: stopLivePoll,
    ensureLiveSubscription: ensureLiveSubscription,
    waitForLiveBet: waitForLiveBet,
    notifyLiveWaiters: notifyLiveWaiters,
    rankOfWinner: rankOfWinner,
    hintsFromTracks: hintsFromTracks,
    isScribdRace: isScribdRace,
    feedbackForRank: feedbackForRank,
    migrateFeedback: migrateFeedback,
    jackpotStreakNote: jackpotStreakNote,
    predictionAccuracy: predictionAccuracy,
    oddsBlendWeight: oddsBlendWeight,
    segmentLengths: segmentLengths,
    resolveVehicleName: resolveVehicleName,
    resolveTrackName: resolveTrackName,
    importCsv: importCsv,
    buildReason: buildReason,
    appAccessFor: appAccessFor,
    isFreeWindowActive: isFreeWindowActive,
    whatsappBuyMessage: whatsappBuyMessage,
    whatsappBuyUrl: whatsappBuyUrl,
    buyPremiumHtml: buyPremiumHtml,
    validateUsername: validateUsername,
    lockedHtml: lockedHtml
  };
}
