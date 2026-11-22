// Paired comparison: does the history-based unknown-segment guess
// (historicalFreq) help or hurt live-condition accuracy?
// For each race (one run per known-track position) records the winner's
// rank WITH history vs WITHOUT history (uniform 1/6 for unknown
// segments), then reports the discordant pairs — the only pairs that
// can move the headline numbers — plus the headline numbers.
// Usage: node scripts/replay-paired-hist.js
// Run from the repo root. Exit code 0.
'use strict';
var fs = require('fs');
var path = require('path');

global.window = {};
require(path.join(__dirname, '..', 'js', 'config.js'));
var app = require(path.join(__dirname, '..', 'js', 'app.js'));

var FILES = [
  'sql/seed-races.sql',
  'sql/seed-races-41-57.sql',
  'sql/seed-races-scribd-final.sql',
  'sql/seed-races-2026-11-22-video.sql'
];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var rows = [];
FILES.forEach(function (f) {
  var sql = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  var m;
  while ((m = re.exec(sql)) !== null) {
    rows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3], how_won_text: m[4] || '' });
  }
});
var deduped = [];
rows.forEach(function (r) { if (!app.isDuplicateRace(r, deduped)) deduped.push(r); });
rows = deduped;
console.log('races: ' + rows.length);

function hintFor(track) {
  return track === 'unknown'
    ? { mode: 'unknown', track: null, chance: 50 }
    : { mode: 'pin', track: track, chance: 100 };
}

var n = 0, skipped = 0;
var withHist = { r1: 0, r2: 0, r3: 0 };
var noHist = { r1: 0, r2: 0, r3: 0 };
// Discordant pairs: [rankWithHist, rankNoHist] counts.
var disc = {};
function key(a, b) { return a + '->' + b; }
var betterNoHist = 0, betterWithHist = 0, tied = 0;

for (var j = 9; j < rows.length; j++) {
  var target = rows[j];
  var knownIdx = [];
  for (var k = 0; k < 3; k++) {
    if (target.tracks[k] !== 'unknown') knownIdx.push(k);
  }
  knownIdx.forEach(function (pinIdx) {
    var hints = [0, 1, 2].map(function (i) {
      return hintFor(i === pinIdx ? target.tracks[i] : 'unknown');
    });
    var history = rows.slice(0, j).reverse();
    var resH = app.computePrediction({
      vehicles: target.vehicles, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: history
    });
    var resN = app.computePrediction({
      vehicles: target.vehicles, seg1Hint: hints[0], seg2Hint: hints[1], seg3Hint: hints[2],
      speeds: app.DEFAULT_SPEEDS, races: []
    });
    var rankH = app.rankOfWinner(resH.ranked, target.winner);
    var rankN = app.rankOfWinner(resN.ranked, target.winner);
    if (rankH === null || rankN === null) { skipped++; return; }
    n++;
    withHist['r' + rankH]++;
    noHist['r' + rankN]++;
    if (rankH === rankN) { tied++; return; }
    disc[key(rankH, rankN)] = (disc[key(rankH, rankN)] || 0) + 1;
    if (rankN < rankH) betterNoHist++; else betterWithHist++;
  });
}

console.log('paired runs n=' + n + ' skipped=' + skipped);
console.log('WITH history : HIGH ' + withHist.r1 + ' (' + (100 * withHist.r1 / n).toFixed(1) + '%)  MID ' + withHist.r2 + '  JACKPOT ' + withHist.r3 + ' (' + (100 * withHist.r3 / n).toFixed(1) + '%)');
console.log('WITHOUT hist : HIGH ' + noHist.r1 + ' (' + (100 * noHist.r1 / n).toFixed(1) + '%)  MID ' + noHist.r2 + '  JACKPOT ' + noHist.r3 + ' (' + (100 * noHist.r3 / n).toFixed(1) + '%)');
console.log('discordant pairs (rankWithHist -> rankNoHist): ' + JSON.stringify(disc));
console.log('pairs where NO-history ranks the winner HIGHER: ' + betterNoHist);
console.log('pairs where WITH-history ranks the winner HIGHER: ' + betterWithHist);
console.log('tied pairs: ' + tied);
// McNemar-style check on top-1 hits: discordant top-1 pairs only.
var h1n0 = (disc['1->2'] || 0) + (disc['1->3'] || 0); // with-hist top1, nohist not
var h0n1 = (disc['2->1'] || 0) + (disc['3->1'] || 0); // nohist top1, with-hist not
console.log('top-1 discordant: with-hist-only ' + h1n0 + ' vs nohist-only ' + h0n1);
console.log('done.');
