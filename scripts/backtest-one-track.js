// One-track backtest for the Lucky Race Predictor.
// Simulates the real game: before a bet the game shows EXACTLY ONE track.
// For each race, only its FIRST known segment is pinned; the other two
// segments stay Unknown. Chronological: race j is predicted using only
// races before it as history (newest-first, as the app passes them).
//
// Usage: node scripts/backtest-one-track.js [--live-config]
//   Default (no flag): Node defaults — equal-thirds segment lengths,
//   which matches how the earlier all-known backtest (67.7% top-1) was run,
//   so the numbers are directly comparable.
//   --live-config: loads js/config.js (SEGMENT_LENGTHS [0.189, 0.511, 0.300])
//   so the numbers reflect the live site.
//
// Run from the repo root. Exit code 0.
'use strict';
var fs = require('fs');
var path = require('path');

var LIVE_CONFIG = process.argv.indexOf('--live-config') !== -1;
if (LIVE_CONFIG) {
  // Make app.js see the real config, as the browser does.
  global.window = {};
  require(path.join(__dirname, '..', 'js', 'config.js'));
}

var app = require(path.join(__dirname, '..', 'js', 'app.js'));

var sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'seed-races.sql'), 'utf8');
var rows = [];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var m;
while ((m = re.exec(sql)) !== null) {
  rows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3] });
}
console.log('races loaded: ' + rows.length);
console.log('segment lengths in use: [' + app.segmentLengths().map(function (x) { return x.toFixed(3); }).join(', ') + ']' +
  (LIVE_CONFIG ? ' (live config)' : ' (Node defaults = equal thirds)'));

function hintFor(track) {
  return track === 'unknown'
    ? { mode: 'unknown', track: null, chance: 50 }
    : { mode: 'pin', track: track, chance: 100 };
}

function run(j0, j1, label) {
  var top1 = 0, top2 = 0, n = 0;
  var pinPos = { 0: 0, 1: 0, 2: 0, none: 0 };
  for (var j = j0; j <= j1; j++) {
    var target = rows[j];
    var history = rows.slice(0, j).reverse(); // newest-first
    // ONE-TRACK: pin only the FIRST known segment, others Unknown.
    var pinIdx = -1;
    for (var k = 0; k < 3; k++) {
      if (target.tracks[k] !== 'unknown') { pinIdx = k; break; }
    }
    if (pinIdx === -1) pinPos.none++; else pinPos[pinIdx]++;
    var hints = [0, 1, 2].map(function (i) {
      return hintFor(i === pinIdx ? target.tracks[i] : 'unknown');
    });
    var res = app.computePrediction({
      vehicles: target.vehicles,
      seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: history
    });
    var hit1 = res.ranked[0].vehicle === target.winner;
    var hit2 = hit1 || res.ranked[1].vehicle === target.winner;
    if (hit1) top1++;
    if (hit2) top2++;
    n++;
  }
  console.log(label + ': n=' + n +
    '  top-1 (MAIN PICK) ' + top1 + '/' + n + ' = ' + (100 * top1 / n).toFixed(1) + '%' +
    '  top-2 (MAIN or BACKUP) ' + top2 + '/' + n + ' = ' + (100 * top2 / n).toFixed(1) + '%' +
    '  | pinned position seg1/seg2/seg3/none: ' + pinPos[0] + '/' + pinPos[1] + '/' + pinPos[2] + '/' + pinPos.none);
  return { n: n, top1: top1, top2: top2 };
}

console.log('--- ONE-TRACK backtest (only first known segment pinned) ---');
run(9, 39, 'overall (history 10-39 races)');
run(9, 24, 'early   (history 10-24 races)');
run(25, 39, 'late    (history 25-39 races)');
console.log('random baseline: top-1 = 33.3%, top-2 = 66.7% (3 vehicles)');
console.log('history blend gate: OFF below 150 races (current N=40)');
