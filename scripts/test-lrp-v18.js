// Tests for lrp-v18: START-immediate + the HIGH/JACKPOT inversion
// regression tests.
//   (a) START-immediate: pressing START first pulls the latest live bet
//       and runs it at once; with no fresh live bet it says so plainly
//       and goes to manual picking. startLiveDecision is the pure
//       decider; handleLiveBet now returns 'ran' | 'shown' | false so
//       START knows whether a live result is on screen.
//   (b) Ranking semantics (lrp-v19: DATA-ONLY): HIGH must be the
//       vehicle with the best empirical record at the finest matching
//       level, JACKPOT the worst. No speeds, no odds — if anyone ever
//       flips the sort or the labels, or reintroduces speeds/odds into
//       the ranking, these fail. (v18's physics-based version of this
//       section is superseded: the old model scored HIGH 50.3% /
//       top-2 81.1% on the 346-race replay, but the user ordered a
//       purely data-based ranking, so the direction is now pinned by
//       the data itself.)
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
// These tests pin seg2 with a synthetic history where the winner split
// is known exactly, so the expected HIGH/JACKPOT comes from the data.
function pinSeg2(track) {
  return {
    seg1Hint: { mode: 'unknown', track: null, chance: 50 },
    seg2Hint: { mode: 'pin', track: track, chance: 100 },
    seg3Hint: { mode: 'unknown', track: null, chance: 50 }
  };
}
function histFor(vehicles, pinSeg, track, wins) {
  // wins: { vehicle: count } — races with the given pin, same vehicles.
  var out = [];
  Object.keys(wins).forEach(function (v) {
    for (var i = 0; i < wins[v]; i++) {
      var tracks = ['unknown', 'unknown', 'unknown'];
      tracks[pinSeg] = track;
      out.push({ vehicles: vehicles.slice(), tracks: tracks, winner: v, how_won: 'Other', how_won_text: '' });
    }
  });
  return out;
}
var dirtPin = pinSeg2('Dirt');
var dirtRes = app.computePrediction({
  vehicles: ['ORV', 'SUV', 'Monster Truck'],
  seg1Hint: dirtPin.seg1Hint, seg2Hint: dirtPin.seg2Hint, seg3Hint: dirtPin.seg3Hint,
  speeds: app.DEFAULT_SPEEDS, races: histFor(['ORV', 'SUV', 'Monster Truck'], 1, 'Dirt', { 'SUV': 4, 'Monster Truck': 1 })
});
check('rank: pin seg2 Dirt, SUV won 4/5 in the data -> HIGH',
  dirtRes.ranked[0].vehicle === 'SUV');
check('rank: pin seg2 Dirt, Monster Truck won 1/5 -> MID (ORV, 0 wins, is JACKPOT)',
  dirtRes.ranked[1].vehicle === 'Monster Truck' && dirtRes.ranked[2].vehicle === 'ORV');
check('rank: data level is L1 with n=5',
  dirtRes.dataInfo.level === 1 && dirtRes.dataInfo.matches === 5);
var desertPin = pinSeg2('Desert');
var desertRes = app.computePrediction({
  vehicles: ['Supercar', 'Car', 'ATV'],
  seg1Hint: desertPin.seg1Hint, seg2Hint: desertPin.seg2Hint, seg3Hint: desertPin.seg3Hint,
  speeds: app.DEFAULT_SPEEDS, races: histFor(['Supercar', 'Car', 'ATV'], 1, 'Desert', { 'ATV': 4, 'Car': 1 })
});
check('rank: pin seg2 Desert, ATV won 4/5 in the data -> HIGH',
  desertRes.ranked[0].vehicle === 'ATV');
check('rank: pin seg2 Desert, Supercar won 0/5 -> JACKPOT',
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
// With NO saved races the honest answer is uniform — speeds must NOT
// invent a HIGH on their own.
var onePin = app.computePrediction({
  vehicles: ['ORV', 'SUV', 'Monster Truck'],
  seg1Hint: { mode: 'unknown', track: null, chance: 50 },
  seg2Hint: { mode: 'pin', track: 'Dirt', chance: 100 },
  seg3Hint: { mode: 'unknown', track: null, chance: 50 },
  speeds: app.DEFAULT_SPEEDS, races: []
});
check('rank: one pin (seg2 Dirt) with NO saved races -> uniform 1/3, no invented HIGH',
  onePin.ranked.every(function (r) { return Math.abs(r.prob - 1 / 3) < 1e-9; }));
check('rank: speeds alone do NOT make SUV HIGH (SUV is 2nd by input order)',
  onePin.ranked[0].vehicle === 'ORV' && onePin.ranked[1].vehicle === 'SUV');

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
check('live: after "ran" the run is the row\'s vehicles + pin (data-only: no history -> uniform, input order first)',
  app.wizard.lastRun.vehicles.join('|') === 'ORV|SUV|Monster Truck' &&
  app.wizard.lastRun.result.ranked[0].vehicle === 'ORV' &&
  app.wizard.lastRun.result.dataInfo && app.wizard.lastRun.result.dataInfo.level === 4);
check('live: after "ran" the run\'s probs sum to 1',
  Math.abs(app.wizard.lastRun.result.ranked.reduce(function (s, r) { return s + r.prob; }, 0) - 1) < 1e-9);
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
