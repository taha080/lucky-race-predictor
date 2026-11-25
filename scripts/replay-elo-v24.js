// ELO experiment for Lucky Race Predictor (lrp-v24 candidate).
// Applies the method from Green Code's "I Trained AI to Predict Sports
// (again)": (1) leakage-safe walk-forward evaluation — every race is
// predicted only from races before it; (2) time-based reporting — the
// newest 100 races are reported separately as the real test slice;
// (3) ELO-style ratings per vehicle per track with a dynamic K-factor
// (higher K while a vehicle has few races on that track, chess-style).
//
// Variants compared under LIVE conditions (exactly one segment pinned,
// same as scripts/replay-blend-v22.js):
//   current        shipped lrp-v22/v23 blend (0.6 speeds + 0.4 history)
//   elo-only       ELO ratings only (track ELO, overall fallback)
//   blend-a15/a25/a40  current prob mixed with ELO prob at alpha
//
// Usage: node scripts/replay-elo-v24.js
// Run from the repo root. Exit code 0.
// NOTE: local seed files cover 346 races; the DB holds more (~651 at
// 24 Nov). Same local set as the v22 replay, so numbers are comparable.
'use strict';
var fs = require('fs');
var path = require('path');

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
console.log('races loaded (deduped): ' + rows.length);

// ---- ELO state ---------------------------------------------------------
// overall: {vehicle: {r, games}}; byTrack: {vehicle: {track: {r, games}}}
var ELO_START = 1500;
function eloEntry(map, key) {
  if (!map[key]) map[key] = { r: ELO_START, games: 0 };
  return map[key];
}
function kFactor(games) {
  // Dynamic K, chess-style: ratings with few games move fast.
  if (games < 10) return 32;
  if (games < 30) return 24;
  return 16;
}
function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}
function updatePair(winnerEntry, loserEntry) {
  var ew = expectedScore(winnerEntry.r, loserEntry.r);
  var el = 1 - ew;
  winnerEntry.r += kFactor(winnerEntry.games) * (1 - ew);
  loserEntry.r += kFactor(loserEntry.games) * (0 - el);
  winnerEntry.games += 1;
  loserEntry.games += 1;
}

var overall = {};
var byTrack = {};
function trackEntry(vehicle, track) {
  if (!byTrack[vehicle]) byTrack[vehicle] = {};
  return eloEntry(byTrack[vehicle], track);
}
// Apply one finished race to the ELO state. Winner beats each loser
// pairwise; the two losers are not compared (their order is unknown).
function applyRace(race) {
  var losers = race.vehicles.filter(function (v) { return v !== race.winner; });
  if (losers.length !== 2) return;
  losers.forEach(function (loser) {
    updatePair(eloEntry(overall, race.winner), eloEntry(overall, loser));
  });
  race.tracks.forEach(function (track) {
    if (!track || track === 'unknown') return;
    losers.forEach(function (loser) {
      updatePair(trackEntry(race.winner, track), trackEntry(loser, track));
    });
  });
}
function ratingFor(vehicle, track) {
  if (track && byTrack[vehicle] && byTrack[vehicle][track] && byTrack[vehicle][track].games > 0) {
    return byTrack[vehicle][track].r;
  }
  return eloEntry(overall, vehicle).r;
}
// ELO win probabilities for 3 vehicles: strength = 10^(R/400), normalized.
function eloProbs(vehicles, track) {
  var strengths = vehicles.map(function (v) { return Math.pow(10, ratingFor(v, track) / 400); });
  var sum = strengths.reduce(function (s, x) { return s + x; }, 0);
  var out = {};
  vehicles.forEach(function (v, i) { out[v] = sum > 0 ? strengths[i] / sum : 1 / vehicles.length; });
  return out;
}

// ---- evaluation --------------------------------------------------------
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
    '  | top-2 ' + (100 * (stats.r1 + stats.r2) / n).toFixed(1) + '%' +
    '  skipped=' + stats.skipped);
}
function rankFromProbs(vehicles, probs, winner) {
  var ranked = vehicles.slice().sort(function (a, b) { return probs[b] - probs[a]; });
  var idx = ranked.indexOf(winner);
  return idx === -1 ? null : idx + 1;
}

var VARIANTS = ['current', 'elo-only', 'blend-a15', 'blend-a25', 'blend-a40'];
var ALPHA = { 'blend-a15': 0.15, 'blend-a25': 0.25, 'blend-a40': 0.4 };
var statsAll = {}, statsLate = {};
VARIANTS.forEach(function (v) { statsAll[v] = newStats(); statsLate[v] = newStats(); });

var J0 = 9;
var LATE_FROM = rows.length - 100; // newest 100 races = time-based test slice

for (var j = 0; j < rows.length; j++) {
  var target = rows[j];
  if (j >= J0) {
    var history = rows.slice(0, j).reverse(); // newest-first, before race j only
    for (var k = 0; k < 3; k++) {
      if (target.tracks[k] === 'unknown') continue;
      var pinnedTrack = target.tracks[k];
      var hints = [0, 1, 2].map(function (i) {
        return hintFor(i === k ? pinnedTrack : 'unknown');
      });
      var cur = app.computePrediction({
        vehicles: target.vehicles,
        seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
        speeds: app.DEFAULT_SPEEDS, races: history
      });
      var curProbs = {};
      cur.ranked.forEach(function (r) { curProbs[r.vehicle] = r.prob; });
      var eloP = eloProbs(target.vehicles, pinnedTrack);
      VARIANTS.forEach(function (v) {
        var probs;
        if (v === 'current') probs = curProbs;
        else if (v === 'elo-only') probs = eloP;
        else {
          var a = ALPHA[v];
          probs = {};
          target.vehicles.forEach(function (veh) {
            probs[veh] = (1 - a) * (curProbs[veh] || 0) + a * (eloP[veh] || 0);
          });
        }
        var rank = rankFromProbs(target.vehicles, probs, target.winner);
        addRank(statsAll[v], rank);
        if (j >= LATE_FROM) addRank(statsLate[v], rank);
      });
    }
  }
  applyRace(target); // ELO learns from race j only AFTER predicting it
}

console.log('--- walk-forward replay, live-pin-each (random baseline HIGH 33.3%, top-2 66.7%) ---');
VARIANTS.forEach(function (v) { report(v + ' (all)', statsAll[v]); });
console.log('--- newest 100 races only (time-based test slice) ---');
VARIANTS.forEach(function (v) { report(v + ' (late)', statsLate[v]); });
console.log('done.');
