// Tests that the GAME ODDS are IGNORED for ranking (lrp-v19).
// The Predictor ranks purely from the saved races — no speeds, no
// segment lengths, no odds, nothing invented. The game's odds are
// still shown on the vehicle cards and quoted in the JACKPOT reason,
// but they must NEVER move the % or flip the order. (Before lrp-v19
// the odds were blended in at 10% — that blend is gone.)
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
function baseInput(races, odds) {
  return {
    vehicles: vehicles,
    seg1Hint: pin('Desert'),
    seg2Hint: unknown(),
    seg3Hint: unknown(),
    speeds: speeds,
    races: races || [],
    odds: odds || null
  };
}

// --- baseline: no odds, no races -> honest uniform, no oddsInfo ---
var base = app.computePrediction(baseInput());
check('baseline: probs sum to 1', approx(sumProbs(base), 1, 1e-6));
check('baseline: uniform 1/3 with no data', base.ranked.every(function (r) { return approx(r.prob, 1 / 3, 1e-9); }));
check('baseline: first by input order (no invented HIGH)', base.ranked[0].vehicle === 'ORV');
check('baseline: no oddsInfo without odds', base.oddsInfo === null);
check('baseline: no histInfo (no blend)', base.histInfo === null);

// --- odds favouring the underdog must NOT pull its % up ---
var withOdds = app.computePrediction(baseInput([], { 'ORV': 5.0, 'Car': 2.0, 'SUV': 3.0 }));
check('odds: probs sum to 1', approx(sumProbs(withOdds), 1, 1e-6));
check('odds: Car % does NOT rise with favourable odds', approx(probOf(withOdds, 'Car'), probOf(base, 'Car'), 1e-9));
check('odds: ORV % does NOT fall with poor odds', approx(probOf(withOdds, 'ORV'), probOf(base, 'ORV'), 1e-9));
check('odds: ranking identical to baseline', JSON.stringify(withOdds.ranked) === JSON.stringify(base.ranked));
check('odds: oddsInfo stays null with odds passed', withOdds.oddsInfo === null);
check('odds: no oddsProb recorded on ranked rows',
  withOdds.ranked.every(function (r) { return typeof r.oddsProb === 'undefined'; }));

// --- strong odds must NOT flip MAIN or move anything ---
var nudge = app.computePrediction(baseInput([], { 'ORV': 8.0, 'Car': 1.2, 'SUV': 8.0 }));
check('odds: strong Car odds do NOT flip MAIN', nudge.ranked[0].vehicle === 'ORV');
check('odds: nudged probs still sum to 1', approx(sumProbs(nudge), 1, 1e-6));
check('odds: strong Car odds do NOT raise Car %', approx(probOf(nudge, 'Car'), probOf(base, 'Car'), 1e-9));

// --- changing odds moves nothing at all ---
var oddsA = app.computePrediction(baseInput([], { 'ORV': 2.0, 'Car': 2.0, 'SUV': 2.0 }));
var oddsB = app.computePrediction(baseInput([], { 'ORV': 2.0, 'Car': 4.0, 'SUV': 2.0 }));
check('odds: raising Car odds does NOT lower Car %', approx(probOf(oddsB, 'Car'), probOf(oddsA, 'Car'), 1e-9));
check('odds: equal odds leave ranking = baseline ranking',
  JSON.stringify(oddsA.ranked) === JSON.stringify(base.ranked));

// --- with real data, the DATA decides — odds still ignored ---
var hist = [];
for (var i = 0; i < 4; i++) hist.push({ vehicles: vehicles.slice(), tracks: ['Desert', 'unknown', 'unknown'], winner: 'ORV', how_won: 'Other', how_won_text: '' });
hist.push({ vehicles: vehicles.slice(), tracks: ['Desert', 'unknown', 'unknown'], winner: 'Car', how_won: 'Other', how_won_text: '' });
var dataNoOdds = app.computePrediction(baseInput(hist));
var dataOdds = app.computePrediction(baseInput(hist, { 'ORV': 9.0, 'Car': 1.1, 'SUV': 9.0 }));
check('odds: with data, ORV is HIGH from its 4/5 wins', dataNoOdds.ranked[0].vehicle === 'ORV');
check('odds: with data, odds still change nothing', JSON.stringify(dataOdds.ranked) === JSON.stringify(dataNoOdds.ranked));

// --- invalid / missing odds are ignored, never crash ---
var badOdds = app.computePrediction(baseInput([], { 'ORV': 0, 'Car': 2.0, 'SUV': 3.0 }));
check('odds: zero odds ignored (same as baseline)',
  badOdds.oddsInfo === null && approx(probOf(badOdds, 'ORV'), probOf(base, 'ORV'), 1e-9));
var partialOdds = app.computePrediction(baseInput([], { 'ORV': 2.0, 'Car': 2.0 }));
check('odds: missing one vehicle odds ignored',
  partialOdds.oddsInfo === null && approx(probOf(partialOdds, 'Car'), probOf(base, 'Car'), 1e-9));

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
