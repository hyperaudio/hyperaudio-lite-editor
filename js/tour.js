/**
 * tour.js
 * (C) The Hyperaudio Project
 * @version 1.3.36 — last changed in release 1.3.36
 * @license MIT
 *
 * A tour of the editor (#718): a few cards, each pointing at one part of the
 * page, driven by driver.js (js/vendor/driver-1.9.0.js). It runs once, the
 * first time the editor is opened, after the intro project is on screen so
 * the cards point at real content, and it can be taken again from Settings
 * ▸ Application ▸ Take the tour.
 *
 * Seen is one flag in the settings store (tourSeen), set as the tour starts:
 * shown is seen, however far it is followed. A step may open something —
 * the Transcribe dialog, the File menu, Export media, Settings — so its
 * card can point inside, and closes it again on the way out, whichever way
 * out that is. Steps whose target is not on the page, or not shown
 * at this width (Recents is a drawer on a phone, so the card goes on the
 * button that opens it), are left out rather than pointed at nothing.
 *
 * Remove this file, its <script> tag, the Take the tour row in Settings and
 * the two vendored driver files, and nothing else changes.
 */
(function () {
  const SETTING = 'tourSeen';

  // A modal opened for a step, and closed again after it. The toggle's change
  // event is what a dialog fills itself on (Export media lists its formats
  // then), and a checkbox set from script does not fire it by itself.
  const modal = (id) => () => {
    const toggle = document.getElementById(id);
    if (toggle === null) return () => {};
    const set = (checked) => {
      toggle.checked = checked;
      toggle.dispatchEvent(new Event('change', { bubbles: true }));
    };
    set(true);
    return () => set(false);
  };
  const modalBox = (id) => '#' + id + ' + .modal .modal-box';
  // The captions view, entered and left as the two view buttons do it
  const captionsView = () => {
    const captions = document.getElementById('caption-editor-btn');
    const transcript = document.getElementById('transcript-editor-btn');
    if (captions === null || transcript === null) return () => {};
    if (captions.getAttribute('aria-pressed') !== 'true') captions.click();
    return () => { if (transcript.getAttribute('aria-pressed') !== 'true') transcript.click(); };
  };
  // A Recents row's three-dot menu, opened as a click on the dots does
  const rowMenu = () => {
    const kebab = document.querySelector('#file-picker .recents-kebab');
    if (kebab === null) return () => {};
    if (kebab.getAttribute('aria-expanded') !== 'true') kebab.click();
    return () => {
      const open = document.querySelector('.recents-kebab[aria-expanded="true"]');
      if (open !== null) open.click(); // a second click shuts it
    };
  };

  // Each step names its targets in order of preference: the first one on the
  // page and shown is used. None shown, no step. A step with `open` opens
  // something first, and its card points at `inside` when that is on the
  // page. A button is explained on its own card before the step that opens
  // what it leads to.
  const STEPS = [
    {
      targets: ['#new-transcription-btn'],
      title: 'Start with a recording',
      text: 'NEW is where a transcript begins: it transcribes an audio or video file, or a link. This intro is here so you can try the editor first.',
    },
    {
      targets: ['#new-transcription-btn'],
      open: modal('transcribe-modal'),
      inside: modalBox('transcribe-modal'),
      title: 'Choose an engine',
      text: 'Transcribe on this device, where nothing is uploaded, or in the cloud with your own key for longer recordings and faster results.',
    },
    {
      targets: ['#hypertranscript'],
      title: 'The transcript',
      // one point per paragraph: driver renders the description as HTML
      text: '<p>Double-click any word to move the playhead and press play.</p>'
        + '<p>For faster navigation select "Double-click a word to play from it" from Settings → Playback.</p>'
        + '<p>Type straight into the transcript to correct it.</p>'
        + '<p>Press return for a new paragraph.</p>'
        + '<p>Add speaker names between [square brackets].</p>',
    },
    {
      targets: ['#strikethrough'],
      title: 'Strikethrough',
      text: 'Select words and strike them out to cut them. Playback and exports skip struck words.',
    },
    {
      targets: ['#view-switch'],
      title: 'Transcript and captions',
      text: 'Switch between the transcript and the captions made from it.',
    },
    {
      targets: ['#caption-editor-btn'],
      open: captionsView,
      inside: '#captions-display',
      title: 'The captions view',
      text: 'Captions are made from the transcript as you edit it. Here each one can be tweaked on its own, and the Transcript button takes you back.',
    },
    {
      targets: ['#recents-card', '#sidebar-toggle'],
      title: 'Recents',
      text: 'Every project you open or transcribe is kept here, in this browser. Click one to switch to it.',
    },
    {
      targets: ['#file-picker .recents-kebab'],
      open: rowMenu,
      inside: '#recents-menu',
      title: 'A project\'s actions',
      text: 'The three dots on a project star it, rename it, duplicate it or delete it.',
    },
    {
      targets: ['#export-media-btn'],
      title: 'Export media',
      text: 'Turn your edited transcript back into media: audio or video with the cuts applied.',
    },
    {
      targets: ['#export-media-btn'],
      open: modal('export-modal'),
      inside: modalBox('export-modal'),
      title: 'The export dialog',
      text: 'Choose the whole recording or the edited one, the format, and whether to burn the captions in. A video can also be cropped for portrait or square.',
    },
    {
      targets: ['#settings-btn'],
      title: 'Settings',
      text: 'Captions, playback, provenance and the editor\'s storage are set here.',
    },
    {
      targets: ['#settings-btn'],
      open: modal('settings-modal'),
      inside: '#settings-tour',
      title: 'Taking the tour again',
      text: 'This is where to find the tour whenever you want it.',
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
  let current = null; // the step on screen
  let cleanup = null; // closes what the current step opened
  function closeStep() {
    if (cleanup !== null) {
      const close = cleanup;
      cleanup = null;
      try { close(); } catch (e) { /* nothing left to close */ }
    }
  }
  function openStep(step) {
    if (current === step && cleanup !== null) return; // already open for this step
    closeStep();
    current = step;
    if (typeof step.open === 'function') {
      cleanup = step.open();
      // a dialog is measured before it has fully appeared: place the card again once it has
      setTimeout(() => { if (running !== null && current === step) running.refresh(); }, 260);
    }
  }
  // the card points inside what the step opened, where that is on the page
  const cardTarget = (step) => {
    if (step.inside) {
      const inside = document.querySelector(step.inside);
      if (inside !== null) return inside.closest('.settings-row') || inside;
    }
    return targetOf(step);
  };

  function start() {
    const lib = window.driver && window.driver.js && window.driver.js.driver;
    if (typeof lib !== 'function') return false;
    if (running !== null) running.destroy();
    const steps = STEPS.map((step) => {
      if (targetOf(step) === null) return null;
      return {
        // opened as the target is looked up: driver resolves the element
        // before it fires any hook, and a menu made on opening (Recents'
        // three dots) is only there to point at once it is open
        element: () => { openStep(step); return cardTarget(step); },
        popover: { title: step.title, description: step.text },
        onHighlightStarted: () => openStep(step),
        // fired after the NEXT step's target is resolved, by which time that
        // step is current and has closed this one's: only ever close our own
        onDeselected: () => { if (current === step) closeStep(); },
      };
    }).filter((step) => step !== null);
    if (steps.length === 0) return false;
    // the tour is on top of everything: nothing else should be open under it
    document.querySelectorAll('.modal-toggle:checked').forEach((toggle) => { toggle.checked = false; });
    // Nothing moves between steps: the cut-out sliding from a button to the
    // dialog it opens, while the dialog faded in, was a white block crossing
    // the page. Steps cut, and the dialogs cut too (body.hyperaudio-touring).
    document.body.classList.add('hyperaudio-touring');
    running = lib({
      steps,
      animate: false,
      overlayOpacity: 0.35, // the page stays readable behind the card
      showProgress: true,
      progressText: '{{current}} of {{total}}',
      nextBtnText: 'Next',
      prevBtnText: 'Back',
      doneBtnText: 'Done',
      popoverClass: 'hyperaudio-tour',
      // whichever way out — Done, ✕, Escape, the overlay — nothing stays open
      onDestroyStarted: () => {
        closeStep();
        current = null;
        const d = running;
        running = null;
        if (d !== null) d.destroy();
        document.body.classList.remove('hyperaudio-touring');
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
