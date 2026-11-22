// Tests for lrp-v18: START-immediate + the HIGH/JACKPOT inversion
// regression tests.
//   (a) START-immediate: pressing START first pulls the latest live bet
//       and runs it at once; with no fresh live bet it says so plainly
//       and goes to manual picking. startLiveDecision is the pure
//       decider; handleLiveBet now returns 'ran' | 'shown' | false so
//       START knows whether a live result is on screen.
//   (b) Inversion regression: the ranking semantics the 23 Nov live
//       report questioned — HIGH must be the fastest / most likely
//       vehicle, JACKPOT the slowest / least likely. The replay
//       (scripts/replay-live-inversion.js, 346 saved races, live
//       conditions: one segment pinned) found NO inversion — HIGH won
//       50.3% of races, JACKPOT 18.9% — so these tests pin the correct
//       direction: if anyone ever flips the sort or the labels, they
//       fail. No label/sort change was made in v18.
// Run from the repo root:
//   node scripts/test-lrp-v18.js
// Exit code 0 = all pass, 1 = any failure.
'use strict';
var path = require('path');
var app = require(path.join(__dirname, '..', 'js', 'app.js'));

var passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log('PASS  ' + name); }
  else { failed++; console.log('FAIL  ' + name); }
}
function finish() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed ? 1 : 0);
}

/* ---- (a) startLiveDecision: pure truth table -------------------------- */
check('start: live on + signed in + access + ran -> live',
  app.startLiveDecision(true, true, true, 'ran') === 'live');
check('start: live on + signed in + access + shown -> live',
  app.startLiveDecision(true, true, true, 'shown') === 'live');
check('start: live on + signed in + access + no bet -> manual',
  app.startLiveDecision(true, true, true, false) === 'manual');
check('start: live off + ran -> manual (toggle off beats a live bet)',
  app.startLiveDecision(false, true, true, 'ran') === 'manual');
check('start: signed out + ran -> manual',
  app.startLiveDecision(true, false, true, 'ran') === 'manual');
check('start: no access + ran -> manual',
  app.startLiveDecision(true, true, false, 'ran') === 'manual');
check('start: no access + shown -> manual',
  app.startLiveDecision(true, true, false, 'shown') === 'manual');
check('start: everything off -> manual',
  app.startLiveDecision(false, false, false, false) === 'manual');

/* ---- (b) inversion regression: ranking semantics ---------------------- */
// NOTE: the one-track rule (oneTrackHints) keeps only the FIRST pinned
// segment — a test must pin exactly one segment, as live play does.
// Pinning all three is silently reduced to one pin, so these tests pin
// seg2 (the longest segment, 51%) where the fastest vehicle is
// unambiguous. If anyone ever flips the sort or the labels, they fail.
function pinSeg2(track) {
  return {
    seg1Hint: { mode: 'unknown', track: null, chance: 50 },
    seg2Hint: { mode: 'pin', track: track, chance: 100 },
    seg3Hint: { mode: 'unknown', track: null, chance: 50 }
  };
}
var dirtPin = pinSeg2('Dirt');
var dirtRes = app.computePrediction({
  vehicles: ['ORV', 'SUV', 'Monster Truck'],
  seg1Hint: dirtPin.seg1Hint, seg2Hint: dirtPin.seg2Hint, seg3Hint: dirtPin.seg3Hint,
  speeds: app.DEFAULT_SPEEDS, races: []
});
check('rank: pin seg2 Dirt, fastest on Dirt (SUV 134) is HIGH',
  dirtRes.ranked[0].vehicle === 'SUV');
check('rank: pin seg2 Dirt, slowest on Dirt (Monster Truck 66) is JACKPOT',
  dirtRes.ranked[2].vehicle === 'Monster Truck');
var desertPin = pinSeg2('Desert');
var desertRes = app.computePrediction({
  vehicles: ['Supercar', 'Car', 'ATV'],
  seg1Hint: desertPin.seg1Hint, seg2Hint: desertPin.seg2Hint, seg3Hint: desertPin.seg3Hint,
  speeds: app.DEFAULT_SPEEDS, races: []
});
check('rank: pin seg2 Desert, fastest on Desert (ATV 72) is HIGH',
  desertRes.ranked[0].vehicle === 'ATV');
check('rank: pin seg2 Desert, slowest on Desert (Supercar 40) is JACKPOT',
  desertRes.ranked[2].vehicle === 'Supercar');
check('rank: ranked is sorted by probability, highest first',
  desertRes.ranked[0].prob >= desertRes.ranked[1].prob &&
  desertRes.ranked[1].prob >= desertRes.ranked[2].prob);
check('labels: rankName(1)=HIGH, (2)=MID, (3)=JACKPOT',
  app.rankName(1) === 'HIGH' && app.rankName(2) === 'MID' && app.rankName(3) === 'JACKPOT');
check('labels: suggestion line puts ranked[0] after HIGH and ranked[2] after JACKPOT',
  app.suggestionLine([
    { vehicle: 'Alpha', prob: 0.5 },
    { vehicle: 'Beta', prob: 0.3 },
    { vehicle: 'Gamma', prob: 0.2 }
  ]) === 'Suggested bet: HIGH — Alpha · MID — Beta · JACKPOT — Gamma');
// Live-condition single pin, same setup as the handleLiveBet test below.
var onePin = app.computePrediction({
  vehicles: ['ORV', 'SUV', 'Monster Truck'],
  seg1Hint: { mode: 'unknown', track: null, chance: 50 },
  seg2Hint: { mode: 'pin', track: 'Dirt', chance: 100 },
  seg3Hint: { mode: 'unknown', track: null, chance: 50 },
  speeds: app.DEFAULT_SPEEDS, races: []
});
check('rank: one pin (seg2 Dirt), fastest on Dirt (SUV 134) is HIGH',
  onePin.ranked[0].vehicle === 'SUV');
check('rank: one pin (seg2 Dirt), slowest on Dirt (Monster Truck 66) is JACKPOT',
  onePin.ranked[2].vehicle === 'Monster Truck');

/* ---- (c) handleLiveBet return contract (needs a minimal DOM) --------- */
// The app module was required without a document (as the other test
// files do), so init() never ran. Stub just enough DOM for the live
// auto-drive path (renders + showTab + toast) after the fact.
function fakeEl() {
  return {
    textContent: '', innerHTML: '', value: '', disabled: false,
    checked: false, className: '',
    classList: { add: function () {}, remove: function () {}, toggle: function () {} },
    style: {},
    setAttribute: function () {}, getAttribute: function () { return null; },
    addEventListener: function () {}, appendChild: function () {},
    querySelector: function () { return null; },
    querySelectorAll: function () { return []; }
  };
}
global.window = { scrollTo: function () {} };
global.document = {
  getElementById: function () { return fakeEl(); },
  querySelectorAll: function () { return []; },
  querySelector: function () { return null; },
  createElement: function () { return fakeEl(); },
  addEventListener: function () {}
};

var NOW = Date.now();
function freshRow(over) {
  var row = {
    vehicles: ['ORV', 'SUV', 'Monster Truck'],
    tracks: ['unknown', 'Dirt', 'unknown'],
    timer_seconds: null,
    odds: {},
    updated_at: new Date(NOW - 5000).toISOString(),
    created_at: new Date(NOW - 5000).toISOString()
  };
  if (over) Object.keys(over).forEach(function (k) { row[k] = over[k]; });
  return row;
}
function resetWizard() {
  app.wizard.step = 0; app.wizard.ran = false; app.wizard.lastRun = null;
  app.wizard.feedback = null; app.wizard.feedbackSaved = false; app.wizard.feedbackSaving = false;
  app.pred.vehicles = [];
  app.pred.seg1 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg2 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg3 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.odds = {};
}

resetWizard();
var r1 = app.handleLiveBet(freshRow());
check('live: fresh valid row auto-runs and returns "ran"', r1 === 'ran');
check('live: after "ran" the wizard is on step 3 with a run',
  app.wizard.step === 3 && app.wizard.ran === true && !!app.wizard.lastRun);
check('live: after "ran" the run is the row\'s vehicles + pin (SUV fastest on Dirt -> HIGH)',
  app.wizard.lastRun.vehicles.join('|') === 'ORV|SUV|Monster Truck' &&
  app.wizard.lastRun.result.ranked[0].vehicle === 'SUV');
var r2 = app.handleLiveBet(freshRow());
check('live: same row again returns "shown" (result already on screen)', r2 === 'shown');
check('live: after "shown" the wizard is still on step 3',
  app.wizard.step === 3 && app.wizard.ran === true);
check('live: stale row (>60s) returns false',
  app.handleLiveBet(freshRow({ updated_at: new Date(NOW - 120000).toISOString() })) === false);
check('live: row with 2 vehicles returns false',
  app.handleLiveBet(freshRow({ vehicles: ['ORV', 'SUV'] })) === false);
check('live: row with no known track returns false',
  app.handleLiveBet(freshRow({ tracks: ['unknown', 'unknown', 'unknown'] })) === false);
var r3 = app.handleLiveBet(freshRow({
  vehicles: ['Supercar', 'Car', 'ATV'],
  tracks: ['Expressway', 'unknown', 'unknown']
}));
check('live: a different fresh row auto-runs again and returns "ran"', r3 === 'ran');
check('live: the new run replaces the old one',
  app.wizard.lastRun.vehicles.join('|') === 'Supercar|Car|ATV' &&
  app.wizard.step === 3 && app.wizard.ran === true);
// fetchLatestLiveBet with no Supabase client (demo / Node) -> false.
app.fetchLatestLiveBet().then(function (v) {
  check('live: fetchLatestLiveBet with no client returns false', v === false);
  finish();
}).catch(function () {
  check('live: fetchLatestLiveBet with no client returns false', false);
  finish();
});
