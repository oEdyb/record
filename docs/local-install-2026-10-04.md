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
The reviewed asset baseline was rebound and signed using the existing documented local
Ed25519 approval procedure. Initial full suite found six approval failures; after updating
the baseline and detached signature, all 12 tests in the two affected files passed.
Combined verification: 4,131 unit tests pass, one existing skip; app/test typechecks and
lint pass. Earlier failures remain in the logs.

## Installed and verified

Fresh full native, Parakeet, Whisper, FFmpeg/compositor and Vite builds were packaged with
`--dir --arm64 --publish never`. Runtime code is main through `dddb4208`, packaging fixes
through `fce33cad`; `ec9a8b9b` adds the detached approval signature. Whisper provenance binds
to `fce33cad` with local workflow ID 0 and verified pinned upstream checkouts.

`/Applications/Klippt.app` was replaced after the idle previous app quit normally.
Developer ID Application: Dyberg & Co AB (LF8KF3G42Q), afterSign guard, deep strict
codesign verification and final packaged distribution audit all pass. App and cursor
helper designated requirements are unchanged. All 81 compiled build files match the
installed archive. ASAR SHA-256:
`4f5bd1f8fb14a1dd33dfc4e5b5fcf3d51156024b34e988221fa32fde09d3de7c`.

Previous app retained at
`/Users/olle/Library/Application Support/Klippt/Archived Apps.noindex/Klippt-replaced-2026-10-04.bundle-backup`.

Actual installed Mac UI smoke: Record, Pause, Continue, Stop, review, playback, native
export folder picker, Separate takes and Cmd-N return to compact ready Record all pass.
Recording 1791104929338 contains two clips, 25.92 seconds total, screen+microphone+system.
All six exported files match original SHA-256 hashes and fully decode with the installed
FFmpeg. OTIO is present. Four warnings correctly describe shorter audio coverage as gaps.
Camera and long-duration capture were not repeated for this packaging-only update;
30/60-minute evidence remains in the creator-loop acceptance note.

The installed app is left running, ready to record. Existing media was preserved.
No remote push, public release or notarization was performed.
Evidence: `artifacts/local-install-2026-10-04/installed-smoke.json`, installed parity,
designated requirements, distribution audit and gate logs.
