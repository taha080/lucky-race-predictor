// Tests for lrp-v15: HIGH/MID/JACKPOT feedback-button fix + suggestion line.
// The bug (22 Nov 2026): the three feedback buttons did nothing on the
// user's phone — no toast, no state change. Causes fixed here:
//   (a) listeners were bound directly once in init (dead when buttons are
//       re-created or when a stale cached app.js runs against new HTML);
//       now ONE delegated listener on #feedbackBox handles all three.
//   (b) answerFeedback returned silently on every failure path; now every
//       path toasts, and a tap shows 'Saving…' + disabled buttons at once.
//   (c) a rejected cloud insert left the box stuck on 'Saving…' forever;
//       now the answer is cleared so the user can tap again.
//   (d) js/app.js is network-first in the service worker, so a stale
//       app.js can no longer outlive a fresh index.html.
// Run from the repo root:
//   node scripts/test-lrp-v15.js
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

/* --- Minimal DOM stub, set AFTER require (init() never runs in Node) --- */
var toastText = '';
function makeEl() {
  return {
    textContent: '',
    disabled: false,
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    addEventListener: function () {},
    closest: function () { return null; }
  };
}
var toastEl = makeEl();
Object.defineProperty(toastEl, 'textContent', {
  get: function () { return toastText; },
  set: function (v) { toastText = v; }
});
global.document = {
  getElementById: function (id) { return id === 'toast' ? toastEl : makeEl(); },
  addEventListener: function () {},
  readyState: 'complete'
};

function resetWizard() {
  app.wizard.step = 0; app.wizard.ran = false; app.wizard.lastRun = null;
  app.wizard.feedback = null; app.wizard.feedbackSaved = false; app.wizard.feedbackSaving = false;
}
function sampleRun(vehicles, tracks, ranked) {
  return {
    vehicles: vehicles.slice(),
    tracks: tracks.slice(),
    result: { ranked: ranked.map(function (v) { return { vehicle: v }; }) }
  };
}
function flush() { return new Promise(function (r) { setTimeout(r, 20); }); }

(async function main() {
  check('suggestionLine exported', typeof app.suggestionLine === 'function');
  check('answerFeedback exported', typeof app.answerFeedback === 'function');
  check('wizard exported', !!app.wizard && typeof app.wizard === 'object');

  // --- suggestionLine (pure) ---
  check('suggestionLine names all three picks',
    app.suggestionLine([{ vehicle: 'SUV' }, { vehicle: 'ORV' }, { vehicle: 'Motorcycle' }]) ===
    'Suggested bet: HIGH — SUV · MID — ORV · JACKPOT — Motorcycle');
  check('suggestionLine short list -> empty', app.suggestionLine([{ vehicle: 'SUV' }]) === '');
  check('suggestionLine null -> empty', app.suggestionLine(null) === '');
  check('suggestionLine missing vehicle -> empty',
    app.suggestionLine([{ vehicle: 'SUV' }, {}, { vehicle: 'Motorcycle' }]) === '');

  // --- answerFeedback: no run at all -> visible toast, nothing saved ---
  resetWizard();
  toastText = '';
  app.answerFeedback(2);
  check('tap with no run toasts RUN-first', toastText === 'Tap RUN first, then tell us which pick won.');
  check('tap with no run sets no feedback', app.wizard.feedback === null);

  // --- answerFeedback: happy path (MID won) ---
  resetWizard();
  app.wizard.ran = true;
  app.wizard.lastRun = sampleRun(['SUV', 'ORV', 'Motorcycle'], ['Dirt', 'unknown', 'unknown'], ['SUV', 'ORV', 'Motorcycle']);
  toastText = '';
  app.answerFeedback(2);
  check('MID tap records rank 2 / ORV',
    !!app.wizard.feedback && app.wizard.feedback.rank === 2 && app.wizard.feedback.winner === 'ORV');
  check('MID tap sets feedbackSaving at once', app.wizard.feedbackSaving === true);
  await flush();
  check('MID tap saves (demo mode: local save)', app.wizard.feedbackSaved === true);
  check('MID tap clears feedbackSaving', app.wizard.feedbackSaving === false);
  check('MID tap toasts saved', toastText === 'Race saved. Model updated.');

  // --- answerFeedback: double tap -> second tap ignored, first wins ---
  resetWizard();
  app.wizard.ran = true;
  app.wizard.lastRun = sampleRun(['Car', 'ATV', 'Sports Car'], ['Highway', 'unknown', 'unknown'], ['Car', 'ATV', 'Sports Car']);
  toastText = '';
  app.answerFeedback(1);
  app.answerFeedback(3);
  check('double tap keeps first answer (rank 1)',
    !!app.wizard.feedback && app.wizard.feedback.rank === 1 && app.wizard.feedback.winner === 'Car');
  check('double tap toasts Saving-please-wait', toastText === 'Saving… please wait.');
  await flush();
  check('double tap still saves once', app.wizard.feedbackSaved === true);

  // --- answerFeedback: tap after saved -> visible toast, no change ---
  toastText = '';
  var fbBefore = app.wizard.feedback;
  app.answerFeedback(2);
  check('tap after saved toasts already-saved', toastText === 'This race is already saved.');
  check('tap after saved keeps feedback', app.wizard.feedback === fbBefore);

  // --- answerFeedback: bad rank -> visible toast, no feedback ---
  resetWizard();
  app.wizard.ran = true;
  app.wizard.lastRun = sampleRun(['SUV', 'ORV', 'Motorcycle'], ['Dirt', 'unknown', 'unknown'], ['SUV', 'ORV', 'Motorcycle']);
  toastText = '';
  app.answerFeedback(4);
  check('bad rank toasts RUN-again', toastText === 'No result to answer for — tap RUN again.');
  check('bad rank sets no feedback', app.wizard.feedback === null);

  // --- answerFeedback: run without a ranked list -> visible toast ---
  resetWizard();
  app.wizard.ran = true;
  app.wizard.lastRun = { vehicles: ['SUV', 'ORV', 'Motorcycle'], tracks: ['Dirt', 'unknown', 'unknown'] };
  toastText = '';
  app.answerFeedback(1);
  check('run without ranked list toasts RUN-again', toastText === 'No result to answer for — tap RUN again.');
  check('run without ranked list sets no feedback', app.wizard.feedback === null);

  finish();
})().catch(function (e) {
  console.log('FAIL  test crashed: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
