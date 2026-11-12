/**
 * tour.js
 * (C) The Hyperaudio Project
 * @version 1.3.47 — last changed in release 1.3.47
 * @license AGPL-3.0-only
 *
 * A tour of the editor (#718): eight cards, each pointing at one part of the
 * page, driven by driver.js (js/vendor/driver-1.9.0.js). It runs once, the
 * first time the editor is opened, after the intro project is on screen so
 * the cards point at real content, and it can be taken again from Settings
 * ▸ Application ▸ Take the tour.
 *
 * The cards come in the order people meet things (#796): the transcript and
 * the two editing buttons first, since that is where everyone starts, and
 * NEW sixth. No card opens a dialog on the viewer's behalf: what a dialog
 * offers is said on the button's own card. (Fourteen cards, five of them
 * inside dialogs the card before had opened, were too many and put NEW
 * first, which nobody wanted first.)
 *
 * Seen is one flag in the settings store (tourSeen), set as the tour starts:
 * shown is seen, however far it is followed. Steps whose target is not on
 * the page, or not shown at this width (Recents is a drawer on a phone, so
 * the card goes on the button that opens it), are left out rather than
 * pointed at nothing.
 *
 * Remove this file, its <script> tag, the Take the tour row in Settings and
 * the two vendored driver files, and nothing else changes.
 */
(function () {
  const SETTING = 'tourSeen';

  const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || '');
  const STRIKE_SHORTCUT = IS_MAC ? '⌘⇧X' : 'Ctrl+Shift+X';

  // Each step names its targets in order of preference: the first one on the
  // page and shown is used. None shown, no step. Driver renders the text as
  // HTML, so a card with several points has one paragraph per point.
  const STEPS = [
    {
      targets: ['#hypertranscript'],
      title: 'The transcript',
      text: '<p>Click any word to move the playhead there.</p>'
        + '<p>Type straight into the transcript to correct it.</p>'
        + '<p>Press Return for a new paragraph.</p>'
        + '<p>Add speaker names between [square brackets].</p>',
    },
    {
      targets: ['#strikethrough'],
      title: 'Cut words',
      text: '<p>Select words and strike them out (' + STRIKE_SHORTCUT + ') to cut them from the audio and video. Playback and exports skip struck words.</p>'
        + '<p>Deleting a word corrects the text. Striking it out cuts the media.</p>',
    },
    {
      targets: ['#remove-gaps-btn'],
      title: 'Skip the gaps',
      text: '<p>Silences between speech can be skipped, in playback and in exports, without touching the transcript.</p>'
        + '<p>Switch it on here. Under Advanced settings, say how long a silence has to be before it goes.</p>',
    },
    {
      targets: ['#view-switch'],
      title: 'Transcript and captions',
      text: 'Captions are made from the transcript as you edit it. Switch to the captions view to tweak each one on its own, and back to the transcript to carry on.',
    },
    {
      targets: ['#export-media-btn'],
      title: 'Export media',
      text: '<p>Turn your edited transcript back into media: audio or video with the cuts applied.</p>'
        + '<p>Choose the whole recording or the edited one, the format, and whether to burn the captions in. A video can also be cropped for portrait or square.</p>',
    },
    {
      targets: ['#new-transcription-btn'],
      title: 'Transcribe',
      text: 'NEW is where a transcript of your own begins: choose an audio or video file, or a link, and transcribe it. Transcribing on this device uploads nothing.',
    },
    {
      targets: ['#recents-card', '#sidebar-toggle'],
      title: 'Recents',
      text: '<p>Every project you open or transcribe is kept here. Click one to switch to it.</p>'
        + '<p>The three dots on a project star it, rename it, duplicate it or delete it.</p>',
    },
    {
      targets: ['#settings-btn'],
      title: 'Settings',
      text: 'Captions, playback, provenance and the editor\'s storage are set here, and the tour whenever you want it.',
    },
  ];

  const settings = () => window.HyperaudioSettings;
  const seen = () => !!(settings() && settings().get(SETTING) === true);
  const markSeen = () => { if (settings()) settings().set(SETTING, true); };

  // on the page, and inside the viewport: an off-canvas drawer has a size
  // but is not somewhere a card can point
  const shown = (el) => {
    if (el === null || getComputedStyle(el).visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0
      && r.left < window.innerWidth && r.top < window.innerHeight;
  };
  const targetOf = (step) => {
    for (const selector of step.targets) {
      const el = document.querySelector(selector);
      if (shown(el)) return el;
    }
    return null;
  };

  let running = null;

  function start() {
    const lib = window.driver && window.driver.js && window.driver.js.driver;
    if (typeof lib !== 'function') return false;
    if (running !== null) running.destroy();
    const steps = STEPS.map((step) => {
      if (targetOf(step) === null) return null;
      return {
        element: () => targetOf(step),
        popover: { title: step.title, description: step.text },
      };
    }).filter((step) => step !== null);
    if (steps.length === 0) return false;
    // the tour is on top of everything: nothing else should be open under it
    document.querySelectorAll('.modal-toggle:checked').forEach((toggle) => { toggle.checked = false; });
    running = lib({
      steps,
      animate: false, // the cut-out cuts from card to card rather than sliding across the page
      overlayOpacity: 0.35, // the page stays readable behind the card
      showProgress: true,
      progressText: '{{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      popoverClass: 'hyperaudio-tour',
      onDestroyStarted: () => {
        const d = running;
        running = null;
        if (d !== null) d.destroy();
      },
    });
    markSeen();
    running.drive();
    return true;
  }

  // First use: once the intro project (or whatever a reload returns to) is on
  // screen and nothing is in the way. Checked when the page settles and
  // whenever the library moves, until it has run once. Not under automation
  // (navigator.webdriver): the overlay would sit on top of every test.
  let started = false;
  let settle = null;
  function ready() {
    const t = document.getElementById('hypertranscript');
    return t !== null && t.querySelector('[data-m]') !== null
      && t.getAttribute('aria-busy') !== 'true'
      && document.querySelector('.modal-toggle:checked') === null
      && !document.hidden;
  }
  function tryFirstRun() {
    if (started || seen() || navigator.webdriver === true) return;
    clearTimeout(settle);
    settle = setTimeout(() => {
      if (started || seen() || !ready()) return;
      started = true;
      start();
    }, 1200);
  }

  function wire() {
    const button = document.getElementById('settings-tour');
    if (button !== null) button.addEventListener('click', start);
    tryFirstRun();
    document.addEventListener('hyperaudioLibraryChanged', tryFirstRun);
    document.addEventListener('hyperaudioInit', tryFirstRun);
  }

  window.HyperaudioTour = Object.freeze({ start, seen, SETTING });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }
}());
