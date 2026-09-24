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
license headers are retained in each file — except the one below.

## transformers.js, patched (#462)

`transformers-4.2.0-pr1755.min.js` is **not** a published build. It is
[@huggingface/transformers](https://github.com/huggingface/transformers.js)
4.2.0 (Apache-2.0) rebuilt from source with the source changes of
[huggingface/transformers.js#1755](https://github.com/huggingface/transformers.js/pull/1755)
applied, which free the GPU tensors Whisper's generation leaves behind
([huggingface/transformers.js#1739](https://github.com/huggingface/transformers.js/issues/1739), our #462).
Imported by `js/whisper.worker.js`; ONNX Runtime's own files still load from
jsDelivr, as with the published build. Not precached: it is only needed to
transcribe, which needs the network for the model anyway, and the service
worker caches it on first use like every file here.

- Source: tag `4.2.0`, plus `patches/transformers-4.2.0-pr1755.patch`
  (`git diff` of `packages/transformers/src` between the PR's merge base and
  its head, commit `7b2bd3a`).
- Build: `pnpm install --frozen-lockfile`, then
  `node scripts/build.mjs` in `packages/transformers`; the file is
  `dist/transformers.min.js`.
- Check: the same build WITHOUT the patch is byte-identical to the file
  jsDelivr serves for `@huggingface/transformers@4.2.0`, so the patch is the
  only difference.
- SHA-256: `3818cf2e8bd0a104955368714d5ab924ff2e7861edc94eceed9015b9049b4f29`
- Verified (M4 Pro, Chrome, 2026-09-24): GPU memory flat across repeated
  runs on Base and Small, where 4.2.0 grows ~600 MB per 137 s on Base; words
  and timings identical to 4.2.0 on both the WebGPU and the WASM path.

**Remove it** once a transformers.js release includes the fix: go back to the
jsDelivr import in `js/whisper.worker.js` and delete this file and the patch.
Whisper Small and Large v3 Turbo are behind Settings ▸ Experimental features
because of this leak; whether they can leave it is a separate decision.

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
