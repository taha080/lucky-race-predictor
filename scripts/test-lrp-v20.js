// Tests for lrp-v20: live-bet freshness indicator + START wait 10s +
// step-1 manual-guard refinement + inversion regression (23 Nov 2026).
// What v20 adds on top of v19:
//   (a) freshness indicator on the Predict tab: liveFreshnessText /
//       liveRowSummary / formatAgeSeconds (pure, unit-tested here) —
//       the user can SEE when the last live bet arrived and whether
//       the Reader has stopped sending (age > 60s);
//   (b) LIVE_START_WAIT_MS 5s -> 10s: a live bet pushed 6-10s after
//       START still runs instead of falling through to manual picking;
//   (c) isManualRunInProgress refined: step 1 counts as busy only
//       when at least one vehicle is picked — START's fall-through
//       leaves step 1 empty, so a late live bet is no longer dropped
//       as 'manual-busy' while 20+ s remain on the 35s timer.
//   (d) INVERSION REGRESSION (user report 23 Nov 12:46 PKT): Desert
//       shown, Motorcycle / Stock Car / SUV — the user said the
//       Predictor shows ATV HIGH, Motorcycle MID, Stock Car JACKPOT
//       and that Stock Car (fastest on Desert) should be HIGH.
//       Reproduced here through BOTH paths (live decideLiveBet +
//       applyLiveBet + computePrediction, and manual computePrediction)
//       on the local seed races: both paths agree, rank 1 is labelled
//       HIGH, rank 3 JACKPOT, and the ranked list contains ONLY the
//       3 input vehicles — ATV can never appear. No inversion or
//       label bug exists in the code; the data-only ranker (v19, the
//       user's own order) ranks SUV HIGH here because in the 8
//       same-cars races SUV won 3, Stock Car 2, Motorcycle 1 — and
//       the Desert pin has <2 matches, so it does not move the
//       ranking. (The old physics model would say Stock Car HIGH on
//       Desert speed 80 vs Motorcycle 63 vs SUV 57 — speeds are
//       deliberately ignored by the v19 data-only ranker.)
// Run from the repo root:
//   node scripts/test-lrp-v20.js
// Exit code 0 = all pass, 1 = any failure.
'use strict';
var fs = require('fs');
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
function pin(t) { return { mode: 'pin', track: t, chance: 100 }; }
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

// ---- load the local seed races (same loader as replay-data-only-v19.js)
var FILES = [
  'sql/seed-races.sql',
  'sql/seed-races-41-57.sql',
  'sql/seed-races-scribd-final.sql',
  'sql/seed-races-2026-11-22-video.sql'
];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var seedRows = [];
FILES.forEach(function (f) {
  var sql = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  var m;
  while ((m = re.exec(sql)) !== null) {
    seedRows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3], how_won_text: m[4] || '' });
  }
});
var deduped = [];
seedRows.forEach(function (r) { if (!app.isDuplicateRace(r, deduped)) deduped.push(r); });
seedRows = deduped;

(function main() {
  // --- (a) freshness helpers exported, constants unchanged where they must be ---
  check('v20 freshness helpers exported',
    typeof app.liveFreshnessText === 'function' &&
    typeof app.liveRowSummary === 'function' &&
    typeof app.formatAgeSeconds === 'function');
  check('START wait is 10s', app.LIVE_START_WAIT_MS === 10000);
  check('stale threshold still 60s', app.LIVE_STALE_MS === 60000);
  check('LATE threshold still 10s', app.LIVE_LATE_SECONDS === 10);

  // --- (a) formatAgeSeconds ---
  check('age 0s', app.formatAgeSeconds(0) === '0s');
  check('age 45s', app.formatAgeSeconds(45) === '45s');
  check('age 59s', app.formatAgeSeconds(59) === '59s');
  check('age 60s -> 1m', app.formatAgeSeconds(60) === '1m');
  check('age 125s -> 2m', app.formatAgeSeconds(125) === '2m');
  check('age 3600s -> 1h 0m', app.formatAgeSeconds(3600) === '1h 0m');
  check('age 37380s (10h 23m)', app.formatAgeSeconds(37380) === '10h 23m');
  check('negative age clamps to 0s', app.formatAgeSeconds(-5) === '0s');

  // --- (a) liveRowSummary ---
  check('summary names vehicles + known track',
    app.liveRowSummary({ vehicles: ['SUV', 'ATV', 'Sports Car'], tracks: ['Dirt', 'unknown', 'unknown'] }) === 'SUV/ATV/Sports Car · Dirt');
  check('summary with no known track omits the track',
    app.liveRowSummary({ vehicles: ['SUV', 'ATV', 'Sports Car'], tracks: ['unknown', 'unknown', 'unknown'] }) === 'SUV/ATV/Sports Car');
  check('summary of a null row is empty', app.liveRowSummary(null) === '');
  check('summary of a row with no vehicles is empty', app.liveRowSummary({ vehicles: [] }) === '');

  // --- (a) liveFreshnessText ---
  check('no row ever: warns to check the Reader',
    app.liveFreshnessText(null, '', NOW) === 'No live bet yet — check the Reader is ON.');
  var freshAt = NOW - 45000;
  var freshText = app.liveFreshnessText(freshAt, 'SUV/ATV/Sports Car · Dirt', NOW);
  check('fresh row (45s) names the age + summary, no stale warning',
    freshText.indexOf('45s ago') !== -1 && freshText.indexOf('SUV/ATV/Sports Car · Dirt') !== -1 &&
    freshText.indexOf("isn't sending") === -1);
  check('exactly 60s old is still fresh (stale is strictly > 60s)',
    app.liveFreshnessText(NOW - 60000, 'X/Y/Z', NOW).indexOf("isn't sending") === -1);
  check('61s old IS stale and names the Reader',
    app.liveFreshnessText(NOW - 61000, 'X/Y/Z', NOW).indexOf("Reader isn't sending bets") !== -1);
  check('10h-old row shows hours and the stale warning',
    app.liveFreshnessText(NOW - 37380000, 'SUV/ATV/Sports Car · Dirt', NOW).indexOf('10h 23m ago') !== -1 &&
    app.liveFreshnessText(NOW - 37380000, 'SUV/ATV/Sports Car · Dirt', NOW).indexOf("isn't sending") !== -1);

  // --- (c) isManualRunInProgress refinement ---
  resetState();
  app.wizard.step = 0;
  check('step 0 is not a manual run', app.isManualRunInProgress() === false);
  app.wizard.step = 1;
  check('step 1 with no picks is NOT a manual run (v20 fix)',
    app.isManualRunInProgress() === false);
  app.pred.vehicles = ['ORV'];
  check('step 1 with a pick IS a manual run', app.isManualRunInProgress() === true);
  app.pred.vehicles = [];
  app.wizard.step = 2;
  check('step 2 is always a manual run', app.isManualRunInProgress() === true);
  app.wizard.step = 3;
  check('step 3 is not a manual run', app.isManualRunInProgress() === false);
  resetState();

  // --- (b)+(c) decideLiveBet regression: START fall-through + late bet runs ---
  // START waited 10s, found nothing, left the wizard on step 1 with no
  // vehicles picked; a live bet pushed 8s after START must RUN, not be
  // dropped as 'manual-busy'.
  resetState();
  app.wizard.step = 1; // exactly where START's fall-through lands
  var lateRow = freshRow({ timer_seconds: 27, updated_at: new Date(NOW - 8000).toISOString() });
  var busy = app.isManualRunInProgress();
  var d = app.decideLiveBet(lateRow, true, NOW, '', busy);
  check('late bet after START fall-through runs (not manual-busy)',
    busy === false && d.action === 'run');
  resetState();

  // --- (d) INVERSION REGRESSION: Desert, Motorcycle / Stock Car / SUV ---
  console.log('  (seed races loaded: ' + seedRows.length + ')');
  var VEH = ['Motorcycle', 'Stock Car', 'SUV'];
  function manualRun(seg) {
    var hints = [unknown(), unknown(), unknown()];
    hints[seg] = pin('Desert');
    return app.computePrediction({
      vehicles: VEH.slice(), seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: seedRows, odds: null
    });
  }
  function liveRun(seg) {
    var tracks = ['unknown', 'unknown', 'unknown'];
    tracks[seg] = 'Desert';
    var row = {
      vehicles: VEH.slice(), tracks: tracks, timer_seconds: 30,
      updated_at: new Date(NOW - 5000).toISOString(),
      created_at: new Date(NOW - 5000).toISOString()
    };
    resetState();
    var dec = app.decideLiveBet(row, true, NOW, '', false);
    if (dec.action !== 'run') return null;
    var ap = app.applyLiveBet(row, NOW);
    if (!ap.ok) return null;
    return app.computePrediction({
      vehicles: app.pred.vehicles.slice(), seg1Hint: app.pred.seg1, seg2Hint: app.pred.seg2, seg3Hint: app.pred.seg3,
      speeds: app.DEFAULT_SPEEDS, races: seedRows, odds: null
    });
  }
  [0, 1, 2].forEach(function (seg) {
    var m = manualRun(seg);
    var l = liveRun(seg);
    var order = m.ranked.map(function (r) { return r.vehicle; }).join(' > ');
    console.log('  Desert seg ' + (seg + 1) + ': ' + order +
      ' | ' + m.ranked.map(function (r) { return r.vehicle + ' ' + (r.prob * 100).toFixed(1) + '%'; }).join(', ') +
      ' | level=' + m.dataInfo.level + ' n=' + m.dataInfo.matches);
    check('Desert seg ' + (seg + 1) + ': live path runs and agrees with manual path',
      l !== null && JSON.stringify(l.ranked) === JSON.stringify(m.ranked));
    check('Desert seg ' + (seg + 1) + ': ranked list is exactly the 3 input vehicles (no ATV)',
      m.ranked.map(function (r) { return r.vehicle; }).sort().join('|') === VEH.slice().sort().join('|') &&
      !m.ranked.some(function (r) { return r.vehicle === 'ATV'; }));
    check('Desert seg ' + (seg + 1) + ': ranked is sorted by probability, descending',
      m.ranked[0].prob >= m.ranked[1].prob && m.ranked[1].prob >= m.ranked[2].prob);
    check('Desert seg ' + (seg + 1) + ': rank 1 is HIGH, rank 2 MID, rank 3 JACKPOT',
      app.rankName(1) === 'HIGH' && app.rankName(2) === 'MID' && app.rankName(3) === 'JACKPOT');
  });
  // The concrete reproduction result on the local seeds (23 Nov 2026):
  // SUV HIGH 48.4%, Stock Car MID 33.4%, Motorcycle JACKPOT 18.2% —
  // level 3 (same cars, 8 races: SUV 3 wins, Stock Car 2, Motorcycle 1).
  // The Desert pin has <2 matches for this line-up, so it cannot move
  // the ranking. If the seed files change, update this expectation.
  var rep = manualRun(0);
  check('reproduction: SUV HIGH, Stock Car MID, Motorcycle JACKPOT on local seeds',
    rep.ranked[0].vehicle === 'SUV' && rep.ranked[1].vehicle === 'Stock Car' && rep.ranked[2].vehicle === 'Motorcycle' &&
    rep.dataInfo.level === 3 && rep.dataInfo.matches === 8);

  finish();
})();
