// Tests for lrp-v22: SPEEDS + FULL-HISTORY BLEND.
// The user's order (24 Nov 2026, reversing the v19 data-only order):
// rank from the game's own speed table (DEFAULT_SPEEDS, canonical —
// never a user's localStorage edits) AND the full saved history,
// first bet to last, via the v19 hierarchical back-off with the
// recency decay ON (halves every 50 races — every race still counts,
// recent ones count more). Blend: final = V22_SPEED_WEIGHT * speed +
// (1 - V22_SPEED_WEIGHT) * history, default weight 0.6 — the lowest
// weight that puts Stock Car first on Desert in the user's own case
// (6 saved Desert races: SUV 3 wins, Stock Car 2, Motorcycle 1;
// at 0.5 the thin history still overrules the speed table).
// The confidence guard is applied again in computePrediction after
// the blend (it was dropped from the ranking path in v19).
// Run from the repo root:
//   node scripts/test-lrp-v22.js
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
// Data-only shares were SUV ~48%, Stock Car ~33%, Motorcycle ~18% —
// the predictor said SUV HIGH even though the speed table says
// Stock Car is fastest on Desert (80, vs SUV 57, Motorcycle 63).
var VEH_DESERT = ['Motorcycle', 'Stock Car', 'SUV'];
var histDesert = [
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Stock Car'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Motorcycle'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Stock Car'),
  race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV')
];

// --- (a) Speed table: Stock Car IS fastest on Desert ---
check('v22 (a) speed table: Stock Car Desert 80 is fastest of the three', function () {
  var s = app.DEFAULT_SPEEDS;
  return s['Stock Car']['Desert'] === 80 &&
    s['Stock Car']['Desert'] > s['SUV']['Desert'] &&
    s['Stock Car']['Desert'] > s['Motorcycle']['Desert'];
}());

// --- (b) Speed-only (w=1), no history: ranking follows the table ---
var rSpeedOnly = predict(VEH_DESERT, 0, 'Desert', [], { speedWeight: 1 });
check('v22 (b) speed-only, no races: Stock Car HIGH, Motorcycle MID, SUV JACKPOT', function () {
  return rSpeedOnly.ranked[0].vehicle === 'Stock Car' &&
    rSpeedOnly.ranked[1].vehicle === 'Motorcycle' &&
    rSpeedOnly.ranked[2].vehicle === 'SUV' &&
    approx(sumProbs(rSpeedOnly), 1);
}());

// --- (c) History-only (w=0) == the v19 data-only answer: SUV first ---
var rHistOnly = predict(VEH_DESERT, 0, 'Desert', histDesert, { speedWeight: 0 });
check('v22 (c) history-only (w=0): SUV HIGH — the old data-only answer', function () {
  return rHistOnly.ranked[0].vehicle === 'SUV' &&
    rHistOnly.ranked[1].vehicle === 'Stock Car' &&
    approx(sumProbs(rHistOnly), 1);
}());

// --- (d) Blended (default weight): Stock Car FIRST in the user's case ---
var rBlend = predict(VEH_DESERT, 0, 'Desert', histDesert);
check('v22 (d) blended (default weight): Stock Car HIGH, SUV MID, Motorcycle JACKPOT', function () {
  return rBlend.ranked[0].vehicle === 'Stock Car' &&
    rBlend.ranked[1].vehicle === 'SUV' &&
    rBlend.ranked[2].vehicle === 'Motorcycle' &&
    approx(sumProbs(rBlend), 1);
}());

// --- (e) The blend sits BETWEEN speed-only and history-only ---
check('v22 (e) blended Stock Car % is between history-only and speed-only', function () {
  var pHist = probOf(rHistOnly, 'Stock Car');
  var pBlend = probOf(rBlend, 'Stock Car');
  var pSpeed = probOf(rSpeedOnly, 'Stock Car');
  return pHist < pBlend && pBlend < pSpeed;
}());

// --- (f) The weight threshold: at 0.5 the thin history still wins ---
var rHalf = predict(VEH_DESERT, 0, 'Desert', histDesert, { speedWeight: 0.5 });
check('v22 (f) at speedWeight 0.5 the history still overrules speeds (SUV first) — so the default must be above 0.5', function () {
  return rHalf.ranked[0].vehicle === 'SUV' && app.V22_SPEED_WEIGHT > 0.5;
}());

// --- (g) input.speeds (localStorage edits) are IGNORED — canonical table rules ---
check('v22 (g) tampered input.speeds change nothing: ranking still follows DEFAULT_SPEEDS', function () {
  var tampered = JSON.parse(JSON.stringify(app.DEFAULT_SPEEDS));
  tampered['Motorcycle'] = { Expressway: 999, Highway: 999, Desert: 999, Bumpy: 999, Potholes: 999, Dirt: 999 };
  tampered['Stock Car'] = { Expressway: 1, Highway: 1, Desert: 1, Bumpy: 1, Potholes: 1, Dirt: 1 };
  var hints = [pin('Desert'), unknown(), unknown()];
  var a = app.computePrediction({ vehicles: VEH_DESERT, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2], speeds: tampered, races: histDesert, odds: null });
  var b = app.computePrediction({ vehicles: VEH_DESERT, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2], speeds: app.DEFAULT_SPEEDS, races: histDesert, odds: null });
  return JSON.stringify(a.ranked) === JSON.stringify(b.ranked) && a.ranked[0].vehicle === 'Stock Car';
}());

// --- (h) No races at all: the ranking follows SPEEDS, not uniform ---
var rNoRaces = predict(['SUV', 'Motorcycle', 'Car'], 1, 'Dirt', []);
check('v22 (h) no races, Seg 2 Dirt: SUV first (fastest on Dirt, 134) — not uniform 1/3', function () {
  return rNoRaces.ranked[0].vehicle === 'SUV' &&
    rNoRaces.dataInfo.level === 4 &&
    approx(sumProbs(rNoRaces), 1) &&
    !approx(probOf(rNoRaces, 'SUV'), 1 / 3, 0.001);
}());

// --- (i) Unknown-track confidence clamp: never over 90% / under 5% ---
var histUnanimous = [];
for (var i = 0; i < 6; i++) histUnanimous.push(race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'));
var rUnanimous = predict(VEH_DESERT, 0, 'Desert', histUnanimous);
check('v22 (i) 6/6 SUV wins on Desert still guarded: max <= 90%, min >= 5%, sum = 1', function () {
  var probs = rUnanimous.ranked.map(function (x) { return x.prob; });
  return Math.max.apply(null, probs) <= 0.90 &&
    Math.min.apply(null, probs) >= 0.05 &&
    approx(sumProbs(rUnanimous), 1);
}());
var rAllUnknown = predict(['ORV', 'Car', 'SUV'], null, null, []);
check('v22 (i2) all tracks unknown, no races: spread < 0.45, every prob > 0.15, sum = 1', function () {
  var probs = rAllUnknown.ranked.map(function (x) { return x.prob; });
  return Math.max.apply(null, probs) - Math.min.apply(null, probs) < 0.45 &&
    Math.min.apply(null, probs) > 0.15 &&
    approx(sumProbs(rAllUnknown), 1);
}());

// --- (j) Decay: a winner-pattern flip over 100 races moves the ranking ---
// Newest-first list: the 50 NEWEST races are all Stock Car wins, the
// 50 OLDEST all SUV wins. Plain counts tie 50-50; decay weights the
// recent Stock Car wins more, so Stock Car must lead.
var histFlip = [];
for (var j = 0; j < 50; j++) histFlip.push(race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'Stock Car'));
for (var k = 0; k < 50; k++) histFlip.push(race(VEH_DESERT, ['Desert', 'unknown', 'unknown'], 'SUV'));
check('v22 (j) decay ON: recent Stock Car wins outweigh old SUV wins', function () {
  var d = app.dataOnlyRank(VEH_DESERT, 0, 'Desert', histFlip, { decay: true });
  return d.dataInfo.shares['Stock Car'] > d.dataInfo.shares['SUV'];
}());
check('v22 (j2) decay OFF (v19 plain counts): the 50-50 split ties', function () {
  var d = app.dataOnlyRank(VEH_DESERT, 0, 'Desert', histFlip);
  return approx(d.dataInfo.shares['Stock Car'], d.dataInfo.shares['SUV']);
}());
check('v22 (j3) decay ON still counts every race: level 1, 100 matches', function () {
  var d = app.dataOnlyRank(VEH_DESERT, 0, 'Desert', histFlip, { decay: true });
  return d.dataInfo.level === 1 && d.dataInfo.matches === 100;
}());

// --- (k) blendInfo shape: both shares present and each sums to 1 ---
check('v22 (k) blendInfo carries speedWeight, speedShares and historyShares, each summing to 1', function () {
  var b = rBlend.blendInfo;
  if (!b) return false;
  var ss = Object.keys(b.speedShares).reduce(function (s, v) { return s + b.speedShares[v]; }, 0);
  var hs = Object.keys(b.historyShares).reduce(function (s, v) { return s + b.historyShares[v]; }, 0);
  return b.speedWeight === app.V22_SPEED_WEIGHT &&
    approx(ss, 1) && approx(hs, 1) &&
    approx(b.speedShares['Stock Car'], 0.40) &&
    b.historyShares['SUV'] > b.historyShares['Stock Car'];
}());

// --- (l) Backup pick: ranked[1] is a different vehicle, always present ---
check('v22 (l) HIGH/MID/JACKPOT are three distinct vehicles, MID is the backup', function () {
  var names = rBlend.ranked.map(function (x) { return x.vehicle; });
  return names.length === 3 &&
    names[0] !== names[1] && names[1] !== names[2] && names[0] !== names[2];
}());

// --- (m) Odds still ignored in Predict (kept in Log only) ---
check('v22 (m) odds change nothing in Predict', function () {
  var hints = [unknown(), pin('Desert'), unknown()];
  var base = { vehicles: VEH_DESERT, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2], speeds: app.DEFAULT_SPEEDS, races: histDesert, odds: null };
  var withOdds = { vehicles: VEH_DESERT, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2], speeds: app.DEFAULT_SPEEDS, races: histDesert, odds: { 'Motorcycle': 5.0, 'Stock Car': 2.7, 'SUV': 2.6 } };
  var a = app.computePrediction(base);
  var b = app.computePrediction(withOdds);
  return JSON.stringify(a.ranked) === JSON.stringify(b.ranked) && a.oddsInfo === null && b.oddsInfo === null;
}());

// --- (n) The reason line names speeds AND history ---
check('v22 (n) buildBlendReason mentions speeds and history percentages', function () {
  var reason = app.buildBlendReason(rBlend.ranked[0].vehicle, rBlend.dataInfo, rBlend.blendInfo);
  return typeof reason === 'string' && reason.indexOf('speeds') !== -1 && reason.indexOf('history') !== -1;
}());

// --- (o) Unanimous history still wins: 6/6 SUV wins beats the speed table ---
// Honest boundary: the blend is not speed-only. A unanimous history
// (every saved race the same winner) keeps that winner on top.
check('v22 (o) 6/6 SUV wins on Desert: SUV stays HIGH despite Stock Car being faster', function () {
  return rUnanimous.ranked[0].vehicle === 'SUV';
}());

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
