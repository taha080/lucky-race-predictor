// Tests for lrp-v19: DATA-ONLY ranking + START robustness.
// The Predictor ranks the 3 vehicles PURELY from the saved races —
// no speeds, no segment lengths, no odds, nothing invented.
// Hierarchical back-off: L1 same cars + same segment + same track,
// L2 same cars + same track (any segment), L3 same cars, L4 overall
// win rates. Levels fire at DATA_ONLY_MIN_MATCHES (2) matches, with
// Laplace smoothing (DATA_ONLY_ALPHA = 2) toward the next level, so a
// % is never 0% or 100%. START waits briefly for a live bet and says
// WHY there is none instead of going silent.
// Run from the repo root:
//   node scripts/test-lrp-v19.js
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
function predict(vehicles, pinSeg, pinTrack, races, odds, speeds) {
  var hints = [unknown(), unknown(), unknown()];
  if (pinSeg !== null) hints[pinSeg] = pin(pinTrack);
  return app.computePrediction({
    vehicles: vehicles, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
    speeds: speeds || app.DEFAULT_SPEEDS, races: races || [], odds: odds || null
  });
}

var VEH = ['SUV', 'Motorcycle', 'Car'];

// --- (a) L1: same cars + Seg 2 Dirt, SUV won 4 of 5 ---
var histL1 = [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Car')
];
var rL1 = predict(VEH, 1, 'Dirt', histL1);
console.log('  (a) L1: ' + rL1.ranked.map(function (r) { return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%'; }).join(', ') + ' | ' + rL1.dataInfo.levelLabel + ' n=' + rL1.dataInfo.matches);
check('(a) L1 fires', rL1.dataInfo.level === 1);
check('(a) L1 label names the segment + track', rL1.dataInfo.levelLabel === 'same cars + Seg 2 Dirt');
check('(a) L1 match count is 5', rL1.dataInfo.matches === 5);
check('(a) SUV is HIGH on its own data', rL1.ranked[0].vehicle === 'SUV');
check('(a) Motorcycle (0 wins) is JACKPOT', rL1.ranked[2].vehicle === 'Motorcycle');
check('(a) SUV wins recorded', rL1.ranked[0].wins === 4);
check('(a) probs sum to 1', approx(sumProbs(rL1), 1, 1e-9));
check('(a) histInfo is null (no blend)', rL1.histInfo === null);
check('(a) oddsInfo is null (no odds blend)', rL1.oddsInfo === null);
check('(a) dists still computed', rL1.dist2 && approx(Object.keys(rL1.dist2).reduce(function (s, k) { return s + rL1.dist2[k]; }, 0), 1, 1e-9));

// --- (b) L2: only 1 Seg-2-Dirt race, but 3 with Dirt anywhere ---
var histL2 = [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(VEH, ['Dirt', 'unknown', 'unknown'], 'SUV')
];
var rL2 = predict(VEH, 1, 'Dirt', histL2);
console.log('  (b) L2: ' + rL2.ranked.map(function (r) { return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%'; }).join(', ') + ' | ' + rL2.dataInfo.levelLabel + ' n=' + rL2.dataInfo.matches);
check('(b) L2 fires when L1 is short', rL2.dataInfo.level === 2);
check('(b) L2 label', rL2.dataInfo.levelLabel === 'same cars + Dirt anywhere');
check('(b) L2 match count is 3', rL2.dataInfo.matches === 3);
check('(b) SUV is HIGH from the wider Dirt data', rL2.ranked[0].vehicle === 'SUV');

// --- (c) L3: same cars, no Dirt anywhere ---
var histL3 = [
  race(VEH, ['Highway', 'unknown', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Highway', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'unknown', 'Highway'], 'SUV'),
  race(VEH, ['Potholes', 'unknown', 'unknown'], 'Motorcycle')
];
var rL3 = predict(VEH, 1, 'Dirt', histL3);
check('(c) L3 fires when no Dirt races exist', rL3.dataInfo.level === 3);
check('(c) L3 label', rL3.dataInfo.levelLabel === 'same cars');
check('(c) L3 match count is 4', rL3.dataInfo.matches === 4);
check('(c) SUV is HIGH from the same-cars data', rL3.ranked[0].vehicle === 'SUV');

// --- (d) L4: same cars only once, SUV wins elsewhere ---
var histL4 = [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'SUV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'ORV'),
  race(['SUV', 'ORV', 'Monster Truck'], ['Dirt', 'unknown', 'unknown'], 'ORV')
];
var rL4 = predict(VEH, 1, 'Dirt', histL4);
check('(d) L4 fires when same-cars data is thin', rL4.dataInfo.level === 4);
check('(d) L4 label', rL4.dataInfo.levelLabel === 'overall win rates');
check('(d) SUV is HIGH from its overall win rate', rL4.ranked[0].vehicle === 'SUV');
check('(d) overall rate recorded', approx(rL4.dataInfo.overallRates['SUV'], 7 / 9, 1e-9));
check('(d) overall appearances recorded', rL4.dataInfo.overallAppearances['SUV'] === 9);

// --- (e) threshold: exactly 1 L1 match does not fire; 2 do ---
var histT = [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV')
];
var histT1 = [race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV')];
var dOne = app.dataOnlyRank(VEH, 1, 'Dirt', histT1);
var dTwo = app.dataOnlyRank(VEH, 1, 'Dirt', histT);
var dStrict = app.dataOnlyRank(VEH, 1, 'Dirt', histT, { minMatches: 3 });
check('(e) 1 match does NOT fire L1 at the default threshold (2)', dOne.dataInfo.level !== 1);
check('(e) 2 matches DO fire L1 at the default threshold (2)', dTwo.dataInfo.level === 1);
check('(e) 2 matches do NOT fire L1 with minMatches 3', dStrict.dataInfo.level !== 1);
check('(e) default threshold is 2', app.DATA_ONLY_MIN_MATCHES === 2);
check('(e) default alpha is 2', app.DATA_ONLY_ALPHA === 2);

// --- (f) never 0% / 100% ---
// 500 races, Motorcycle appears every time and never wins.
var histBig = [];
for (var i = 0; i < 500; i++) {
  histBig.push(race(VEH, ['Dirt', 'unknown', 'unknown'], i < 300 ? 'SUV' : 'Car'));
}
var rBig = app.dataOnlyRank(VEH, null, null, histBig);
console.log('  (f) 500-race L4: ' + rBig.ranked.map(function (r) { return r.vehicle + ' ' + (r.prob * 100).toFixed(2) + '%'; }).join(', '));
check('(f) 0-win vehicle still displays at least 1% (never 0%)', Math.round(rBig.ranked.filter(function (r) { return r.vehicle === 'Motorcycle'; })[0].prob * 100) >= 1);
check('(f) top vehicle displays at most 99% (never 100%)', Math.round(rBig.ranked[0].prob * 100) <= 99);
check('(f) probs still sum to 1 after clamping', approx(rBig.ranked.reduce(function (s, r) { return s + r.prob; }, 0), 1, 1e-9));
// Small-n: 3 races, all SUV wins — smoothing must hold it under 99%.
var rSmall = app.dataOnlyRank(VEH, 1, 'Dirt', [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'SUV')
]);
check('(f) 3/3 wins is still under 99%', rSmall.ranked[0].prob < 0.99 && rSmall.ranked[0].vehicle === 'SUV');

// --- (g) backup always present + distinct ---
[rL1, rL2, rL3, rL4].forEach(function (res, i) {
  check('(g) case ' + i + ': 3 ranked vehicles', res.ranked.length === 3);
  check('(g) case ' + i + ': HIGH != MID', res.ranked[0].vehicle !== res.ranked[1].vehicle);
  check('(g) case ' + i + ': MID != JACKPOT', res.ranked[1].vehicle !== res.ranked[2].vehicle);
});

// --- (h) SUV vs Motorcycle BOTH directions (no hard-coded direction) ---
var histMoto = [
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Motorcycle'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Motorcycle'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Motorcycle'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Motorcycle'),
  race(VEH, ['unknown', 'Dirt', 'unknown'], 'Car')
];
var rMoto = predict(VEH, 1, 'Dirt', histMoto);
check('(h) when the data says Motorcycle, Motorcycle is HIGH', rMoto.ranked[0].vehicle === 'Motorcycle');
check('(h) when the data says Motorcycle, SUV is JACKPOT', rMoto.ranked[2].vehicle === 'SUV');
check('(h) when the data says SUV, SUV is HIGH', rL1.ranked[0].vehicle === 'SUV');
check('(h) when the data says SUV, Motorcycle is JACKPOT', rL1.ranked[2].vehicle === 'Motorcycle');

// --- (i) odds are IGNORED for ranking ---
var oddsA = { 'SUV': 1.2, 'Motorcycle': 9.0, 'Car': 5.0 };
var oddsB = { 'SUV': 9.0, 'Motorcycle': 1.2, 'Car': 5.0 };
var rOddsA = predict(VEH, 1, 'Dirt', histL1, oddsA);
var rOddsB = predict(VEH, 1, 'Dirt', histL1, oddsB);
var rNoOdds = predict(VEH, 1, 'Dirt', histL1, null);
check('(i) wildly different odds give the identical ranking', JSON.stringify(rOddsA.ranked) === JSON.stringify(rOddsB.ranked));
check('(i) no odds gives the identical ranking', JSON.stringify(rOddsA.ranked) === JSON.stringify(rNoOdds.ranked));
check('(i) oddsInfo stays null even with odds passed', rOddsA.oddsInfo === null);

// --- (j) speeds are IGNORED for ranking ---
var fastMoto = JSON.parse(JSON.stringify(app.DEFAULT_SPEEDS));
Object.keys(fastMoto['Motorcycle']).forEach(function (t) { fastMoto['Motorcycle'][t] = 999; });
Object.keys(fastMoto['SUV']).forEach(function (t) { fastMoto['SUV'][t] = 1; });
var rFast = predict(VEH, 1, 'Dirt', histL1, null, fastMoto);
check('(j) making Motorcycle 999x faster changes nothing', JSON.stringify(rFast.ranked) === JSON.stringify(rNoOdds.ranked));

// --- (k) no races: honest uniform, level 4, never 0/100 ---
var rEmpty = predict(VEH, 1, 'Dirt', []);
check('(k) no races -> level 4', rEmpty.dataInfo.level === 4);
check('(k) no races -> uniform 1/3 each', rEmpty.ranked.every(function (r) { return approx(r.prob, 1 / 3, 1e-9); }));
check('(k) no races -> probs sum to 1', approx(sumProbs(rEmpty), 1, 1e-9));
check('(k) no races -> input order is the tie-break', rEmpty.ranked[0].vehicle === 'SUV');

// --- (l) buildDataReason texts ---
check('(l) reason for an L1 winner names wins + n', app.buildDataReason('SUV', rL1.dataInfo) === 'Won 4 of 5 same cars + Seg 2 Dirt races');
check('(l) reason for an L1 zero-win names the gap', app.buildDataReason('Motorcycle', rL1.dataInfo).indexOf('No wins in 5 same cars + Seg 2 Dirt races') === 0);
check('(l) reason for L4 names the overall rate', app.buildDataReason('SUV', rL4.dataInfo).indexOf('Overall win rate 78% across 9 races') === 0);

// --- (m) liveBetStatusText: every state says WHY ---
check('(m) stale names the age + Reader', app.liveBetStatusText('stale', 127).indexOf('127s') !== -1 && app.liveBetStatusText('stale', 127).indexOf('Reader') !== -1);
check('(m) none names the Reader', app.liveBetStatusText('none').indexOf('Reader') !== -1);
check('(m) no-known-track names the missing track', app.liveBetStatusText('no-known-track').indexOf('no track') !== -1);
check('(m) vehicles names the unreadable bet', app.liveBetStatusText('vehicles').indexOf("can't read") !== -1);
check('(m) signed-out asks to sign in', app.liveBetStatusText('signed-out').indexOf('Sign in') !== -1);
check('(m) error names the connection', app.liveBetStatusText('error').indexOf('connection') !== -1);
check('(m) fresh falls back to waiting', app.liveBetStatusText('fresh').indexOf('waiting') !== -1);
check('(m) START wait window is 5s', app.LIVE_START_WAIT_MS === 5000);

// --- (n) async: liveBetStatus (no Supabase in Node) + the waiter ---
var asyncChecks = [];
asyncChecks.push(app.liveBetStatus().then(function (s) {
  check('(n) liveBetStatus with no client is signed-out', s.state === 'signed-out' && s.ageSeconds === null);
}));
// Sequence the waiter checks: the notify test first, THEN the timeout
// test — notifyLiveWaiters wakes every waiter registered at the time,
// so the two must not overlap.
var waiterChain = new Promise(function (resolve) {
  var p = app.waitForLiveBet(5000);
  setTimeout(function () { app.notifyLiveWaiters('ran'); }, 10);
  p.then(function (v) {
    check('(n) waiter wakes when a live bet runs', v === 'ran');
    resolve();
  });
}).then(function () {
  return app.waitForLiveBet(30).then(function (v) {
    check('(n) waiter times out with false when no bet arrives', v === false);
  });
});
asyncChecks.push(waiterChain);

Promise.all(asyncChecks).then(function () {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
});
