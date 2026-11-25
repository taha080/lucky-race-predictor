// Follow-up checks for the lrp-v24 ELO experiment (scripts/replay-elo-v24.js):
// 1) Weight sweep judged ONLY on the newest-100-races slice (the video's
//    time-based discipline: pick settings on old data, judge on new).
// 2) Head-to-head feature: on the pinned track, how often each of the 3
//    vehicles beat the other two in past races on that track, blended
//    into the current probabilities at alpha 0.15 / 0.25.
//
// Usage: node scripts/replay-elo-v24b.js
// Run from the repo root. Exit code 0.
'use strict';
var fs = require('fs');
var path = require('path');

var app = require(path.join(__dirname, '..', 'js', 'app.js'));

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
    rows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3] });
  }
});
var deduped = [];
rows.forEach(function (r) { if (!app.isDuplicateRace(r, deduped)) deduped.push(r); });
rows = deduped;
console.log('races loaded (deduped): ' + rows.length);

function hintFor(track) {
  return track === 'unknown'
    ? { mode: 'unknown', track: null, chance: 50 }
    : { mode: 'pin', track: track, chance: 100 };
}
function newStats() { return { n: 0, r1: 0, r2: 0, r3: 0, skipped: 0 }; }
function addRank(stats, rank) {
  if (rank === null) { stats.skipped++; return; }
  stats.n++;
  if (rank === 1) stats.r1++; else if (rank === 2) stats.r2++; else stats.r3++;
}
function report(label, stats) {
  var n = stats.n;
  if (!n) { console.log(label + ': n=0'); return; }
  console.log(label + ': n=' + n +
    '  HIGH ' + (100 * stats.r1 / n).toFixed(1) + '%' +
    '  MID ' + (100 * stats.r2 / n).toFixed(1) + '%' +
    '  JACKPOT ' + (100 * stats.r3 / n).toFixed(1) + '%' +
    '  | top-2 ' + (100 * (stats.r1 + stats.r2) / n).toFixed(1) + '%');
}
function rankFromProbs(vehicles, probs, winner) {
  var ranked = vehicles.slice().sort(function (a, b) { return probs[b] - probs[a]; });
  var idx = ranked.indexOf(winner);
  return idx === -1 ? null : idx + 1;
}

// Head-to-head shares on one track: among history races on that track
// where at least two of the 3 vehicles raced, count wins of each of the
// 3 against the others present. Laplace-smoothed; uniform when no data.
function h2hShares(vehicles, track, history) {
  var wins = {}, games = {};
  vehicles.forEach(function (v) { wins[v] = 0; games[v] = 0; });
  history.forEach(function (r) {
    if (r.tracks.indexOf(track) === -1) return;
    var present = vehicles.filter(function (v) { return r.vehicles.indexOf(v) !== -1; });
    if (present.length < 2) return;
    present.forEach(function (v) { games[v] += 1; });
    if (present.indexOf(r.winner) !== -1) wins[r.winner] += 1;
  });
  var shares = {}, sum = 0;
  vehicles.forEach(function (v) {
    shares[v] = (wins[v] + 1) / (games[v] + 3); // smoothed win rate
    sum += shares[v];
  });
  vehicles.forEach(function (v) { shares[v] = sum > 0 ? shares[v] / sum : 1 / 3; });
  return shares;
}

var J0 = 9;
var LATE_FROM = rows.length - 100;
var WEIGHTS = [0.5, 0.6, 0.7, 0.8, 1.0];
var wStats = {};
WEIGHTS.forEach(function (w) { wStats[w] = { all: newStats(), late: newStats() }; });
var hStats = { 'h2h-a15': { all: newStats(), late: newStats() }, 'h2h-a25': { all: newStats(), late: newStats() } };

for (var j = J0; j < rows.length; j++) {
  var target = rows[j];
  var history = rows.slice(0, j).reverse();
  for (var k = 0; k < 3; k++) {
    if (target.tracks[k] === 'unknown') continue;
    var pinnedTrack = target.tracks[k];
    var hints = [0, 1, 2].map(function (i) { return hintFor(i === k ? pinnedTrack : 'unknown'); });
    var base = {
      vehicles: target.vehicles,
      seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: history
    };
    WEIGHTS.forEach(function (w) {
      var res = app.computePrediction(Object.assign({}, base, { speedWeight: w }));
      var rank = app.rankOfWinner(res.ranked, target.winner);
      addRank(wStats[w].all, rank);
      if (j >= LATE_FROM) addRank(wStats[w].late, rank);
    });
    // H2H blends on top of the shipped default weight.
    var cur = app.computePrediction(base);
    var curProbs = {};
    cur.ranked.forEach(function (r) { curProbs[r.vehicle] = r.prob; });
    var h2h = h2hShares(target.vehicles, pinnedTrack, history);
    [['h2h-a15', 0.15], ['h2h-a25', 0.25]].forEach(function (pair) {
      var probs = {};
      target.vehicles.forEach(function (v) {
        probs[v] = (1 - pair[1]) * (curProbs[v] || 0) + pair[1] * (h2h[v] || 0);
      });
      var rank = rankFromProbs(target.vehicles, probs, target.winner);
      addRank(hStats[pair[0]].all, rank);
      if (j >= LATE_FROM) addRank(hStats[pair[0]].late, rank);
    });
  }
}

console.log('--- speed-weight sweep (shipped default is 0.6) ---');
WEIGHTS.forEach(function (w) {
  report('w=' + w + ' (all) ', wStats[w].all);
  report('w=' + w + ' (late)', wStats[w].late);
});
console.log('--- head-to-head blends on top of shipped default ---');
Object.keys(hStats).forEach(function (key) {
  report(key + ' (all) ', hStats[key].all);
  report(key + ' (late)', hStats[key].late);
});
console.log('done.');
