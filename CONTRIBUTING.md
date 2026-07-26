# Contributing to Hyperaudio Lite Editor

Thanks for your interest in improving Hyperaudio Lite Editor! This guide covers
how to contribute, the licensing that contributions are made under, and the
project's conventions.

> **Please read the [Contributor License Agreement](#contributor-license-agreement)
> section before opening a pull request** — because this project is offered
> under more than one license (see below), we need a short agreement from
> contributors. It only has to be signed once.

## Ways to contribute

- **Report bugs** and **request features** via [GitHub Issues](https://github.com/hyperaudio/hyperaudio-lite-editor/issues).
- **Fix issues** — issues tagged `good first issue` are a friendly starting point.
- **Improve docs** — corrections and clarifications are always welcome.

## Development setup

The editor is a static web app — there is no build step for the app itself.

```bash
git clone https://github.com/hyperaudio/hyperaudio-lite-editor.git
cd hyperaudio-lite-editor
npm install          # dev dependencies (Playwright, etc.) — only needed for tests
python3 -m http.server 4173   # or any static file server
# open http://localhost:4173/index.html
```

## Running the tests

```bash
npm test            # unit + end-to-end
npm run test:unit   # node --test, __TEST__/unit/**
npm run test:e2e    # Playwright, __TEST__/e2e/**
```

The unit lane needs Node 21+ (CI uses Node 22). For the e2e lane you may need
`npx playwright install --with-deps chromium` the first time.

**Please add a test with your change.** The convention here is a regression
test per fix — a small unit or e2e test that fails on the old code and passes
with your change. This keeps fixes from silently regressing later.

## Conventions

- **Keep it modular.** New features should be self-contained (their own file /
  module where reasonable) so they can be maintained or disabled independently.
- **Vendored files are read-only here.** `js/hyperaudio-lite.js`,
  `js/hyperaudio-lite-extension.js`, `js/caption.js`,
  `css/hyperaudio-lite-player.css`, and everything under `js/vendor/` are
  copied from upstream projects. Fixes to those belong **upstream** (e.g.
  [hyperaudio-lite](https://github.com/hyperaudio/hyperaudio-lite)) and are
  re-vendored here — please don't patch them locally.
- **Cache-bust changed assets.** Scripts and styles are loaded with a `?v=`
  query in `index.html`; bump it (and any per-file `@version` header) when you
  change a file, so browsers pick up the new version.
- **Match the surrounding code.** Follow the style, naming, and comment density
  of the file you're editing.
- **Priority browsers** are Chrome and Safari (including iOS Safari); please
  don't introduce regressions there. Firefox support is nice-to-have.

## Submitting a pull request

1. Fork the repo and create a branch from `main`.
2. Make your change, add a test, and run `npm test`.
3. Open a pull request describing **what** changed and **why**, and referencing
   any related issue (e.g. `Fixes #123`).
4. Sign the CLA when prompted (see below). CI must be green before merge.

## Contributor License Agreement

Hyperaudio Lite Editor is provided under a **triple license model** (see
[README](./README.md#licensing) and [LICENSES](./LICENSES)):

- **AGPL-3.0** — the default open-source license;
- **MIT** — for non-commercial / not-for-profit use;
- a **commercial license** — for proprietary/commercial use.

Because the project is distributed under these different licenses (including a
commercial one), we ask every contributor to agree to a **Contributor License
Agreement (CLA)** before their contribution can be merged. In short, the CLA
lets you keep the copyright to your work while granting the project the rights
it needs to include your contribution under **all** of the licenses above.

- Read the agreement: **[CLA.md](./CLA.md)**.
- **How to sign:** we use [CLA Assistant](https://cla-assistant.io/). The bot
  will comment on your first pull request with a link to sign electronically
  (via your GitHub account), and your PR can be merged once the CLA status
  check is green. You only sign once; it covers all your future contributions.
- Contributing on behalf of an **employer**? See the corporate section in
  [CLA.md](./CLA.md) — your employer may need to sign too.

If you have any questions about contributing or licensing, contact
**mark@hyperaud.io**.
