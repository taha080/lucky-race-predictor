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
       (a) user-pinned track          -> 1.0 for that track
       (b) user-hinted track + chance p (10/20/30/50/70/90%)
                                        -> hinted track gets p, the rest
                                           (1-p) is shared over the other 5
                                           tracks by historical frequency
       (c) historical frequency of that track for that segment position,
           learned from saved races, conditioned on the segments that ARE
           known (pinned) — "unknown" entries in saved races are ignored
       (d) equal probability (1/6) when there is no data at all
     IMPORTANT: a hint is a LIKELIHOOD, never a certainty. Patterns change
     every round — never assume a fixed daily pattern. The model relearns
     from every newly saved race.
   - HISTORY BLEND: when 150+ races are saved, blend the speed model with
     the actual win rate for the same 3-vehicle set + the same known
     (pinned) segments.
       w = clamp((N_total - 150) / 350, 0, 0.5)
     applied only if >= 5 saved races match that exact set + known segments.
       P_final = (1 - w) * P_model + w * P_hist
   - ONE-TRACK RULE: the game shows exactly ONE track before the bet, so
     at most ONE segment may be pinned (Pin 100%). Pinning a second
     segment unpins the first; the other two stay Unknown. Hints (a
     likelihood, not a certainty) on unknown segments are still allowed.
     The engine enforces this too: if the input somehow carries two or
     three pins, only the first (lowest index) is kept and the others are
     treated as Unknown.
   ========================================================================== */

'use strict';

/* ---------------- Static game data (from the game screenshots) ------------ */

var TRACKS = ['Expressway', 'Highway', 'Desert', 'Bumpy', 'Potholes', 'Dirt'];

var VEHICLES = [
  { name: 'ORV',           winRate: 42.1, odds: 2.3, color: '#8a9a3b', glyph: 'car' },
  { name: 'Monster Truck', winRate: 41.7, odds: 2.4, color: '#2e9e4f', glyph: 'big' },
  { name: 'SUV',           winRate: 37.1, odds: 2.6, color: '#8e44ad', glyph: 'car' },
  { name: 'Stock Car',     winRate: 36.7, odds: 2.7, color: '#e67e22', glyph: 'car' },
  { name: 'Car',           winRate: 36.6, odds: 2.7, color: '#e84393', glyph: 'car' },
  { name: 'ATV',           winRate: 30.0, odds: 3.3, color: '#e74c3c', glyph: 'car' },
  { name: 'Motorcycle',    winRate: 29.0, odds: 3.4, color: '#27ae60', glyph: 'bike' },
  { name: 'Sports Car',    winRate: 26.3, odds: 3.7, color: '#2980b9', glyph: 'car' },
  { name: 'Supercar',      winRate: 19.8, odds: 5.0, color: '#bdc3c7', glyph: 'car' }
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

var CHANCE_OPTIONS = [100, 90, 70, 50, 30, 20, 10]; // 100 = pinned
var HISTORY_BLEND_MIN_TOTAL = 150;   // start blending at 150 saved races
var HISTORY_BLEND_MIN_MATCHES = 5;   // need >= 5 races of the same set + seg1

/* ---------------- Config / environment ------------------------------------ */

var CONFIG = (typeof window !== 'undefined' && window.LRP_CONFIG) ? window.LRP_CONFIG : {};
var DEMO_MODE = !CONFIG.SUPABASE_URL || CONFIG.SUPABASE_URL.indexOf('YOUR_') === 0;

var sb = null;          // Supabase client (null in demo mode)
var currentUser = null; // { id, email } when signed in (Supabase mode)
var isAdmin = false;
var subActive = false;  // active subscription? (demo mode: always true)
var subExpiresAt = null;

/* ---------------- Local state ---------------------------------------------- */

var races = [];         // saved races: {id, vehicles[3], tracks[3], patterns[], winner, how_won, how_won_text, odds{}, created_at}
var speeds = cloneSpeeds(DEFAULT_SPEEDS);

var pred = {           // Predict tab state
  vehicles: [],        // up to 3 names
  // All three segments behave the same: { mode, track, chance }.
  // mode: unknown|hint|pin. Default is Unknown for every segment — never
  // pre-select or auto-fill a track, including segment 1.
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

/* Core prediction. Returns { ranked: [{vehicle, prob, modelProb}], dist1, dist2, dist3, histInfo } */
function computePrediction(input) {
  var vehicles = input.vehicles;
  var speedsMap = input.speeds;
  var raceList = input.races || [];
  var hints = oneTrackHints([input.seg1Hint, input.seg2Hint, input.seg3Hint]);
  var knownSegs = pinnedSegments(hints);
  var segLen = segmentLengths();

  var dists = hints.map(function (h, i) { return segmentDistribution(i, knownSegs, h, raceList); });

  var probs = {};
  vehicles.forEach(function (v) { probs[v] = 0; });

  // Enumerate all track combos (up to 6x6x6), weighted by P(t1)*P(t2)*P(t3).
  // A pinned segment is a point mass, so it contributes only its one track.
  TRACKS.forEach(function (t1) {
    TRACKS.forEach(function (t2) {
      TRACKS.forEach(function (t3) {
        var combo = [t1, t2, t3];
        var w = combo.reduce(function (acc, t, i) { return acc * (dists[i][t] || 0); }, 1);
        if (w <= 0) return;
        var times = vehicles.map(function (v) {
          return segLen[0] / speedsMap[v][combo[0]] + segLen[1] / speedsMap[v][combo[1]] + segLen[2] / speedsMap[v][combo[2]];
        });
        var min = Math.min.apply(null, times);
        var winners = [];
        times.forEach(function (t, i) { if (t === min) winners.push(i); });
        winners.forEach(function (i) { probs[vehicles[i]] += w / winners.length; });
      });
    });
  });

  // History blend (only with plenty of data and enough exact matches).
  // Matches share the same 3-vehicle set AND the same known (pinned) segments.
  // No pinned segment is required — with none pinned, any race with the
  // same vehicle set matches.
  var blended = {};
  vehicles.forEach(function (v) { blended[v] = probs[v]; });
  var histInfo = null;
  var N = raceList.length;
  if (N >= HISTORY_BLEND_MIN_TOTAL) {
    var setKey = vehicles.slice().sort().join('|');
    var knownKeys = Object.keys(knownSegs);
    var matches = [];
    raceList.forEach(function (r, i) {
      if (r.tracks && r.vehicles && r.vehicles.slice().sort().join('|') === setKey &&
          knownKeys.every(function (k) { return r.tracks[k] === knownSegs[k]; })) {
        matches.push({ race: r, weight: decayWeight(i, historyHalfLife()) });
      }
    });
    if (matches.length >= HISTORY_BLEND_MIN_MATCHES) {
      var w = clamp((N - HISTORY_BLEND_MIN_TOTAL) / 350, 0, 0.5);
      var histCounts = {};
      var histTotal = 0;
      vehicles.forEach(function (v) { histCounts[v] = 0; });
      matches.forEach(function (m) {
        if (histCounts[m.race.winner] !== undefined) {
          histCounts[m.race.winner] += m.weight;
          histTotal += m.weight;
        }
      });
      vehicles.forEach(function (v) {
        var hp = histTotal > 0 ? histCounts[v] / histTotal : 0;
        blended[v] = (1 - w) * probs[v] + w * hp;
      });
      histInfo = { matches: matches.length, weight: w, total: N };
    }
  }

  var ranked = vehicles.map(function (v) {
    return { vehicle: v, prob: blended[v], modelProb: probs[v] };
  }).sort(function (a, b) { return b.prob - a.prob; });

  return { ranked: ranked, dist1: dists[0], dist2: dists[1], dist3: dists[2], histInfo: histInfo };
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
function saveLocalRaces() { lsSet(LS_RACES, JSON.stringify(races)); }
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
    console.warn('Supabase JS not loaded — running in demo mode.');
    DEMO_MODE = true;
    return;
  }
  sb = window.supabase.createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);
}

async function refreshSession() {
  if (!sb) { subActive = true; return; } // demo mode: predictions unlocked
  var res = await sb.auth.getSession();
  var session = res && res.data ? res.data.session : null;
  currentUser = session ? session.user : null;
  if (!currentUser) { subActive = false; isAdmin = false; return; }
  await checkAdmin();
  await checkSubscription();
}

async function checkAdmin() {
  isAdmin = false;
  if (!currentUser) return;
  if ((CONFIG.ADMIN_EMAILS || []).indexOf(currentUser.email) !== -1) isAdmin = true;
  try {
    var res = await sb.from('profiles').select('is_admin').eq('id', currentUser.id).maybeSingle();
    if (res && res.data && res.data.is_admin) isAdmin = true;
  } catch (e) { /* profiles table may not exist yet — config list still works for UI */ }
}

async function checkSubscription() {
  subActive = false;
  subExpiresAt = null;
  if (!currentUser) return;
  try {
    var res = await sb.from('subscriptions')
      .select('expires_at')
      .eq('user_id', currentUser.id)
      .eq('status', 'active')
      .gt('expires_at', new Date().toISOString())
      .order('expires_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (res && res.data) {
      subActive = true;
      subExpiresAt = res.data.expires_at;
    }
  } catch (e) { /* subscriptions table missing — treat as no subscription */ }
}

/* Races: Supabase is the source of truth when signed in; localStorage is cache. */
async function syncRacesFromCloud() {
  if (!sb || !currentUser) return;
  try {
    var res = await sb.from('races')
      .select('*')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false });
    if (res.error) { console.warn('Race sync failed:', res.error.message); return; }
    races = (res.data || []).map(function (r) {
      return {
        id: r.id, vehicles: r.vehicles, tracks: r.tracks, patterns: r.patterns || [],
        winner: r.winner, how_won: r.how_won, how_won_text: r.how_won_text || '',
        odds: r.odds || {}, created_at: r.created_at
      };
    });
    saveLocalRaces();
  } catch (e) { console.warn('Race sync failed:', e); }
}

async function cloudInsertRace(race) {
  if (!sb || !currentUser) return null;
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
  var res = await sb.from('races').update({
    vehicles: race.vehicles, tracks: race.tracks, patterns: race.patterns,
    winner: race.winner, how_won: race.how_won, how_won_text: race.how_won_text,
    odds: race.odds
  }).eq('id', race.id).eq('user_id', currentUser.id);
  return !res.error;
}
async function cloudDeleteRace(id) {
  if (!sb || !currentUser) return false;
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
  applyTabLocks();
  window.scrollTo(0, 0);
}

function glyphHtml(v) {
  return '<div class="glyph ' + v.glyph + '" style="--c:' + v.color + '">' +
    '<i class="body"></i><i class="cab"></i><i class="bar"></i><i class="w1"></i><i class="w2"></i></div>';
}

/* ============================================================================
   UI — Predict tab
   ========================================================================== */

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
}

function togglePredictVehicle(name) {
  var i = pred.vehicles.indexOf(name);
  if (i !== -1) {
    pred.vehicles.splice(i, 1);
    delete pred.odds[name];
  } else {
    if (pred.vehicles.length >= 3) { toast('Only 3 vehicles per round.'); return; }
    pred.vehicles.push(name);
    pred.odds[name] = vehicleByName(name).odds;
  }
  renderPredictVehicles();
  renderOddsBox();
  renderPrediction();
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
   same): tap a track to hint it (50% by default — change the chance or pin
   it with the chips below), tap "? Unknown" to leave it unknown. */
function renderPredictSeg(segNum) {
  var state = pred['seg' + segNum];
  var rowId = 'seg' + segNum + 'Tracks';
  var chanceId = 'seg' + segNum + 'Chance';
  renderTrackRow(rowId, state.mode === 'unknown' ? null : state.track, function (t) {
    if (t === null) {
      state.mode = 'unknown'; state.track = null;
    } else {
      // Tapping a track makes it a hint at the default 50% chance.
      // The user can change the chance (or pin it) with the chips below.
      state.mode = 'hint'; state.track = t;
      if (!state.chance) state.chance = 50;
    }
    renderPredictSeg(segNum);
    renderPrediction();
  }, true);

  var chanceRow = $(chanceId);
  chanceRow.innerHTML = '';
  if (state.mode === 'hint' || state.mode === 'pin') {
    chanceRow.classList.remove('hidden');
    chanceRow.appendChild(el('div', 'chance-label',
      'How likely is ' + state.track + ' on segment ' + segNum + '? (a hint is a likelihood, never a certainty)'));
    CHANCE_OPTIONS.forEach(function (c) {
      var isSel = (c === 100 && state.mode === 'pin') || (c !== 100 && state.mode === 'hint' && state.chance === c);
      var chip = el('button', 'chance-chip' + (isSel ? ' selected' : ''), c === 100 ? 'Pin 100%' : c + '%');
      chip.addEventListener('click', function () {
        if (c === 100) {
          state.mode = 'pin';
          // ONE-TRACK RULE: pinning this segment unpins any other pinned
          // segment — re-render all three boxes so the change shows.
          pinSegment(segNum);
          renderPredictSeg(1); renderPredictSeg(2); renderPredictSeg(3);
        } else {
          state.mode = 'hint'; state.chance = c;
          renderPredictSeg(segNum);
        }
        renderPrediction();
      });
      chanceRow.appendChild(chip);
    });
  } else {
    chanceRow.classList.add('hidden');
  }
}

/* One-tap reset: all three segment boxes back to Unknown. */
function resetSegments() {
  [1, 2, 3].forEach(function (n) {
    pred['seg' + n] = { mode: 'unknown', track: null, chance: 50 };
    renderPredictSeg(n);
  });
  renderPrediction();
}

function renderOddsBox() {
  var box = $('oddsBox');
  var rows = $('oddsRows');
  rows.innerHTML = '';
  if (pred.vehicles.length === 0) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  pred.vehicles.forEach(function (name) {
    var row = el('div', 'odds-row');
    row.appendChild(el('span', 'odds-name', name));
    var minus = el('button', 'stepper', '−');
    var val = el('span', 'odds-val', (pred.odds[name] || 0).toFixed(1));
    var plus = el('button', 'stepper', '+');
    minus.addEventListener('click', function () {
      pred.odds[name] = Math.max(1.0, Math.round(((pred.odds[name] || 2) - 0.1) * 10) / 10);
      renderOddsBox();
    });
    plus.addEventListener('click', function () {
      pred.odds[name] = Math.min(20, Math.round(((pred.odds[name] || 2) + 0.1) * 10) / 10);
      renderOddsBox();
    });
    row.appendChild(minus); row.appendChild(val); row.appendChild(plus);
    rows.appendChild(row);
  });
}

/* Full-app premium gate.
   Who can use the software:
   - Demo mode (Supabase unconfigured): everyone, predictions unlocked.
   - Admins / owner (ADMIN_EMAILS in js/config.js or profiles.is_admin):
     PERMANENT access. The owner NEVER needs a subscription — the bypass
     is by admin/owner status, never by a subscription row (an admin's
     subscription row, if one exists, is irrelevant to their own access).
   - Everyone else: an active subscription is required to use any tab.
   Pure core (appAccessFor) is unit-tested in Node; appAccess() reads the
   live session state. Returns { ok: true } or
   { ok: false, reason: 'signin' | 'premium' }. */
function appAccessFor(s) {
  if (s.demo) return { ok: true };
  if (!s.user) return { ok: false, reason: 'signin' };
  if (s.admin) return { ok: true };
  if (s.sub) return { ok: true };
  return { ok: false, reason: 'premium' };
}
function appAccess() {
  return appAccessFor({ demo: DEMO_MODE, admin: isAdmin, user: currentUser, sub: subActive });
}
function lockedHtml(reason) {
  return '<div class="locked-panel"><h3>Premium required</h3>' +
    (reason === 'signin'
      ? '<p>Sign in from the Account tab to use this app.</p>'
      : '<p>This app is for premium users only. Subscriptions end at the end of each calendar month. Ask the owner to grant you premium from his account.</p>') +
    '<button class="btn btn-yellow goto-account-btn">Go to Account</button></div>';
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
      var go = overlay.querySelector('.goto-account-btn');
      if (go) go.addEventListener('click', function () { showTab('account'); });
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

  var gate = predictionAllowed();
  if (!gate.ok) {
    panel.innerHTML = lockedHtml(gate.reason);
    var go = panel.querySelector('.goto-account-btn');
    if (go) go.addEventListener('click', function () { showTab('account'); });
    return;
  }

  if (pred.vehicles.length !== 3) {
    panel.innerHTML = '<p class="result-empty">Pick 3 vehicles to see the prediction.</p>';
    return;
  }

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
  var ms = Math.max(0, Math.round(t1 - t0));

  var knownSegs = pinnedSegments([pred.seg1, pred.seg2, pred.seg3]);
  var knownParts = [];
  Object.keys(knownSegs).forEach(function (k) {
    knownParts.push('Seg ' + (parseInt(k, 10) + 1) + ' ' + knownSegs[k]);
  });
  var top = result.ranked.slice(0, 2);
  var html = '<div class="result-title">Top picks' +
    (knownParts.length ? ' — known: ' + knownParts.join(', ') : ' — all segments unknown') + '</div>';
  top.forEach(function (r, idx) {
    var others = pred.vehicles.filter(function (v) { return v !== r.vehicle; });
    var reason = buildReason(r.vehicle, others, knownSegs, [result.dist1, result.dist2, result.dist3], speeds);
    var pct = Math.round(r.prob * 100);
    var oddsTxt = pred.odds[r.vehicle] ? ' · Odds ' + pred.odds[r.vehicle].toFixed(1) : '';
    // #1 is the MAIN PICK (big, highlighted); #2 is the smaller BACKUP PICK.
    var isMain = idx === 0;
    var label = isMain ? 'MAIN PICK' : 'BACKUP PICK';
    html += '<div class="result-card rank-' + (idx + 1) + (isMain ? ' main-pick' : ' backup-pick') + '">' +
      '<div class="result-label">' + label + '</div>' +
      '<div class="result-head"><span class="result-name">' + r.vehicle + '</span>' +
      '<span class="result-conf">' + pct + '%</span></div>' +
      '<div class="conf-bar"><div class="conf-fill" style="width:' + pct + '%"></div></div>' +
      '<div class="result-reason">' + reason + oddsTxt + '</div></div>';
  });
  var third = result.ranked[2];
  html += '<div class="result-foot">3rd: ' + third.vehicle + ' — ' + Math.round(third.prob * 100) + '%' +
    (result.histInfo ? ' · blended with history (' + result.histInfo.matches + ' matching races, weight ' +
      Math.round(result.histInfo.weight * 100) + '%)' : '') +
    ' · computed in ' + ms + ' ms</div>';
  panel.innerHTML = html;

  line.textContent = 'Assumed tracks — Seg 1: ' + formatDist(result.dist1) +
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
    minus.addEventListener('click', function () {
      logForm.odds[name] = Math.max(1.0, Math.round(((logForm.odds[name] || 2) - 0.1) * 10) / 10);
      renderLogOdds();
    });
    plus.addEventListener('click', function () {
      logForm.odds[name] = Math.min(20, Math.round(((logForm.odds[name] || 2) + 0.1) * 10) / 10);
      renderLogOdds();
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
    line1.innerHTML = '<b>' + r.winner + '</b> won — ' + r.vehicles.join(' vs ');
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
    '<div class="stat-chip"><div class="num">' + (s.total >= 150 ? 'ON' : 'OFF') + '</div><div class="lbl">History blend (150+)</div></div>' +
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
      how_won_text: (c[idx.how_won_text] || '').trim(),
      odds: {},
      created_at: (c[idx.created_at] || '').trim() || new Date().toISOString()
    };
    // Duplicate rows are skipped and counted, like invalid rows — a race
    // already in the dataset is never added twice (also catches a
    // duplicate row earlier in the same file, since `races` grows as
    // rows are imported).
    if (isDuplicateRace(race, races)) { skipped += 1; continue; }
    try { race.odds = JSON.parse(c[idx.odds] || '{}'); } catch (e) { race.odds = {}; }
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
      html += '<td><input type="number" min="1" max="999" step="1" value="' + speeds[v.name][t] +
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

  if (!currentUser) {
    var auth = el('div', 'acct-card');
    auth.innerHTML = '<h3>Sign in</h3><p>Predictions need an account with an active subscription.</p>';
    var email = el('input', 'field'); email.type = 'email'; email.placeholder = 'Email'; email.id = 'authEmail';
    var pass = el('input', 'field'); pass.type = 'password'; pass.placeholder = 'Password (min 6 characters)'; pass.id = 'authPass';
    var inBtn = el('button', 'btn btn-yellow btn-block', 'Sign in');
    var upBtn = el('button', 'btn btn-ghost btn-block', 'Create account');
    inBtn.addEventListener('click', async function () {
      var res = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
      if (res.error) { toast(res.error.message); return; }
      await afterAuth();
    });
    upBtn.addEventListener('click', async function () {
      var res = await sb.auth.signUp({ email: email.value.trim(), password: pass.value });
      if (res.error) { toast(res.error.message); return; }
      toast('Account created. Please sign in.');
      await afterAuth();
    });
    auth.appendChild(email); auth.appendChild(pass); auth.appendChild(inBtn); auth.appendChild(upBtn);
    box.appendChild(auth);
    return;
  }

  /* Owner profile: a distinct card at the top of the Account tab for the
     admin/owner, with his email and an OWNER badge. His access is
     permanent — he never needs a subscription. */
  if (isAdmin) {
    var owner = el('div', 'acct-card owner-card');
    owner.innerHTML = '<h3><span class="owner-badge">OWNER</span> ' + currentUser.email + '</h3>' +
      '<p>Your access is permanent — as the owner you never need a subscription. ' +
      'Grant premium to anyone from the users list below. Only users with an active subscription can use this app.</p>';
    box.appendChild(owner);
  }

  var status = el('div', 'acct-card');
  status.innerHTML = '<h3>' + currentUser.email + '</h3>' +
    '<p>Subscription: ' + (subActive
      ? '<span class="sub-active">Active until ' + fmtDate(subExpiresAt) + '</span>'
      : (isAdmin
        ? '<span class="sub-active">Owner — permanent access, no subscription needed</span>'
        : '<span class="sub-expired">Expired / none</span> — subscriptions end at the end of each calendar month.')) + '</p>' +
    (isAdmin ? '<p>You are the owner of this app.</p>' : '');
  var outBtn = el('button', 'btn btn-ghost', 'Sign out');
  outBtn.addEventListener('click', async function () {
    await sb.auth.signOut();
    currentUser = null; subActive = false; isAdmin = false;
    races = loadLocalRaces();
    renderAccount();
    renderPrediction();
    applyTabLocks();
    toast('Signed out.');
  });
  status.appendChild(outBtn);
  box.appendChild(status);

  if (isAdmin) renderAdminPanel(box);
}

async function renderAdminPanel(box) {
  var card = el('div', 'acct-card');
  card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3><p>Grant premium to any user from your own account. A grant lasts until the end of the current calendar month. Revoking blocks the whole app for that user immediately.</p><p class="help-text">Loading users…</p>';
  box.appendChild(card);
  try {
    var profs = await sb.from('profiles').select('id, email, is_admin').order('email');
    var subs = await sb.from('subscriptions').select('user_id, expires_at, status').eq('status', 'active');
    if (profs.error) throw new Error(profs.error.message);
    var subByUser = {};
    (subs.data || []).forEach(function (s) {
      if (!subByUser[s.user_id] || new Date(s.expires_at) > new Date(subByUser[s.user_id].expires_at)) {
        subByUser[s.user_id] = s;
      }
    });
    card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3><p>Grant premium to any user from your own account. A grant lasts until the end of the current calendar month. Revoking blocks the whole app for that user immediately.</p>';
    if (!(profs.data || []).length) {
      card.appendChild(el('p', 'help-text', 'No users found.'));
      return;
    }
    (profs.data || []).forEach(function (u) {
      var row = el('div', 'user-row');
      var sub = subByUser[u.id];
      var active = sub && new Date(sub.expires_at) > new Date();
      row.innerHTML = '<span class="u-email">' + u.email + (u.is_admin ? ' (admin)' : '') + '</span>' +
        '<span class="u-sub">' + (active ? 'Active to ' + fmtDate(sub.expires_at) : 'No active sub') + '</span>';
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
      card.appendChild(row);
    });
  } catch (e) {
    card.innerHTML = '<h3>Grant premium — users &amp; subscriptions</h3><p class="help-text">Could not load users: ' + e.message +
      '. Make sure profiles.is_admin = true for your account (see README.md).</p>';
  }
}

async function afterAuth() {
  await refreshSession();
  await syncRacesFromCloud();
  renderAccount();
  renderPrediction();
  renderRaceList();
  applyTabLocks();
}

/* ============================================================================
   Init
   ========================================================================== */

function init() {
  if (typeof document === 'undefined') return;
  races = loadLocalRaces();
  speeds = loadLocalSpeeds();
  initSupabase();
  if (DEMO_MODE) {
    var banner = $('demoBanner');
    if (banner) banner.classList.remove('hidden');
    subActive = true;
  }

  document.querySelectorAll('.nav-btn').forEach(function (b) {
    b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
  });

  renderPredictVehicles();
  renderPredictSeg(1);
  renderPredictSeg(2);
  renderPredictSeg(3);
  renderOddsBox();
  renderPrediction();
  renderLogForm();
  renderRaceList();
  renderStats();
  renderSpeedTable();
  renderTimer();

  $('timerBtn').addEventListener('click', startTimer);
  $('resetSegsBtn').addEventListener('click', resetSegments);
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
    await syncRacesFromCloud();
    renderAccount();
    renderPrediction();
    renderRaceList();
    renderStats();
    applyTabLocks();
  })();
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
    segmentDistribution: segmentDistribution,
    historicalFreq: historicalFreq,
    pinnedSegments: pinnedSegments,
    applySinglePin: applySinglePin,
    pinSegment: pinSegment,
    oneTrackHints: oneTrackHints,
    decayWeight: decayWeight,
    historyHalfLife: historyHalfLife,
    segmentLengths: segmentLengths,
    resolveVehicleName: resolveVehicleName,
    resolveTrackName: resolveTrackName,
    importCsv: importCsv,
    buildReason: buildReason,
    appAccessFor: appAccessFor,
    lockedHtml: lockedHtml
  };
}
