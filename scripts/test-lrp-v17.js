// Tests for lrp-v17: LIVE auto-predict — age-adjusted countdown, LATE
// marking, and the manual-run guard.
// What v17 adds on top of v16 (see scripts/test-lrp-v16.js):
//   (a) the shown countdown is age-adjusted: timer_seconds minus the
//       time since updated_at (liveRemainingSeconds) — a bet read at
//       33s but delivered 8s later really has 25s left, not 33;
//   (b) a bet arriving with under 10s left is still predicted but
//       flagged late (decideLiveBet run decision carries late: true);
//   (c) a live bet never clobbers a manual run in progress (wizard
//       steps 1–2) — decideLiveBet ignores it as 'manual-busy' and the
//       caller shows a small notice instead.
//       REMOVED in lrp-v21 (23 Nov 2026): that guard is what dropped
//       live bets the user was waiting for — START fell through to
//       step 1, the user started picking, the bet arrived and was
//       thrown away. A live bet now ALWAYS wins over an unfinished
//       manual pick; the (c) checks below assert the new behaviour.
//       The manual-busy branch and isManualRunInProgress are deleted;
//       see scripts/test-lrp-v21.js for the full v21 coverage.
// These tests cover the PURE logic only (no DOM, no Supabase). The
// Realtime subscription, the DOM auto-drive (handleLiveBet) and the
// visible LATE note are wiring — verified by hand in the browser.
// Run from the repo root:
//   node scripts/test-lrp-v17.js
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
function freshRow(over) {
  var row = {
    vehicles: ['ORV', 'SUV', 'Monster Truck'],
    tracks: ['unknown', 'Dirt', 'unknown'],
    timer_seconds: 33,
    odds: { ORV: 2.3 },
    updated_at: new Date(NOW - 5000).toISOString(),
    created_at: new Date(NOW - 5000).toISOString()
  };
  if (over) Object.keys(over).forEach(function (k) { row[k] = over[k]; });
  return row;
}
function resetPred() {
  app.pred.vehicles = [];
  app.pred.seg1 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg2 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.seg3 = { mode: 'unknown', track: null, chance: 50 };
  app.pred.odds = {};
  app.wizard.step = 0; app.wizard.ran = false; app.wizard.lastRun = null;
  app.wizard.feedback = null; app.wizard.feedbackSaved = false; app.wizard.feedbackSaving = false;
}

(function main() {
  check('v17 live helpers exported',
    typeof app.liveRemainingSeconds === 'function' &&
    app.LIVE_LATE_SECONDS === 10);

  // --- (a) liveRemainingSeconds: age-adjusted countdown ---
  check('remaining = timer minus age (33s read 5s ago -> 28)',
    app.liveRemainingSeconds(freshRow(), NOW) === 28);
  check('remaining null when timer_seconds is null',
    app.liveRemainingSeconds(freshRow({ timer_seconds: null }), NOW) === null);
  check('remaining null for a stale row (61s old)',
    app.liveRemainingSeconds(freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), NOW) === null);
  check('remaining floors at 0 once the timer ran out (10s read 30s ago)',
    app.liveRemainingSeconds(freshRow({ timer_seconds: 10, updated_at: new Date(NOW - 30000).toISOString() }), NOW) === 0);
  check('remaining falls back to raw timer when updated_at is missing',
    app.liveRemainingSeconds(freshRow({ updated_at: undefined, created_at: undefined }), NOW) === 33);
  check('remaining uses created_at when updated_at is missing',
    app.liveRemainingSeconds(freshRow({ updated_at: undefined, created_at: new Date(NOW - 5000).toISOString() }), NOW) === 28);

  // --- (a) validateLiveBet carries the age-adjusted value ---
  var v = app.validateLiveBet(freshRow(), NOW);
  check('validateLiveBet keeps raw timerSeconds (33)',
    v.ok && v.timerSeconds === 33);
  check('validateLiveBet carries remainingSeconds (28)',
    v.ok && v.remainingSeconds === 28);

  // --- (b) LATE marking on the decideLiveBet run decision ---
  resetPred();
  var late = app.decideLiveBet(
    freshRow({ timer_seconds: 8, updated_at: new Date(NOW - 2000).toISOString() }), true, NOW, '');
  check('bet with 6s left still runs but is flagged late',
    late.action === 'run' && late.late === true && late.remainingSeconds === 6);
  resetPred();
  var onTime = app.decideLiveBet(freshRow(), true, NOW, '');
  check('bet with 28s left runs and is NOT late',
    onTime.action === 'run' && onTime.late === false && onTime.remainingSeconds === 28);
  resetPred();
  var boundaryOk = app.decideLiveBet(
    freshRow({ timer_seconds: 12, updated_at: new Date(NOW - 2000).toISOString() }), true, NOW, '');
  check('exactly 10s left is NOT late (boundary)',
    boundaryOk.action === 'run' && boundaryOk.late === false && boundaryOk.remainingSeconds === 10);
  resetPred();
  var boundaryLate = app.decideLiveBet(
    freshRow({ timer_seconds: 11, updated_at: new Date(NOW - 2000).toISOString() }), true, NOW, '');
  check('9s left IS late (boundary)',
    boundaryLate.action === 'run' && boundaryLate.late === true && boundaryLate.remainingSeconds === 9);
  resetPred();
  var noTimer = app.decideLiveBet(freshRow({ timer_seconds: null }), true, NOW, '');
  check('no timer at all: runs, not late (nothing to be late against)',
    noTimer.action === 'run' && noTimer.late === false && noTimer.remainingSeconds === null);

  // --- (c) lrp-v21: the manual-busy drop is GONE. A live bet always
  // wins over an unfinished manual pick (steps 1–2, no run yet) —
  // the pick is for the same race and is at most 4 taps, while
  // dropping the bet is the failure the user reported. ---
  resetPred();
  app.wizard.step = 1;
  app.pred.vehicles = ['ORV']; // mid-pick: 1 vehicle chosen, no run yet
  check('live bet RUNS while wizard is mid-pick on step 1 (v21: no manual-busy drop)',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'run');
  resetPred();
  app.wizard.step = 2; // pinning the track, no run yet
  app.pred.vehicles = ['ORV', 'SUV', 'Monster Truck'];
  check('live bet RUNS while wizard is on step 2 pinning (v21: no manual-busy drop)',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'run');
  resetPred();
  check('premium gate still wins (access denied -> premium, not run)',
    app.decideLiveBet(freshRow(), false, NOW, '').action === 'premium');
  check('a stale row is still reported stale',
    app.decideLiveBet(
      freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), true, NOW, '').reason === 'stale');
  resetPred();
  // ...but a MANUAL RUN of the same line-up still stays ignored
  // ('already-shown'): the user already has this exact prediction on
  // screen, so re-running it would be pointless churn. That dedup is
  // NOT the manual-busy guard — it stays.
  app.wizard.ran = true;
  app.wizard.lastRun = { vehicles: ['ORV', 'SUV', 'Monster Truck'], tracks: ['unknown', 'Dirt', 'unknown'] };
  check('manual RUN of the same line-up stays already-shown (dedup, not manual-busy)',
    (function () {
      var d = app.decideLiveBet(freshRow(), true, NOW, '');
      return d.action === 'ignore' && d.reason === 'already-shown';
    })());
  resetPred();

  // --- (d) consecutive identical bets: dedup must NOT swallow the 2nd ---
  // The bug: two consecutive bets with the SAME 3 vehicles + the SAME
  // shown track share one liveBetKey, so the 2nd was ignored as a
  // 'duplicate' and the user missed a prediction (~1 in 500 bets).
  // The fix (isNewLiveBet): the same line-up is a NEW bet when
  //   (b) updated_at is >= LIVE_NEW_BET_GAP_MS (40 s) newer than the
  //       last processed row — one bet screen lives at most 35 s, so
  //       two updates of the SAME screen can never be that far apart;
  //   (c) the timer jumped back up near 35 after counting down
  //       (timer reset = a fresh bet screen appeared).
  // A same-bet refresh (small gap, decreasing timer) must still NOT
  // re-run. decideLiveBet takes the full last-bet record as an object
  // { key, updatedAtMs, timerSeconds } (handleLiveBet's liveLastBet);
  // a bare string key keeps the legacy key-only behaviour (v16).
  check('new dedup helpers exported',
    typeof app.isNewLiveBet === 'function' &&
    typeof app.liveRowUpdatedAtMs === 'function' &&
    app.LIVE_NEW_BET_GAP_MS === 40000 &&
    app.LIVE_TIMER_RESET_MIN === 30 &&
    app.LIVE_TIMER_RESET_JUMP === 5);
  function lastBetFrom(row) {
    return {
      key: app.liveBetKey(row),
      updatedAtMs: Date.parse(row.updated_at),
      timerSeconds: row.timer_seconds
    };
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
  // (b) gap: bet 1 read at 33s, bet 2 (identical) 68s later at 34s.
  resetPred();
  var bet1 = freshRow({ timer_seconds: 33, updated_at: new Date(NOW - 5000).toISOString() });
  showRun(bet1);
  var bet2gap = freshRow({
    timer_seconds: 34,
    updated_at: new Date(NOW + 63000).toISOString()
  });
  check('consecutive identical bet runs when updated_at gap is 68s',
    app.decideLiveBet(bet2gap, true, NOW + 66000, lastBetFrom(bet1)).action === 'run');
  // (c) timer reset: bet 1 last seen mid-screen at 20s; bet 2 (identical)
  // 30s later — gap under 40s — but the timer is back at 34s.
  resetPred();
  var bet1mid = freshRow({ timer_seconds: 20, updated_at: new Date(NOW - 5000).toISOString() });
  showRun(bet1mid);
  var bet2reset = freshRow({
    timer_seconds: 34,
    updated_at: new Date(NOW + 25000).toISOString()
  });
  check('consecutive identical bet runs on timer reset (30s gap, 20s -> 34s)',
    app.decideLiveBet(bet2reset, true, NOW + 28000, lastBetFrom(bet1mid)).action === 'run');
  // Same-bet refresh: 8s later, timer 33 -> 25, same line-up: duplicate.
  resetPred();
  showRun(bet1);
  var refresh = freshRow({
    timer_seconds: 25,
    updated_at: new Date(NOW + 3000).toISOString()
  });
  check('same-bet refresh (8s gap, timer 33 -> 25) is a duplicate',
    (function () {
      var d = app.decideLiveBet(refresh, true, NOW + 5000, lastBetFrom(bet1));
      return d.action === 'ignore' && d.reason === 'duplicate';
    })());
  // Same-bet refresh with a 1s timer wobble (33 -> 32): still a duplicate.
  resetPred();
  showRun(bet1);
  var wobble = freshRow({
    timer_seconds: 32,
    updated_at: new Date(NOW + 3000).toISOString()
  });
  check('same-bet refresh with 1s timer wobble (33 -> 32) is a duplicate',
    app.decideLiveBet(wobble, true, NOW + 5000, lastBetFrom(bet1)).reason === 'duplicate');
  // Gap boundary: 39s gap, timer still counting down (33 -> 28): duplicate.
  resetPred();
  showRun(bet1);
  var gap39 = freshRow({
    timer_seconds: 28,
    updated_at: new Date(NOW + 34000).toISOString()
  });
  check('39s gap without a timer reset is still a duplicate',
    app.decideLiveBet(gap39, true, NOW + 36000, lastBetFrom(bet1)).reason === 'duplicate');
  // Gap boundary: exactly 40s gap runs (timer 33 -> 27, no reset needed).
  resetPred();
  showRun(bet1);
  var gap40 = freshRow({
    timer_seconds: 27,
    updated_at: new Date(NOW + 35000).toISOString()
  });
  check('exactly 40s gap runs (timer 33 -> 27)',
    app.decideLiveBet(gap40, true, NOW + 37000, lastBetFrom(bet1)).action === 'run');
  // Timer-reset boundary: jump of exactly 5s to 30s runs; 4s does not.
  resetPred();
  showRun(bet1mid);
  var resetEdge = freshRow({
    timer_seconds: 30,
    updated_at: new Date(NOW + 25000).toISOString()
  });
  check('timer jump of exactly 5s to 30s runs (20s -> 30s, 30s gap)',
    app.decideLiveBet(resetEdge, true, NOW + 28000, lastBetFrom(bet1mid)).action === 'run');
  resetPred();
  showRun(bet1mid);
  var noReset = freshRow({
    timer_seconds: 24,
    updated_at: new Date(NOW + 25000).toISOString()
  });
  check('timer jump of only 4s (20s -> 24s) is a duplicate',
    app.decideLiveBet(noReset, true, NOW + 28000, lastBetFrom(bet1mid)).reason === 'duplicate');
  // A genuinely different bet still runs with an object lastBet.
  resetPred();
  check('different bet runs with an object lastBet',
    app.decideLiveBet(
      freshRow({ tracks: ['unknown', 'Desert', 'unknown'] }), true, NOW, lastBetFrom(bet1)).action === 'run');
  // Stale row still ignored, even with an object lastBet.
  resetPred();
  check('stale row still ignored with an object lastBet',
    app.decideLiveBet(
      freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), true, NOW, lastBetFrom(bet1)).reason === 'stale');
  // Legacy string lastKey still dedups an identical bet (v16 behaviour).
  resetPred();
  check('legacy string lastKey still dedups an identical bet',
    app.decideLiveBet(freshRow(), true, NOW, app.liveBetKey(freshRow())).reason === 'duplicate');
  // A manual run of the same line-up stays ignored (already-shown):
  // the user already predicted this exact race by hand.
  resetPred();
  showRun(bet1);
  check('manual run of the same line-up stays already-shown (object lastBet, different key)',
    (function () {
      var otherLast = lastBetFrom(freshRow({ tracks: ['unknown', 'Desert', 'unknown'] }));
      var d = app.decideLiveBet(freshRow(), true, NOW, otherLast);
      return d.action === 'ignore' && d.reason === 'already-shown';
    })());
  // isNewLiveBet unit checks.
  check('isNewLiveBet: no last bet -> new',
    app.isNewLiveBet(freshRow(), null) === true);
  check('isNewLiveBet: different key -> new',
    app.isNewLiveBet(freshRow({ tracks: ['unknown', 'Desert', 'unknown'] }), lastBetFrom(bet1)) === true);
  check('isNewLiveBet: same key, small gap, decreasing timer -> same bet',
    app.isNewLiveBet(refresh, lastBetFrom(bet1)) === false);
  check('liveRowUpdatedAtMs parses updated_at',
    app.liveRowUpdatedAtMs(bet1) === NOW - 5000);
  check('liveRowUpdatedAtMs null for a row with no timestamp',
    app.liveRowUpdatedAtMs({}) === null);

  finish();
})();
