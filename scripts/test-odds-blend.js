// Tests for the ODDS BLEND (Lucky Race Predictor).
// The game's odds move the prediction % live: implied chance per vehicle
// is (1 / odds), normalised across the 3 picked vehicles — higher odds
// mean the game thinks the vehicle is LESS likely to win. The final %
// is (1 - ODDS_BLEND_WEIGHT) * track+speed+history % + ODDS_BLEND_WEIGHT
// * odds-implied % (default weight 0.5, see js/config.js).
// Run from the repo root:
//   node scripts/test-odds-blend.js
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

var speeds = app.DEFAULT_SPEEDS;
var vehicles = ['ORV', 'Car', 'SUV'];
function baseInput() {
  return {
    vehicles: vehicles,
    seg1Hint: pin('Desert'), // ORV is fastest on Desert: physics favours ORV
    seg2Hint: unknown(),
    seg3Hint: unknown(),
    speeds: speeds,
    races: []
  };
}

// --- baseline: no odds -> pure physics, no oddsInfo ---
var base = app.computePrediction(baseInput());
check('baseline: probs sum to 1', approx(sumProbs(base), 1, 1e-6));
check('baseline: ranked desc', base.ranked[0].prob >= base.ranked[1].prob && base.ranked[1].prob >= base.ranked[2].prob);
check('baseline: ORV is MAIN on a Desert pin', base.ranked[0].vehicle === 'ORV');
check('baseline: no oddsInfo without odds', base.oddsInfo === null);

// --- odds favouring the underdog pull its % up, ORV down ---
var withOdds = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 5.0, 'Car': 2.0, 'SUV': 3.0 }
}));
check('odds: probs sum to 1', approx(sumProbs(withOdds), 1, 1e-6));
check('odds: Car % rises vs baseline', probOf(withOdds, 'Car') > probOf(base, 'Car'));
check('odds: ORV % falls vs baseline', probOf(withOdds, 'ORV') < probOf(base, 'ORV'));
check('odds: oddsInfo weight is 0.5', withOdds.oddsInfo && withOdds.oddsInfo.weight === 0.5);
check('odds: implied Car (1/2 normalised) beats ORV (1/5)',
  withOdds.oddsInfo.implied['Car'] > withOdds.oddsInfo.implied['ORV']);
var carRow = withOdds.ranked.filter(function (x) { return x.vehicle === 'Car'; })[0];
check('odds: oddsProb recorded on ranked rows', carRow && typeof carRow.oddsProb === 'number' && carRow.oddsProb > 0);

// --- strong odds flip MAIN / BACKUP ---
var flip = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 8.0, 'Car': 1.2, 'SUV': 8.0 }
}));
check('odds: strong Car odds flip MAIN to Car', flip.ranked[0].vehicle === 'Car');
check('odds: flipped probs still sum to 1', approx(sumProbs(flip), 1, 1e-6));

// --- changing odds moves the % (the live-update the user asked for) ---
var oddsA = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 2.0, 'Car': 2.0, 'SUV': 2.0 }
}));
var oddsB = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 2.0, 'Car': 4.0, 'SUV': 2.0 }
}));
check('odds: raising Car odds lowers Car %', probOf(oddsB, 'Car') < probOf(oddsA, 'Car'));
check('odds: equal odds leave ranking = physics ranking',
  oddsA.ranked.map(function (r) { return r.vehicle; }).join('|') ===
  base.ranked.map(function (r) { return r.vehicle; }).join('|'));

// --- invalid / missing odds are ignored, never crash ---
var badOdds = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 0, 'Car': 2.0, 'SUV': 3.0 }
}));
check('odds: zero odds ignored (same as baseline)',
  badOdds.oddsInfo === null && approx(probOf(badOdds, 'ORV'), probOf(base, 'ORV'), 1e-9));
var partialOdds = app.computePrediction(Object.assign(baseInput(), {
  odds: { 'ORV': 2.0, 'Car': 2.0 }
}));
check('odds: missing one vehicle odds ignored',
  partialOdds.oddsInfo === null && approx(probOf(partialOdds, 'Car'), probOf(base, 'Car'), 1e-9));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
