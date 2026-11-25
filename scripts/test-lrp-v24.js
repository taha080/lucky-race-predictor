// Tests for lrp-v24: speed weight 0.6 -> 0.8 (Green Code method applied).
// The user's order (25 Nov 2026): apply the sports-prediction method from
// Green Code's "I Trained AI to Predict Sports (again)" to the Lucky Race
// Predictor. What the walk-forward replay showed (scripts/replay-elo-v24.js
// + scripts/replay-elo-v24b.js, 346 local races, live-pin-each):
//   - Leakage audit: PASS — every replay already predicts each race only
//     from races before it; nothing to fix.
//   - ELO per vehicle per track (dynamic K) and head-to-head shares:
//     tested, did NOT beat the current blend — not shipped.
//   - Weight sweep judged on the newest 100 races: w=0.8 beats w=0.6 on
//     both slices (all: HIGH 48.2% -> 52.1%, top-2 78.9% -> 80.0%;
//     newest 100: HIGH 48.5% -> 54.5%, top-2 82.8% -> 85.9%).
// So v24 raises V22_SPEED_WEIGHT to 0.8. History still counts at 20%
// (the user's 24 Nov order: speeds AND full history).
// Run from the repo root:
//   node scripts/test-lrp-v24.js
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
function race(vehicles, tracks, winner) {
  return { vehicles: vehicles.slice(), tracks: tracks.slice(), winner: winner, how_won: 'Other', how_won_text: '' };
}
function probOf(result, name) {
  var r = result.ranked.filter(function (x) { return x.vehicle === name; })[0];
  return r ? r.prob : null;
}
function sumProbs(result) {
  return result.ranked.reduce(function (acc, r) { return acc + r.prob; }, 0);
}
function predict(vehicles, pinSeg, pinTrack, races, opts) {
  var hints = [unknown(), unknown(), unknown()];
  if (pinSeg !== null) hints[pinSeg] = pin(pinTrack);
  var input = {
    vehicles: vehicles, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
    speeds: app.DEFAULT_SPEEDS, races: races || [], odds: null
  };
  if (opts && typeof opts.speedWeight === 'number') input.speedWeight = opts.speedWeight;
  return app.computePrediction(input);
}

// The user's Desert case (call #5, 23 Nov): 6 saved races, same 3
// vehicles, Seg 1 Desert, SUV won 3, Stock Car 2, Motorcycle 1.
var VEH_DESERT = ['Motorcycle', 'Stock Car', 'SUV'];
var histDesert = [
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Stock Car'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Motorcycle'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Stock Car'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV')
];

// --- (a) Version + weight constants ---
check('v24 (a) APP_VERSION is v24 and speed weight is 0.8', function () {
  return app.APP_VERSION === 'v24' && app.V22_SPEED_WEIGHT === 0.8;
}());

// --- (b) Desert case at the new default: Stock Car still FIRST ---
var rBlend = predict(VEH_DESERT, 0, 'Desert', histDesert);
check('v24 (b) Desert case at default 0.8: Stock Car HIGH, SUV MID, Motorcycle JACKPOT', function () {
  return rBlend.ranked[0].vehicle === 'Stock Car' &&
    rBlend.ranked[1].vehicle === 'SUV' &&
    rBlend.ranked[2].vehicle === 'Motorcycle' &&
    approx(sumProbs(rBlend), 1);
}());

// --- (c) The blend still sits BETWEEN history-only and speed-only ---
var rHistOnly = predict(VEH_DESERT, 0, 'Desert', histDesert, { speedWeight: 0 });
var rSpeedOnly = predict(VEH_DESERT, 0, 'Desert', [], { speedWeight: 1 });
check('v24 (c) blended Stock Car % is between history-only and speed-only', function () {
  var pHist = probOf(rHistOnly, 'Stock Car');
  var pBlend = probOf(rBlend, 'Stock Car');
  var pSpeed = probOf(rSpeedOnly, 'Stock Car');
  return pHist < pBlend && pBlend < pSpeed;
}());

// --- (d) History still counts: unanimous 6/6 SUV wins keep SUV HIGH ---
var histUnanimous = [];
for (var i = 0; i < 6; i++) histUnanimous.push(race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'));
var rUnanimous = predict(VEH_DESERT, 0, 'Desert', histUnanimous);
check('v24 (d) 6/6 SUV wins on Desert: SUV stays HIGH at 0.8 (history still counts)', function () {
  return rUnanimous.ranked[0].vehicle === 'SUV';
}());

// --- (e) No history: ranking follows the speed table on the pinned track ---
var rNoHist = predict(VEH_DESERT, 0, 'Desert', []);
check('v24 (e) no races: Stock Car HIGH (fastest on Desert), probs sum to 1', function () {
  return rNoHist.ranked[0].vehicle === 'Stock Car' && approx(sumProbs(rNoHist), 1);
}());

// --- (f) Explicit speedWeight still overrides the default ---
var rHalf = predict(VEH_DESERT, 0, 'Desert', histDesert, { speedWeight: 0.5 });
check('v24 (f) explicit speedWeight 0.5 still lets thin history win (SUV first)', function () {
  return rHalf.ranked[0].vehicle === 'SUV';
}());

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
