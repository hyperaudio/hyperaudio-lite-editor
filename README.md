
# Hyperaudio Lite Editor

A lightweight transcript editor for creating, editing and correcting machine‑generated transcripts — then turning them into captions, edited media and interactive transcripts.

Super Lightweight :snowflake:
Lightning Fast :zap:
Accessible :couple_with_heart:
Installable :computer:
Portable :iphone:

### Try it out!

[Demo (with localStorage, installable as a Progressive Web App)](https://hyperaudio.github.io/hyperaudio-lite-editor/index.html)

[<img alt="Hyperaudio Lite Editor — default view" src="docs/images/default-view.png" width="860">](https://hyperaudio.github.io/hyperaudio-lite-editor/index.html)

---

## Features

### Transcribe — locally or in the cloud

Transcribe right in your browser, or through a cloud service with your own key.

- **Local (in‑browser, no key, private):** Parakeet and Whisper run entirely on your machine — the audio never leaves the browser.
- **Cloud (bring your own key):** AssemblyAI, Deepgram, and Parakeet via HuggingFace — fast, accurate, with word‑level timing.

<img alt="Transcribe dialog — local engines" src="docs/images/transcribe-dialog-local.png" width="330"> <img alt="Transcribe dialog — cloud engines" src="docs/images/transcribe-dialog-cloud.png" width="330">

### Already have a transcript? Align it

Paste an existing transcript and align it to the media to recover word‑level timings.

<img alt="Align previously transcribed content" src="docs/images/align-previously-transcribed-content.png" width="640">

### Edit, correct, search and replace

Edit in the usual way — fix words, add punctuation, split and merge paragraphs. Find and replace across the whole transcript, with the active match highlighted.

<img alt="Search and replace" src="docs/images/search-and-replace.png" width="860">

### Strike out to redact and cut

Strike out words to remove them — from the transcript, from playback, and from any exported media.

<img alt="Strike out to redact" src="docs/images/strikeout-to-redact.png" width="860">

### Remove silent gaps

Skip silences during playback and in export, with a simple on/off switch and advanced controls for the pause threshold and edge buffers.

<img alt="Gap removal — basic" src="docs/images/gap-removal-basic.png" width="640">

<img alt="Gap removal — advanced settings" src="docs/images/gap-removal-advanced.png" width="520">

### Caption editor

Switch into caption mode to review and fine‑tune cues line by line, with timings kept in sync.

<img alt="Caption editor" src="docs/images/caption-editor.png" width="860">

### Karaoke‑style burned‑in captions

Bake word‑level, read‑along captions straight into the video — spoken words solid, the current word highlighted — TikTok/Reels style.

<img alt="Burned‑in karaoke captions" src="docs/images/burned-in-karaoke-captions.png" width="860">

### Flexible export

Export edited media (WAV / MP3 / MP4 / WebM) with cuts, gap‑skips and playback speed applied; adjust the speed or fit to a target length; and download captions (WebVTT / SRT) or a self‑contained interactive transcript that links your exported media.

<img alt="Flexible export options" src="docs/images/flexible-export.png" width="330"> <img alt="Export with burned‑in captions" src="docs/images/export-with-burned-in-captions.png" width="330">

<img alt="Export and download menu" src="docs/images/export-and-download.png" width="500">

<img alt="Interactive transcript export" src="docs/images/interactive-transcript-export.png" width="520">

### A view that adapts to you

Collapse the video, pop it out picture‑in‑picture, or work on a phone — the layout adapts.

<img alt="Flexible view" src="docs/images/flexible-view.png" width="700">

<img alt="Picture‑in‑picture" src="docs/images/picture-in-picture.png" width="500"> <img alt="Mobile compatible" src="docs/images/mobile-compatible.png" width="300">

---

### How to Use

Edit in the usual way – add punctuation, create and merge paragraphs etc. Place speaker names in square brackets ie [Maria]. It's recommended that in order to maintain word timings you don't paste large blocks of text. Double-click on words to set the playhead at that point.

### Lightweight, Performant and Installable

We score very highly on Google Chrome's Lighthouse audit tool.

<img width="739" alt="Chrome Lighthouse showing maximum accessibility, performance and best practice scores" src="https://user-images.githubusercontent.com/208756/232544023-a3f29e3b-5238-4c06-8404-27ab008012a2.png">

Created as a Progressive Web App, you can install it on your desktop or mobile home screen.

### Licensing

`Hyperaudio Lite Editor`'s source code is provided under a **triple license model**.

#### Open source license

If you are creating an open source application under a license compatible with the GNU Affero GPL license v3, you may use `Hyperaudio Lite Editor` for free under the terms of the [AGPL-3.0](./LICENSE). This is the default license for `Hyperaudio Lite Editor`.

#### Non-commercial use

If you are a non-commerical / not-for-profit entity or organisation and wish to to use this software for non-commercial please contact [mark@hyperaud.io](mailto:mark@hyperaud.io) to use `Hyperaudio Lite Editor` for free under the terms of the [MIT License](/.LICENSE-MIT)

#### Commercial license

If you'd like to use `Hyperaudio Lite Editor` to develop commercial sites, tools, and applications, the Commercial License is the appropriate license. With this option, your source code is kept proprietary. To enquire about a `Hyperaudio Lite Editor` Commercial License please contact [mark@hyperaud.io](mailto:mark@hyperaud.io).

### Support

Please support The Hyperaudio Project by donating to our [Patreon account](https://patreon.com/hyperaudio).
