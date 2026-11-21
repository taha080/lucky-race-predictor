// Tests for the ONE-TRACK rule (Lucky Race Predictor).
// The game shows exactly ONE track before the bet, so at most one segment
// may be pinned at a time. Run from the repo root:
//   node scripts/test-one-track.js
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
function unknown() { return { mode: 'unknown', track: null, chance: 50 }; }
function pin(track) { return { mode: 'pin', track: track, chance: 100 }; }
function hint(track) { return { mode: 'hint', track: track, chance: 50 }; }

// --- applySinglePin: pinning a second segment unpins the first ---
// (The input at pinIndex is already the newly-pinned segment, exactly as
// the Predict tab calls it after setting state.mode = 'pin'.)
var s1 = app.applySinglePin([pin('Highway'), pin('Desert'), unknown()], 1);
check('pin seg2 unpins seg1', s1[0].mode === 'unknown' && s1[0].track === null && s1[1].mode === 'pin' && s1[1].track === 'Desert');
var s2 = app.applySinglePin([pin('Expressway'), unknown(), pin('Dirt')], 0);
check('pin seg1 unpins seg3', s2[0].mode === 'pin' && s2[0].track === 'Expressway' && s2[2].mode === 'unknown' && s2[2].track === null);
var s3 = app.applySinglePin([unknown(), hint('Bumpy'), pin('Highway')], 2);
check('hint on seg2 survives pinning seg3', s3[1].mode === 'hint' && s3[1].track === 'Bumpy' && s3[2].mode === 'pin');
var s4 = app.applySinglePin([unknown(), unknown(), unknown()], 0);
check('no pins: applySinglePin is a no-op', s4.every(function (h) { return h.mode === 'unknown'; }));
var s5 = app.applySinglePin([pin('Desert'), pin('Highway'), pin('Bumpy')], 2);
check('pin seg3 unpins BOTH earlier pins', s5[0].mode === 'unknown' && s5[1].mode === 'unknown' && s5[2].mode === 'pin');

// --- oneTrackHints: engine-side enforcement ---
var h1 = app.oneTrackHints([pin('Highway'), pin('Desert'), unknown()]);
check('engine keeps only first pin (2 pins in)', h1[0].mode === 'pin' && h1[0].track === 'Highway' && h1[1].mode === 'unknown');
var h2 = app.oneTrackHints([pin('Highway'), pin('Desert'), pin('Bumpy')]);
check('engine keeps only first pin (3 pins in)', h2[0].mode === 'pin' && h2[1].mode === 'unknown' && h2[2].mode === 'unknown');
var h3 = app.oneTrackHints([unknown(), pin('Dirt'), unknown()]);
check('engine leaves a single pin untouched', h3[1].mode === 'pin' && h3[1].track === 'Dirt');
var h4 = app.oneTrackHints([unknown(), hint('Bumpy'), unknown()]);
check('engine leaves hints untouched', h4[1].mode === 'hint' && h4[1].track === 'Bumpy');

// --- computePrediction: one pin in EACH position gives MAIN + BACKUP ---
var sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'seed-races.sql'), 'utf8');
var rows = [];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var m;
while ((m = re.exec(sql)) !== null) {
  rows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3] });
}
check('40 races loaded', rows.length === 40);
var history = rows.slice().reverse(); // newest-first, as the app passes it
var vehicles = ['Motorcycle', 'ATV', 'Supercar'];
[0, 1, 2].forEach(function (pinIdx) {
  var hints = [unknown(), unknown(), unknown()];
  hints[pinIdx] = pin('Highway');
  var res = app.computePrediction({
    vehicles: vehicles,
    seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
    speeds: app.DEFAULT_SPEEDS, races: history
  });
  var sum = res.ranked.reduce(function (a, r) { return a + r.prob; }, 0);
  check('pin seg' + (pinIdx + 1) + ' only: ranked has 3 vehicles', res.ranked.length === 3);
  check('pin seg' + (pinIdx + 1) + ' only: MAIN + BACKUP distinct', res.ranked[0].vehicle !== res.ranked[1].vehicle);
  check('pin seg' + (pinIdx + 1) + ' only: probabilities sum to 1', Math.abs(sum - 1) < 1e-9);
  check('pin seg' + (pinIdx + 1) + ' only: pinned segment is a point mass',
    res['dist' + (pinIdx + 1)].Highway === 1);
});

// --- engine normalises 2 pins passed directly to computePrediction ---
var res2 = app.computePrediction({
  vehicles: vehicles,
  seg1Hint: pin('Highway'), seg2Hint: pin('Desert'), seg3Hint: unknown(),
  speeds: app.DEFAULT_SPEEDS, races: history
});
check('2 pins in: seg1 stays a point mass', res2.dist1.Highway === 1);
check('2 pins in: seg2 is NOT a point mass (demoted to unknown)',
  res2.dist2.Desert !== 1 && res2.dist2.Desert > 0 && res2.dist2.Desert < 1);

// --- historicalFreq: unknown segment conditioned on the single pin ---
// Pin seg1 = Potholes: matching races have seg2 = Highway (race 10) and
// Expressway (race 22), so the conditioned distribution must favour both.
var dist = app.historicalFreq(1, { 0: 'Potholes' }, history);
var distSum = Object.keys(dist).reduce(function (a, k) { return a + dist[k]; }, 0);
check('historicalFreq conditioned on one pin sums to 1', Math.abs(distSum - 1) < 1e-9);
check('conditioned seg2 favours Highway and Expressway', dist.Highway > 0 && dist.Expressway > 0);
var distFree = app.historicalFreq(1, {}, history);
var differs = Object.keys(dist).some(function (k) { return Math.abs(dist[k] - distFree[k]) > 1e-9; });
check('conditioning on the pin changes the unknown-segment distribution', differs);

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
