// Tests for lrp-v23: live dedup fix — EVERY fresh live bet auto-runs.
//
// What broke (user report, voice call 24 Nov ~17:50 PKT): while recording
// a client demo video, the Predictor showed only 1-2 live batches, then
// live stopped — never more than 2 consecutive live batches — even
// though the Reader kept sending bets and races kept saving. Connected
// but no data, batches late or missing entirely.
//
// Root cause (verified against the real traffic): the v17 dedup rule
// (isNewLiveBet) needed a 40 s updated_at gap, a different line-up, or
// a timer reset to call two same-key rows different bets. The real
// game deals new bet screens ~9 s apart with IDENTICAL line-ups and a
// NULL timer (17:46 PKT 24 Nov: Sports Car / Stock Car / SUV,
// Dirt/unknown/unknown, timer NULL, races every ~9 s) — so after the
// first 1-2 bets every later bet failed all three tests and was
// dropped as a 'duplicate'.
//
// The v23 fix: live_bets holds ONE row per user, upserted only when
// the Reader SENDs a new bet screen or UPDATEs on a real change — so
// ANY strictly-newer updated_at is a new bet. The same updated_at is
// still the same row re-delivered (Realtime + 4 s poll + START fetch
// all see the same row) and stays a duplicate. The timer reset is now
// only a fallback when either side has no usable timestamp.
//
// These tests cover the PURE logic only (no DOM, no Supabase) and
// replay the real 24 Nov traffic pattern through decideLiveBet — the
// single decision point both the Realtime event and the 4 s poll use.
// Run from the repo root:
//   node scripts/test-lrp-v23.js
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

var NOW = Date.now();
function resetPred() {
  app.pred.vehicles = [];
  app.pred.seg1 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg2 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg3 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.odds = {};
  app.wizard.step = 0; app.wizard.ran = false; app.wizard.lastRun = null;
  app.wizard.feedback = null; app.wizard.feedbackSaved = false; app.wizard.feedbackSaving = false;
}
function showRun(row) {
  // Simulate the displayed run: the previous identical bet is on screen.
  app.wizard.ran = true;
  app.wizard.lastRun = {
    vehicles: row.vehicles.slice(),
    tracks: row.tracks.slice(),
    result: { ranked: [{ vehicle: 'ORV' }, { vehicle: 'SUV' }, { vehicle: 'Monster Truck' }] }
  };
}
function lastBetFrom(row) {
  return {
    key: app.liveBetKey(row),
    updatedAtMs: Date.parse(row.updated_at),
    timerSeconds: row.timer_seconds
  };
}

(function main() {
  check('v23 live helpers exported (no 40s gap constant any more)',
    typeof app.isNewLiveBet === 'function' &&
    typeof app.decideLiveBet === 'function' &&
    app.APP_VERSION === 'v24' &&
    typeof app.LIVE_NEW_BET_GAP_MS === 'undefined');

  // --- (a) REPLAY of the real 24 Nov traffic ---------------------------
  // 6 consecutive bets, ~9 s apart, same vehicles every time, timer
  // NULL (the Reader could not read it). Bets 2-4 and 6 share the
  // exact same key (Dirt/Dirt/Dirt) — exactly the 17:45-17:47 PKT
  // burst (races every ~9 s, Sports Car / Stock Car / SUV).
  // Under v17/v22 bets 3, 4 and 6 were dropped as 'duplicate' (same
  // key, 9 s gap < 40 s, no timer reset). Under v23 every one must run.
  resetPred();
  var lastBet = null;
  var ran = 0;
  var trackSets = [
    ['Dirt', 'unknown', 'unknown'],
    ['Dirt', 'Dirt', 'Dirt'],
    ['Dirt', 'Dirt', 'Dirt'],
    ['Dirt', 'Dirt', 'Dirt'],
    ['unknown', 'unknown', 'unknown'], // all-unknown row: rejected, not a bet
    ['Dirt', 'Dirt', 'Dirt']
  ];
  for (var i = 0; i < trackSets.length; i++) {
    var atMs = NOW - 2000 + i * 9000;
    var row = {
      vehicles: ['Sports Car', 'Stock Car', 'SUV'],
      tracks: trackSets[i],
      timer_seconds: null,
      odds: {},
      updated_at: new Date(atMs).toISOString(),
      created_at: new Date(atMs).toISOString()
    };
    var d = app.decideLiveBet(row, true, atMs + 2000, lastBet);
    if (i === 4) {
      check('replay bet ' + (i + 1) + ' (all tracks unknown) is ignored, not run',
        d.action === 'ignore' && d.reason === 'no-known-track');
      continue;
    }
    if (d.action === 'run') {
      ran++;
      lastBet = lastBetFrom(row); // what handleLiveBetInner records
      showRun(row); // the run is now on screen
    }
    resetPred();
    if (lastBet) showRun(row);
  }
  check('replay: 5 of 5 real bets auto-run (6th row was all-unknown)',
    ran === 5);

  // --- (b) The same row re-delivered is STILL a duplicate --------------
  // Realtime event + 4 s poll + START fetch all see the same row: the
  // same updated_at must never re-run. This is the duplicate
  // protection v23 keeps.
  resetPred();
  var betA = {
    vehicles: ['Sports Car', 'Stock Car', 'SUV'],
    tracks: ['Dirt', 'unknown', 'unknown'],
    timer_seconds: null,
    odds: {},
    updated_at: new Date(NOW - 2000).toISOString(),
    created_at: new Date(NOW - 2000).toISOString()
  };
  var first = app.decideLiveBet(betA, true, NOW, null);
  check('first delivery of a bet runs', first.action === 'run');
  var lb = lastBetFrom(betA);
  showRun(betA);
  var redelivered = app.decideLiveBet(betA, true, NOW + 4000, lb);
  check('same row re-delivered (same updated_at, poll 4s later) is a duplicate',
    redelivered.action === 'ignore' && redelivered.reason === 'duplicate');
  var redelivered2 = app.decideLiveBet(betA, true, NOW + 8000, lb);
  check('same row re-delivered again (Realtime re-fire) is a duplicate',
    redelivered2.action === 'ignore' && redelivered2.reason === 'duplicate');

  // --- (c) isNewLiveBet boundaries -------------------------------------
  resetPred();
  check('isNewLiveBet: 1 ms newer updated_at is new',
    app.isNewLiveBet(
      { vehicles: ['Sports Car', 'Stock Car', 'SUV'], tracks: ['Dirt', 'unknown', 'unknown'], timer_seconds: null, updated_at: new Date(NOW - 1999).toISOString() },
      { key: app.liveBetKey(betA), updatedAtMs: NOW - 2000, timerSeconds: null }) === true);
  check('isNewLiveBet: older updated_at is NOT new',
    app.isNewLiveBet(
      { vehicles: ['Sports Car', 'Stock Car', 'SUV'], tracks: ['Dirt', 'unknown', 'unknown'], timer_seconds: null, updated_at: new Date(NOW - 3000).toISOString() },
      { key: app.liveBetKey(betA), updatedAtMs: NOW - 2000, timerSeconds: null }) === false);
  var noTsRow = { vehicles: ['ORV', 'SUV', 'Monster Truck'], tracks: ['unknown', 'Dirt', 'unknown'], timer_seconds: 34 };
  var noTsKey = app.liveBetKey(noTsRow);
  check('isNewLiveBet: no timestamp on the new row + timer reset is new',
    app.isNewLiveBet(noTsRow,
      { key: noTsKey, updatedAtMs: null, timerSeconds: 20 }) === true);
  var noTsRow2 = { vehicles: ['ORV', 'SUV', 'Monster Truck'], tracks: ['unknown', 'Dirt', 'unknown'], timer_seconds: 25 };
  check('isNewLiveBet: no timestamp on either side + no reset is a duplicate',
    app.isNewLiveBet(noTsRow2,
      { key: noTsKey, updatedAtMs: null, timerSeconds: 33 }) === false);

  // --- (d) The 17:46 real bet after the 23 Nov bet ----------------------
  // Last live bet 23 Nov 13:49 (Supercar/ATV/SUV, Desert); the next one
  // 24 Nov 17:46 (Sports Car/Stock Car/SUV, Dirt, timer NULL). Different
  // line-up, ~28 h apart: must run.
  resetPred();
  var oldBet = {
    vehicles: ['Supercar', 'ATV', 'SUV'],
    tracks: ['Desert', 'unknown', 'unknown'],
    timer_seconds: null,
    odds: {},
    updated_at: '2026-11-23T08:49:38.000Z',
    created_at: '2026-11-23T08:49:38.000Z'
  };
  var newBet = {
    vehicles: ['Sports Car', 'Stock Car', 'SUV'],
    tracks: ['Dirt', 'unknown', 'unknown'],
    timer_seconds: null,
    odds: {},
    updated_at: '2026-11-24T12:46:28.799Z',
    created_at: '2026-11-24T12:46:28.799Z'
  };
  check('17:46 live bet runs after the 23 Nov bet (different line-up)',
    app.decideLiveBet(newBet, true, Date.parse('2026-11-24T12:46:30.000Z'), lastBetFrom(oldBet)).action === 'run');

  // --- (e) Guards that must NOT change ----------------------------------
  resetPred();
  check('stale row still ignored even with a newer updated_at',
    app.decideLiveBet(
      { vehicles: ['Sports Car', 'Stock Car', 'SUV'], tracks: ['Dirt', 'unknown', 'unknown'], timer_seconds: null, updated_at: new Date(NOW - 61000).toISOString() },
      true, NOW, lastBetFrom(betA)).reason === 'stale');
  resetPred();
  check('premium gate still wins (access denied -> premium, not run)',
    app.decideLiveBet(betA, false, NOW, null).action === 'premium');
  resetPred();
  check('legacy string lastKey still dedups an identical bet',
    app.decideLiveBet(betA, true, NOW, app.liveBetKey(betA)).reason === 'duplicate');

  finish();
})();
