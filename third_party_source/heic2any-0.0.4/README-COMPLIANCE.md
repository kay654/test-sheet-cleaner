# HEIC converter source

This directory contains only the source files needed to rebuild the third-party HEIC converter distributed as `../../vendor/heic2any/heic2any.min.js`.

- Package: `heic2any@0.0.4` (upstream commit `3428539e643e112323a5b8a2c77c6402cb1372f6`)
- Distributed file SHA-256: `0963cfa50e9e1e7e6af929a40a81e3e898a673f1270eafa6917dd137e4968164`
- Rebuild command: `npm ci` followed by `npm run build` (the empty `dist/` output directory is retained because the upstream build program expects it to exist)

`build/build.ts` is not application code. It is the upstream package's build program, retained solely so that `npm run build` can regenerate the distributed converter from `src/`. It embeds the HEIC decoder (`src/libheif.js`) and GIF helper (`src/gifshot.js`) in the worker, then writes the bundled converter.

The HEIC decoder is a libheif-based Emscripten JavaScript artifact. Its precise upstream libheif revision was not recorded by heic2any. The LGPL text is at `../../third_party_licenses/LGPL-3.0.txt`; upstream libheif source is <https://github.com/strukturag/libheif>.
