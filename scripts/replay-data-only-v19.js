// Data-only replay for lrp-v19: verifies the new ranker on the saved
// races under LIVE conditions (the game shows exactly ONE track before
// the bet, so only one segment is pinned and the other two stay
// unknown). No odds, no speeds — the ranking comes only from the saved
// races, with the history available BEFORE each target race.
//
// Modes (one per process run):
//   live-pin-each  (default) one run per known-track position of each
//                  race, via computePrediction (the real code path)
//   thresholds     same runs, but with dataOnlyRank directly, for
//                  minMatches 2 vs 3 x alpha 1 vs 2 — picks the
//                  threshold to ship
//
// Also reports: level distribution + accuracy per level, and the
// SUV-vs-Motorcycle head-to-head (the exact case the user reported:
// shown segment favouring SUV, Predictor ranking Motorcycle HIGH and
// SUV JACKPOT — the data must rank SUV above Motorcycle when the data
// says so).
//
// Usage: node scripts/replay-data-only-v19.js [mode]
// Run from the repo root. Exit code 0.
// NOTE: local seed files cover 346 races; the DB holds more (~471+ at
// 23 Nov 01:20 PKT) — the parent agent runs the full-DB replay after
// the browser export lands.
'use strict';
var fs = require('fs');
var path = require('path');

var MODE = process.argv[2] || 'live-pin-each';
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
console.log('threshold: minMatches=' + app.DATA_ONLY_MIN_MATCHES + ' alpha=' + app.DATA_ONLY_ALPHA);

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

function predictViaCompute(target, pinIdx, history) {
  var hints = [0, 1, 2].map(function (i) {
    return hintFor(i === pinIdx ? target.tracks[i] : 'unknown');
  });
  return app.computePrediction({
    vehicles: target.vehicles,
    seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
    speeds: app.DEFAULT_SPEEDS, races: history
  });
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

if (MODE === 'thresholds') {
  // Compare minMatches 2 vs 3 x alpha 1 vs 2 on the same runs.
  var combos = [
    { minMatches: 2, alpha: 1 }, { minMatches: 2, alpha: 2 },
    { minMatches: 3, alpha: 1 }, { minMatches: 3, alpha: 2 }
  ];
  combos.forEach(function (opts) {
    var stats = newStats();
    var predictFn = function (target, pinIdx, history) {
      var d = app.dataOnlyRank(target.vehicles, pinIdx, target.tracks[pinIdx], history, opts);
      return { ranked: d.ranked, dataInfo: d.dataInfo };
    };
    forEachRun(predictFn, function (res) { add(stats, res); });
    console.log('minMatches=' + opts.minMatches + ' alpha=' + opts.alpha + ':');
    report('  ', stats);
  });
  console.log('done.');
  process.exit(0);
}

// Default: live-pin-each through the real code path.
var all = newStats();
var byPin = { 0: newStats(), 1: newStats(), 2: newStats() };
var late = newStats();
var byLevel = { 1: newStats(), 2: newStats(), 3: newStats(), 4: newStats() };
var h2h = { n: 0, suvAbove: 0, motoAbove: 0, suvWonSuvTop: 0, suvWon: 0, motoWonMotoTop: 0, motoWon: 0 };
var h2hByTrack = {};

forEachRun(predictViaCompute, function (res, j, pinIdx) {
  add(all, res);
  add(byPin[pinIdx], res);
  if (j >= 30) add(late, res);
  if (res && res.level) add(byLevel[res.level], res);
  // SUV vs Motorcycle head-to-head (only runs where both are racing).
  if (!res) return;
  var target = rows[j];
  if (target.vehicles.indexOf('SUV') === -1 || target.vehicles.indexOf('Motorcycle') === -1) return;
  var suvRank = null, motoRank = null;
  res.ranked.forEach(function (r, i) {
    if (r.vehicle === 'SUV') suvRank = i + 1;
    if (r.vehicle === 'Motorcycle') motoRank = i + 1;
  });
  if (suvRank === null || motoRank === null) return;
  h2h.n++;
  if (suvRank < motoRank) h2h.suvAbove++; else h2h.motoAbove++;
  if (target.winner === 'SUV') { h2h.suvWon++; if (suvRank === 1) h2h.suvWonSuvTop++; }
  if (target.winner === 'Motorcycle') { h2h.motoWon++; if (motoRank === 1) h2h.motoWonMotoTop++; }
  var t = res.pinTrack;
  h2hByTrack[t] = h2hByTrack[t] || { n: 0, suvAbove: 0, motoAbove: 0 };
  h2hByTrack[t].n++;
  if (suvRank < motoRank) h2hByTrack[t].suvAbove++; else h2hByTrack[t].motoAbove++;
});

console.log('--- winner rank distribution (random baseline 33.3% / 33.3% / 33.3%) ---');
report('OVERALL', all);
report('  pin seg1 only', byPin[0]);
report('  pin seg2 only', byPin[1]);
report('  pin seg3 only', byPin[2]);
report('  late (target race #30+)', late);
console.log('--- accuracy by back-off level ---');
[1, 2, 3, 4].forEach(function (lv) { report('  level L' + lv, byLevel[lv]); });
console.log('--- SUV vs Motorcycle head-to-head (runs where both race) ---');
console.log('  n=' + h2h.n + '  SUV ranked above Motorcycle ' + h2h.suvAbove + ' (' + (h2h.n ? (100 * h2h.suvAbove / h2h.n).toFixed(1) : '0') + '%)' +
  '  Motorcycle above SUV ' + h2h.motoAbove + ' (' + (h2h.n ? (100 * h2h.motoAbove / h2h.n).toFixed(1) : '0') + '%)');
console.log('  when SUV actually won (n=' + h2h.suvWon + '): SUV was rank 1 in ' + h2h.suvWonSuvTop + ' (' + (h2h.suvWon ? (100 * h2h.suvWonSuvTop / h2h.suvWon).toFixed(1) : '0') + '%)');
console.log('  when Motorcycle actually won (n=' + h2h.motoWon + '): Motorcycle was rank 1 in ' + h2h.motoWonMotoTop + ' (' + (h2h.motoWon ? (100 * h2h.motoWonMotoTop / h2h.motoWon).toFixed(1) : '0') + '%)');
Object.keys(h2hByTrack).sort().forEach(function (t) {
  var s = h2hByTrack[t];
  console.log('  pinned ' + t + ': n=' + s.n + '  SUV above ' + s.suvAbove + '  Motorcycle above ' + s.motoAbove);
});
console.log('done.');
