// Tests for the HISTORY BLEND ramp (kept as a pure helper) + the
// DATA-ONLY ranking that replaced the blend in lrp-v19 + the feedback
// race builder (Lucky Race Predictor).
//
// lrp-v19 retired the blend: the ranking IS the saved data, via
// dataOnlyRank — no speeds, no odds, no blend. histInfo is always null
// now. The historyBlendWeight ramp function is still exported (and
// still unit-tested here) for its own sake, but computePrediction no
// longer calls it. Synthetic histories below control the match count
// and totals exactly.
//
// Run from the repo root:
//   node scripts/test-history-blend.js
// Exit code 0 = all pass, 1 = any failure.
'use strict';
var path = require('path');

var app = require(path.join(__dirname, '..', 'js', 'app.js'));

var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}
function approx(a, b, eps) { return Math.abs(a - b) < (eps || 1e-9); }
function unknown() { return { mode: 'unknown', track: null, chance: 50 }; }
function pin(track) { return { mode: 'pin', track: track, chance: 100 }; }
function probOf(result, name) {
  var r = result.ranked.filter(function (x) { return x.vehicle === name; })[0];
  return r ? r.prob : null;
}

var speeds = app.DEFAULT_SPEEDS;
var vehicles = ['ORV', 'Car', 'SUV'];

/* Synthetic history: n races, all the same vehicle set + seg1 Desert
   pinned, winners split orvWins / carWins / suvWins (must sum to n).
   Plain counts, no recency decay — every saved race counts the same. */
function synthHistory(n, orvWins, carWins, suvWins) {
  var out = [];
  var winners = [];
  var i;
  for (i = 0; i < orvWins; i++) winners.push('ORV');
  for (i = 0; i < carWins; i++) winners.push('Car');
  for (i = 0; i < suvWins; i++) winners.push('SUV');
  for (i = 0; i < n; i++) {
    out.push({
      vehicles: ['ORV', 'Car', 'SUV'],
      tracks: ['Desert', 'unknown', 'unknown'],
      winner: winners[i % winners.length]
    });
  }
  return out;
}
function predictWith(races) {
  return app.computePrediction({
    vehicles: vehicles,
    seg1Hint: pin('Desert'),
    seg2Hint: unknown(),
    seg3Hint: unknown(),
    speeds: speeds,
    races: races
  });
}

// --- the ramp: weight is 0 below 30, 0.225 at 57, capped at 0.5 ---
check('ramp: weight 0 with no races', app.historyBlendWeight(0) === 0);
check('ramp: weight 0 at 29 races', app.historyBlendWeight(29) === 0);
check('ramp: weight 0 at exactly 30 races', app.historyBlendWeight(30) === 0);
check('ramp: weight (40-30)/120 at 40 races', approx(app.historyBlendWeight(40), 10 / 120, 1e-9));
check('ramp: weight 0.225 at 57 races', approx(app.historyBlendWeight(57), 0.225, 1e-9));
check('ramp: weight capped at 0.5 (90 races)', app.historyBlendWeight(90) === 0.5);
check('ramp: weight capped at 0.5 (200 races)', app.historyBlendWeight(200) === 0.5);

// --- lrp-v19: there is NO history blend any more — the ranking IS the
// data. histInfo is always null, whatever the match count. ---
var under = predictWith(synthHistory(29, 20, 5, 4));
check('v19: no histInfo below 30 races (no blend at all)', under.histInfo === null);

// --- 40 matching races now fire data level L1, with the count reported ---
var at40 = predictWith(synthHistory(40, 28, 8, 4));
check('v19: no histInfo at 40 races either', at40.histInfo === null);
check('v19: 40 matching races fire data level L1', at40.dataInfo && at40.dataInfo.level === 1);
check('v19: L1 match count is 40', at40.dataInfo && at40.dataInfo.matches === 40);
var at57 = predictWith(synthHistory(57, 40, 10, 7));
check('v19: 57 matching races also fire L1', at57.dataInfo && at57.dataInfo.level === 1);

// --- the data pulls the % toward the historical win rate ---
var base = predictWith([]);
var withHist = predictWith(synthHistory(40, 36, 2, 2)); // ORV won 90% of them
check('data: ORV % rises toward its 90% historical win rate',
  probOf(withHist, 'ORV') > probOf(base, 'ORV'));
check('data: Car % falls toward its 5% historical win rate',
  probOf(withHist, 'Car') < probOf(base, 'Car'));
check('data: ORV is HIGH from its own data', withHist.ranked[0].vehicle === 'ORV');

// --- the 2-match minimum still applies ---
var fewMatches = synthHistory(1, 1, 0, 0).concat(synthHistory(39, 20, 10, 9).map(function (r) {
  // Same total (40) but a different vehicle set, so only 1 matches.
  return { vehicles: ['ATV', 'Car', 'Monster Truck'], tracks: r.tracks, winner: 'Car' };
}));
check('min-matches: 1 matching race does NOT fire L1', predictWith(fewMatches).dataInfo.level !== 1);

// --- buildFeedbackRace: the race the wizard feedback saves ---
var run = {
  vehicles: ['ORV', 'Car', 'SUV'],
  tracks: ['Desert', 'unknown', 'unknown'],
  main: 'ORV',
  result: predictWith([]),
  ms: 2
};
var fb = app.buildFeedbackRace(run, 'ORV');
check('feedback: race built for the MAIN pick',
  fb && fb.vehicles.join('|') === 'ORV|Car|SUV' && fb.winner === 'ORV');
check('feedback: tracks keep unknowns as stored',
  fb && fb.tracks.join('|') === 'Desert|unknown|unknown');
check('feedback: how_won Other, empty note/patterns/odds',
  fb && fb.how_won === 'Other' && fb.how_won_text === '' &&
  Array.isArray(fb.patterns) && fb.patterns.length === 0 &&
  fb.odds && Object.keys(fb.odds).length === 0);
var fbWrong = app.buildFeedbackRace(run, 'Car');
check('feedback: race built for the actual winner when wrong',
  fbWrong && fbWrong.winner === 'Car');
check('feedback: winner outside the run is rejected', app.buildFeedbackRace(run, 'ATV') === null);
check('feedback: run with fewer than 3 vehicles is rejected',
  app.buildFeedbackRace({ vehicles: ['ORV', 'Car'], tracks: ['Desert', 'unknown', 'unknown'] }, 'ORV') === null);
check('feedback: no run is rejected', app.buildFeedbackRace(null, 'ORV') === null);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
