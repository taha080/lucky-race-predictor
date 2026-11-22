// Tests for lrp-v16: LIVE auto-predict mode.
// The Android Live Reader upserts one row per user into public.live_bets
// (see sql/migration-live-bets.sql) when a new bet appears; the web app
// subscribes over Supabase Realtime and auto-drives the wizard from it.
// These tests cover the PURE live-bet logic only (no DOM, no Supabase):
//   (a) applying a live bet row to wizard state (vehicles set, exactly
//       one segment pinned, others unknown, invalid rows rejected),
//   (b) countdown sync (timer_seconds -> displayed seconds; stale rows
//       older than 60s ignored),
//   (c) premium gating (no auto-run when appAccess().ok is false).
// The Realtime subscription itself (sb.channel) and the DOM auto-drive
// (handleLiveBet -> resetPrediction -> runPrediction) are wiring, not
// pure logic — they are verified by hand in the browser, not here.
// Run from the repo root:
//   node scripts/test-lrp-v16.js
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
  check('live helpers exported',
    typeof app.validateLiveBet === 'function' &&
    typeof app.applyLiveBet === 'function' &&
    typeof app.decideLiveBet === 'function' &&
    typeof app.liveBetSegments === 'function' &&
    typeof app.liveBetKey === 'function' &&
    typeof app.liveTimerSeconds === 'function' &&
    typeof app.liveCountdownAt === 'function' &&
    typeof app.currentBetKey === 'function' &&
    typeof app.LIVE_STALE_MS === 'number');

  // --- (a) validateLiveBet: happy path ---
  var v = app.validateLiveBet(freshRow(), NOW);
  check('valid row validates', v.ok === true);
  check('valid row keeps vehicles', v.ok && v.vehicles.join(',') === 'ORV,SUV,Monster Truck');
  check('valid row keeps tracks', v.ok && v.tracks.join(',') === 'unknown,Dirt,unknown');
  check('valid row finds the one known track (seg 2 Dirt)',
    v.ok && v.knownSegIndex === 1 && v.knownTrack === 'Dirt');
  check('valid row carries timer_seconds', v.ok && v.timerSeconds === 33);

  // --- (a) applyLiveBet: wizard state ---
  resetPred();
  var applied = app.applyLiveBet(freshRow(), NOW);
  check('applyLiveBet ok', applied.ok === true);
  check('applyLiveBet sets the 3 vehicles',
    app.pred.vehicles.join(',') === 'ORV,SUV,Monster Truck');
  check('applyLiveBet pins exactly one segment (seg 2 Dirt)',
    app.pred.seg2.mode === 'pin' && app.pred.seg2.track === 'Dirt');
  check('applyLiveBet leaves the other two segments Unknown',
    app.pred.seg1.mode === 'unknown' && app.pred.seg1.track === null &&
    app.pred.seg3.mode === 'unknown' && app.pred.seg3.track === null);
  check('applyLiveBet does not feed Reader odds into pred.odds',
    JSON.stringify(app.pred.odds) === '{}');

  // --- (a) one-track rule: row naming 3 tracks pins only the first ---
  resetPred();
  var three = app.applyLiveBet(freshRow({ tracks: ['Desert', 'Bumpy', 'Dirt'] }), NOW);
  check('3 known tracks still apply', three.ok === true);
  check('3 known tracks pin only the first (seg 1 Desert)',
    app.pred.seg1.mode === 'pin' && app.pred.seg1.track === 'Desert' &&
    app.pred.seg2.mode === 'unknown' && app.pred.seg3.mode === 'unknown');

  // --- (a) liveBetSegments (pure) ---
  var segs = app.liveBetSegments(['unknown', 'unknown', 'Potholes']);
  check('liveBetSegments pins the only known track (seg 3)',
    segs[2].mode === 'pin' && segs[2].track === 'Potholes' &&
    segs[0].mode === 'unknown' && segs[1].mode === 'unknown');
  check('liveBetSegments all-unknown pins nothing',
    app.liveBetSegments(['unknown', 'unknown', 'unknown'])
      .every(function (s) { return s.mode === 'unknown'; }));
  check('liveBetSegments treats null entries as Unknown',
    app.liveBetSegments([null, 'Highway', null])[1].mode === 'pin');

  // --- (a) invalid rows rejected ---
  check('null row rejected', app.validateLiveBet(null, NOW).ok === false);
  check('2 vehicles rejected',
    app.validateLiveBet(freshRow({ vehicles: ['ORV', 'SUV'] }), NOW).reason === 'vehicles');
  check('4 vehicles rejected',
    app.validateLiveBet(freshRow({ vehicles: ['ORV', 'SUV', 'Monster Truck', 'Car'] }), NOW).reason === 'vehicles');
  check('unknown vehicle name rejected',
    app.validateLiveBet(freshRow({ vehicles: ['ORV', 'SUV', 'Rocket'] }), NOW).reason === 'vehicles');
  check('duplicate vehicle rejected',
    app.validateLiveBet(freshRow({ vehicles: ['ORV', 'ORV', 'SUV'] }), NOW).reason === 'vehicles');
  check('2 tracks rejected',
    app.validateLiveBet(freshRow({ tracks: ['Dirt', 'unknown'] }), NOW).reason === 'tracks');
  check('bad track name rejected',
    app.validateLiveBet(freshRow({ tracks: ['Dirt', 'unknown', 'Mud'] }), NOW).reason === 'tracks');
  check('all-unknown tracks rejected',
    app.validateLiveBet(freshRow({ tracks: ['unknown', 'unknown', 'unknown'] }), NOW).reason === 'no-known-track');
  check('applyLiveBet rejects an invalid row and leaves pred alone',
    (function () {
      resetPred();
      var r = app.applyLiveBet(freshRow({ vehicles: ['ORV', 'SUV'] }), NOW);
      return r.ok === false && app.pred.vehicles.length === 0;
    })());

  // --- (a) bet identity / duplicates ---
  check('liveBetKey is order-insensitive for vehicles',
    app.liveBetKey(freshRow()) === app.liveBetKey(freshRow({ vehicles: ['Monster Truck', 'SUV', 'ORV'] })));
  check('liveBetKey differs for a different track',
    app.liveBetKey(freshRow()) !== app.liveBetKey(freshRow({ tracks: ['unknown', 'Desert', 'unknown'] })));
  check('liveBetKey empty for a bad row', app.liveBetKey(null) === '');
  resetPred();
  check('currentBetKey empty with nothing picked', app.currentBetKey() === '');
  app.wizard.ran = true;
  app.wizard.lastRun = {
    vehicles: ['ORV', 'SUV', 'Monster Truck'],
    tracks: ['unknown', 'Dirt', 'unknown'],
    result: { ranked: [{ vehicle: 'ORV' }, { vehicle: 'SUV' }, { vehicle: 'Monster Truck' }] }
  };
  var shownKey = app.currentBetKey();
  check('currentBetKey reads the displayed run',
    shownKey === app.liveBetKey(freshRow()));
  check('decideLiveBet ignores the bet already shown',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'ignore' &&
    app.decideLiveBet(freshRow(), true, NOW, '').reason === 'already-shown');
  check('decideLiveBet ignores a re-fired bet (lastKey match)',
    app.decideLiveBet(freshRow(), true, NOW, app.liveBetKey(freshRow())).reason === 'duplicate');
  check('decideLiveBet runs a genuinely new bet',
    (function () {
      resetPred();
      var d = app.decideLiveBet(freshRow({ tracks: ['unknown', 'Desert', 'unknown'] }), true, NOW, '');
      return d.action === 'run' && d.vehicles.length === 3 && d.timerSeconds === 33;
    })());
  check('decideLiveBet ignores an invalid row',
    app.decideLiveBet(freshRow({ vehicles: ['ORV'] }), true, NOW, '').action === 'ignore');

  // --- (b) countdown sync ---
  check('liveTimerSeconds passes timer_seconds through',
    app.liveTimerSeconds(freshRow(), NOW) === 33);
  check('liveTimerSeconds null when timer_seconds is null',
    app.liveTimerSeconds(freshRow({ timer_seconds: null }), NOW) === null);
  check('liveTimerSeconds null when timer_seconds is missing',
    app.liveTimerSeconds(freshRow({ timer_seconds: undefined }), NOW) === null);
  check('liveTimerSeconds clamps above 35',
    app.liveTimerSeconds(freshRow({ timer_seconds: 99 }), NOW) === 35);
  check('liveTimerSeconds clamps below 0',
    app.liveTimerSeconds(freshRow({ timer_seconds: -5 }), NOW) === 0);
  check('liveTimerSeconds null for a stale row (61s old)',
    app.liveTimerSeconds(freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), NOW) === null);
  check('validateLiveBet rejects a stale row (61s old)',
    app.validateLiveBet(freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), NOW).reason === 'stale');
  check('validateLiveBet accepts a 59s-old row (inside the 60s window)',
    app.validateLiveBet(freshRow({ updated_at: new Date(NOW - 59000).toISOString() }), NOW).ok === true);
  check('decideLiveBet ignores a stale row',
    app.decideLiveBet(freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), true, NOW, '').action === 'ignore');
  check('liveCountdownAt ticks down (33s read 5s ago -> 28)',
    app.liveCountdownAt(33, NOW - 5000, NOW) === 28);
  check('liveCountdownAt floors at 0 once expired',
    app.liveCountdownAt(10, NOW - 30000, NOW) === 0);
  check('liveCountdownAt null for an unusable timer',
    app.liveCountdownAt(null, NOW, NOW) === null);

  // --- (c) premium gating ---
  resetPred();
  var gated = app.decideLiveBet(freshRow(), false, NOW, '');
  check('no auto-run without premium', gated.action === 'premium' && gated.reason === 'premium');
  check('premium gate wins even for an invalid row (no auto-run either way)',
    app.decideLiveBet(freshRow({ vehicles: ['ORV'] }), false, NOW, '').action === 'premium');
  check('premium user auto-runs a valid fresh bet',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'run');

  finish();
})();
