// Live-condition replay experiment for the HIGH/JACKPOT inversion report
// (user: live Predictor labels HIGH and JACKPOT swapped, 7-10 bets lost).
//
// Replays the model on the saved races under LIVE conditions: the game
// shows exactly ONE track before the bet, so only one segment is pinned
// and the other two are guessed from history (segmentDistribution).
// Measures the actual winner's rank distribution (HIGH rank 1 / MID
// rank 2 / JACKPOT rank 3) — random baseline is 33.3% each.
//
// Modes (one per process run; config is read at load time):
//   live-pin-each  (default) live config, one run per known-track
//                  position of each race (simulates the game showing
//                  any of the 3 segments)
//   live-pin-first live config, pin only the FIRST known segment
//   live-pin-all   live config, pin ALL known segments (Stats replay
//                  condition — the model's ceiling with full info)
//   live-wrongpin  live config, pin the known track ONE segment to the
//                  right of its true position (simulates the Reader's
//                  tab-centre mapping putting the track in the wrong
//                  segment)
//   live-wrongvalue live config, pin the CORRECT segment but with the
//                  WRONG track value — the next track in TRACKS order
//                  (simulates the Reader's OCR misreading the shown
//                  track name)
//   live-dirtdesert live config, swap Dirt <-> Desert only when pinning
//                  (the plausible OCR confusion: both start with D)
//   live-nohist    live config, no history at all (pure speeds +
//                  uniform 1/6 for unknown segments)
//   equal-pin-each equal-thirds segment lengths, one run per known
//                  position (Node defaults, no live config)
//
// Usage: node scripts/replay-live-inversion.js [mode]
// Run from the repo root. Exit code 0.
'use strict';
var fs = require('fs');
var path = require('path');

var MODE = process.argv[2] || 'live-pin-each';
var LIVE_CONFIG = MODE.indexOf('live-') === 0;
if (LIVE_CONFIG) {
  // Make app.js see the real config, as the browser does.
  global.window = {};
  require(path.join(__dirname, '..', 'js', 'config.js'));
}
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
// Drop exact duplicates the way the DB dedup would (same vehicles +
// same tracks + same winner + same note), keeping the first copy.
var deduped = [];
rows.forEach(function (r) {
  if (!app.isDuplicateRace(r, deduped)) deduped.push(r);
});
rows = deduped;
console.log('mode: ' + MODE);
console.log('races loaded (deduped): ' + rows.length);
console.log('segment lengths: [' + app.segmentLengths().map(function (x) { return x.toFixed(3); }).join(', ') + ']' +
  (LIVE_CONFIG ? ' (live config)' : ' (equal thirds)'));

function hintFor(track) {
  return track === 'unknown'
    ? { mode: 'unknown', track: null, chance: 50 }
    : { mode: 'pin', track: track, chance: 100 };
}

// One prediction for target race j, pinning `pinIdx` (or -1 for none).
// Returns { rank, blendFired } or null when the winner is not among
// the 3 vehicles (bad imported data).
function predict(j, pinIdx, historyOverride) {
  var target = rows[j];
  var history = historyOverride !== undefined
    ? historyOverride
    : rows.slice(0, j).reverse(); // newest-first, as the app passes them
  var hints = [0, 1, 2].map(function (i) {
    return hintFor(i === pinIdx ? target.tracks[i] : 'unknown');
  });
  var res = app.computePrediction({
    vehicles: target.vehicles,
    seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
    speeds: app.DEFAULT_SPEEDS, races: history
  });
  var rank = app.rankOfWinner(res.ranked, target.winner);
  if (rank === null) return null;
  return { rank: rank, blendFired: !!res.histInfo, pinIdx: pinIdx };
}

function report(label, stats) {
  var n = stats.n;
  if (!n) { console.log(label + ': n=0'); return; }
  console.log(label + ': n=' + n +
    '  HIGH(rank1) ' + stats.r1 + ' = ' + (100 * stats.r1 / n).toFixed(1) + '%' +
    '  MID(rank2) ' + stats.r2 + ' = ' + (100 * stats.r2 / n).toFixed(1) + '%' +
    '  JACKPOT(rank3) ' + stats.r3 + ' = ' + (100 * stats.r3 / n).toFixed(1) + '%' +
    '  | top-1 ' + (100 * stats.r1 / n).toFixed(1) + '%' +
    '  top-2 ' + (100 * (stats.r1 + stats.r2) / n).toFixed(1) + '%' +
    '  skipped=' + stats.skipped +
    (stats.blendN ? '  | blend fired: n=' + stats.blendN + ' HIGH ' + (100 * stats.blendR1 / stats.blendN).toFixed(1) + '% JACKPOT ' + (100 * stats.blendR3 / stats.blendN).toFixed(1) + '%' : ''));
}

function newStats() {
  return { n: 0, r1: 0, r2: 0, r3: 0, skipped: 0, blendN: 0, blendR1: 0, blendR3: 0 };
}
function add(stats, res) {
  if (!res) { stats.skipped++; return; }
  stats.n++;
  if (res.rank === 1) stats.r1++;
  else if (res.rank === 2) stats.r2++;
  else stats.r3++;
  if (res.blendFired) {
    stats.blendN++;
    if (res.rank === 1) stats.blendR1++;
    if (res.rank === 3) stats.blendR3++;
  }
}

// Start after a little history exists so the distributions are not
// pure uniform (matches the earlier backtest's j0 = 9).
var J0 = 9;
var all = newStats();
var byPin = { 0: newStats(), 1: newStats(), 2: newStats() };
var late = newStats(); // races after the blend gate can fire (N >= 30)

for (var j = J0; j < rows.length; j++) {
  var target = rows[j];
  var knownIdx = [];
  for (var k = 0; k < 3; k++) {
    if (target.tracks[k] !== 'unknown') knownIdx.push(k);
  }
  if (MODE === 'live-pin-all' || MODE === 'equal-pin-all') {
    // Pin every known segment at once (Stats condition).
    var hints = [0, 1, 2].map(function (i) { return hintFor(target.tracks[i]); });
    var res = app.computePrediction({
      vehicles: target.vehicles,
      seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: rows.slice(0, j).reverse()
    });
    var rank = app.rankOfWinner(res.ranked, target.winner);
    add(all, rank === null ? null : { rank: rank, blendFired: !!res.histInfo });
    continue;
  }
  if (MODE === 'live-nohist') {
    // One run per known position, no history at all.
    knownIdx.forEach(function (pinIdx) {
      add(all, predict(j, pinIdx, []));
    });
    continue;
  }
  if (MODE === 'live-wrongpin') {
    // Pin the first known track one segment to the right of its
    // true position (wraps 2 -> 0).
    if (!knownIdx.length) { all.skipped++; continue; }
    var wrongIdx = (knownIdx[0] + 1) % 3;
    // Build the wrong-pin prediction by hand: the track value comes
    // from the true position, the pin sits at the wrong one.
    var h = [0, 1, 2].map(function (i) {
      return hintFor(i === wrongIdx ? target.tracks[knownIdx[0]] : 'unknown');
    });
    var r2 = app.computePrediction({
      vehicles: target.vehicles,
      seg1Hint: h[0], seg2Hint: h[1], seg3Hint: h[2],
      speeds: app.DEFAULT_SPEEDS, races: rows.slice(0, j).reverse()
    });
    var rk = app.rankOfWinner(r2.ranked, target.winner);
    add(all, rk === null ? null : { rank: rk, blendFired: !!r2.histInfo });
    continue;
  }
  if (MODE === 'live-wrongvalue' || MODE === 'live-dirtdesert') {
    // Pin the CORRECT segment but with the WRONG track value —
    // simulates the Reader's OCR misreading the shown track name.
    // live-wrongvalue: rotate to the next track in TRACKS order.
    // live-dirtdesert: swap Dirt <-> Desert only (the plausible
    // OCR confusion: both start with D); other tracks stay correct.
    if (!knownIdx.length) { all.skipped++; continue; }
    var trueTrack = target.tracks[knownIdx[0]];
    var wrongTrack;
    if (MODE === 'live-dirtdesert') {
      if (trueTrack === 'Dirt') wrongTrack = 'Desert';
      else if (trueTrack === 'Desert') wrongTrack = 'Dirt';
      else wrongTrack = trueTrack; // other tracks: correct pin
    } else {
      var ti = app.TRACKS ? app.TRACKS.indexOf(trueTrack) : -1;
      var list = ['Expressway', 'Highway', 'Desert', 'Bumpy', 'Potholes', 'Dirt'];
      wrongTrack = list[(list.indexOf(trueTrack) + 1) % list.length];
    }
    var h2 = [0, 1, 2].map(function (i) {
      return hintFor(i === knownIdx[0] ? wrongTrack : 'unknown');
    });
    var r3 = app.computePrediction({
      vehicles: target.vehicles,
      seg1Hint: h2[0], seg2Hint: h2[1], seg3Hint: h2[2],
      speeds: app.DEFAULT_SPEEDS, races: rows.slice(0, j).reverse()
    });
    var rk3 = app.rankOfWinner(r3.ranked, target.winner);
    add(all, rk3 === null ? null : { rank: rk3, blendFired: !!r3.histInfo });
    continue;
  }
  // live-pin-each / equal-pin-each / live-pin-first (default family):
  // one run per known position, or only the first known position.
  var positions = MODE === 'live-pin-first' ? knownIdx.slice(0, 1) : knownIdx;
  positions.forEach(function (pinIdx) {
    var r = predict(j, pinIdx);
    add(all, r);
    add(byPin[pinIdx], r);
    if (j >= 30) add(late, r);
  });
}

console.log('--- winner rank distribution (random baseline 33.3% / 33.3% / 33.3%) ---');
report('OVERALL', all);
if (MODE === 'live-pin-each' || MODE === 'equal-pin-each' || MODE === 'live-pin-first') {
  report('  pin seg1 only', byPin[0]);
  report('  pin seg2 only', byPin[1]);
  report('  pin seg3 only', byPin[2]);
  report('  late (target race #30+)', late);
}
console.log('done.');
