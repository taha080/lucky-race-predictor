/* ============================================================================
   Lucky Race Predictor — app.js (vanilla JS, no build step)
   Prediction runs entirely in the browser (<100ms for 36 combos).
   ----------------------------------------------------------------------------
   PREDICTION MODEL (see README.md for the full description):
   - 3 segments, equal length. Time(v) = sum over segments of 1/speed[v][track].
   - Segment 1 track is known. Segments 2 & 3 are hidden: enumerate all 6x6
     track combos, weight each by P(t2) * P(t3), winner = lowest time
     (exact ties split the weight equally).
   - P(segment) comes from, in order:
       (a) user-pinned track          -> 1.0 for that track
       (b) user-hinted track + chance p (10/20/30/50/70/90%)
                                        -> hinted track gets p, the rest
                                           (1-p) is shared over the other 5
                                           tracks by historical frequency
       (c) historical frequency of that track for that segment position,
           given the first segment, learned from saved races
       (d) equal probability (1/6) when there is no data at all
     IMPORTANT: a hint is a LIKELIHOOD, never a certainty. Patterns change
     every round — never assume a fixed daily pattern. The model relearns
     from every newly saved race.
   - HISTORY BLEND: when 150+ races are saved, blend the speed model with
     the actual win rate for the same 3-vehicle set + first track.
       w = clamp((N_total - 150) / 350, 0, 0.5)
     applied only if >= 5 saved races match that exact set + first track.
       P_final = (1 - w) * P_model + w * P_hist
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
  seg1: null,
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

/* Historical frequency of a track type for a segment position (index 1 or 2),
   conditioned on the first segment's track. Falls back to all races for that
   position, then to equal probability (1/6) when there is no data. */
function historicalFreq(segIndex, seg1, raceList) {
  var dist = {};
  TRACKS.forEach(function (t) { dist[t] = 0; });
  var pool = raceList.filter(function (r) {
    return r.tracks && r.tracks[0] === seg1;
  });
  if (!pool.length) pool = raceList;
  if (!pool.length) {
    TRACKS.forEach(function (t) { dist[t] = 1 / TRACKS.length; });
    return dist;
  }
  pool.forEach(function (r) {
    var t = r.tracks[segIndex];
    if (dist[t] !== undefined) dist[t] += 1;
  });
  var total = pool.length;
  TRACKS.forEach(function (t) { dist[t] = dist[t] / total; });
  return dist;
}

/* Probability distribution over the 6 tracks for one hidden segment.
   hint = { mode: 'unknown' | 'hint' | 'pin', track, chance } */
function segmentDistribution(segIndex, seg1, hint, raceList) {
  if (hint && hint.mode === 'pin' && hint.track) {
    var pinned = {};
    TRACKS.forEach(function (t) { pinned[t] = (t === hint.track) ? 1 : 0; });
    return pinned;
  }
  var hist = historicalFreq(segIndex, seg1, raceList);
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

/* Core prediction. Returns { ranked: [{vehicle, prob, modelProb}], dist2, dist3, histInfo } */
function computePrediction(input) {
  var vehicles = input.vehicles;
  var seg1 = input.seg1;
  var speedsMap = input.speeds;
  var raceList = input.races || [];

  var d2 = segmentDistribution(1, seg1, input.seg2Hint, raceList);
  var d3 = segmentDistribution(2, seg1, input.seg3Hint, raceList);

  var probs = {};
  vehicles.forEach(function (v) { probs[v] = 0; });

  // Enumerate all 6x6 hidden-track combos, weighted by P(t2)*P(t3).
  TRACKS.forEach(function (t2) {
    TRACKS.forEach(function (t3) {
      var w = (d2[t2] || 0) * (d3[t3] || 0);
      if (w <= 0) return;
      var times = vehicles.map(function (v) {
        return 1 / speedsMap[v][seg1] + 1 / speedsMap[v][t2] + 1 / speedsMap[v][t3];
      });
      var min = Math.min.apply(null, times);
      var winners = [];
      times.forEach(function (t, i) { if (t === min) winners.push(i); });
      winners.forEach(function (i) { probs[vehicles[i]] += w / winners.length; });
    });
  });

  // History blend (only with plenty of data and enough exact matches).
  var blended = {};
  vehicles.forEach(function (v) { blended[v] = probs[v]; });
  var histInfo = null;
  var N = raceList.length;
  if (N >= HISTORY_BLEND_MIN_TOTAL) {
    var setKey = vehicles.slice().sort().join('|');
    var matches = raceList.filter(function (r) {
      return r.tracks && r.tracks[0] === seg1 &&
        r.vehicles && r.vehicles.slice().sort().join('|') === setKey;
    });
    if (matches.length >= HISTORY_BLEND_MIN_MATCHES) {
      var w = clamp((N - HISTORY_BLEND_MIN_TOTAL) / 350, 0, 0.5);
      var histCounts = {};
      vehicles.forEach(function (v) { histCounts[v] = 0; });
      matches.forEach(function (r) {
        if (histCounts[r.winner] !== undefined) histCounts[r.winner] += 1;
      });
      vehicles.forEach(function (v) {
        var hp = histCounts[v] / matches.length;
        blended[v] = (1 - w) * probs[v] + w * hp;
      });
      histInfo = { matches: matches.length, weight: w, total: N };
    }
  }

  var ranked = vehicles.map(function (v) {
    return { vehicle: v, prob: blended[v], modelProb: probs[v] };
  }).sort(function (a, b) { return b.prob - a.prob; });

  return { ranked: ranked, dist2: d2, dist3: d3, histInfo: histInfo };
}

/* Short human reason for a pick, given the distributions used. */
function buildReason(vehicle, others, seg1, d2, d3, speedsMap) {
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

  if (isFastest(vehicle, seg1)) parts.push('fastest on ' + seg1);
  var top2 = TRACKS.slice().sort(function (a, b) { return d2[b] - d2[a]; })[0];
  var top3 = TRACKS.slice().sort(function (a, b) { return d3[b] - d3[a]; })[0];
  var likely = [];
  [top2, top3].forEach(function (t) { if (likely.indexOf(t) === -1) likely.push(t); });
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
    var u = el('button', 'track-btn unknown-btn' + (!selected ? ' selected' : ''), 'Unknown');
    u.addEventListener('click', function () { onPick(null); });
    row.appendChild(u);
  }
}

function renderSeg1() {
  renderTrackRow('seg1Tracks', pred.seg1, function (t) {
    pred.seg1 = t;
    renderSeg1();
    renderPrediction();
  }, false);
}

function renderHiddenSeg(segNum) {
  var state = segNum === 2 ? pred.seg2 : pred.seg3;
  var rowId = segNum === 2 ? 'seg2Tracks' : 'seg3Tracks';
  var chanceId = segNum === 2 ? 'seg2Chance' : 'seg3Chance';
  renderTrackRow(rowId, state.mode === 'unknown' ? null : state.track, function (t) {
    if (t === null) {
      state.mode = 'unknown'; state.track = null;
    } else {
      // Tapping a track makes it a hint at the default 50% chance.
      // The user can change the chance (or pin it) with the chips below.
      state.mode = 'hint'; state.track = t;
      if (!state.chance) state.chance = 50;
    }
    renderHiddenSeg(segNum);
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
        if (c === 100) { state.mode = 'pin'; }
        else { state.mode = 'hint'; state.chance = c; }
        renderHiddenSeg(segNum);
        renderPrediction();
      });
      chanceRow.appendChild(chip);
    });
  } else {
    chanceRow.classList.add('hidden');
  }
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

function predictionAllowed() {
  if (DEMO_MODE) return { ok: true };
  if (!currentUser) return { ok: false, reason: 'signin' };
  if (!subActive) return { ok: false, reason: 'expired' };
  return { ok: true };
}

function renderPrediction() {
  var panel = $('resultPanel');
  var line = $('assumedLine');
  line.textContent = '';

  var gate = predictionAllowed();
  if (!gate.ok) {
    panel.innerHTML = '<div class="locked-panel"><h3>Predictions are locked</h3>' +
      (gate.reason === 'signin'
        ? '<p>Sign in from the Account tab to use predictions.</p>'
        : '<p>Your subscription has expired (subscriptions end at the end of each calendar month). Renew from the Account tab or ask the admin to grant a new one.</p>') +
      '<button class="btn btn-yellow" id="gotoAccountBtn">Go to Account</button></div>';
    var go = $('gotoAccountBtn');
    if (go) go.addEventListener('click', function () { showTab('account'); });
    return;
  }

  if (pred.vehicles.length !== 3 || !pred.seg1) {
    panel.innerHTML = '<p class="result-empty">Pick 3 vehicles and the first track to see the prediction.</p>';
    return;
  }

  var t0 = (typeof performance !== 'undefined') ? performance.now() : 0;
  var result = computePrediction({
    vehicles: pred.vehicles,
    seg1: pred.seg1,
    seg2Hint: pred.seg2,
    seg3Hint: pred.seg3,
    speeds: speeds,
    races: races
  });
  var t1 = (typeof performance !== 'undefined') ? performance.now() : 0;
  var ms = Math.max(0, Math.round(t1 - t0));

  var top = result.ranked.slice(0, 2);
  var html = '<div class="result-title">Top picks — ' + pred.seg1 + ' first</div>';
  top.forEach(function (r, idx) {
    var others = pred.vehicles.filter(function (v) { return v !== r.vehicle; });
    var reason = buildReason(r.vehicle, others, pred.seg1, result.dist2, result.dist3, speeds);
    var pct = Math.round(r.prob * 100);
    var oddsTxt = pred.odds[r.vehicle] ? ' · Odds ' + pred.odds[r.vehicle].toFixed(1) : '';
    html += '<div class="result-card rank-' + (idx + 1) + '">' +
      '<div class="result-head"><span class="result-name">#' + (idx + 1) + ' ' + r.vehicle + '</span>' +
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

  line.textContent = 'Assumed hidden tracks — Seg 2: ' + formatDist(result.dist2) +
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
    }, false);
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
  if (logForm.vehicles.length !== 3) { toast('Pick 3 vehicles first.'); return; }
  if (logForm.tracks.some(function (t) { return !t; })) { toast('Pick all 3 segment tracks.'); return; }
  if (!logForm.winner) { toast('Pick the winner.'); return; }
  if (!logForm.howWon) { toast('Pick how it won.'); return; }
  var howText = logForm.howWon === 'Other' ? ($('logHowText').value || '').trim() : '';
  var race = {
    id: logForm.editId || ('local-' + Date.now() + '-' + Math.floor(Math.random() * 1000)),
    vehicles: logForm.vehicles.slice(),
    tracks: logForm.tracks.slice(),
    patterns: logForm.patterns.slice(),
    winner: logForm.winner,
    how_won: logForm.howWon,
    how_won_text: howText,
    odds: Object.assign({}, logForm.odds),
    created_at: new Date().toISOString()
  };

  if (logForm.editId) {
    var idx = races.findIndex(function (r) { return String(r.id) === String(logForm.editId); });
    if (idx !== -1) races[idx] = race;
    await cloudUpdateRace(race);
    toast('Race updated.');
  } else {
    var saved = await cloudInsertRace(race);
    if (saved) { race.id = saved.id; race.created_at = saved.created_at || race.created_at; }
    races.unshift(race);
    toast('Race saved. Model updated.');
  }
  saveLocalRaces();
  resetLogForm();
  renderRaceList();
  renderPrediction(); // new data changes hidden-track probabilities
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
        tracks: (r.tracks || []).slice(),
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
    wrap.appendChild(el('h4', null, 'Segment ' + (i + 1) + (i === 0 ? ' (visible)' : ' (hidden)')));
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

async function importCsv(file) {
  var text = await file.text();
  var lines = text.split(/\r?\n/).filter(function (l) { return l.trim().length; });
  if (lines.length < 2) { toast('CSV is empty.'); return; }
  var header = parseCsvLine(lines[0]).map(function (h) { return h.trim().toLowerCase(); });
  var idx = {};
  header.forEach(function (h, i) { idx[h] = i; });
  var added = 0, skipped = 0;
  for (var li = 1; li < lines.length; li++) {
    var c = parseCsvLine(lines[li]);
    var vehicles = (c[idx.vehicles] || '').split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    var tracks = [c[idx.track1], c[idx.track2], c[idx.track3]].map(function (s) { return (s || '').trim(); });
    var winner = (c[idx.winner] || '').trim();
    var ok = vehicles.length === 3 &&
      vehicles.every(function (v) { return vehicleByName(v); }) &&
      tracks.every(function (t) { return TRACKS.indexOf(t) !== -1; }) &&
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

  var status = el('div', 'acct-card');
  status.innerHTML = '<h3>' + currentUser.email + '</h3>' +
    '<p>Subscription: ' + (subActive
      ? '<span class="sub-active">Active until ' + fmtDate(subExpiresAt) + '</span>'
      : '<span class="sub-expired">Expired / none</span> — subscriptions end at the end of each calendar month.') + '</p>' +
    (isAdmin ? '<p>You are an admin.</p>' : '');
  var outBtn = el('button', 'btn btn-ghost', 'Sign out');
  outBtn.addEventListener('click', async function () {
    await sb.auth.signOut();
    currentUser = null; subActive = false; isAdmin = false;
    races = loadLocalRaces();
    renderAccount();
    renderPrediction();
    toast('Signed out.');
  });
  status.appendChild(outBtn);
  box.appendChild(status);

  if (isAdmin) renderAdminPanel(box);
}

async function renderAdminPanel(box) {
  var card = el('div', 'acct-card');
  card.innerHTML = '<h3>Admin — users &amp; subscriptions</h3><p>Grant sets the subscription to the end of the current calendar month. Revoke blocks predictions immediately.</p><p class="help-text">Loading users…</p>';
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
    card.innerHTML = '<h3>Admin — users &amp; subscriptions</h3><p>Grant sets the subscription to the end of the current calendar month. Revoke blocks predictions immediately.</p>';
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
      var grantBtn = el('button', 'btn btn-yellow', 'Grant');
      grantBtn.addEventListener('click', async function () {
        var res = await sb.from('subscriptions').upsert({
          user_id: u.id,
          expires_at: endOfCurrentMonth().toISOString(),
          status: 'active',
          granted_by: currentUser.id
        }, { onConflict: 'user_id' });
        if (res.error) { toast('Grant failed: ' + res.error.message); return; }
        toast('Subscription granted to ' + u.email + '.');
        renderAccount();
      });
      var revokeBtn = el('button', 'btn btn-ghost', 'Revoke');
      revokeBtn.addEventListener('click', async function () {
        var res = await sb.from('subscriptions').update({ status: 'revoked' }).eq('user_id', u.id).eq('status', 'active');
        if (res.error) { toast('Revoke failed: ' + res.error.message); return; }
        toast('Subscription revoked for ' + u.email + '.');
        renderAccount();
      });
      row.appendChild(grantBtn);
      row.appendChild(revokeBtn);
      card.appendChild(row);
    });
  } catch (e) {
    card.innerHTML = '<h3>Admin — users &amp; subscriptions</h3><p class="help-text">Could not load users: ' + e.message +
      '. Make sure profiles.is_admin = true for your account (see README.md).</p>';
  }
}

async function afterAuth() {
  await refreshSession();
  await syncRacesFromCloud();
  renderAccount();
  renderPrediction();
  renderRaceList();
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
  renderSeg1();
  renderHiddenSeg(2);
  renderHiddenSeg(3);
  renderOddsBox();
  renderPrediction();
  renderLogForm();
  renderRaceList();
  renderStats();
  renderSpeedTable();
  renderTimer();

  $('timerBtn').addEventListener('click', startTimer);
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
    computePrediction: computePrediction,
    segmentDistribution: segmentDistribution,
    historicalFreq: historicalFreq,
    buildReason: buildReason
  };
}
