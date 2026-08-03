# Vendored dependencies

Third-party libraries vendored for offline use (#381). Loaded lazily by
`js/media-export.js` via bare specifiers, resolved by the import map in
`index.html`.

| File | Package | Version | License | Source |
|---|---|---|---|---|
| `mediabunny-1.50.3.min.js` | [mediabunny](https://www.npmjs.com/package/mediabunny) | 1.50.3 | MPL-2.0 | `dist/bundles/mediabunny.min.mjs` |
| `mediabunny-mp3-encoder-1.50.3.min.js` | [@mediabunny/mp3-encoder](https://www.npmjs.com/package/@mediabunny/mp3-encoder) | 1.50.3 | MPL-2.0 | `dist/bundles/mediabunny-mp3-encoder.min.mjs` |
| `soundtouchjs-0.3.0.js` | [soundtouchjs](https://www.npmjs.com/package/soundtouchjs) | 0.3.0 | LGPL-2.1 | `dist/soundtouch.js` |
| `jszip-3.10.1.min.js` | [jszip](https://www.npmjs.com/package/jszip) | 3.10.1 | MIT (dual MIT/GPL-3.0; used under MIT) | `dist/jszip.min.js` |

All files are unmodified copies of the packages' published dist builds;
license headers are retained in each file.

## Upgrading

mediabunny and @mediabunny/mp3-encoder release together and MUST stay in
exact lockstep — the mp3-encoder's internal bare `import "mediabunny"` is
resolved by the import map to our mediabunny copy, giving one shared module
instance (`registerMp3Encoder()` registers into the copy we encode with).

To upgrade:

1. Download the new package tarballs from the npm registry and copy the same
   dist builds listed above into this folder, versioned filenames included.
2. Update the three entries in the `importmap` in `index.html`.
3. Remove the old files, and update the precache list in `serviceworker.js`.
