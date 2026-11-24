// Speeds + full-history blend replay for lrp-v22: verifies the new
// blended ranker on the saved races under LIVE conditions (the game
// shows exactly ONE track before the bet, so only one segment is
// pinned and the other two stay unknown). The ranking blends the
// canonical DEFAULT_SPEEDS table with the full saved history (first
// bet to last, decay-weighted), at V22_SPEED_WEIGHT, with the
// confidence guard applied after the blend — through computePrediction
// (the real code path), with the history available BEFORE each target
// race.
//
// Modes (one per process run):
//   sweep          (default) live-pin-each at speedWeight 0 (data-only
//                  with decay), 0.5, 0.6 (the shipped default), 0.7
//                  and 1.0 (speed-only) — picks the weight to ship
//   live-pin-each  the shipped default weight only, with the full
//                  breakdown (by pin segment, by back-off level, late
//                  races) + the Desert Stock Car head-to-head
//
// Also reports the Desert Stock Car head-to-head (the exact case the
// user reported: shown track Desert, Stock Car fastest per the speed
// table, predictor ranking it JACKPOT — the blend must rank Stock Car
// above SUV on Desert when the speeds say so).
//
// Usage: node scripts/replay-blend-v22.js [mode]
// Run from the repo root. Exit code 0.
// NOTE: local seed files cover 346 races; the DB holds more (~471+ at
// 23 Nov 01:20 PKT) — the parent agent runs the full-DB replay after
// the browser export lands.
// REFERENCE NUMBERS (same 346 races, same live-pin-each runs):
//   v19 data-only (plain counts, no decay): HIGH 39.2%, MID 30.0%,
//     JACKPOT 30.8%, top-2 69.2%
//   old physics model (speeds + segment lengths, no history):
//     HIGH 50.3%, top-2 81.1%
// The w=0 line below is NOT the v19 number: v22's history is
// decay-weighted (halves every 50 races), v19's was plain counts.
'use strict';
var fs = require('fs');
var path = require('path');

var MODE = process.argv[2] || 'sweep';
var app = require(path.join(__dirname, '..', 'js', 'app.js'));

// ---- load all saved races, in file (chronological) order --------------
var FILES = [
  'sql/seed-races.sql',
  'sql/seed-races-41-57.sql',
  'sql/seed-races-scribd-final.sql',
  'sql/seed-races-2026-11-22-video.sql'
];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var rows = [];
FILES.forEach(function (f) {
  var sql = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  var m;
  while ((m = re.exec(sql)) !== null) {
    rows.push({
      vehicles: JSON.parse(m[1]),
      tracks: JSON.parse(m[2]),
      winner: m[3],
      how_won_text: m[4] || ''
    });
  }
});
var deduped = [];
rows.forEach(function (r) {
  if (!app.isDuplicateRace(r, deduped)) deduped.push(r);
});
rows = deduped;
console.log('mode: ' + MODE);
console.log('races loaded (deduped): ' + rows.length + ' (local seeds only; DB holds more — see note at the top)');
console.log('shipped default speed weight: ' + app.V22_SPEED_WEIGHT);

function hintFor(track) {
  return track === 'unknown'
    ? { mode: 'unknown', track: null, chance: 50 }
    : { mode: 'pin', track: track, chance: 100 };
}

// Start after a little history exists (matches the earlier backtest's
// j0 = 9).
var J0 = 9;

function newStats() {
  return { n: 0, r1: 0, r2: 0, r3: 0, skipped: 0 };
}
function add(stats, res) {
  if (!res) { stats.skipped++; return; }
  stats.n++;
  if (res.rank === 1) stats.r1++;
  else if (res.rank === 2) stats.r2++;
  else stats.r3++;
}
function report(label, stats) {
  var n = stats.n;
  if (!n) { console.log(label + ': n=0'); return; }
  console.log(label + ': n=' + n +
    '  HIGH ' + stats.r1 + ' = ' + (100 * stats.r1 / n).toFixed(1) + '%' +
    '  MID ' + stats.r2 + ' = ' + (100 * stats.r2 / n).toFixed(1) + '%' +
    '  JACKPOT ' + stats.r3 + ' = ' + (100 * stats.r3 / n).toFixed(1) + '%' +
    '  | top-1 ' + (100 * stats.r1 / n).toFixed(1) + '%' +
    '  top-2 ' + (100 * (stats.r1 + stats.r2) / n).toFixed(1) + '%' +
    '  skipped=' + stats.skipped);
}

// One live-condition run for target race j, pinning pinIdx, using the
// given predictor fn(target, pinIdx, history) -> { ranked, dataInfo }
// or null when the winner is not among the 3 vehicles.
function runOne(j, pinIdx, predictFn) {
  var target = rows[j];
  var history = rows.slice(0, j).reverse(); // newest-first
  var out = predictFn(target, pinIdx, history);
  if (!out) return null;
  var rank = app.rankOfWinner(out.ranked, target.winner);
  if (rank === null) return null;
  return { rank: rank, level: out.dataInfo ? out.dataInfo.level : null, ranked: out.ranked, pinTrack: target.tracks[pinIdx] };
}

function forEachRun(predictFn, collect) {
  for (var j = J0; j < rows.length; j++) {
    var target = rows[j];
    for (var k = 0; k < 3; k++) {
      if (target.tracks[k] === 'unknown') continue;
      var res = runOne(j, k, predictFn);
      collect(res, j, k);
    }
  }
}

function predictAtWeight(w) {
  return function (target, pinIdx, history) {
    var hints = [0, 1, 2].map(function (i) {
      return hintFor(i === pinIdx ? target.tracks[i] : 'unknown');
    });
    return app.computePrediction({
      vehicles: target.vehicles,
      seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: history, speedWeight: w
    });
  };
}

// Desert Stock Car head-to-head: runs where the pinned track is Desert
// and both Stock Car and SUV race. Counts how often Stock Car ranks
// above SUV, and when Stock Car actually won, how often it was rank 1.
function desertH2H(collect) {
  var h = { n: 0, stockAbove: 0, suvAbove: 0, stockWon: 0, stockWonTop: 0, suvWon: 0, suvWonTop: 0 };
  var orig = collect;
  return { h: h, collect: function (res, j, pinIdx) {
    orig(res, j, pinIdx);
    if (!res || res.pinTrack !== 'Desert') return;
    var target = rows[j];
    if (target.vehicles.indexOf('Stock Car') === -1 || target.vehicles.indexOf('SUV') === -1) return;
    var stockRank = null, suvRank = null;
    res.ranked.forEach(function (r, i) {
      if (r.vehicle === 'Stock Car') stockRank = i + 1;
      if (r.vehicle === 'SUV') suvRank = i + 1;
    });
    if (stockRank === null || suvRank === null) return;
    h.n++;
    if (stockRank < suvRank) h.stockAbove++; else h.suvAbove++;
    if (target.winner === 'Stock Car') { h.stockWon++; if (stockRank === 1) h.stockWonTop++; }
    if (target.winner === 'SUV') { h.suvWon++; if (suvRank === 1) h.suvWonTop++; }
  } };
}
function reportDesertH2H(label, h) {
  if (!h.n) { console.log(label + ': n=0'); return; }
  console.log(label + ': n=' + h.n +
    '  Stock Car above SUV ' + h.stockAbove + ' (' + (100 * h.stockAbove / h.n).toFixed(1) + '%)' +
    '  SUV above Stock Car ' + h.suvAbove + ' (' + (100 * h.suvAbove / h.n).toFixed(1) + '%)');
  console.log('  when Stock Car actually won (n=' + h.stockWon + '): Stock Car was rank 1 in ' + h.stockWonTop + ' (' + (h.stockWon ? (100 * h.stockWonTop / h.stockWon).toFixed(1) : '0') + '%)');
  console.log('  when SUV actually won (n=' + h.suvWon + '): SUV was rank 1 in ' + h.suvWonTop + ' (' + (h.suvWon ? (100 * h.suvWonTop / h.suvWon).toFixed(1) : '0') + '%)');
}

if (MODE === 'sweep') {
  [0, 0.5, 0.6, 0.7, 1.0].forEach(function (w) {
    var stats = newStats();
    var wrap = desertH2H(function (res) { add(stats, res); });
    forEachRun(predictAtWeight(w), wrap.collect);
    var tag = w === app.V22_SPEED_WEIGHT ? '  <-- SHIPPED DEFAULT' : (w === 0 ? '  (data-only, decay-weighted)' : (w === 1 ? '  (speed-only)' : ''));
    console.log('speedWeight=' + w + tag + ':');
    report('  ', stats);
    reportDesertH2H('  Desert Stock Car vs SUV', wrap.h);
  });
  console.log('done.');
  process.exit(0);
}

// Default detail mode: shipped weight only, full breakdown.
var all = newStats();
var byPin = { 0: newStats(), 1: newStats(), 2: newStats() };
var late = newStats();
var byLevel = { 1: newStats(), 2: newStats(), 3: newStats(), 4: newStats() };
var wrap = desertH2H(function (res, j, pinIdx) {
  add(all, res);
  add(byPin[pinIdx], res);
  if (j >= 30) add(late, res);
  if (res && res.level) add(byLevel[res.level], res);
});
forEachRun(predictAtWeight(app.V22_SPEED_WEIGHT), wrap.collect);

console.log('--- winner rank distribution (random baseline 33.3% / 33.3% / 33.3%) ---');
report('OVERALL', all);
report('  pin seg1 only', byPin[0]);
report('  pin seg2 only', byPin[1]);
report('  pin seg3 only', byPin[2]);
report('  late (target race #30+)', late);
console.log('--- accuracy by back-off level ---');
[1, 2, 3, 4].forEach(function (lv) { report('  level L' + lv, byLevel[lv]); });
console.log('--- Desert Stock Car vs SUV head-to-head (pinned Desert, both racing) ---');
reportDesertH2H('  ', wrap.h);
console.log('done.');
