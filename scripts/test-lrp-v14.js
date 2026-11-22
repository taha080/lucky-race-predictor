// Tests for lrp-v14: HIGH/MID/JACKPOT labels, 3-button feedback,
// jackpot streak watch, prediction-accuracy replay.
// Run from the repo root:
//   node scripts/test-lrp-v14.js
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

// --- Background history: the 40 seed races, newest-first as the app holds it ---
var sql = fs.readFileSync(path.join(__dirname, '..', 'sql', 'seed-races.sql'), 'utf8');
var rows = [];
var re = /'(\[[^\]]*\])'::jsonb, '(\[[^\]]*\])'::jsonb, '\[\]'::jsonb, '([^']+)', 'Other', '(.*)', '\{\}'::jsonb/g;
var m;
while ((m = re.exec(sql)) !== null) {
  rows.push({ vehicles: JSON.parse(m[1]), tracks: JSON.parse(m[2]), winner: m[3], how_won: 'Other', how_won_text: m[4] });
}
check('40 seed races loaded', rows.length === 40);
var seedHistory = rows.slice().reverse();

// --- Synthetic own-bet races, built chronologically (oldest first) ---
// Every race has the same 3 vehicles and the same pinned seg1 track.
// Each race's winner is chosen by rank (1/2/3) as computed by the live
// model with the history available before that race — the same replay
// the streak and accuracy helpers perform — so the expected rank is
// known by construction. Returns the list newest-first, as the app
// holds it (seed history is NOT included; callers concat it).
var VEH = ['SUV', 'ORV', 'Motorcycle'];
var TRK = ['Dirt', 'unknown', 'unknown'];
// includeSeed (default true): whether the 40 seed races are part of the
// history each synthetic race is built from. The accuracy replays slice
// the list to the newest N races, so the seed is NOT in the replay
// history — those histories must be built WITHOUT the seed, or the
// ranks would not reproduce. The streak replays pass the full list, so
// they keep the seed.
function buildSynthetic(n, rankFn, includeSeed) {
  var chrono = [];
  for (var i = 0; i < n; i++) {
    // History before this race, newest-first: synthetic races so far
    // (reversed), on top of the seed history when included.
    var historyBefore = chrono.slice().reverse();
    if (includeSeed !== false) historyBefore = historyBefore.concat(seedHistory);
    var res = app.computePrediction({
      vehicles: VEH, seg1Hint: pin('Dirt'), seg2Hint: unknown(), seg3Hint: unknown(),
      speeds: app.DEFAULT_SPEEDS, races: historyBefore
    });
    var rank = rankFn(i, res.ranked);
    chrono.push({ vehicles: VEH.slice(), tracks: TRK.slice(), winner: res.ranked[rank - 1].vehicle, how_won: 'Other', how_won_text: '' });
  }
  return chrono.slice().reverse();
}

// --- rankName / rankOfWinner ---
check('rankName 1 = HIGH', app.rankName(1) === 'HIGH');
check('rankName 2 = MID', app.rankName(2) === 'MID');
check('rankName 3 = JACKPOT', app.rankName(3) === 'JACKPOT');
check('rankOfWinner finds each rank', app.rankOfWinner([{ vehicle: 'A' }, { vehicle: 'B' }, { vehicle: 'C' }], 'B') === 2);
check('rankOfWinner null for a winner outside the list', app.rankOfWinner([{ vehicle: 'A' }, { vehicle: 'B' }], 'Z') === null);
check('rankOfWinner null for a missing list', app.rankOfWinner(null, 'A') === null);

// --- hintsFromTracks ---
var h = app.hintsFromTracks(['Dirt', 'unknown', 'Highway']);
check('hintsFromTracks pins known tracks', h[0].mode === 'pin' && h[0].track === 'Dirt' && h[2].mode === 'pin' && h[2].track === 'Highway');
check('hintsFromTracks leaves unknown unknown', h[1].mode === 'unknown' && h[1].track === null);
check('hintsFromTracks tolerates missing tracks', app.hintsFromTracks(null).every(function (x) { return x.mode === 'unknown'; }));

// --- isScribdRace ---
check('isScribdRace true for sheet rows', app.isScribdRace({ how_won_text: 'Scribd sheet: ATV WIN' }));
check('isScribdRace false for own bets', !app.isScribdRace({ how_won_text: '' }) && !app.isScribdRace({ how_won_text: 'Potholes' }));

// --- feedbackForRank / migrateFeedback ---
var sampleRun = {
  vehicles: ['SUV', 'ORV', 'Motorcycle'],
  main: 'SUV',
  result: { ranked: [{ vehicle: 'SUV' }, { vehicle: 'ORV' }, { vehicle: 'Motorcycle' }] }
};
check('feedback rank 1 = HIGH winner', JSON.stringify(app.feedbackForRank(sampleRun, 1)) === JSON.stringify({ rank: 1, winner: 'SUV' }));
check('feedback rank 2 = MID winner', app.feedbackForRank(sampleRun, 2).winner === 'ORV');
check('feedback rank 3 = JACKPOT winner', app.feedbackForRank(sampleRun, 3).winner === 'Motorcycle');
check('feedback rank 4 rejected', app.feedbackForRank(sampleRun, 4) === null);
check('feedback with no run rejected', app.feedbackForRank(null, 1) === null);
check('migrate legacy correct -> rank 1', (function () { var f = app.migrateFeedback('correct', sampleRun); return f && f.rank === 1 && f.winner === 'SUV'; })());
check('migrate legacy wrong/MID -> rank 2', app.migrateFeedback({ wrong: true, winner: 'ORV' }, sampleRun).rank === 2);
check('migrate legacy wrong/JACKPOT -> rank 3', app.migrateFeedback({ wrong: true, winner: 'Motorcycle' }, sampleRun).rank === 3);
check('migrate new shape passes through', app.migrateFeedback({ rank: 2, winner: 'ORV' }, sampleRun).rank === 2);
check('migrate garbage -> null', app.migrateFeedback('nonsense', sampleRun) === null);
check('migrate null -> null', app.migrateFeedback(null, sampleRun) === null);

// buildFeedbackRace still saves the right winner for each rank's button
[1, 2, 3].forEach(function (rank) {
  var fb = app.feedbackForRank(sampleRun, rank);
  var race = app.buildFeedbackRace({ vehicles: sampleRun.vehicles, tracks: ['Dirt', 'unknown', 'unknown'] }, fb.winner);
  check('feedback rank ' + rank + ' builds a race with that winner', race !== null && race.winner === fb.winner);
});

// --- jackpot streak ---
// A: 20 own bets, HIGH always wins -> no JACKPOT in last 15 -> note shown
var histA = buildSynthetic(20, function () { return 1; });
var noteA = app.jackpotStreakNote(histA.concat(seedHistory), app.DEFAULT_SPEEDS);
check('streak: 20 HIGH wins -> note shown', typeof noteA === 'string' && noteA.indexOf('Jackpot watch') === 0);
check('streak: note text is exact', noteA === 'Jackpot watch: no JACKPOT win in the last 15 — you could try JACKPOT for the next 1–2 bets. (Streaks don\'t change the odds — your call.)');
// B: 20 own bets, one JACKPOT win inside the last 15 -> no note
var histB = buildSynthetic(20, function (i) { return i === 10 ? 3 : 1; });
check('streak: JACKPOT win inside last 15 -> no note', app.jackpotStreakNote(histB.concat(seedHistory), app.DEFAULT_SPEEDS) === '');
// C: fewer than 15 own bets -> no note (graceful)
var histC = buildSynthetic(5, function () { return 1; });
check('streak: 5 races only -> no note', app.jackpotStreakNote(histC, app.DEFAULT_SPEEDS) === '');
check('streak: empty history -> no note', app.jackpotStreakNote([], app.DEFAULT_SPEEDS) === '');
// D: JACKPOT win OUTSIDE the last 15 (chrono index 2 of 20) -> note shown
var histD = buildSynthetic(20, function (i) { return i === 2 ? 3 : 1; });
check('streak: JACKPOT win older than last 15 -> note shown', app.jackpotStreakNote(histD.concat(seedHistory), app.DEFAULT_SPEEDS).indexOf('Jackpot watch') === 0);
// E: exactly 15 own bets, HIGH always -> note shown
var histE = buildSynthetic(15, function () { return 1; });
check('streak: exactly 15 HIGH wins -> note shown', app.jackpotStreakNote(histE.concat(seedHistory), app.DEFAULT_SPEEDS).indexOf('Jackpot watch') === 0);
// F: Scribd rows are excluded — 20 Scribd rows (newest) with JACKPOT wins
// on top of 20 HIGH own bets -> note still shown (the sheet rows are not
// the user's bets, so they must not enter the window)
var scribd = buildSynthetic(20, function () { return 3; }).map(function (r) {
  var copy = Object.assign({}, r, { how_won_text: 'Scribd sheet' });
  copy.vehicles = r.vehicles.slice(); copy.tracks = r.tracks.slice();
  return copy;
});
var histF = scribd.concat(histA).concat(seedHistory);
check('streak: Scribd rows excluded from the window', app.jackpotStreakNote(histF, app.DEFAULT_SPEEDS).indexOf('Jackpot watch') === 0);
// G: Scribd-only history -> no note (fewer than 15 own bets)
check('streak: Scribd-only history -> no note', app.jackpotStreakNote(scribd, app.DEFAULT_SPEEDS) === '');

// --- prediction accuracy (replay) ---
// Built WITHOUT the seed: the replay slices to the newest 20, so the
// seed is not in the replay history either — construction and replay
// see the same history, so the ranks reproduce exactly.
var histAAcc = buildSynthetic(20, function () { return 1; }, false);
var accA = app.predictionAccuracy(histAAcc.concat(seedHistory), app.DEFAULT_SPEEDS, 20);
check('accuracy: 20 rank-1 wins -> high 20', accA.total === 20 && accA.high === 20 && accA.mid === 0 && accA.jackpot === 0 && accA.skipped === 0);
var mixed = buildSynthetic(10, function (i) { return i < 5 ? 1 : i < 8 ? 2 : 3; }, false);
var accM = app.predictionAccuracy(mixed.concat(seedHistory), app.DEFAULT_SPEEDS, 10);
check('accuracy: mixed ranks counted', accM.total === 10 && accM.high === 5 && accM.mid === 3 && accM.jackpot === 2);
var bad = [
  { vehicles: ['SUV', 'ORV', 'Motorcycle'], tracks: ['Dirt', 'unknown', 'unknown'], winner: 'ATV', how_won: 'Other', how_won_text: '' },
  { vehicles: ['SUV', 'ORV'], tracks: ['Dirt', 'unknown', 'unknown'], winner: 'SUV', how_won: 'Other', how_won_text: '' }
];
var accB = app.predictionAccuracy(bad.concat(histAAcc).concat(seedHistory), app.DEFAULT_SPEEDS, 22);
check('accuracy: bad rows skipped, good rows counted', accB.skipped === 2 && accB.total === 20);
check('accuracy: empty history -> zero', (function () { var a = app.predictionAccuracy([], app.DEFAULT_SPEEDS, 100); return a.total === 0 && a.window === 0; })());

// --- replay cost sanity (the Stats tab runs this on open) ---
var big = buildSynthetic(100, function () { return 1; }).concat(seedHistory);
var t0 = Date.now();
var accBig = app.predictionAccuracy(big, app.DEFAULT_SPEEDS, 100);
var ms = Date.now() - t0;
check('accuracy: 100-race replay completes', accBig.total === 100);
console.log('INFO  accuracy replay of 100 races took ' + ms + ' ms');

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
