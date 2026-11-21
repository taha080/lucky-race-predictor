// Tests for the HISTORY BLEND gate + ramp + feedback race builder
// (Lucky Race Predictor).
//
// The gate came down from 150 to 30 races on 21 Nov 2026 so every
// prediction uses all 57 saved races: w = clamp((N - 30) / 120, 0, 0.5),
// applied only when >= 5 saved races match the exact 3-vehicle set +
// the same known (pinned) segments. At 57 races the weight is 0.225 —
// real but modest, so the speed model still decides and history only
// nudges it.
//
// The real 57 saved races do NOT trigger the blend yet (no vehicle set
// repeats 5 times — the most common set appears 3 times), so the blend
// is tested here with synthetic histories where the match count and
// total are controlled exactly. The backtest on the real 40 races is
// the check that the change does not break real predictions.
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
   Newest-first order is irrelevant to the gate; decay weights differ
   per index but the blend weight depends only on n. */
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

// --- gate OFF below 30 races even with plenty of matches ---
var under = predictWith(synthHistory(29, 20, 5, 4));
check('gate: no histInfo below 30 races', under.histInfo === null);

// --- gate ON at 30+ races: weight + match count reported ---
var at40 = predictWith(synthHistory(40, 28, 8, 4));
check('gate: histInfo present at 40 races', at40.histInfo !== null);
check('gate: 40 matching races counted', at40.histInfo && at40.histInfo.matches === 40);
check('gate: weight (40-30)/120 reported', at40.histInfo && approx(at40.histInfo.weight, 10 / 120, 1e-9));
var at57 = predictWith(synthHistory(57, 40, 10, 7));
check('gate: weight 0.225 reported at 57 races', at57.histInfo && approx(at57.histInfo.weight, 0.225, 1e-9));

// --- the blend pulls the % toward the historical win rate ---
var base = predictWith([]);
var withHist = predictWith(synthHistory(40, 36, 2, 2)); // ORV won 90% of them
check('blend: ORV % rises toward its 90% historical win rate',
  probOf(withHist, 'ORV') > probOf(base, 'ORV'));
check('blend: Car % falls toward its 5% historical win rate',
  probOf(withHist, 'Car') < probOf(base, 'Car'));

// --- the 5-match minimum still applies ---
var fewMatches = synthHistory(4, 3, 1, 0).concat(synthHistory(36, 20, 10, 6).map(function (r) {
  // Same total (40) but a different vehicle set, so only 4 match.
  return { vehicles: ['ATV', 'Car', 'Monster Truck'], tracks: r.tracks, winner: 'Car' };
}));
check('min-matches: no histInfo with only 4 matching races', predictWith(fewMatches).histInfo === null);

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
