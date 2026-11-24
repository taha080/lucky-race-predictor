// Tests for lrp-v21: live-receive hardening — poll fallback, Realtime
// recovery, live bet wins over unfinished manual picks, version badge.
// What v21 adds on top of v20 (23 Nov 2026, user's order: deep-check
// everything — every previous version shipped with a problem):
//   (a) POLL FALLBACK: while live mode is on, the app re-fetches the
//       live_bets row every 4 s (LIVE_POLL_MS) in addition to Realtime,
//       so a missed event can never hide a bet for more than ~4 s.
//   (b) REALTIME RECOVERY: a dead channel (CHANNEL_ERROR / TIMED_OUT /
//       CLOSED, or open-but-never-confirmed past the 15 s zombie
//       window) is torn down and re-subscribed on backoff
//       (liveBackoffMs: 2s, 5s, 10s, 20s, 30s cap). The poll tick
//       drives the retry. The old code kept the dead channel object
//       forever, so the `if (liveChannel) return true` guard blocked
//       every later subscribe — a tab could sit for hours on a dead
//       socket showing "waiting for the Reader…".
//   (c) LIVE BET WINS over an unfinished manual pick: the v17–v20
//       'manual-busy' drop is DELETED. START fell through to step 1,
//       the user started picking, the bet arrived and was thrown away
//       — that is the failure the user reported. decideLiveBet takes
//       no manual-busy flag any more; isManualRunInProgress is gone.
//       (A MANUAL RUN of the same line-up still stays 'already-shown':
//       the user already has that exact prediction on screen.)
//   (d) RETURNING to the Predict tab (or to a visible tab, or back
//       online) re-fetches the live row at once — wiring, verified by
//       hand in the browser; the pure decision helpers are tested here.
//   (e) VERSION BADGE: APP_VERSION ('v23') is shown in the header, so
//       a cached old deploy is visible at a glance; the freshness line
//       now also has a green 'fresh' state when the last bet is <= 60 s
//       old.
//   (f) FETCH FAILURES are counted, not silent: 3 network failures in
//       a row put a "couldn't reach the live-bet table" warning in the
//       status line instead of looking exactly like "no live bet".
// Untouched by v21: data-only ranking (v19), confidence caps, backup
// pick, premium/free-window gate, HIGH/MID/JACKPOT labels.
// Run from the repo root:
//   node scripts/test-lrp-v21.js
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
function unknown() { return { mode: 'unknown', track: null, chance: 50 }; }
function resetState() {
  app.pred.vehicles = [];
  app.pred.seg1 = unknown(); app.pred.seg2 = unknown(); app.pred.seg3 = unknown();
  app.pred.odds = {};
  app.wizard.step = 0; app.wizard.ran = false; app.wizard.lastRun = null;
  app.wizard.feedback = null; app.wizard.feedbackSaved = false; app.wizard.feedbackSaving = false;
}
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

(async function main() {
  // --- (e) version + poll constants ---
  check('APP_VERSION is v23', app.APP_VERSION === 'v23');
  check('poll interval is 4s', app.LIVE_POLL_MS === 4000);
  check('resubscribe zombie window is 15s', app.LIVE_RESUBSCRIBE_ZOMBIE_MS === 15000);
  check('v21 live helpers exported',
    typeof app.liveBackoffMs === 'function' &&
    typeof app.liveSubscriptionAction === 'function' &&
    typeof app.livePollTick === 'function' &&
    typeof app.startLivePoll === 'function' &&
    typeof app.stopLivePoll === 'function' &&
    typeof app.ensureLiveSubscription === 'function');

  // --- (b) liveBackoffMs: 2s, 5s, 10s, 20s, 30s cap ---
  check('backoff: 0 fails -> 2s', app.liveBackoffMs(0) === 2000);
  check('backoff: 1 fail -> 2s', app.liveBackoffMs(1) === 2000);
  check('backoff: 2 fails -> 5s', app.liveBackoffMs(2) === 5000);
  check('backoff: 3 fails -> 10s', app.liveBackoffMs(3) === 10000);
  check('backoff: 4 fails -> 20s', app.liveBackoffMs(4) === 20000);
  check('backoff: 5 fails -> 30s (cap)', app.liveBackoffMs(5) === 30000);
  check('backoff: 10 fails still 30s (cap holds)', app.liveBackoffMs(10) === 30000);
  check('backoff never exceeds 30s', app.liveBackoffMs(100) === 30000);

  // --- (b) liveSubscriptionAction: the resubscribe decision ---
  check('no channel + retry time reached -> subscribe',
    app.liveSubscriptionAction({ channel: false, active: false, lastSubscribeAtMs: 0, nextRetryAtMs: 0 }, NOW) === 'subscribe');
  check('no channel + still in backoff -> wait',
    app.liveSubscriptionAction({ channel: false, active: false, lastSubscribeAtMs: 0, nextRetryAtMs: NOW + 5000 }, NOW) === 'wait');
  check('no channel + unknown retry time -> wait (safe default)',
    app.liveSubscriptionAction({ channel: false, active: false, lastSubscribeAtMs: 0, nextRetryAtMs: undefined }, NOW) === 'wait');
  check('channel + confirmed SUBSCRIBED -> ok',
    app.liveSubscriptionAction({ channel: true, active: true, lastSubscribeAtMs: NOW - 60000, nextRetryAtMs: 0 }, NOW) === 'ok');
  check('channel + unconfirmed but recent (5s) -> wait',
    app.liveSubscriptionAction({ channel: true, active: false, lastSubscribeAtMs: NOW - 5000, nextRetryAtMs: 0 }, NOW) === 'wait');
  check('channel + unconfirmed exactly 15s -> still wait (boundary is strictly > 15s)',
    app.liveSubscriptionAction({ channel: true, active: false, lastSubscribeAtMs: NOW - 15000, nextRetryAtMs: 0 }, NOW) === 'wait');
  check('channel + unconfirmed 16s -> teardown-subscribe (zombie)',
    app.liveSubscriptionAction({ channel: true, active: false, lastSubscribeAtMs: NOW - 16000, nextRetryAtMs: 0 }, NOW) === 'teardown-subscribe');
  check('channel + unconfirmed for minutes -> teardown-subscribe',
    app.liveSubscriptionAction({ channel: true, active: false, lastSubscribeAtMs: NOW - 600000, nextRetryAtMs: 0 }, NOW) === 'teardown-subscribe');

  // --- (c) live bet wins over an unfinished manual pick ---
  resetState();
  app.wizard.step = 1;
  app.pred.vehicles = ['ORV', 'SUV', 'Monster Truck']; // all 3 picked, no pin, no run
  check('live bet RUNS with a full manual pick waiting on step 1 (v21)',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'run');
  resetState();
  app.wizard.step = 2; // pinning, no run yet
  app.pred.vehicles = ['ORV', 'SUV', 'Monster Truck'];
  check('live bet RUNS on step 2 pinning (v21)',
    app.decideLiveBet(freshRow(), true, NOW, '').action === 'run');
  resetState();
  // ...but the dedup guards still hold: duplicate / already-shown /
  // stale / premium are unchanged by v21.
  check('duplicate of the last auto-run bet is still ignored',
    app.decideLiveBet(freshRow(), true, NOW, app.liveBetKey(freshRow())).reason === 'duplicate');
  app.wizard.ran = true;
  app.wizard.lastRun = { vehicles: ['ORV', 'SUV', 'Monster Truck'], tracks: ['unknown', 'Dirt', 'unknown'] };
  check('manual RUN of the same line-up is still already-shown',
    app.decideLiveBet(freshRow(), true, NOW, '').reason === 'already-shown');
  resetState();
  check('stale row still ignored as stale',
    app.decideLiveBet(freshRow({ updated_at: new Date(NOW - 61000).toISOString() }), true, NOW, '').reason === 'stale');
  check('premium gate still wins (no access -> premium)',
    app.decideLiveBet(freshRow(), false, NOW, '').action === 'premium');
  check('a genuinely new bet still runs',
    app.decideLiveBet(freshRow({ tracks: ['unknown', 'Desert', 'unknown'] }), true, NOW, '').action === 'run');
  resetState();

  // --- (a)/(d)/(f) wiring guards: safe no-ops without a DOM/session ---
  check('livePollTick resolves false with no session (Node: no document/sb)',
    (await app.livePollTick()) === false);
  check('fetchLatestLiveBet resolves false with no session',
    (await app.fetchLatestLiveBet()) === false);
  check('ensureLiveSubscription returns wait without a DOM',
    app.ensureLiveSubscription(NOW) === 'wait');
  check('startLivePoll / stopLivePoll do not throw without a DOM',
    (function () { try { app.startLivePoll(); app.stopLivePoll(); return true; } catch (e) { return false; } })());

  finish();
})();
