// #356/#287 ("two sets of captions") kept coming back for a structural reason:
// each fix was attached to ONE path, so the next path to swap captions
// reintroduced it. The bug has two halves — stale cue DATA (a reused <track>) and
// stale cue PIXELS (a paused video never re-composites its native caption
// overlay) — and a path that does only the first still shows the previous
// document's caption line.
//
// Both halves now live behind one door: applyCaptionTrack / flushCaptionPaint in
// js/hyperaudio-save.js. This test is the guard rail — it fails when a new
// caption writer sets the track's src itself instead of going through the door,
// which is the mistake that caused each recurrence. The e2e spec
// (caption-track-reset.spec.mjs) checks that the paths actually flush; this one
// checks that no path can quietly opt out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const JS_DIR = new URL('../../js/', import.meta.url);

// Where the door itself lives — the one legitimate `track.src =`.
const DOOR = 'hyperaudio-save.js';

// The live-edit sanitise path assigns .src in place on every debounced keystroke
// and must NOT swap the element or churn the caption paint (see the note in
// editor-core.js's regenerate handler). Deliberately exempt.
const LIVE_EDIT = new Set(['editor-core.js', 'editor-main.js']);

// Vendored from hyperaudio-lite — not ours to edit. caption.js's applyCaptions is
// reached only through generateCaptionsFromTranscript, whose caller flushes.
const VENDORED = new Set([
  'caption.js',
  'hyperaudio-lite.js',
  'hyperaudio-lite-extension.js',
]);

test('only the caption door assigns the caption track src (#356/#287)', () => {
  const offenders = [];
  const files = fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length > 5, 'expected to find the js/ sources');

  for (const name of files) {
    if (name === DOOR || LIVE_EDIT.has(name) || VENDORED.has(name)) continue;
    const text = fs.readFileSync(new URL(name, JS_DIR), 'utf8');
    text.split('\n').forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, '');           // ignore comments
      if (/-vtt['"]\)\s*\.src\s*=/.test(code) || /\btrack\.src\s*=/.test(code)) {
        offenders.push(`${name}:${i + 1}: ${line.trim()}`);
      }
    });
  }

  assert.deepEqual(
    offenders,
    [],
    'these must call applyCaptionTrack() so the paint flush cannot be skipped:\n'
      + offenders.join('\n')
  );
});
