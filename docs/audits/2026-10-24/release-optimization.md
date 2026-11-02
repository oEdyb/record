# Klippt release optimization audit, 2026-10-24

Status: **working audit; not a release approval.** Both independent reviews are complete and their three regressions are fixed. The full suite has 2,762 passes and the supply-chain suite has 128 passes. The updated dependency signature verifies and notices are current. The signed package, a short native fixture capture, One video, and clip-native source handoff are verified. Real missing-source rejection while paused and recovery after reselection are now verified, with decoded clips and byte-identical media handoff. Long-session/hardware acceptance, native font-picker interaction, and fast-CLI cleanup diagnostics remain open.

## Scope and constraints

Branch `optimize/release-2026-10-24`, based on `df86f532`. The goal was to find and fix correctness, performance, privacy, dependency, and current-UI problems before release. The recording-focused product, Electron/React, Swift ScreenCaptureKit/AVFoundation, and Rust compositor remain unchanged architecturally. The closeout adds the requested local commits by area. No new editor feature, framework migration, blanket memoization, forced dependency fix, push, installation, publishing, or deletion of user media is part of this pass.

The untracked `.codex/` directory and unrelated worktrees were preserved. The installed app and user projects were not replaced. Owner-held signing keys were not read or used.

## Changes made

### Media and recording safety

- Every export destination is checked against every source, including clips, camera, microphone, B-roll, audio overlays, images, cursor sprites, `<screenPath>.cursor.json`, bundled resources, and CLI voiceover. MP4, GIF, and buffer publication reject a collision before rendering. Canonical paths and device/inode identity protect hard links and aliases; invalid scene metadata rejects before partial source coverage can permit an overwrite. Existing sources and destinations stay unchanged.
- Continue now requires fresh active-source evidence. Stale seeds and stale replacement-stream callbacks cannot acknowledge a clip. Readiness, no-seed timeout, low-disk, deferred lock/sleep/disk/source-loss, queue-ownership, and Replay Backspace behavior are guarded. Source inactivity after native resume but before acknowledgement also rejects on `sampleQueue`; all `pendingResume` access has that owner, including Stop and acknowledgement. The rejection is retryable, emitted once, rolls back the attempted clip, and preserves previous bytes.
- Readiness now returns before deadline and cadence checks when there is no clip, the recorder is paused/stopping/failed, or the clip is already live. Source generation remains checked with source usability and acknowledgement under `stateQueue`. The High-quality Pause regression uses a real seeded writer and an append measured more than 150 ms late, fully decodes the clip, fails before the guard with one `writer-failed-during-capture`, and passes after it. The isolated Swift suite passes 94 tests.
- Copied recordings no longer run the same unchanged staging-file verification twice. The first verification and its rendered-export fallback remain, as do packet and final-artifact proofs elsewhere. On the real native verifier and a 300-second 1080p60 H.264/stereo-AAC fixture, one call cost 61.263 ms p50 / 62.486 ms p95; two calls cost 122.475 / 126.388 ms. The paired duplicate cost was 61.226 / 64.662 ms. This is verifier-only evidence, not a total-export speedup.

### Review, accessibility, and errors

- Compact review has a floating transport over the video. Original files opens only source recovery, never a One video action, and does not change the remembered export choice.
- Read-only mode keeps playback and source recovery but blocks finished export, import, deletion, recording, and editing. Browse files is hidden and its handler checks the import entitlement before opening a picker.
- Delete confirmation moves focus to Cancel, back to the invoker on Cancel, and to an adjacent row or Search after confirmed deletion. It does not leave focus on a removed row.
- Notes and Transcript use the documented 80% dark card. Start, Pause, Continue, and Stop failures now have localized next steps in all 13 locales, with the technical IPC detail retained as toast detail.
- The generic source label now follows live locale changes without renaming the actual window/display source. Production-renderer proof passed English → Arabic → English with zero external requests; screenshots are `source-locale-ar-fixed.png` and `source-locale-en-fixed.png`.
- Failed latest-project startup shows `EACCES` with working Retry and Recordings controls instead of the normal empty-library hint. `startup-error-proof.json` passes at 1280×800 and 520×400 with the real production HTML/CSS, no external requests, no page errors, no bad responses, correct dark-theme foreground, and the loading veil hidden. Both screenshots were inspected, then repeated in the desktop browser.

### Measured performance

Numbers are medians unless stated otherwise. Synthetic fixtures do not prove a packaged cold start or a real-user frame rate.

| Area | Before | After | Meaning |
|---|---:|---:|---|
| Open one transcript-heavy project, 1 file | 18.104 ms | 15.268 ms | Reuse the already migrated/validated document; 15.7% faster |
| Open one transcript-heavy project, 20 files | 18.059 ms | 13.167 ms | 27.1% faster |
| Open one transcript-heavy project, 100 files | 18.677 ms | 13.002 ms | 30.4% faster |
| Startup, ordinary 1 / 20 / 100 projects | 0.812 / 3.159 / 12.797 ms | 0.382 / 0.382 / 0.626 ms | Latest valid full view instead of listing the entire library |
| Startup, transcript-heavy 1 / 20 / 100 projects | 25.015 / 190.339 / 913.460 ms | 17.001 / 17.264 / 19.459 ms | 32.0%, 90.9%, 97.9% faster respectively |
| Native position mapping, 500 segments | 0.481 ms/frame | 0.000264 ms/frame | Reuse raw spans while only the playhead changes |
| Native position mapping, 2,000 segments | 7.476 ms/frame | 0.00130 ms/frame | Trim/seam/EOF behavior is covered; no binary search was needed |
| Main renderer JavaScript | 492,787 bytes | 205,906 bytes | 58.2% smaller; byte reduction, not a startup-time claim |
| Main renderer JavaScript, gzip | 144,853 bytes | 66,494 bytes | 54.1% smaller |

Project-open evidence is in `comparison.json` and `latest-comparison.json` under `artifacts/release-optimization-2026-10-24/`. Ordinary projects use about 20 KB and 60 words per file; transcript-heavy projects use about 2.456 MB, 1,000 segments, and 8,000 words per file. The latest path performs one complete view read and media authorization, preserves transaction identity and Undo recovery, and keeps full-library listing for the library UI. File mtime selects startup order; library summaries still use document `updatedAt`, so externally copied files with divergent timestamps can rank differently. Corrupt newest candidates fall back; permission failures remain errors.

The locale loader bundles English and locale display names, loads a saved non-English locale before first translation, and loads other locales on selection. Loads are coalesced, stale selections cannot win, and a failed load keeps the current language with a retry message.

The shell also defers its entitlement dialog and toaster. Initial-locale recovery dynamically imports Sonner only when needed, with an unmount guard. Installed Sonner 2.0.7 `dist/index.mjs` starts the toaster with an empty array and subscribes only to later events, so the existing wrapper replays still-active history once on mount, preserving IDs, actions, types, and custom content without reviving dismissed notices. This is based on the exact installed dependency source, not generic toast advice. The production locale-retry and font-recovery flows initially failed after lazy loading, then passed after this replay fix; screenshots were inspected. Main JavaScript fell from 279,720 bytes after the locale change to 205,906 bytes after the root lazy-loading fix, below the earlier 227,522-byte optimized baseline. See `renderer-final-metrics.json`.

Eight interleaved pairs per mode in production-renderer Chromium gave these startup results. Cold was noisy/inconclusive: baseline FCP 282 ms versus current 284 ms, and Settings 107.35 ms versus 117 ms at the median. Warm improved modestly: FCP 206 → 196 ms and Settings 30.15 → 25.7 ms. Warm Settings favored current in 7/8 pairs, but warm FCP p95 was worse, so this is not a uniform improvement. Both builds used Vite 7.3.7. Saved Arabic loaded before its first translation with no English-flash samples; actual English ↔ Arabic controls passed with zero external requests. This is isolated renderer evidence, not native Electron startup or HUD hit-testing. Full samples and cache evidence are in `renderer-startup-results.json`.

Paused audio now uses the existing playback-loop backoff: after 30 quiet frames it checks four times per second instead of requesting a display frame continuously. Store seeks, clock changes, and media readiness wake it immediately; unmount cleans up listeners and media. This is scheduler evidence, not a new total-CPU measurement.

### Camera direct manipulation

The measured large fixture had 100 visible clips, 500 regions, 15,000 transcript words, 2,228 caption annotations, and 1.26 MB of scene JSON per update. Renderer patch/build/stringify was 13.117 ms p50 / 19.560 ms p95; adding main-side asset resolution made it 18.134 / 25.649 ms. A small control was 0.126 / 0.212 ms and 0.251 / 0.490 ms respectively.

Camera gestures now retain only the latest placement per animation frame and flush it before commit on both pointer-up and pointer-cancel. Unmount cancels pending work without saving. At a 60 Hz example, the cap is 1,020 scene/parameter IPC calls/s instead of 2,040 at 120 Hz, and 75.6 MB/s instead of 151.23 MB/s. Those are offered-work caps, not measured native-drag FPS. The large combined path can still exceed one frame, so no broader scheduler or memoization was added. Evidence: `camera-coalescing.json`.

### Fonts and dependencies

- The 16 requested caption families are local now: 120 WOFF2 files, 2,801,900 bytes, 217 font-face rules, and 16 license notices. All files and notices match the hashes in `font-provenance.json`; `font-verification.json` reports no failures. Google font origins were removed from the app CSP. Geist was already local.
- Single-family legacy CSS2 requests no longer inject remote stylesheets. Exact bundled/known variations load locally. Other requested normal/italic weight variations can be restored through an explicit toast action and one local file picker per face. TTF/OTF/WOFF/WOFF2 files are limited to 2 MiB, checked by extension and signature, and returned as data URLs; every requested CSS face must parse and load before persistence. Saved faces reload without pickers, failed saves do not claim persistence, and `font-src` adds only `data:`.
- `font-recovery-proof.json` verifies real Chromium Inter 300 recovery with one explicit picker, exact persisted bytes, a loaded 300 face, picker-free reload, no external requests, and no stale picker action on the success toast. The stale action was found by inspecting the screenshot and fixed by dismissing the recovery toast before a new terminal toast. Native dialog interaction is not covered by this harness. Other font axes/ranges and font collections are unsupported, not silently substituted.
- Patched Electron-compatible build dependencies: Vite 7.3.7, Zod 4.6.6, source-map-js 1.2.2, undici 6.29.1/7.30.1, Vitest 4.1.12, fast-uri 3.1.9, and postcss-selector-parser 6.1.5. Electron stays on the already patched 44.9.1. No major upgrades or overrides were used.
- Desktop audit reports no unreviewed high or critical advisory. `npm audit --audit-level=high` exits 0 and reports four moderate paths for the same Tailwind parser advisory. The installed 6.1.5 is the official Tailwind 3 backport; registry metadata still says `<7.1.6`. No new exception hides it. All 9 generated stylesheets were byte-identical after that patch.
- Local macOS releases now run the desktop dependency audit before signer/notary checks.

## Research and what it changed

Primary sources were used for implementation decisions. Electron explicitly recommends measuring first, deferring unnecessary work, and bundling Google Fonts: [performance guide](https://www.electronjs.org/docs/latest/tutorial/performance), [security guide](https://www.electronjs.org/docs/latest/tutorial/security). The locale approach follows [Vite glob imports](https://vite.dev/guide/features.html#glob-import) and [i18next resource loading](https://www.i18next.com/how-to/add-or-load-translations). UI review used the current [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md).

Capture work used Apple's [ScreenCaptureKit sample](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos), [`SCStreamDelegate`](https://developer.apple.com/documentation/screencapturekit/scstreamdelegate), and [`AVAssetWriter.finishWriting`](https://developer.apple.com/documentation/avfoundation/avassetwriter/finishwriting()). Font provenance uses the [Google Fonts CSS API](https://developers.google.com/fonts/docs/css2) and pinned [`google/fonts` commit `e7db6ca`](https://github.com/google/fonts/commit/e7db6ca603fd4862010383ff17ffd6cc4ffac1c0). Dependency decisions used the official Vite, Zod, Electron, Vitest, fast-uri, and [postcss-selector-parser 6.1.5](https://github.com/postcss/postcss-selector-parser/releases/tag/6.1.5) releases, not generic upgrade advice.

### Competitor complaints inspected

The sample covered 38 posts in five complete GitHub threads dated 2026-01-14 to 2026-09-07: 32 human posts and six bot comments, from 18 human accounts and 16 first-hand complainants. It is **not a prevalence estimate or proof that Klippt shares a defect**.

- Capture/writer/finalization failure or lost output: 10 voices, [Cap #1535](https://github.com/CapSoftware/Cap/issues/1535), [Recordly #821](https://github.com/webadderallorg/Recordly/issues/821).
- Retained/runaway memory: 3 voices, [Cap #1589](https://github.com/CapSoftware/Cap/issues/1589).
- Permission/signing failures: 2 voices, [Cap #1722](https://github.com/CapSoftware/Cap/issues/1722).
- Export failure/lag/diagnostics: 1 voice, [Cap #1515](https://github.com/CapSoftware/Cap/issues/1515).

The response was to test failure loudness, recovery, memory bounds, permissions, and proof rather than copy another product's fixes or rewrite the app. There was no adequate original-user sample for Screen Studio, Loom, or CleanShot X in this pass.

## Verification collected so far

- Baseline before these edits: 2,646 unit tests passed and 2 skipped; both typechecks, lint, i18n/design checks, and `build-vite` passed.
- Focused export/source, startup, locale, font, and camera/review suites pass; these groups overlap and are not a separate total. The three review regressions have 208 affected tests passing, with fail-before and pass-after evidence. Clip-native pack/info adds eight passing tests. The completed release-inventory font fixture has six passing tests.
- Latest full Vitest: **2,762 passed, 2 skipped, no failures**. The dedicated supply-chain suite is **128 passed**, with no failures. The updated dependency signature verifies. `node scripts/generate-third-party-inventory.mjs --write` regenerated 572 components including 16 Google font groups, and `npm run supply-chain:notices` passes. No signing key was accessed.
- The isolated Swift runner passes **94 tests**, including the High-quality late-Pause regression. Plain `swift test` is not the test entry point because the production manifest intentionally has no test target. The regression emits `writer-failed-during-capture` before the guard and none after it; its saved clip fully decodes. Rust workspace: **249 passed**, 3 intentionally ignored real-media benchmarks.
- Both TypeScript checks, lint, i18n validation, and docs/design checks pass. Authored diff whitespace checks pass; after staging the previously untracked notices, the full range reports 475 whitespace warnings in 15 exact upstream Google license files (including retained CRLF endings). Their provenance hashes are preserved; `vendored-license-whitespace.log` records the diagnostics. Biome still warns that the existing 1.4 MiB Cargo evidence file exceeds its 1 MiB processing limit. The full run includes 35 passing package-policy tests.
- `npm run build-vite`, both native-helper builds, and `npm run build -- --publish never` pass on the current source, including clip-native pack/info compatibility. Helper provenance was refreshed and verified. `release/1.9.5/mac-arm64/Klippt.app` passes packaged distribution, deep signature, and Developer ID checks. Its HUD and notification host pass an accessibility smoke test; the app exited and its isolated standby helper was stopped. See `packaged-smoke-proof.json`. Notarization, installation, and publishing were not performed.
- `npm audit signatures`: 736 verified registry signatures and 174 attestations. The desktop audit and release-preflight contract pass.
- `source-locale-proof.json` passed English → Arabic → English with zero external requests, zero page errors, and zero bad responses; both screenshots were inspected. `font-verification.json` verifies all 120 font binaries and 16 notices. `startup-error-proof.json`, `locale-recovery-proof.json`, and `font-recovery-proof.json` pass with real production assets and inspected screenshots. The compact startup capture now waits for two rendered frames; it has one brand and one alert in a 400px-high viewport. The earlier duplicate was a resize-capture race, not a layout defect.
- `native-capture-proof.json` verifies an isolated fixture recording, Pause, Continue, Stop, review, two fully decoded source clips, and a 2560×1440 60 fps One video export. `native-handoff-verification.log` verifies that both packed clips match original bytes and that asset paths were rewritten. The real `info` command reports schemaVersion 11 and the existing primary video. `native-pack.log` and `native-info.log` retain nonfatal Mach Port cleanup diagnostics for follow-up.
- The later real source-loss pass used the same signed test package and isolated fixture/profile; no code changed during this test. [Native source-loss proof](../../../artifacts/release-optimization-2026-10-24/native-source-loss-proof.json) records two failed Continue attempts with `shareable-content:window-missing` at 75 and 79 ms while paused. The native log also records `source-inactive`, `source-active`, and `paused-source-unavailable` (ScreenCaptureKit -3815). Reselecting/reconfiguring the available fixture source took 336 ms; Continue then returned successfully in 70 ms, Stop in 99 ms, and review reached its first frame in 400 ms. These are individual native timing samples, not a latency distribution.
- The recovered session has exactly two screen-only H.264 clips: 29.015 s / 1,741 frames and 149.083 s / 8,946 frames, both 2560×1440. Both fully decode according to `source-loss-media-verification.json`; `source-loss-clip-{1,2}-probe.json` retains their metadata. The two `source-loss-clip-{1,2}-raw_1.000s.png` frames were inspected and show the intended animated fixture. The saved session, imported project, and packed project all retain the two clips; the failed Continue attempts did not add an extra saved clip. `source-loss-handoff-verification.json` passes: three files total (one schemaVersion 11 project plus two media files), both media SHA-256 values match the originals, and project asset/legacy paths point into the handoff folder. These hashes and paths were rechecked during closeout; the rewritten project is not claimed to be byte-identical.
- [Shutdown proof](../../../artifacts/release-optimization-2026-10-24/shutdown-proof.json) confirms fixture task `bash-enw2ha6x` / PID 28182 exited after a PID-specific SIGTERM, with its wrapper and children gone. No recording-test app, helper, server, or runner remains; fixture port 53992 has no listener. Normal Chrome PID 15316 remains running, and the installed `/Applications/Klippt.app` was not touched. Closeout only updates documentation and evidence; existing code changes are preserved.

### Local commit series

The requested separation uses five code commits followed by an evidence/documentation commit. Every code commit passed the normal staged-file hook; a SHA-256 comparison against the closeout's starting snapshot confirms that all 253 pre-existing changed/untracked files outside this audit and handoff retain their bytes. `.codex/` remains untracked and untouched. The prior full-suite, build, and real-media results above apply to the same source content; they were not rerun just to create commits.

- `cc4eaf24` — Keep paused recordings recoverable when a source disappears.
- `704f7925` — Speed up project loading and defer renderer work.
- `8b2e1d8c` — Protect source media and preserve recovery in read-only mode.
- `fbe43164` — Bundle caption fonts and restore legacy styles from local files.
- `365d3391` — Update patched dependencies and verify release approvals.

The font and dependency commits share the signed asset/input approval; reverting one requires checking that approval against the remaining inputs. No signing key was used to manufacture an intermediate approval. Detailed proof, decoded media, frames, and timing logs remain local in the ignored `artifacts/release-optimization-2026-10-24/` directory. Nothing was pushed.

Fresh closeout checks pass: `npm run docs:check` (28 files and design-token synchronization), `npm run design:check`, and all 11 checks in `source-loss-closeout-checks.json` for proof status, durable assets, source bytes, shutdown, current records, and audit links. One verified source-loss milestone was recorded and read back from the project ledger. The vault checker returned `errors: []` and `warnings: []`; results are in `vault-check.json`. This closeout changed documentation and evidence only, so code suites and builds were not repeated.

## Resolved and open gates

- **Owner signature and notices:** resolved. The updated signature verifies. `node scripts/generate-third-party-inventory.mjs --write` regenerated 572 components including 16 Google font groups, and `npm run supply-chain:notices` passes. No private key was accessed.
- **Real Mac capture and source loss:** resolved for the short isolated fixture and missing-window-while-paused scenario. Pause, Continue, Stop, review, full source decode, One video, and clip-native source handoff passed; the later source-loss pass rejected missing-window Continue twice and recovered after source reselection, with two fully decoded clips and unchanged packed media bytes. Only the dedicated fixture window was recorded. This does not cover every source interruption during active capture or long sessions. The computer-use agent's own screenshot grant is unavailable, so native proof uses accessibility state and real media; the extracted clip frames were inspected.
- **Final independent reviews:** both completed. Their older-unreadable-project, stale-empty-retry, and stale-locale findings now have fail-before/pass-after regression coverage. No confirmed recording or export data-loss defect was found. No review blocker remains open.
- **CLI cleanup diagnostics:** fast `pack` and `info` exits still log Mach Port rendezvous permission and missing-client errors. The commands returned success, and every output file and hash was verified; no lost output was observed. Keep this as a cleanup diagnostic to triage, not as evidence of data loss or something to hide.
- **Hardware/release acceptance:** 30–90-minute sessions, clean account/second Mac, Meet 2 daylight, ProMotion, 5K/6K, and N→N+1 updates remain unverified in this pass. Native font-picker interaction is also unverified. The work is now committed by area; release still requires reviewed commits and rebuilt same-commit helper/release artifacts. This does not authorize installation of this test package over the existing app.
- **Compatibility:** local recovery supports a single legacy Google family with normal/italic weight tuples. Other axes/ranges and font collections are rejected rather than silently substituted. The real Chromium proof covers Inter 300, not every historical family or native dialog.
- **Rejected:** React/Vite/Tailwind major migrations, a Swift/Tauri rewrite, new editor features, broad memoization, forced audit fixes, weakening tests or security gates, and claiming vendor performance or competitor fixes as Klippt measurements.
