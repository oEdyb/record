# Current creator-loop signed local installation — October 4, 2026

User authorized fixing packaging and installing the merged creator-loop build.

## Packaging corrections

The Vite 7.3.6 manifest is build-analysis metadata, with no runtime consumers. Keep it
in dist for startup analysis, but exclude exactly `dist/.vite/manifest.json` from the
installed app. The distribution policy enforces that same exclusion; it does not
allow arbitrary JSON assets. Positive and negative packaging tests cover this boundary.
Primary reference: https://vite.dev/config/build-options.html#build-manifest and the
installed Vite 7.3.6 `BuildOptions.manifest` declaration.

Parakeet now uses the existing tested Swift build-output resolver, querying the same
configuration with `swift build --show-bin-path`. `swift build --help` confirms this
contract and `--scratch-path`; the actual current Swift output is `out/Products/Release`.
A missing executable fails rather than finding an older build. Real Parakeet build passed.

Focused packaging and Swift tests: 42 passed. Independent review: no findings.
Installation and final packaged verification pending.
