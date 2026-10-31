# Shared recording fixes — October 31, 2026

Branch: `t3/port-upstream-recording-fixes`. Implementation only; no app installation,
launch, permission changes, sound, push, or merge.

## Disposition and acceptance

1. **DONE — #886 + #1196.** `src/hooks/useScreenRecorder.ts:1643` continues after
   denied, unresolved, or rejected optional cursor access. The take's native request uses
   system cursor, without changing the saved preference. A localized warning after
   successful start says the editable cursor is off for this take; it does not claim
   the app lacks Accessibility. `electron/ipc/handlers.ts:2376` checks app trust without
   prompting and removes the recurring app permission dialog. Already-trusted requests
   retain helper probing. Tests cover granted and ungranted requests and repeated
   non-prompting IPC calls. All 13 locale files contain the notice.
2. **DONE — #1054.** `electron/recording/nativeMacHelperClient.ts:448` retains the first
   `recording-started.timestampMs`, including an event received before its waiter.
   Invalid/missing stamps fall back to event receipt time. The shared service returns
   `startedAtMs` before recovery-write/reply latency on both ordinary and deferred
   starts (`electron/recording/nativeMacRecordingService.ts:287`, `:390`). Linux uses
   this same client/service. The hook starts both clocks from it
   (`src/hooks/useScreenRecorder.ts:1565`). Cursor offset uses the same origin.
   Tests cover cached stamps, invalid stamps, both start paths and a 20-second late reply.
3. **DONE — #1332.** `electron/stt/modelManager.ts:426` defaults all model downloads to
   Electron `net.fetch`, preserving retry, checksum, disk streaming and injectable
   test fetchers. `electron/cleanCut/alignerModel.ts:54` already calls this manager,
   so inherits proxy support without another adapter. Test verifies URL normalization
   and request options reach Chromium; existing model/aligner tests pass.
4. **DONE — #1385, bounded alternative.** `src/cli/CliExportRunner.tsx:416` reads input
   response streams with hard byte accounting, regardless of absent or false
   Content-Length. `src/lib/exporter/voiceoverLimits.ts:1` sets 128 MiB video,
   32 MiB voiceover, 144 MiB output and five-minute duration limits.
   `src/lib/exporter/voiceoverMix.ts:98` also checks actual container durations,
   channels (maximum stereo), sample rates (maximum 48 kHz), and output writes,
   bounding decoded audio and output buffering. This retains the existing memory
   mixer for small inputs; large/long inputs now fail explicitly rather than risk
   exhausting memory. It is not an unrestricted streaming mixer. Tests cover missing,
   false and oversized lengths, cancellation of rejected bodies, duration limits,
   successful mixing publication, and rejection before mixing/publication with cleanup.

## Sources and adaptation

Read upstream MIT PR diffs with `gh pr diff N -R getopenscreen/openscreen`:
[#886](https://github.com/getopenscreen/openscreen/pull/886),
[#1054](https://github.com/getopenscreen/openscreen/pull/1054),
[#1332](https://github.com/getopenscreen/openscreen/pull/1332).
Also read [#1196](https://github.com/getopenscreen/openscreen/issues/1196) and
[#1385](https://github.com/getopenscreen/openscreen/issues/1385).
No Recordly code was used.

Checked the lockfile's Electron **44.9.1** against its
[versioned net API](https://github.com/electron/electron/blob/v44.9.1/docs/api/net.md):
`net.fetch` uses Chromium and the default session, including system proxy resolution.
The [systemPreferences API](https://www.electronjs.org/docs/latest/api/system-preferences#systempreferencesistrustedaccessibilityclientprompt-macos)
defines `false` as a trust check without prompting. The installed Mediabunny **1.40.1**
source/type declarations and [reading guide](https://mediabunny.dev/guide/reading-media-files)
confirm container duration/track inspection and target write callbacks. Existing Swift
and Rust helpers already emit epoch-millisecond `recording-started` stamps; no native
source or binaries changed.

## Verification

- `npx tsc --noEmit`: PASS.
- `npx tsc -p tsconfig.test.json --noEmit`: PASS.
- Targeted Vitest: **247 passed in eight files** (IPC startup, native helper client,
  recording service, model manager, aligner, recorder hook, CLI runner, voiceover limits).
- Final CLI/media retest with `OPENSCREEN_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg`:
  **7 passed in two files**, including real constant/variable cadence media probing.
- `npx biome check` on all touched TypeScript/TSX/JSON files: PASS.
- `npm run i18n:check`: PASS, 12 translations match English across six namespaces.
- `npm run test` once: **3277 passed, 9 failed, 15 skipped**; 315 files passed,
  four failed, seven skipped. Eight failures are the supplied known failures:
  check-approved-dependencies (1), check-cargo-graphs (2), generate-release-inventory (5).
  The ninth was `handoffProvenance.media.test.ts` lacking a bundled FFmpeg; the
  explicit installed-FFmpeg retest above passes. No full-suite rerun.
- `git diff --check`: PASS.

Dependencies were installed with `npm ci --ignore-scripts`; no native app build was
installed or launched. Local runtime was Node 26.5.0/npm 12.0.1 versus the repository's
Node 22.22.1/npm 10.9.4 engine pin; npm reported that mismatch.

## Still needs a real-app check

On a separately authorized app run: denied/unresolved/granted Accessibility across
repeated Record and Stop, visible system cursor and saved preference recovery;
HUD/Studio time versus written media with delayed startup on Mac and Linux; microphone,
camera offsets, Pause/Continue and Stop; actual downloads through system/PAC/authenticated
proxies; successful bounded MP4 voiceover and explicit refusal of larger files while
preserving the destination. No real desktop recording, playback, proxy session, audio
listening, or native build validation was performed in this task.
