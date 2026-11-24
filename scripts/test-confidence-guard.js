// Tests for the CONFIDENCE GUARD helper + the lrp-v19 data-only
// honesty bounds (Lucky Race Predictor).
// lrp-v19: computePrediction no longer applies the guard or any odds
// blend — the % comes only from the saved races, Laplace-smoothed
// toward the next back-off level and clamped to [1%, 99%], so no
// vehicle may display 0% or 100%. The applyConfidenceGuard helper is
// still exported (and still unit-tested here) for frozen/legacy runs,
// but the ranking path no longer calls it.
// Run from the repo root:
//   node scripts/test-confidence-guard.js
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
function sumProbs(result) {
  return result.ranked.reduce(function (acc, r) { return acc + r.prob; }, 0);
}
function maxProb(result) { return result.ranked[0].prob; }
function minProb(result) { return result.ranked[result.ranked.length - 1].prob; }

var speeds = app.DEFAULT_SPEEDS;

// --- (a) the reported case: Seg 2 Desert known, 2 unknown, odds set ---
// (user's screenshot showed ATV 99% / Car 0% on the OLD code).
// lrp-v19: the % comes only from the saved races. With a history where
// ATV won 4 of 5 same-cars Seg-2-Desert races, ATV is MAIN at ~79%
// and the 0-win vehicle sits at the 1% floor — never 0% or 100%.
var histA = [];
for (var i = 0; i < 4; i++) histA.push({ vehicles: ['ATV', 'Car', 'Monster Truck'], tracks: ['unknown', 'Desert', 'unknown'], winner: 'ATV', how_won: 'Other', how_won_text: '' });
histA.push({ vehicles: ['ATV', 'Car', 'Monster Truck'], tracks: ['unknown', 'Desert', 'unknown'], winner: 'Car', how_won: 'Other', how_won_text: '' });
var caseA = app.computePrediction({
  vehicles: ['ATV', 'Car', 'Monster Truck'],
  seg1Hint: unknown(),
  seg2Hint: pin('Desert'),
  seg3Hint: unknown(),
  speeds: speeds,
  races: histA,
  odds: { 'ATV': 4.1, 'Car': 3.7, 'Monster Truck': 3.0 }
});
console.log('  (a) probs: ' + caseA.ranked.map(function (r) {
  return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%';
}).join(', '));
check('(a) probs sum to 1', approx(sumProbs(caseA), 1, 1e-6));
check('(a) no vehicle displays above 99% (was 99% before)', Math.round(maxProb(caseA) * 100) <= 99);
check('(a) no vehicle displays below 1% (was 0% before)', Math.round(minProb(caseA) * 100) >= 1);
check('(a) ATV is MAIN from its own data', caseA.ranked[0].vehicle === 'ATV');
// With NO races at all, the v22 answer follows the speed table for the
// pinned track (ATV is fastest on Desert, 72) — no longer uniform 1/3.
var caseA0 = app.computePrediction({
  vehicles: ['ATV', 'Car', 'Monster Truck'],
  seg1Hint: unknown(),
  seg2Hint: pin('Desert'),
  seg3Hint: unknown(),
  speeds: speeds,
  races: [],
  odds: { 'ATV': 4.1, 'Car': 3.7, 'Monster Truck': 3.0 }
});
check('(a0) empty history -> ATV first (fastest on Desert, 72), not uniform', caseA0.ranked[0].vehicle === 'ATV' && !approx(caseA0.ranked[0].prob, 1 / 3, 0.001));
check('(a0) empty history -> probs sum to 1', approx(sumProbs(caseA0), 1, 1e-6));

// --- (b) all segments unknown: everything stays near 1/3 ---
var caseB = app.computePrediction({
  vehicles: ['ORV', 'Car', 'SUV'],
  seg1Hint: unknown(),
  seg2Hint: unknown(),
  seg3Hint: unknown(),
  speeds: speeds,
  races: [],
  odds: { 'ORV': 2.3, 'Car': 2.7, 'SUV': 2.6 }
});
console.log('  (b) probs: ' + caseB.ranked.map(function (r) {
  return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%';
}).join(', '));
check('(b) probs sum to 1', approx(sumProbs(caseB), 1, 1e-6));
check('(b) max-min spread stays small', maxProb(caseB) - minProb(caseB) < 0.45);
check('(b) no vehicle above 90%', maxProb(caseB) <= 0.90);
check('(b) no vehicle is 0%', minProb(caseB) > 0.15);

// --- (c) all 3 segments known: cap is 95% ---
// NOTE: through computePrediction this input cannot occur — the one-track
// rule (oneTrackHints) keeps only the FIRST pin and demotes the rest, so
// unknownCount is always 2 or 3 in a real prediction. The 95% cap branch
// is therefore tested directly on the exported guard helper, with the
// realistic blended values for a known [Desert, Highway, Expressway]
// combo with odds (Car is fastest on that combo, so model [0,1,0]
// blended 90/10 with the odds-implied chance), computed exactly here
// from the odds — no hand-rounded numbers.
var invSum = 1 / 4.1 + 1 / 3.7 + 1 / 3.0;
var guardC = {
  'ATV': 0.1 * (1 / 4.1) / invSum,
  'Car': 0.9 + 0.1 * (1 / 3.7) / invSum,
  'Monster Truck': 0.1 * (1 / 3.0) / invSum
};
var guardCBefore = { 'ATV': guardC['ATV'], 'Car': guardC['Car'], 'Monster Truck': guardC['Monster Truck'] };
app.applyConfidenceGuard(guardC, 0);
console.log('  (c) guard(0 unknown): ' + Object.keys(guardC).map(function (v) {
  return v + ' ' + (guardC[v] * 100).toFixed(1) + '%';
}).join(', '));
check('(c) guard leaves in-range values alone', approx(guardC['Car'], guardCBefore['Car'], 1e-9));
check('(c) no vehicle above 95% with all segments known',
  Math.max(guardC['ATV'], guardC['Car'], guardC['Monster Truck']) <= 0.95);
check('(c) no vehicle below 2% with all segments known',
  Math.min(guardC['ATV'], guardC['Car'], guardC['Monster Truck']) >= 0.02);
check('(c) guard output still sums to 1',
  approx(guardC['ATV'] + guardC['Car'] + guardC['Monster Truck'], 1, 1e-9));

// And through computePrediction: passing 3 pins demotes to 1 pin, so the
// 2-unknown (90%) cap applies — never 99%.
var caseC = app.computePrediction({
  vehicles: ['ATV', 'Car', 'Monster Truck'],
  seg1Hint: pin('Desert'),
  seg2Hint: pin('Highway'),
  seg3Hint: pin('Expressway'),
  speeds: speeds,
  races: [],
  odds: { 'ATV': 4.1, 'Car': 3.7, 'Monster Truck': 3.0 }
});
console.log('  (c) 3 pins in: ' + caseC.ranked.map(function (r) {
  return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%';
}).join(', '));
check('(c) 3 pins in: probs sum to 1', approx(sumProbs(caseC), 1, 1e-6));
check('(c) 3 pins in: max stays under the 90% unknown cap', maxProb(caseC) <= 0.90);

// NOTE: without odds, all-known is a point mass (one vehicle gets raw
// prob 1.0). The guard's final clamp (after renormalise) holds the cap
// exactly: max is 95.0%, never 95.96%.
var guardC0 = { 'ATV': 0.99, 'Car': 0.005, 'Monster Truck': 0.005 };
app.applyConfidenceGuard(guardC0, 0);
console.log('  (c0) guard(0 unknown, degenerate): ' + Object.keys(guardC0).map(function (v) {
  return v + ' ' + (guardC0[v] * 100).toFixed(1) + '%';
}).join(', '));
check('(c0) no-odds all-known max is exactly the 95% cap', Math.max(guardC0['ATV'], guardC0['Car'], guardC0['Monster Truck']) <= 0.95);
check('(c0) no-odds all-known min stays at the 2% floor', Math.min(guardC0['ATV'], guardC0['Car'], guardC0['Monster Truck']) >= 0.02);

// --- (d) odds are IGNORED for ranking (lrp-v19) — they must not move
// the % at all, and must never flip MAIN / BACKUP ---
function caseDInput(odds) {
  return {
    vehicles: ['ATV', 'Car', 'Monster Truck'],
    seg1Hint: unknown(),
    seg2Hint: pin('Desert'),
    seg3Hint: unknown(),
    speeds: speeds,
    races: [],
    odds: odds
  };
}
var dEqual = app.computePrediction(caseDInput({ 'ATV': 2.0, 'Car': 2.0, 'Monster Truck': 2.0 }));
var dCarFavoured = app.computePrediction(caseDInput({ 'ATV': 8.0, 'Car': 1.2, 'Monster Truck': 8.0 }));
console.log('  (d) equal odds: ' + dEqual.ranked.map(function (r) {
  return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%';
}).join(', '));
console.log('  (d) Car-favoured odds: ' + dCarFavoured.ranked.map(function (r) {
  return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%';
}).join(', '));
check('(d) probs sum to 1 (equal odds)', approx(sumProbs(dEqual), 1, 1e-6));
check('(d) probs sum to 1 (Car-favoured odds)', approx(sumProbs(dCarFavoured), 1, 1e-6));
check('(d) favouring Car odds does NOT change any %', JSON.stringify(dCarFavoured.ranked) === JSON.stringify(dEqual.ranked));
check('(d) ATV stays first (fastest on Desert, 72 — not input order)', dCarFavoured.ranked[0].vehicle === 'ATV');
check('(d) probs still respect the 99% display cap', Math.round(maxProb(dCarFavoured) * 100) <= 99);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
