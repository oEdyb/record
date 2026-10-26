# October 26: Linux port on `feat/linux-port`

Current Linux checkout: `/home/olle/dev/screenrec-linux`, cloned from private `oEdyb/record` main at `228131a4`. The dirty `/home/olle/dev/screenrec` directory is a different older repository and was not changed. Preserve the shared recorder/review/project/export model; Windows follows Linux.

Latest runtime is `af35b212`: Linux renderer cameras prefer recoverable H.264 MP4 instead of H.264-in-WebM, with the existing fallback retained. The Ubuntu-floor AppImage passed real two-clip capture, full app/helper SIGKILL recovery, camera preview to tail, four byte-identical original exports with OTIO/FCPXML and zero compatibility warnings, and fully decodable NVENC One video. All four packages, extracted policy and three bare distro loader checks pass. Current candidates: `release/linux-port-20261026-af35b212/`; build output: `artifacts/linux-port-2026-10-26/portable-build/output/camera-mp4-af35b212/`. Native helper bytes are unchanged from `f7ca5dfd`. Latest camera slice: 194 focused tests, both typechecks, lint/docs/design/i18n, and two independent reviews pass. Current React Doctor scores 75 on both baseline and changed code with the same existing HUD warning (earlier tool score 82 is not directly comparable). Camera evidence: `artifacts/linux-port-2026-10-26/camera-container-probe/packaged-crash/`.

Paused Linux source replacement is implemented in the current working tree: transactional candidate grant/first-frame adoption, recoverable cancel/retry, owner-bound IPC and Stop cancellation before the serialized queue. Focused affected checks pass; first desktop pass saved three decodable clips across 1262×1374 → 900×600, preserved the first hash, cancelled/retried, and stopped a pending picker through the existing tray-restored HUD (9 ms cancellation, 36 ms Stop). Final cursor replay ordering was corrected after this pass. Next: exact-final rebuilt desktop/export, final review, portable packages and PR evidence. The `af35b212` packages remain the stable earlier camera candidate; no source replacement is claimed in them. Portal-fixed cursor-mode replacement is still unsupported. Details/evidence are in the report's “Paused source replacement” section.

The Rust portal/PipeWire helper implements real clip Pause/Continue in one portal session, isolated unboosted audio originals, fragmented recovery, packet readiness, validated EGL import and NVENC. Shared orchestration owns recovery, storage, removal/Undo, renderer camera handoff and quit/WM-close acknowledgement. Linux HUD input has compact native bounds. Preview drains the final GOP. SDK codec fields now stay behind C accessors; strict helper Clippy passes without suppressions.

Real desktop checks passed Record, Pause/Continue, removal through zero/Undo, review, byte-identical original export with OTIO/FCPXML, One video and helper-kill recovery. Synthetic-camera WM close/reopen passed. A separate app SIGKILL/reopen recovered screen and camera, persisted the association and preserved all 615 decoded camera frames through container repair. Camera paths journal after first disk append; new capture waits for startup repair. Linux suspend now uses the existing clip interruption/Pause path (simulated event tested, actual machine not suspended).

A source-timing follow-up now preserves callback outages from PipeWire per-buffer cycle times (runtime ≥1.0.5), with a cumulative cursor and 2 ms jitter tolerance. Decoded tests exposed and fixed original shortening, jitter accumulation and a legacy retained-writer Continue mute. Invalid backward cycle clocks fail visibly before admitting PCM, preserving committed clips. Old runtimes keep the previous untimed path; initial offsets remain estimated. The audio/video grid now shares an active clip clock, and legacy Continue receives a fresh watchdog deadline and waits for a new packet. Independent review, real desktop checks and updated packages pass at runtime `f7ca5dfd`.

Current checks: 95 native helper tests pass, one existing live test ignored; strict Clippy and formatting pass. Previous combined affected-area run: 213 tests on Node 22.22.1/npm 10.9.4; both TypeScript checks clean. AppImage policy suite: 43 pass. One full JS run previously passed 3,035 tests; later changes use focused checks. Lint retains one existing oversized Cargo evidence warning. Docs/design/i18n checks passed. Fresh reviews have no remaining P1/P2 findings in the corrected slices.

Ubuntu 22.04 baseline builds produced all four formats with the strict symbol floor. Clean Ubuntu/Arch/Fedora installs resolve all 27 ELFs and reach the three expected executables. The floor-built addon remuxes the actual crashed camera correctly. Actual extracted AppImage policy passes, including exact branded icon bytes, generated metadata validation and provenance. Previous runtime artifacts at `f7ca5dfd` pass strict build and extracted-AppImage policy. Previous packages and SHA-256 inventory: `release/linux-port-20261026-f7ca5dfd/`; reproducible output: `artifacts/linux-port-2026-10-26/portable-build/output/audio-cycle-f7ca5dfd/`. The actual AppImage launches normally with FUSE and passed Record → Pause → Continue → Stop, synthetic-camera review, playback through the final frame and byte-identical four-original OTIO/FCPXML export, using its bundled helper and Vulkan addon. The older CachyOS host-mode AppImage remains a development artifact.

The repeat 60-minute 1080p60 test completed cleanly: two 30-minute clips, NVENC retained, all six media files fully decode, 108,005 video frames per clip and no audio-overflow warnings. Microphone scans found 1,801/1,800 pulses with no gaps over 1.01 seconds. Settled A/V marker medians moved by at most one frame; source-clock checks exclude a frozen-frame/integer-second alias. There were 81 superseded source frames; do not equate decoder output cadence with zero capture drops. Helper CPU averaged 61.3% of one core; RSS rose 391→476 MiB. The hour binary predates the final source-return/opaque-codec and producer-cycle timing refinements; its exact hash/diff is retained. Final runtime NVENC was separately exercised by the packaged smoke. The first failed hour remains evidence: driver allocation errors exposed audio-ring loss that compressed time; bounded silence now preserves missing intervals. Evidence: `artifacts/linux-port-2026-10-26/soak-60m-rerun/` and `portable-final-smoke/`. A final floor-built legacy test also passed a 500 ms helper stall and three-second Pause with 8.09 seconds of active media, not the paused wall time. Latest evidence: `artifacts/linux-port-2026-10-26/audio-cycle-time/`. Owned app/fixture/audio jobs exited and the build container is stopped.

Draft PR: https://github.com/oEdyb/record/pull/1. Latest GitHub jobs executed zero steps because of failed account payments/spending limit; no billing settings or gates were changed. Remaining release gates: physical webcam, AMD/Intel/other desktops, older untimed PipeWire, estimated initial offsets/physical clock-rate parity, real Mac regression and later Windows parity. The hour result is bounded host evidence, not an exact-final-binary or universal parity claim. Wayland own-window exclusion and niri global shortcut activation remain limits. Camera recovery can lose the last unwritten MediaRecorder chunk. Do not publish or claim universal performance parity. Exact measurements, contracts and artifacts: [Linux implementation evidence](docs/linux-port-2026-10-26.md).

# October 26: consolidated source for the Linux handoff

The recorder morph changes are committed, and the remaining Final Cut source-timeline worktree is merged while preserving Clean Cut source markers, OTIO output, both export manifest paths and original media. Every registered worktree head is included in the combined history. The generated design-token mirror is synchronized with the existing production tokens.

Combined gates: 3,008 unit tests passed, 5 skipped; both typechecks, lint (existing oversized Cargo evidence warning only), i18n, docs and design checks pass. Two fresh independent export reviews passed, including marker coexistence/source timing and 250 byte-identical OTIO fixtures. Actual Final Cut/Premiere import and a Linux runtime pass remain unverified. Linux build commands already exist; this handoff does not claim the full Linux port is complete.

Actual installed hover: real global cursor movement, no keyboard, clicks or renderer event injection, completed three in/out cycles (center, bottom edge, upper-right edge). Each stayed expanded through a two-second stationary hold. Evidence: `artifacts/hud-installed-hover/three-cycles-then-interruption.json`. A later physical cursor change interrupted the upper-left attempt; a further run also stopped on cursor movement. Those partial runs do not establish the full 20-cycle or flicker-free acceptance gate. The installed app's paused 11-second take was not restarted or modified. The reported spacing gap and occasional flicker are retained as polish follow-ups, not claimed fixed by this consolidation.

# October 26: continuous recorder morph and interaction audit

Current implementation replaces the top tab/control crossfade with one persistent center mark or actual recording timer, natural-size control wings and a shared moving surface/mask. Top docking reserves the full expanded footprint. Click/Enter/Space pins the attached pill; Escape collapses it. One controller owns native/DOM hover, focus, panel and drag holds. Native probes remain available while click-through is enabled, do no cursor reads while hidden, and recover on visibility changes even when Electron panel hide/show events are missing. Explicit collapse stays latched through spring undershoot at a stationary tab edge. Opaque overlapping surface pieces remove compositing seams.

Setup and Source keep docking, have keyboard focus entry/return, and implement declared tab/radio keyboard navigation. Side-tab open/collapse transfers focus to the visible grip. Replay now shows decode/play errors and retries the retained clip and position with a fresh media-load identity; retry reapplies listening preferences. All 13 locale files include the new labels. Audit and current official sources: `docs/audits/2026-10-26/recorder-interaction-audit.md`.

Verification: 2,998 unit tests passed, 5 skipped; app/test typechecks and lint pass (existing oversized Cargo evidence warning only); i18n passes. Four Chrome browser tests pass: identity/pin/stationary hold, panel and source focus, 25/50/75% reversal and reduced motion, side-dock keyboard handoff. The final opaque-surface adjustment also passes its rendered reversal test; closing detail was visually inspected without seams. Two independent code reviews passed after resolving their findings. No FPS benchmark or universal native-usability claim.

Native evidence: `artifacts/hud-native-pointer/visibility-gated/fixture-4fbaaa/proof.json` passes five stationary cursor cycles with DOM pointer events suppressed, transparent-region native ignore state, hidden zero reads/probes, and show recovery. Later frame collectors aborted on real cursor movement and are invalid. `artifacts/hud-replay-smoke/1792971926147/proof.json` verifies a real media 404, Retry re-request and actual 320×180 MP4 decode (51 frames) from retained 1 s offset. Camera retry is unit-only. Scripts use isolated profiles/generated media and do not touch the installed app's capture.

Build/install status: `.local-install.noindex/hud-ux-redesign-final-20261026/mac-arm64/Klippt.app` is installed at `/Applications/Klippt.app`. Package and installed Developer ID/helper guards pass; installed app.asar SHA-256 matches the package (`29d2a8821a8280ef09d43bbf13107580fd0ee0ff6357fa2342e09935ae71e51b`). User confirmed the prior 33-second take was stopped/saved before replacement. Previous app preserved at `.local-install.noindex/backup-before-hud-ux-20261026-012913`.

Installed renderer verification: `artifacts/hud-installed-redesign/proof.json` has 2,401 samples and 149 screencast frames over 40 s, with two open/close cycles driven by native desktop keyboard input. Center identity persists and row opacity stays 1 throughout; transformed surface pieces remain overlapping, with no positive geometric gap. Opening/closing frames were visually inspected in `installed-morph-strip.png`. Collector: `scripts/hud-installed-morph-observe.mjs`. Background synthetic clicks during diagnostics were inconclusive; do not claim proof of real native first-click delivery or installed stationary hover. Separate native pointer fixture evidence above remains applicable to the source, not a replacement for manual installed hover acceptance. App reopened normally afterward; no debug arguments or port 9337 listener remain.

No capture/helper source changed in this slice; no notarization, publishing or new real capture pass. Remaining acceptance: actual installed first-click/scroll delivery and inactive-panel hover, display corners/multiple displays, drag and writer-state coverage. `node scripts/check-docs.mjs` passes; combined docs gate additionally reports pre-existing stale `design/tokens/v4.css`. Earlier installed-motion claims below refer to the previous implementation.

# October 25: installed HUD motion verified in both directions

Latest tuning, October 26: the user asked for a softer, springier feel. The attached surface and matching content mask now share a sampled spring easing: damping 0.8, response 0.4 s, 600 ms settle, 31 samples at 20 ms intervals, with a small overshoot. CSS `linear()` preserves the existing compositor transforms and interruptible transitions without a dependency. The spring is a sampled easing, not a velocity-preserving physics integrator. Source: [MDN linear easing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Values/easing-function/linear) and the Apple-design skill's damping/response guidance. The longer duration is intentional for this requested feel change.

Installed latest: `.local-install.noindex/soft-spring-20261025/mac-arm64/Klippt.app`, backup `.local-install.noindex/backup-before-soft-spring-20261025`. Package and installed Developer ID/helper guards pass. Full suite again: 2,954 pass, 5 skip; both Chrome tests pass, including reversal and reduced motion. Installed capture `artifacts/hud-motion-installed/soft-spring/` completed with zero blank samples and no meaningful seam gap; its video preserves captured frame timing. Opening and closing frames were inspected. Later collector repeats failed during the second synthetic hover: the tab received pointerenter then pointerleave before the requested pointer move, so those repeats do not establish reliable native repeated-hover behavior. Browser reversal tests remain green; do not treat the collector's short input timeout as a product smoothness guarantee. The app was restarted normally after diagnostics. `scripts/hud-motion-smoke.mjs` now records wall-clock alignment and verifies the second hover opened before trying reversal.

The top-docked pill now opens through coordinated transforms on two end caps and a middle surface, preserving its outline while the controls keep their size. A matching control mask prevents glyphs escaping the moving background. Opening uses 260 ms, closing 220 ms, both with `cubic-bezier(0.32, 0.72, 0, 1)`. Control/tab fades overlap, replacing the previous blank-label pause. Entering a still-moving surface or tab reverses closing immediately; settled-tab hover retains its intent delay. Covered tabs become hidden after fading and leave keyboard navigation. Reduced motion removes shape motion.

Earlier fixes remain: shared hover boundary for tab/pill/bump, no stationary-pointer oscillation, the tuck chevron 2 px lower, startup-only instant placement, and persistence of all three dock edges. Top-attached mode has a flat top and rounded bottom; floating pills stay fully rounded. Product behavior is in `technical-documentation/product-behavior.md`.

Installed and verified at `/Applications/Klippt.app`. Final package: `.local-install.noindex/motion-mask-20261025/mac-arm64/Klippt.app`; previous app: `.local-install.noindex/backup-before-motion-mask-20261025`. Both packaged and installed Developer ID/helper identity guards pass. The app reopens normally after diagnostics; no notarization, publishing or native-capture retest.

Actual installed-renderer verification used the app's loopback DevTools endpoint, pointer input, frame capture and per-frame state sampling, rather than a browser shim. Evidence: `artifacts/hud-motion-installed/before/` and `final/`, each with `motion.json`, frames, a transition strip and timestamp-preserving `transition.mp4`. The baseline had 33 samples with both label opacities below 0.05; the final run has zero such samples across 237 samples. The largest measured background-piece seam discrepancy was 0.000061 CSS px. These are diagnostics of the captured renderer, not a display-FPS benchmark or independent manual OS click-through proof. Final checks covered opening, closing, stationary hover and re-entry during closing; the final frame strip was inspected. Reusable collector: `scripts/hud-motion-smoke.mjs OUTPUT`, with `CDP_ENDPOINT` defaulting to `http://127.0.0.1:9337`. Start the idle installed app once with `--remote-debugging-port=9337 --remote-debugging-address=127.0.0.1`, then restart normally afterwards.

Verification: full unit suite 2,954 passed, 5 skipped; final affected component tests 119 passed; both typechecks; lint (existing oversized Cargo evidence warning); two final Chrome tests, including mid-close re-entry via surface and tab, hidden-tab visibility, and reduced motion; both held-out rechecks PASS. Document checker passes; combined docs gate retains the existing stale token mirror (token files unchanged). `.codex/` remains untouched.

Sources: [Emil Kowalski's animation skills](https://github.com/emilkowalski/skills/blob/main/skills/animate/SKILL.md), [Apple Designing Fluid Interfaces](https://developer.apple.com/videos/play/wwdc2018/803/), [web.dev animation performance](https://web.dev/articles/animations-guide), [MDN getAnimations](https://developer.mozilla.org/en-US/docs/Web/API/Element/getAnimations), and [Electron 44 command-line switches](https://github.com/electron/electron/blob/v44.9.1/docs/api/command-line-switches.md). The implementation uses transforms for the persistent background and a clipping mask only on the content; it requires no added animation dependency.

# October 24: release optimization evidence and remaining gates

Branch `optimize/release-2026-10-24`, based on `df86f532`; release work is committed by area, with `.codex/` untouched. Capture `cc4eaf24`, startup/playback `704f7925`, export/read-only `8b2e1d8c`, fonts `fbe43164`, and dependencies/approvals `365d3391` precede the final evidence commit. No push, installation, publishing, notarization, or owner-key use. This is not a release approval.

Later on October 24 (HEAD `a57556f6`): the draggable, foldable recording pill is merged; the pill folds, unfolds and morphs into the recording pill from its left end (grip stays under the pointer) with a short control cascade; the folded grip is 48×40; the Removed notice uses the pill surface. Startup no longer leaves a workload-telemetry rejection unhandled. A camera delivering frames at a size other than its configured native format now drops them with `camera-interrupted` warnings and reapplies the format instead of failing Record (seen on the MacBook Air camera, configured 1920×1080, delivered 1280×720; cause unconfirmed). Verified: 2,788 unit, 97 Swift, signed local package; Record with camera started afterwards. Not verified: the off-size path on real hardware, pill drag on two displays.

- Export refuses destinations matching any clip, B-roll, audio/image, cursor sprite, cursor sidecar, bundled, or voiceover source before rendering. Invalid scene metadata also stops export before partial source coverage. Continue requires fresh active-source evidence; stale seeds, replacement callbacks, low disk, deferred interruptions, pending source loss, and Replay Backspace are guarded. Copied-file verification now runs once while preserving packet proof and rendered fallback.
- Readiness returns before deadline/cadence work for missing, paused, stopping, failed, or already-live clips; source generation stays synchronized. A real High-quality Pause closing append over 150 ms late emitted `writer-failed-during-capture` before the restored guard and does not after it. The regression decodes the saved clip; all 94 Swift tests pass.
- Both held-out reviews are complete. They found no confirmed recording/export data loss and three startup regressions: older unreadable projects fall behind newer valid candidates without hiding reached permission errors; empty retry resets idle while preserving an open document; superseded locale selections no longer show false failures. Each has fail-before/pass-after regression coverage.
- Read-only keeps playback and Original files, but not finished export, import, deletion, recording, or editing. Original files is source-only and does not change remembered export settings. Delete focus, compact transport, localized recorder recovery, and generic source-label locale switching are corrected. Failed latest-project startup shows the real error with Retry and Recordings, not a false empty library; production screenshots and desktop-browser checks pass at 1280 and 520 pixels.
- Latest-valid startup on the 100-project transcript-heavy fixture is 913.460 → 19.459 ms; ordinary 1/20/100 also improved. Main renderer JavaScript is 492,787 → 205,906 bytes (144,853 → 66,494 gzip). The shell defers its entitlement dialog and toaster; active pre-mount toasts replay once because Sonner 2.0.7 starts empty, while dismissed ones stay dismissed. Locale and font recovery plus startup-error production fixtures pass with inspected screenshots. Cold startup is inconclusive; warm reloads improved modestly. Camera gestures coalesce per frame and flush before commit. Duplicate native verification costs 61.226 ms p50 on the 5-minute fixture.
- Fonts are local: 120 WOFF2 files and 16 notices with exact hashes; production CSP has no Google font origins. Single-family legacy CSS2 requests recover offline through bundled exact faces or explicit local file choices, one per requested variation. Every face must load before saving; saved faces reload without a picker. Real Chromium Inter 300 recovery and picker-free reload pass, and the completed toast no longer retains its old picker action. Native dialog interaction and non-ital/wght axes or collections remain unverified/unsupported.
- Reviewed dependency patches include Vite 7.3.7, Zod 4.6.6, Vitest 4.1.12, fast-uri 3.1.9, and parser 6.1.5; desktop high/critical audit passes. The remaining four moderate paths are the same documented Tailwind-parser metadata warning, with CSS unchanged in 9/9 comparisons.
- Latest full run: 2,762 unit tests pass and 2 skip, with no failures. Supply-chain tests are 128 pass. Swift 94 and Rust 249 pass; 3 real-media benches intentionally ignored. Both typechecks, lint, i18n, docs/design, and scoped checks pass; 35 package-policy tests pass in the full run. The three review regressions have 208 affected tests passing, and the three production recovery fixtures pass with inspected screenshots.
- The updated dependency signature verifies. `node scripts/generate-third-party-inventory.mjs --write` regenerated 572 components including 16 Google font groups, and `npm run supply-chain:notices` passes. No signing key was accessed. The release-inventory fixture now stages every policy-reviewed font; the earlier signature gate had hidden its incomplete coverage.
- Current `npm run build -- --publish never` and packaged distribution/Developer ID checks pass at `release/1.9.5/mac-arm64/Klippt.app`. Helpers were rebuilt and their manifest refreshed and verified; no provenance guard was weakened. The packaged HUD and notification host pass an accessibility smoke test; the app exited and its isolated standby helper was stopped. The final build includes all review fixes and clip-native pack/info compatibility. No installation, notarization, or publishing occurred.
- Real capture on this Mac is verified with an isolated animated fixture, not the desktop. Pause, Continue, Stop, and review produce two fully decoded clips (36.907 s and 26.727 s). `klippt pack` and `info` now support clip-native assets and schemaVersion 11 while preserving legacy projects; packed clips match original bytes. One video exports and fully decodes at 2560×1440, 60 fps. Evidence: `native-capture-proof.json` and `native-handoff-verification.log`.
- Real source loss while paused is now verified: Continue rejected the missing window twice in 75/79 ms. After source reselection/reconfiguration (336 ms), Continue succeeded in 70 ms; Stop returned in 99 ms and review's first frame arrived in 400 ms. The saved session contains exactly two clips (29.015 s and 149.083 s), both fully decoded at 2560×1440 with inspected fixture frames. The three-file handoff contains one rewritten schemaVersion 11 project and two byte-identical media copies. Evidence: `native-source-loss-proof.json`, `source-loss-media-verification.json`, and `source-loss-handoff-verification.json`.
- Shutdown is complete: fixture task `bash-enw2ha6x` / Chrome PID 28182 was stopped using only that verified isolated-profile PID. Its wrapper and fixture children have exited; no recording-test app, helper, server, or runner remains, and port 53992 has no listener. Normal Chrome remains running; `/Applications/Klippt.app` was untouched. This source-loss test and evidence closeout changed no code. See `shutdown-proof.json`.
- All five code commits passed the normal staged-file hooks, with the pre-closeout source bytes preserved. The font and dependency commits share the signed asset/input approval, so review them together when reverting either. Raw diff whitespace checks flag only preserved upstream font-license whitespace; authored changes pass. Large media and detailed proof artifacts remain local under the ignored evidence directory.
- Fresh closeout checks pass: `npm run docs:check` (28 files and token sync), `npm run design:check`, and 11 evidence/record consistency checks. One verified vault milestone was read back from the project ledger; the vault checker reports no errors or warnings. Code suites and builds were not repeated during this documentation-only closeout.

Next: longer sessions and the nonfatal Mach Port cleanup diagnostics seen on fast CLI exits. Remaining gates: second Mac/clean account, Meet 2 daylight, ProMotion, 5K/6K, N→N+1 updates, native font-picker interaction, and a reviewed commit with same-commit helper/release artifacts. The source-loss proof covers a missing window while paused and recovery after reselection, not every interruption during active capture. This is not a release approval. Evidence: `docs/audits/2026-10-24/release-optimization.md` and `artifacts/release-optimization-2026-10-24/`.
# October 20: Final Cut Pro timeline in Separate takes (branch `claude/clever-yalow-8c1dcd`)

Separate takes now writes `timeline.fcpxml` beside `timeline.otio`. Both come from one shared
frame-grid plan (`planSourceTimeline`); OTIO output is byte-identical to before. Screen is the
primary storyline; camera lane 1, microphone −1, system −2, unidentified audio −3. Real nine-take
export: 36 media files byte-identical, FCPXML passes Apple's 1.10 DTD. **Not imported into Final
Cut or Premiere yet**: neither is installed. Premiere 25.6+ reportedly imports `timeline.otio`.
Next: install the Final Cut trial (needs Olle's OK), import, screenshot. Details:
`docs/fcpxml-source-timeline-2026-10-20.md`.

# October 20: local release path and the co.dyberg.klippt identity (branch `fix/launch-readiness`)

GitHub Actions has been blocked by billing since October 8, so every release step now runs on this
Mac. `node scripts/release-mac.mjs` checks the signer, notary profile `klippt-notary`, dependency
approval, notices and commerce IDs; builds the native helpers; packages arm64; signs, notarizes,
staples and runs `spctl`; then stages the update release. `--rehearsal` stops after stapling.
`node scripts/publish-mac-release.mjs --root release/<v>/update-release` is a dry run until
`--yes`, and needs R2 credentials. The feed is arm64-only. License revalidation runs every 12 h,
after wake and before read-only. Commerce IDs live in `electron/entitlements/commercial-config.json`.
Website pages in `website/` are drafts behind a deploy guard. Do not deploy them from this repo. The live site is `~/dev/klippt-site` (klippt.olledyberg.com); once Olle picks klippt.app or klippt.olledyberg.com, move the download, privacy, terms, refund, support and notices pages there. The app is now `co.dyberg.klippt`, with
`klippt-*` helpers signed `co.dyberg.klippt.*`. An existing `…/openscreen` data folder keeps being used; fresh installs use `…/Klippt`. The installed
1.9.5 still has the old ID: installing the new build needs Olle's OK, a one-time permission
re-grant, and a manual install, because Squirrel.Mac cannot cross the ID change (see
`docs/permission-and-control-consistency-2026-09-09.md`). Rehearsal passed: notarized and stapled 1.9.5 arm64 DMG (submission 86a208ef), `spctl` accepts DMG and app as Notarized Developer ID; app `co.dyberg.klippt`, helpers `co.dyberg.klippt.*`, after-sign guard passes.
Waits on Olle: re-sign `supply-chain/approved-dependency-inputs.json`, Lemon IDs, legal text,
klippt.app DNS/MX/CORS, R2 credentials. Follow-ups: Windows `nsis.guid` derives from the new appId (only matters if Windows installs exist); SwiftPM does not rebuild when only a helper Info.plist changes (after-sign catches it). Current optimization audit and status: `docs/audits/2026-10-24/release-optimization.md`.

# October 13: overnight fixes and speed (installed)

Olle asked for fixes and speed across the app while he slept; all of it is on `main` and
installed, Developer ID signed. One video on the 63-minute, 34.6 GB take: about 174 s → 46 s in
the installed app. Two changes: the packet proof hashes with murmur3 instead of SHA-256 (SHA-256
bound each read pass to one core: 60.4/68.6/62.7 s vs 7.8/11.8/7.1 s per pass), and the copy
reserves the MP4 index (`-moov_size`) instead of rewriting the whole file for `+faststart`
(49.3/50.3 s vs 64.5/93.1 s, two runs each). The installed export's 226,757 video packets match
the source in size and content; index before media; audio -18.4 dB. One video now shows one
progress bar across its three passes, names the space needed on a full disk, and describes its
fixed output instead of "Pick a format". Fixed from a review sweep, each with a test that fails
without it: a save path naming the export's own source is refused; Originals no longer overwrites
saved export settings; a failed Pause whose session save also fails stays paused; a helper that
outlives its kill window no longer blocks the next take; a second Pause hotkey press before
re-render is ignored; a transcript pass stops before the next clip once the take continues;
quitting mid-take stops it first (at most 15 s). Checked live: a 27 s take quit mid-recording
finalized all three files and reopened in review. Paused review CPU: 14.3% → 6.0-7.7% of one core
(preview polls at 10 Hz after a second without change; the hidden loading spinner no longer
animates). The camera now records 4:2:0 instead of BGRA (4K frame 33 MB → 12.4 MB, so the 512 MB
queue lasts about 1.3 s instead of 0.5 s); checked only with the MacBook camera in a dark room
(400/400 frames, neutral chroma, bt709 tags). Open: verify the camera change with the Meet 2 at
4K in daylight. Open: recording import of a take that outlives an expired trial is blocked by the
import entitlement (off today; product call). Not done: the review playback-clock rAF still runs
at 60 Hz while paused (about 2%). A fresh-context review of the night's diff found no blockers; its two
findings in the quit-time stop are fixed (`cd038502`: logout or shutdown is never held, and a
cancelled quit re-arms the stop). Still open from that review: if a quit is cancelled after the
take was stopped, the HUD keeps counting a take main already stopped. Test takes from 21:22
(28 s), 21:44 (13 s, camera) and 21:56 (8 s) are in the library. Previous app in `.local-install.noindex/backup-installed-20261013-2*`.

# October 5: repo slimmed; editor archived

Branch `cleanup/slim-repo-2026-10-05` archived the editor UI, in-app LLM chat, `klippt agent`
CLI, automatic direction, pause analysis, zoom suggestions, STT and caption generation, plus
direction-lab, dead exports and 831 unused i18n keys. All of it is in tag `archive/pre-cleanup-2026-10-05`.
Kept: recording, review, playback, source handoff, One video, opening/rendering existing projects,
Notes, Clean Voice, entitlements, `klippt record/export/sources/info/pack`, Windows/Linux code.
Tracked files 1,918 → 1,368; +3,106/−146,095 lines vs the tag. Unit tests: 2,449 pass, 1 skip
(4,131 on October 4); types, lint, docs, i18n, design, supply-chain and `build-vite` pass.
Owner: re-sign `supply-chain/approved-dependency-inputs.json` to drop the importer-free npm
packages langchain, @langchain/{anthropic,core,openai,mistralai}, motion, react-icons, react-rnd,
@uiw/react-color-colorful, @electron/rebuild, fast-check, esbuild, the parakeet/whisper helpers
and `electron/stt/modelManager.ts`. `web-demuxer` now has no code importer either.
Mac pass on the private dev app: screen Record, Pause/Continue, Pause→Stop, review, One video,
Originals (byte-identical) and an old project with three zooms all pass; no console or IPC errors.
Not run: camera/microphone/system audio. Older breakage, not from the archive: `klippt info`
reads only the legacy format, `klippt export` fails on a fresh profile, and the profile and
creator-loop smoke scripts predate the October 4 HUD. Scrubbing fix `8a308450`: the loading cover
no longer hides the preview during a playhead drag (96% of frames covered before, none after).
Installed this branch at `8a308450` to `/Applications/Klippt.app`, Developer ID signed, same
designated requirements. Later the same day: backward scrubbing reuses decoded frames and skips
the stand-in camera (slow backward drag 8 → 25 updates/s), and review gained Space/K, J/L, arrows,
Up/Down, Home/End and M. Installed at `67d3aa26`; Space, Home, End and Right confirmed in the
installed app. Evening: a recording with fewer source files than the previous one no longer
sticks on the loading cover (`5025f1c9`), and the review camera keeps its real shape and can be
dragged and resized (`cc16d3c4`, on main). The Automatic camera format now prefers 16:9 over the
largest pixel area, so a MacBook camera records 1920x1080 instead of 1552x1552 (`7fed550f`); a
live camera recording on Automatic is not yet tested. October 6: the review camera stays movable
after playback crosses a clip boundary and the paused Replay shows the camera (`ff53f5ba`). Stop
no longer waits for the camera to shut down, Pause and Continue log their steps to
`diagnostics/record-pause-continue-timing.jsonl`, and the timer no longer drops back on Pause
(`e3174b30`). Installed at `e3174b30`. Olle's 01:44 camera recording on that build: Stop 0.35 s
(was 1.05-1.13 s), Pause 0.06-0.19 s, Continue 0.05-0.32 s, all 4 screen and camera clips
readable. Open: one first Pause took 3.7-5.4 s at 00:49 on the previous build; cause unknown,
not seen since. Previous app in `.local-install.noindex/backup-installed-20261006-0105`.
[Evidence](artifacts/cleanup-verify-2026-10-05/).

# October 4: current creator-loop build installed

The user authorized fixing packaging and installing the merged build. `/Applications/Klippt.app`
now contains the current recording-loop fixes. Developer ID/permission identities, afterSign,
deep strict signature, compiled-file parity and packaged distribution audit pass. Parakeet uses
Swift's actual output path; build-only Vite metadata is excluded with the reviewed signed policy.
Installed Record/Pause/Continue/Stop/playback/source export and compact return passed; all six
files from two clips hash-match originals and fully decode. App left ready to record.
4,131 unit tests pass across full run plus repaired approval-file rerun, one existing skip;
types and lint pass. Prior app backed up. No push, notarization or public release.
[Installation evidence](docs/local-install-2026-10-04.md).

# October 4: creator recording loop verified locally

All local branch work is integrated through `511f1142`; the final acceptance commit records
this result. The creator path is Record → Pause/Continue → review → untouched source handoff,
with quick Record-again/return navigation, keyboard guards, recovery, compact layouts and
accurate export feedback. No new editor features.

All eight gates pass: 4,129 unit tests, one existing skip; 62 native tests, full native/Vite
builds, independent code/UI reviews and actual Mac UI checks. Paused source switching passed.
Both diagnostics-off 30- and 60-minute four-source workflows passed, including full decoding
of all 12 files per run, unchanged export hashes and exact 60 Hz screen timestamp grids.
The one-hour run reached Record in 0.91 s, review in 3.82 s and source handoff in 1.68 s.
It repeated 2,705/215,856 frames (1.253%) with zero writer failures or backpressure.
[Research, receipts and limits](docs/capture-queue-2026-10-04.md).

Large media generated by these two tests was removed after verification; metrics, hashes,
screenshots and cleanup inventories remain. Installed app, release configuration, remotes
and user projects are unchanged. The older signed test DMG predates current fixes. Public
distribution still fails the existing `dist/.vite/manifest.json` asset policy; resolving that
policy and producing a current signed installer is a separate release step.

The requested local integration and recording-loop implementation are complete. Earlier
checkpoints below document intermediate failures and are superseded by this acceptance.

# October 4: isolated capture delivery and correct source-frame selection

Branch `codex/long-capture-acceptance-2026-10-04` follows local main `675e6d72` (54 commits
ahead of origin). Activity and explicit queue priority alone did not resolve timer-lag failures.
Live stacks exposed framework receive work sharing cadence's queue. Framework delivery now
uses a separate serial queue with bounded synchronous handoff and a source-change barrier.

The first isolated run completed but repeated 45% of output frames: keeping only the newest
capture could discard the eligible image for the current clock slot. A bounded two-frame
cache fixes this while rejecting future/older pixels and retaining only one frame while paused.
The corrected 60-second four-source run passed with 2/3,466 repeated source frames, zero
backpressure, 12 unchanged source exports and clean full decoding. Source delivery p99 0.893 ms.
Record 733 ms; Stop-to-review 2,381 ms; handoff 2,741 ms. All eight gates, 4,119 unit tests,
62 native tests, native/Vite builds and independent review pass. [Evidence](docs/capture-queue-2026-10-04.md).

Next: 30/60-minute normal-runtime acceptance. Installed app, remotes, release configuration
and user projects remain unchanged. The signed local test DMG predates these capture fixes;
public distribution remains blocked by the manifest asset policy. Overall goal remains active.

# October 4: sustained capture scheduling

Branch `codex/capture-queue-timing-2026-10-04` follows local main `ccc12867` (52 commits ahead
of origin). Complete callback timing confirms a 167 ms timer-entry gap, with the writer ready;
the post-failure sampler has no stacks and establishes no cause. Active recording now declares
Apple's user-initiated, latency-critical activity. Separate finalization leases preserve saving
priority after capture failure; Pause releases the activity once saving finishes.

One five-minute High screen/camera/microphone/system recording passed with two Pause/Continue
cycles, paused Stop, review and 12 byte-identical originals. Start 859 ms; Stop-to-review
2,259 ms; source handoff 3,797 ms. All eight code gates passed: 4,118 tests plus 56 native tests.
Independent lifecycle review is clean. [Evidence and limits](docs/capture-queue-2026-10-04.md).

All 12 source files decode fully; all three screen files have zero 60 Hz grid violations.
Signed local packaging and actual desktop recording/review/export smoke passed. Public
distribution validation remains blocked by unapproved `dist/.vite/manifest.json`; release
configuration is unchanged. Record accessible name is corrected and verified in both tray layouts; 4,119 tests and
all eight gates pass. The diagnostics-off 30-minute attempt failed around 100 seconds
with the same eight-frame lag limit. Next: isolate dispatch scheduling before rerunning
30/60-minute acceptance.
One successful run does not establish causality or long-session reliability. Installed app,
remote branches and user projects remain unchanged. The overall goal remains active.

# October 4: creator loop and recovery

Local main includes the 51 prior commits through `bf10edff`. Follow-up branch
`codex/capture-readiness-2026-10-04` makes capture interruptions persistent through Stop,
recovery, import and reopen. Confirmed header-only tails no longer strand earlier valid clips;
unknown probe failures keep the handoff retryable. Original media stays intact. Review shows
an explicit recovery error and Try again instead of permanent Preparing.

Real owned-helper crash, review/reopen, four-source hash-matching export and 400px UI checks
pass. Independent review is clean. Full suite: 4,118 passed, one existing skip. Native 53 tests and full native directory rebuild passed.
Full code-check receipts live in `artifacts/capture-readiness-2026-10-04/final-checks-2`.
[Research, evidence and limits](docs/capture-readiness-2026-10-04.md).

The overall goal remains active: five-minute High four-source capture failed its 133 ms
cadence contract both with diagnostics on and off. Ready writer/no backpressure does not
identify the stall's cause. Next measure complete sample-queue callback and timer delay,
including state locks, sample retiming/admission and callback backlog, without hot-path
logging. Packaging still needs fresh clean-source Whisper provenance; never weaken its guard.
Installed app, remote branches and user projects remain unchanged.

# October 3 follow-up: high-quality untouched sources

Active goal on `codex/overnight-2026-10-03`: Separate takes is the fresh remembered export
choice; copy complete screen, camera, microphone and system-audio originals byte for byte,
with cuts only in `timeline.otio`. High recording quality is the fresh remembered setup
default, with Standard retained. No new editor features. Do not touch the installed app,
release pipeline or Olle's Resolve projects, and do not push.

Implementation and real Mac acceptance are complete in the development build. Final matched
120-second Standard/High recordings handed off all four untouched sources in 740.8/1,491.8 ms;
High measured 136.346 Mbps with an exact 60 Hz output grid. Current UI, recovery, full decode
and new-owned Resolve full/cut/multi/moved-folder import/playback passed; original media and
all existing saved Resolve projects remain byte-identical. Exact full suite: 4,095 passed,
one existing skip; required gates and 53 native tests pass. Installed app, release pipeline
and pushes are unchanged. The dated follow-up in
[docs/overnight-2026-10-03.md](docs/overnight-2026-10-03.md) owns evidence, research and limits.
Do not treat the initial-phase numbers below as the follow-up measurements.

# October 3 initial phase: recording focus

Working branch: `codex/overnight-2026-10-03`. Original uncommitted work was preserved unchanged
in `fff98f36f4748d74d67cd01fd1cdd12b3c66d712` before implementation. Klippt now prioritizes
immediate recording, Pause/Continue, read-only review and direct Save video. Do not build
editor features; preserve existing project, original-media and CLI/export compatibility.

[Changes, actual measurements, checks and remaining limits](docs/overnight-2026-10-03.md)
own the completed overnight result. Actual Record start improved from 2,355.2 to 294.1 ms;
the identical 120.081667-second source exports in 879.6 ms versus 54,389.3 ms. Full suite:
3,992 passed, one existing skip; lint and workbench/app/test TypeScript are green. Twelve
native tests and nine actual Mac smoke cases passed. No installed app, packaging/signing/CI,
update feed, Resolve or remote push was changed. The approved Swift package is unchanged.

Older handoffs below describe historical editor work, not the current feature queue.

# September 21: synchronized source timeline

Separate takes now writes `timeline.otio` with screen, camera, microphone and system audio on
separate tracks. It preserves retained cuts, take order and camera offsets, with gaps for missing
source time and relative media links. [Implementation and evidence](docs/resolve-source-timeline-2026-09-21.md).
Verified in the development app and Resolve Studio 21.1: fresh Mac capture/export, four-track import,
cut and offset positions, and moved folder links. Full suite: 3,793 passed, one existing skip.
The installed app is unchanged. This interchange transfers source cuts and sync, not Klippt effects.

- September 21 recording workspace: editor Record now opens an idle compact pill and restores local per-project source/device/audio/cursor setup. Warm editor return and fast settings-save races are corrected. Real Mac round-trip, restart, A/B switching and screen/camera/microphone capture/import passed in isolated test data. Full suite and static checks pass. [Implementation and evidence](docs/recording-workspace-2026-09-21.md). Installed app unchanged.

- September 19 raw recordings and timeline: new projects start plain; automatic direction runs only on explicit application. Captions are one strip; B-roll has thumbnails above the waveform. Export defaults to Separate takes, with screen/camera/audio numbered together and an agent timing manifest; One video retains the rendered export. UI stays editor-neutral. [Implementation and evidence](docs/raw-recording-timeline-2026-09-19.md). Full suite: 3,774 passed, one existing skip; all static gates and Vite build pass. Real Mac source handoff: two takes, eight media files in about 1.6 seconds. Main Kimi project SHA unchanged. Development build only; installed app and Resolve were not changed.

- September 18 CLI foundation takeover: clone-only verification is finished; main is restored clean at raw 182.633 s. Main and coordinator export clone remain byte-identical; Resolve was untouched. Codex preserved Kimi's work and completed readiness, proof, compact-output, contract-drift, batch recovery and piped-output fixes. F3's immediate seek reproduction and three-step grouped undo pass live. Audited fresh-agent checks: 5/5 new versus 3/5 old, with mixed-build and visual limits. **Acceptance remains partial: continuous boundary coverage and the original six shot-map rows are unpassed.** [Takeover result](artifacts/cli-foundation-codex-takeover-2026-09-18/RESULT.md) owns final checks, evidence and limitations. Editor test window finished; final dev build is running on main.

- September 18 agent CLI foundation decision: keep the CLI, no MCP or code-mode SDK now; seven ordered phases in [`docs/agent-cli-foundation-plan-2026-09-18.md`](docs/agent-cli-foundation-plan-2026-09-18.md). Implementation and acceptance status are recorded in the takeover result above.

- September 18 orchestrator handoff for Codex: [`docs/ORCHESTRATOR-HANDOFF-2026-09-18.md`](docs/ORCHESTRATOR-HANDOFF-2026-09-18.md) holds Olle's goals in his words, hard rules, what landed, the Kimi shot map, in-flight Task F2 (visible proposed-cuts lane) and queued Task G (`broll swap` auto-fit), lessons and open questions. Read it first.

# Klippt handoff

- September 18 accepted FFmpeg reference refinements: the [foundation plan](docs/agent-cli-foundation-plan-2026-09-18.md#accepted-refinements-from-ffmpeg-skill-september-18) now adds command-level proof requirements, component capability checks, contract-drift tests, compact replies, and boundary-focused visual comparisons. These are follow-up acceptance requirements, not a claim of implementation. Local skill routing keeps Klippt the default for project edits; FFmpeg handles standalone files and disclosed fallbacks.

- September 18 stopped work: Kimi's foundation run was stopped at Olle's request and handed to Codex. [Kimi's historical handoff](artifacts/cli-foundation-kimi-2026-09-18/HANDOFF.md) records its session and review handoff. Current work is tracked in the takeover result above.

- September 18 CLI foundation phase 1: `klippt agent skill` now serves bundled, version-matched instructions; `guide --skill` is its alias. The local launcher is installed on PATH, the 70-line canonical skill is discoverable in fresh Codex and Claude sessions, and AGENTS.md makes the CLI the default for supported editing actions. [Coordinator evidence](artifacts/cli-foundation-phase1-2026-09-18/coordinator-result.md) owns installation, checks, review, and limits. Full suite passed 3,449 tests with one existing skip; the review's export-clock instruction correction passed 86 affected tests and a rebuild. No Kimi edits, accepted cuts, or app restart. Phases 2–7 remain in the [foundation plan](docs/agent-cli-foundation-plan-2026-09-18.md); packaged launcher distribution and full fresh-agent editing evaluations remain unverified.

- September 18 cut-safety follow-up: transcript-first pauses, complete raw/cleaned speech protection, safer cutpoint refinement, shared `edges` policy, and stricter short-removal checks passed fresh `cx` review after its off-grid-frame finding was fixed. Full suite: 3,402 passed, one existing skip; final correction: 117 affected tests and both type checks passed. Rebuilt dev app verified through live CLI. [Coordinator result](artifacts/cli-cut-safety-2026-09-18/coordinator-result.md) owns receipts, pictures, limits and next actions. Kimi's bad4:25.65 trim was restored through “For sure.”; real agent-list footage and Agent-47 task B-roll were placed. The Agent-47 zoom is editable in its cloned Klippt source project. Direct B-roll zooms remain unsupported in the main edit. No pause proposals accepted; the lane is empty because proposals intentionally clear on restart/project switch. Nine other cuts remain flagged for audio review; full final export is pending.

- September 18 Task G (partial): `broll swap` preserves slots, reuses assets, selects cover/contain, and trims or holds media through guarded plans and receipts. [Evidence and command tails](artifacts/broll-swap-2026-09-18/README.md) include clone-only short/card/hold swaps and inspected native frames. Kimi bytes are unchanged. Shortening edited/word-anchored overlays awaits Olle's anchor-policy choice; current builds reject it. Canvas-based fit follows the requested formula but split-camera layouts can differ from the visible screen rectangle.

- September 18 Task F2: proposed cuts now occupy a separate row above clips, with token fills, responsive saved-time labels, visible handles, tooltips, and exact waveform washes. [Screenshots, checks and limits](artifacts/staged-cuts-2026-09-18/lane-v2/README.md). Six staged cuts remain; Kimi document unchanged. No visible row label, matching adjacent lanes. All requested gates passed (3,346 tests, one existing skip); live drag/selection passed. Current clip-0017 proposals are at 4:19 and 4:30, not the requested 3:30–3:50.

- September 18 Task F: proposed cuts lane, draggable edges, project rejection memory, explicit CLI stage/list/accept/reject, and single-step GUI/durable history. [Evidence and command tails](artifacts/staged-cuts-2026-09-18/README.md); type checks, 127 focused tests, full suite (3,338 passed; one existing skip), lint, i18n, docs and Vite build passed. Live Mac stage seven → reject one → restage six passed; screenshots inspected and Kimi file unchanged. Six remain staged. Live acceptance/undo and export were not run; integration tests verify one GUI/durable history step.

- **As of:** 2026-09-05
- **Repository:** `github.com/oEdyb/record` (private)
- **Working branch:** `codex/overnight-2026-10-03`
- **Verified code checkpoint:** `5e7bc7e9f6f2d2bfefc72597138bd467ad810c82`
- **Product rules:** [`AGENTS.md`](AGENTS.md)
- **Delivery plan:** [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md)
- **Detailed execution ledger:** [`docs/cutting-edge-execution-plan.md`](docs/cutting-edge-execution-plan.md)

- September 18 Task A.2: calibrated layer/cut/sliver checks, frame-height text sizes, and six unique verify actions; saved-project cut findings 70 → 40 (35 mic / 5 transcript), known-good cut clear. Warm frames require Electron lifecycle changes; see [evidence and limits](artifacts/check-a2/report.md).

This is the current handoff for Klippt. Read it before an implementation session. Reference docs
describe the current architecture. Dated audits and the inherited OpenScreen roadmap are evidence
and history, not the active queue.

## September 18 overnight: agent-first editing state (reviewer summary)

Design: [`docs/agent-editing-state-design-2026-09-18.md`](docs/agent-editing-state-design-2026-09-18.md).
Built by six Codex runs (`codex exec --sandbox danger-full-access`, gpt-6-astra) under Claude
review, one at a time after memory pressure; the plugin sandbox kills Electron, so use the direct
CLI for anything that drives the editor. Skill: `~/dev/skills/skills/klippt-edit`.

Verified live on `proj_77f9202f-…` (Kimi swarm rough cut) with the dev editor, every write undone
afterwards; the project file is unchanged in content (95 trims, 75 camera regions, 11 zooms, 39
overlays; backup `…klippt.backup-20260918-0130.bak`):

- `state --at 1:43` resolves through the scene (clip, source time, cuts, layout with `layer`, regions, captions).
- `check --all` completes in two polls (~20 s); rules paged; 131 findings after A.2 calibration
  (40 cut.mid-sentence, 27 gap.silence, 47 region.off-cut, 17 region.near-cut, 0 camera.nested).
- Morning 2026-09-18: `cut.mid-sentence` now requires the cut to land inside speech and, with
  microphone peaks, the removed side within 10 dB of the kept words (measured with ffmpeg RMS on the
  Kimi project: 9 of 10 "clipped start" findings were silence or a breath). 40 → 10 findings, all
  deliberate mid-talk cuts. The broker no longer passes `transport` replies through
  `boundAgentReply`; it had truncated every probe frame to 512 chars, so `run_probes.py` reported
  false "no holds". Fresh cut probes: 45–51 ms holds at cuts (23–27 ms overnight, machine under
  load). Applied for Olle: clip 4 tail 17.9–18.9 s and clip 5 tail 4.32–5.45 s trimmed
  (request `olle-tails-2026-09-18`, forced past the old rule; audio measured silent).
- Later 2026-09-18: new `cut.loose-tail` warning (mic-level air ≥ 0.35 s next to a cut, setTrim
  fix); rules declare `audio: true` instead of the analyzer's hard-coded list; plan/apply checks
  load cached mic peaks for the touched span (`audioEvidence` in the broker), the delta key drops
  the edited span, and apply gates against the plan-time baseline. Applied for Olle on the Kimi
  edit: tails at 2:02, 2:28–2:30, 2:53, four studio loose tails, and the 5.3 s scoring silence at
  4:57 (requests `olle-tail-202/228/253`, `olle-loose-studio`, `olle-score-gap`). Edit 690.4 → 677.1 s.
  Six gameplay loose tails (0.6–2.1 s) left for Olle to judge. Open: 27 `gap.silence` warnings were
  never acted on overnight; the skill loop should list them.
- Afternoon 2026-09-18: pause pass redefined around speech, not sound. Wordless blips (≤ 0.5 s,
  no transcript word, no detector ≥ 0.8) join the pause; ≥ 0.15 s blips inside a sentence become
  `kind: "blip"` suggestions; `includeNonSpeechEvents` defaults on; `nonSpeechMaximumProbability`
  removed; `pauses --clips` filters by clip. Measured on the Kimi edit before the change: all 26
  remaining `gap.silence` findings sit in the four gameplay clips, blocked by system-audio and
  screen-activity protection (default pass 4 pauses, protections off 9, audio-level 35). Sources:
  Auphonic automatic video cutting (VAD + separate cough/filler detectors), Silero VAD parameter
  semantics.
- Same afternoon, corrections after Olle heard "experiment" clipped at 0:28: the cut planner's
  mic-level gap ignored nothing shorter than a stop closure, so in-word closures (40–120 ms)
  became "end of speech"; `planCutPoint` now drops quiet spans under 0.2 s. Three tightened tails
  were restored (`olle-restore-experiment`, `olle-restore-two`), one re-applied at the measured
  word end (`olle-possible-tail-b`). Also: speech-mode pauses widen to the mic edges
  (`widenToMicrophoneEdges`); blip classification reads the detector without the ±80 ms pad;
  `cut.mid-sentence` skips wordless removals ≤ 1 s inside a take; its kept-speech reference
  window is 1.5 s. Gameplay recipe no longer overrides padding. The 7 remaining gameplay cuts
  are planned with 0 introduced errors (`gameplay-v6-ops.json` in the session scratchpad) and
  not applied. Edit length 673.8 s.
- `layout set --scope clip:ID --camera-size L --camera-anchor bottom-right` → state reports
  `layer: clip:…`; still frame at edited 13 s shows the camera bottom-right; cleared with `setClipLayout`.
- `assets` (96, thumbnails), `frame --at 1:43` (6 s per frame; warm path needs Electron work),
  `text add … --anchor top --size M --style card` rendered and removed.
- `apply` verify block; plan gate refused a mid-sentence trim, `--force` applied it; `history`,
  `undo`, `redo`, `undo` restored 95 trims. Gate now blocks only findings a plan INTRODUCES
  (Claude fix after Task E: `settings set` and `auto regenerate` were refused by pre-existing errors).
- `settings` (grouped, ranges), `settings set motionBlurAmount=0.3` + undo, `preset save night`
  + `preset list` (agent + UI presets), `transcript --all` (paged, 37 clips), `auto regenerate`
  (manual regions survived: 21 before and after) + undo.
- Preview stutter chain (decode → preload → renderer clocks → B-roll prep): reviewer probes across
  edited 49–55 s show 0 ms repeated picture in six steady windows, lag50 55 fps, 0 % late rAF.

Not done / open: warm `frame` under 1 s; per-clip layout preset and screen framing (Rust);
text style shapes (bar/pill) share the card renderer; `clip replace` verified by tests only;
`preview` command takes EDITED seconds (was assumed raw once tonight); installed
`/Applications/Klippt.app` is an old build that cannot read schema 11 and blocks the dev editor.

- September 18 Task E: global settings, per-user/UI preset discovery, guarded automatic edits, and paged all-clip transcripts; see [CLI contract](technical-documentation/agent-cli.md#global-settings-presets-automatic-edits-and-all-transcripts-task-e-september-18). Real-project checks remain with the reviewer.

- September 18 Task D: durable 50-write agent history, guarded undo/redo, apply verification, generic plan error gating, and clip source replacement; see [CLI contract](technical-documentation/agent-cli.md#reversible-writes-and-verification-task-d-september-18). Real-project checks remain with the reviewer.

- September 18 native B-roll preview: render-thread timing confirmed 373 ms overlay preparation.
  One background overlay decoder now prepares ahead; active decoders stay warm with bounded retention.
  Scene-only refreshes also retain the unchanged decoder anchor to avoid a redundant Play seek.
  Final 49–55 s probes: no repeated adjacent JPEGs in two consecutive runs (local before: 337.8 ms).
  Cut maxima: 26/27/23/23 ms; lag50: 58.0/60.0 FPS. All sampled gates pass; Rust 222 tests pass,
  and all 300 benchmark export frame hashes match. Project unchanged; historical renderer hash differs.
  No new capture or long-session memory soak. See [evidence and limits](artifacts/preview-broll-2026-09-18/README.md).

- September 18 renderer preview: prepared video promotion, exact playback cut bounds and a shared
  audio output reduce local cut holds from 104/67/88/145 ms to final maxima 47/28/28/74 ms.
  Acceptance remains unmet: edited 49–55 s still contains a 305.8 ms picture hold with no dropped
  rAF ticks. Lag probe: 51.4–52.5 FPS; backward/click scrubs pass. Both typechecks, 19 targeted tests,
  full suite (3,212 passing), lint and Vite build pass. Audible continuity remains unverified.
  Next: measure native overlay open/seek/decode near edited 51.85 s; no native code changed here.
  See [renderer evidence](artifacts/preview-cut-renderer-2026-09-18/README.md).

- September 18 preview preload: matching cut anchors now consume one prepared decoder pair;
  measured swaps take 4.1–6.8 ms. Zero-visible-hold acceptance remains unmet: renderer media
  switching still produces 66–160 ms sampled picture holds. Rust: 217 tests pass; all 300 export
  frame hashes match; backward/click scrubs pass. See [evidence and remaining work](artifacts/preview-preload-2026-09-18/README.md).

- September 18 Task B: sparse clip camera/caption overrides, named anchors and XS/S/M/L/XL sizes, guarded `layout set`, state layers, and unused-override checks; per-clip preset/framing fields remain blocked by the unchanged native contract. See [CLI details](technical-documentation/agent-cli.md#per-clip-camera-layout-task-b-september-18).

- September 18 Task C: guarded text/B-roll/zoom/camera commands, independent edited/word anchors, four overlay checks, cached asset thumbnails, and edited-time frames/contact sheets; real-project/render timing remains with the reviewer. See [Task C CLI details](technical-documentation/agent-cli.md#text-b-roll-speech-commands-and-frames-task-c-september-18).

- September 18 Task A.1: immediate structural checks, two background audio workers, bounded pages, caption noise exclusions, terminal limits and rule explanations. Standalone saved-project analysis: 3.342 s cold / 0.528 s warm. All tests pass; repository lint is blocked by a formatting error in a protected renderer file. [Evidence, pending shape and reviewer commands](artifacts/check-a1/report.md).

## September 18 agent CLI Task A: state and check

Added `agent state --project_id ID --at TIME [--range FROM TO]` and
`agent check --project_id ID [--all | --range FROM TO] [--rule ID]`, with human output,
`--json`, document revision/hash, cached editor analysis, and seven extensible rules.
`agent contracts` lists all input schemas. See
[agent CLI documentation](technical-documentation/agent-cli.md#effective-state-and-edit-checks-task-a-september-18)
for output shapes, rules, and extension points. State reports the shared scene base layout,
active region parameters, and the native source-time clamp; animated final-pixel geometry
remains compositor-owned and is explicitly identified in the output.

Verification: both TypeScript checks pass; six new test files pass 46 tests; full suite
passes 303 files / 3,096 tests, with one existing skipped test. i18n passes 12 locales / seven
namespaces. Changed-code Biome check passes 28 files. Repository lint still fails on an
untouched formatting error in `src/lib/ai-edition/agent/resolvedEdit.ts`; it also reports the
existing oversized Cargo evidence warning. Document check passes 37 files. Independent review
has no remaining findings. `DEVELOPER_DIR=/Library/Developer/CommandLineTools npx vite build`
passes and refreshed both renderer and Electron bundles without starting Electron.

Read-only saved-project checks on `proj_77f9202f…`: zero nested camera cases, zero camera
pairs overlapping, and 15 camera authored edges within 0.6 seconds of an internal cut
(83 near-cut findings across all region kinds). This differs from the earlier count of 19;
aligned edges, trim-created edges, and removed authored edges are not counted. State at 1:43
maps to raw 125.323996 / source 10.417996 seconds in `clip_recording_1789653794581_2`.
The editor/broker runtime, microphone-backed 5:28 sentence check, and real-project end-to-end
checks remain for the reviewer. This task did not control Electron, write the project, or
change `crates/`.

## September 17 agent CLI: transcript, pauses, split, open/clone, video B-roll overlays

Goal: edit Olle's Kimi swarm video (project `proj_234faece…`, 38 clips, 47 min raw) through the
agent CLI and close every gap the edit hits (handoff spec in
`~/dev/kimi-swarm-arena/_staging/EDIT-HANDOFF-2026-09-17.md`). Added:

- `agent transcript --project --clip` (saved words, segments, silent gaps in source seconds) and
  `agent transcribe --project_id` (editor transcribes missing assets; poll).
- `agent pauses --project_id --preset …` runs the editor's Shorten Pauses detector through the
  broker and returns paged suggestions plus ready `addTrim` operations; plans now take 500 ops.
- `splitClip {clipId, sourceTimeSec}` operation (left half keeps the ID).
- `agent clone --project` (copy into the projects folder under a new ID) and `agent open
  --project_id` (opens the editor window if needed and loads the project) so an agent never
  needs the GUI to start work on a copy.
- **Video B-roll overlays**: document schema 11 (`videoOverlays`, anchored like zooms; old readers
  reject), `addVideoOverlay/setVideoOverlay/removeVideoOverlay`, `import-plan {kind:"video"}`
  (asset via `prepareAsset` + bundled FFmpeg duration probe), scene projection
  (`projectVideoOverlays` advances the source offset per fragment), and the native layer
  (Rust, drawn above screen and below cursor/camera/annotations, no audio). Timeline lane and
  inspector for overlays are not built yet; review through `preview` and export.
- Docs: `technical-documentation/agent-cli.md` (new sections), product behavior (Editor
  behavior bullet). Graphics copies under `~/dev/kimi-swarm-arena/_staging/edit-2026-09-17/`.

Later the same day, from the rough cut itself:

- Region ventilation drops fragments shorter than 1 ms, so an overlay that ends exactly on a clip
  boundary no longer leaves a zero-length fragment on the next clip (15 such fragments had to be
  removed from the rough cut by hand).
- Shorten Pauses treats a silence that touches a clip's start or end as a pause: the lead-in is cut
  back to `keepBefore`, the tail down to `keepAfter`, and the interior kept-fragment rule does not
  apply on the edge. A clip that is silent from start to end is never proposed. The pauses command
  gained `--ignore_non_speech`. Olle's recording key press is still an isolated microphone event,
  so without cleaned analysis it protects the first half second of most narration clips; the rough
  cut closed those with transcript-based edge trims instead.
- Full-screen card B-roll is padded to the screen layer's aspect (3420x2214 → 1920x1242 loops in
  `_staging/edit-2026-09-17/broll/`, 16:9 originals in `broll-16x9/`), because cover-fit into a
  16:10 layer cropped the score grid's right column.

Rough cut state (project copy `proj_77f9202f…`, "Swarm video agent rough cut"): 37 clips,
161 trims, 34 video overlays, 11.83 min playback (from 47 min). Olle records sentence by
sentence, so narration joins were tightened from the transcript to ~90 ms (first word − 50 ms,
last word + 40 ms; word gaps ≥ 250 ms cut to 100 ms); measured join silence 0.07–0.23 s across
30 narration joins. Gameplay clips keep their natural pauses. Gameplay keeps ~20–35 s of play
plus the spoken score per game; the cost line clip (`…352709_6`) was removed as redundant with
the previous clip. Plan files, pause reports and preview frames live in the session scratchpad.

Olle rejected automatic pause shortening on this footage (it cut inside takes where he would
not). All automatic trims were removed; only the 31 editorial cuts remain. Replacement: the
`edges` command (analysis in the editor via `analyzeProjectEdges` → `planEdgeSilence`, trims
tagged `reason: "edge-silence"`, `--remove true` reverses through the new exact-id `removeTrims`
operation). Whisper word timings were the wrong signal for this: they smear word ends into the
silence (clip 14 shows a 1.5 s tail as 0.07 s). Verified on clip 14: cuts 0–1.11 s and
5.69–7.07 s against Olle's own call of 0–1.0 and 5.7–7.0. Applied with `--pad_before 0.03
--pad_after 0.05`: 59 edge trims, 48.4 s removed. Gotcha found on the way: `removeTrim` follows
the editor's pill rule and can delete a touching structural trim on the neighbouring clip, which
is why `removeTrims` deletes by exact id.

Olle then pointed at a 1.8 s hole inside a take (edited 3:50.6–3:52.4, clip 10 of the second
recording, source 27.5–29.3) and expected the silence pass to take it. Cause: the Silero envelope
stays on ~0.5 s after a word ends, so the speech-mode detector saw a 0.74 s pause there, while
the microphone level (audio-level mode) saw 27.52–29.38. `edges` now also plans interior gaps
from the mic level (`quietSpans`, adaptive threshold, `--min_gap 1`, `reason: "gap-silence"`,
`isDeadAirTrim` covers both reasons for `--remove`). Applied: 5 gaps, 6.0 s. Cross-check with
ffmpeg `silencedetect=-35dB:d=0.9` over all 33 talking takes found one uncut stretch of 1.02 s
(take 5), everything else matched.

Olle then reported a one-frame camera flash with a ghost image at 3:40.2. Cause: export splits
a camera region at every trim/clip boundary (`projectRegionsToSource`), each piece restarted
the ease-in and drift on its own bounds, and `camera_fullscreen_region_strength` returned 0 at
`t == start`, so the first frame after the cut drew the small camera and the next frame
motion-blurred from it. Fix: every projected piece carries `envelopeStartMs/EndMs` (the whole
region in the piece's source clock), the scene passes `envelopeStartSec/EndSec`, and
`regions.rs` eases, drifts and gates on the envelope (the first export after gating on the
piece still flashed: the walk asks for the last frame of a fragment a hair past the piece's
end, so the piece must hold there too); instant regions are full frame from their first frame (preview `computeCameraFullscreenRegionStrength` now
includes `startMs` too). Tests: `regions.rs` (piece keeps phase, instant first frame),
`timelineMap.test.ts` / `region-ventilation.test.ts` / `sceneDescription.test.ts`
expectations extended with the envelope, two `cameraFullscreenUtils` tests moved to the new
contract. Zoom regions are split the same way and still re-ease at cuts: open.

At 5:28 an editorial gameplay cut started mid-sentence ("can use absolutely destroy…"). Olle's
rule: cuts land on transcript sentence boundaries, and the exact frame comes from the audio,
"when the last sound of that sentence leaves my mouth". New `cutpoint` command
(`cut-point.ts` planner, `analyzeCutPoint` in the renderer, cached run, broker action, CLI).
On that take it moved the out-point from 356.4 to 351.048 (mic level; Whisper had stored
"cool." as 350.4–355.0) and the in-point from 545.7 to 545.13 (before "And I can use…").

Preview reports (lag, click-seek while playing): a `transport` bridge action now scripts
play/seek/wait/sample/probe through the shell's own handlers (`registerAgentTransport` in
`NewEditorShell`, `runAgentTransport`, runs cached per `runId` in `editorSession`). First
measurements on the rough cut: 15 s of playback gives rAF p99 17.7 ms and 0 % late frames, so
the UI thread is not the lag; the probe now also reports preview frames painted per second to
see whether decode is. The seek script showed the shell's `videoElement` reporting a paused
element at a different source time while the store said playing, and a paused seek followed by
play resumed from the preview's old position: open, see the next entry when fixed. Trackpad:
a plain horizontal swipe on the timeline now pans (only Shift+wheel did before).

Sept 18, night. Export v4 flashed at the cut at 0:28.8: clip 22's full-camera region started
0.028 s (2 frames) after the kept fragment, so two frames of screen layout and one blended
frame showed before the camera. 19 camera region edges sat within 0.6 s of a cut. Fix at the
projection boundary, not in the document: `projectRegionsToSource` snaps such edges onto the
cut and pushes the envelope 3 s past it so the compositor's ease is already complete
(`sceneDescription` passes 0.6 s for camera regions only; zoom regions are left as an open
item because the Rust zoom ease does not read the envelope yet). Verified in export v5.
The auto emphasis region 0.15 s after the cut at 4:48.6 was removed by hand (Olle called it
a double tap); four more auto regions start 0.05–0.5 s after a cut and now snap.
5:28 cut moved to sentence ends with `cutpoint` (out 15.49, in 341.80 on
clip_recording_1789657946392_1).
Preview at every clip change stalls ~150 ms (new `<video>` mounts and loads: samples show
readyState 0 for one to two 80 ms samples, the webcam element stays at readyState 1 for up to
600 ms). The export has no such stall. Next step if Olle keeps judging from the preview:
preload the next clip's elements before the boundary and swap instead of remounting.
The "stale video element after a clip switch" seen through the bridge was the bridge's own
bug (handlers captured once per run); the editor's play button was fine. The bridge now
resolves handlers per step; `VirtualPreview` reports the element through a callback ref;
a `click` step dispatches real pointer events on `data-testid="timeline-ruler"`. Scripted
ruler clicks back while playing land and stay; Olle's report of the playhead snapping back
is not reproduced yet — ask which surface he clicks and whether the timeline is zoomed.
Preview volume: speaker button plus slider in the transport bar, user preference only.

Sept 18, later. Two more root causes with evidence:
- Click back while playing "skips forward" (reproduced with the `click` transport step,
  any zoom level, from a clip on one recording to a clip on another): `seekToVirtualTime`
  set `activeClipIdRef` to the target clip before React swapped the `<video>`; the next
  animation frame still ran the old element's loop with that hint, `locateKeptSegment`
  said "not kept", and `findNextKeptSegment` jumped the OLD clip forward, cancelling the
  seek. Fix: `assetSwitchInFlight` (playbackSwitch.ts) makes the loop stand down while
  the hinted clip lives on another asset than the element on screen. Verified with three
  scripted runs; unit test on the helper.
- Ghost frame on the first frame after a cut in preview AND export ("multiple versions
  of the webcam", 0:19.7, 3:40 earlier): the compositor derives motion-blur velocity from
  the geometry one frame earlier, and one frame before a fragment's first frame lies in
  footage that was cut away, where the camera region is not active. Fix in
  `frame_geometry.rs`: when `source_t - 1/FPS` is before the active clip's
  `source_start_sec`, the previous geometry is the current one. Rust test
  `the_first_frame_of_a_fragment_has_no_motion_blur_velocity`; addon rebuilt; export v6.
- Transport steps added: `wheel` (real wheel event, Ctrl zooms) and `sample` with
  `frame: true` (192 px JPEG of the composited preview; keep runs small, the bridge reply
  caps at 64 KiB).
Camera Emphasis size: `updateCameraScale` in `useTimeline`, "Camera size" select in the
camera inspector, shared ceiling `MAX_CAMERA_EMPHASIS_SCALE = 2` (TS clamp, Rust clamp,
agent op schema, planner range). Tests updated for the new ceiling; addon rebuilt. No
screenshot of the inspector row yet (needs a selected emphasis region).
Preview lag on screen-recording sections (Olle: 0:50.8–0:53.8): rAF is smooth, but the
composited preview paints 19 fps there against 29 fps on camera-only sections. The live
path (`live.rs` `present_frame`) decodes 3420×2214 60 fps H.264 synchronously per frame
through `Decoder::seek_to`; the export's `AsyncDecoder` (vt_decode_macos) is not used live.
That is the next real preview-performance job.
Not done: preloading the next clip in the preview (the ~150 ms hold at each clip change
remains); B-roll and visual research pass Olle asked for (start every edit by planning
B-roll per claim: benchmarks, tech blog screenshots); camera footage replacement later;
review of PiP camera covering screen content and of camera-full choices per section.

Text cards: Olle wants "Apple level" cards with squircle corners instead of the flat prompt
graphic. Electron 44 (Chromium 152) supports `corner-shape: squircle`; the scratch renderer
`cards/render.cjs` captures an offscreen window at device scale 2. Gotcha: Electron persists the
zoom level per origin, so a `setZoomFactor(2)` from one run doubled the layout of the next
`file://` load; use an in-memory partition and `--force-device-scale-factor` instead.

Preview bug from Olle's review: moving the playhead into another clip while playing loaded the
new clip at the right frame but never resumed it (`VirtualPreview` seek-target effect called
`seekToVirtualTime` without `preservePlayback`; the cross-asset pending seek then carried
`play: false`). Fixed with a reproduction test in `VirtualPreview.playback.test.tsx`. He also
reports occasional playback lag; not measured yet — the preview plays the 3420x2214 screen
file and the 4K camera file as two Chromium `<video>` elements, and the `window.__uiProbe`
frame probe exists for a real measurement.

Talking sections with no card or clip B-roll (21 spans ≥ 4 s, 291 s total) first got a
background gameplay loop plus camera emphasis; Olle found the motion overstimulating and the
retention guidance agrees (B-roll should support the sentence, stay on the speaker for opinion),
so they are now full-frame camera with a new **camera drift**: `drift {scaleTo, releaseSec}` on a
camera region pushes in slowly (ease-in-out sine) and returns fast (ease-out quad) over the last
`releaseSec`; `motionStyle: "instant"` so the take cuts hard instead of easing back to the
desktop. Implemented in Rust (`regions.rs camera_drift_factor`, applied in `frame_geometry.rs`
via `scale_center`), the web preview (`cameraFullscreenUtils.ts`), and the agent ops
(`driftScaleTo`, `driftReleaseSec`). Pill semantics bit twice: `removeVideoOverlay` and
`removeTrim` widened to touching neighbours and silently deleted six card overlays and four
structural trims; both agent paths now delete by exact id (`removeTrims` for batches).
`setCameraFullscreen` still refuses ("would be clamped") on 7 of 21 regions that touch an
automatic-direction region; they were recreated instead. Open: an exact-id path for camera
region edits.
Known gap: the recorded cursor is still drawn above a full-screen overlay; an overlay option to
hide the cursor (or skip the screen decode under an opaque full-screen overlay) is not built.

Gates: `tsc` app + test typecheck clean; full `npm run test` 3016 passed, 1 skipped; biome clean on touched files; targeted vitest groups
(cli, timeline, agent, ai-edition, pauses) 817 + 29 passed; `cargo test -p openscreen-compositor`
201 passed; preview stills at playback 336/399/544/623 s show cards, captions and camera PiP
composited correctly. Real export (CLI, quality good): `_staging/edit-2026-09-17/rough-cut-2026-09-17.mp4`,
2560x1440 60 fps, 710.5 s, 2.14 GB — size comes from 1440p60 at that quality, not from the
screen layer under the overlays.

## September 17 camera sync on multi-clip macOS recordings

Olle's real YouTube recording (14 kept clips, 4K camera) played the camera tens of seconds off.
Cause: `importPendingRecording` shifted every clip's camera offset by the cumulative capture
start of earlier clips, which is the rule for one continuous camera file shared by all clips
(Windows/Linux) but wrong on macOS, where each clip records its own camera file that starts with
the clip. The registry held correct per-clip offsets (-103 to -235 ms); the project ended with
-1753, -32314, -59619, … Fix: `isClipOwnedWebcamPath` (camera file named after the clip) keeps
the clip's own offset; the continuous-file shift is unchanged and still tested. Regression tests
in `capturePolicy.test.ts` and `recordingImport.test.ts`; rule recorded in product behavior
(Recording model). The affected project was repaired in place from the registry (14 offsets;
backup `proj_234faece….klippt.before-camsync-repair-20260917-165716.bak`). Gates: both
typechecks, biome on changed files, 2,992 vitest tests. Signed package
`.local-install.noindex/camsync-2026-09-17` installed; prior bundle `backup-installed-2026-09-17a`.
Build note: an in-progress Xcode install switched the developer dir, so builds run with
`DEVELOPER_DIR=/Library/Developer/CommandLineTools` until `xcodebuild -license` is accepted.

## September 16 4K camera: format selection, encoder contention, expandable monitor

Olle's OBSBOT Meet 2 at 3840×2160/30 exposed three defects. (1) The device panel's sync-back
effect copied the camera's still-switching active format into the saved preference, so every
quality choice reverted; it now adopts the resolved format only when the saved choice is one the
camera cannot deliver, and `useCameraPreviewStream` publishes supported and active formats in one
render and caches probe results per camera for the session (`probeWebcamFormatsCached`). (2) The
quality dropdown is a Radix Select whose option list portals to `document.body`; the HUD's
window-level pointerdown dismissal closed the panel before the value committed. The select
content now carries `data-klippt-select-content` and the dismiss handler ignores it. (3) The 4K
camera file came out at about 25 fps: Chromium's MediaRecorder H.264 path uses the VideoToolbox
hardware encoder that the ScreenCaptureKit helper is already driving, and Chromium drops frames
when its encoder queue is full. macOS now launches Chromium with
`--disable-accelerated-video-encode` (webcam is the only Chromium-side encoder on macOS); a
real session afterwards recorded seven 4K clips at 30.0 fps, Constrained Baseline. Evidence and
alternatives: [webcam encoder contention](technical-documentation/engineering/webcam-encoder-contention.md).
New: an Expand control in the camera confidence monitor's top-right corner grows the same window
to the largest centred 16:9 surface on its display and asks the relay for a frame sized to the
surface's device pixels (cap 2560×1440, 24 FPS); collapse restores the compact size and position.
Product rule recorded under Camera confidence monitor. Gates: both typechecks, lint on changed
files (an untracked `artifacts/streamdeck-recording-20260916` folder fails the repo-wide format
check and is not part of this work), 2,986 vitest tests. Signed packages
`.local-install.noindex/camera-format-2026-09-16{,b,c}` were installed in sequence; the expand
build `.local-install.noindex/camera-expand-2026-09-16` is packaged and verified but waits for
the open recording session to end before install. Prior bundles are archived beside them as
`backup-installed-2026-09-16*`. Nothing is committed yet.

Notes window overhaul (same day, Olle's brief: minimum space, still does its job): the window
is now frameless and always on top with a dark card at about 78 % opacity over the macOS `hud`
vibrancy material (solid dark body elsewhere), minimum 220×140, frame remembered in user
preferences through `notes-window-bounds-changed` / `notes-window-set-bounds`. The permanent
toolbar is gone: one slim strip holds a drag handle, play/pause, speed, a chevron for font size
and mirror, and Close; formatting moved to a Tiptap `BubbleMenu` on the selection
(`NotesFormattingMenu.tsx`), absent while the note is locked. The strip fades during auto-scroll
and returns on hover. Locale keys `tooltips.notesToolbar.{more,less,close,move}` added in all 13
locales. Product rule recorded as "Notes" under the floating recording panel. Gates: both
typechecks, biome on changed files, i18n check, 2,990 vitest tests. Signed package
`.local-install.noindex/notes-2026-09-16` installed to `/Applications/Klippt.app`; prior bundle
archived as `backup-installed-2026-09-16e`. The expand-monitor build was installed earlier the
same afternoon after Olle ended his recording session.

## September 11 pipelined VideoToolbox decode

- Held-attention click passages (Olle, September 11): click and drag bursts that keep the cursor inside the framed area join one held Zoom. `makeVisualPassages` bridges click/drag intents across up to 6 s when the next intent and every cursor sample between stay within 0.25 (the padded half extent at 1.65×) of the previous intent; the typing stationary bridge is unchanged. The per-minute count is now a safety net at 12 (screen and combined); the 1.5 s quiet gap is the primary limiter. Replay of the Kimi-Vis project copy: the 28.6 s clip with five triple-click bursts went from one 4 s Zoom plus four dropped bursts to one held Zoom 0.84–21.62 s at 1.65×; the 7.2 min clip went from 25 to 36 Zooms. Regression tests: five-burst fixture, drag-ended burst, cursor departure, 7 s gap, budget of 8 in one minute. Gates: 427 timeline tests, both typechecks, lint, i18n; the sandbox-blocked agentBroker, whisperServer and verify-published-release tests pass locally. Signed package `.local-install.noindex/held-attention-20260911` (also carries the background-export UI) was verified in-app: a real 7:42 Kimi-Vis export at 1080p30 H.264 finished to `~/Downloads/Kimi-Vis.mp4` (460 MB) while the dialog showed Cancel export/Close and the background hint; installed to `/Applications/Klippt.app` late on September 11 with the prior bundle archived as `installed-before-20260911-held-attention.app`. Not yet exercised by script: the top-bar progress button screenshot and Cancel export (blocked by the native save sheet under CDP; a manual click shows the sheet normally).

Export on macOS was decode-bound: a 50-minute 1080p30 export took 25.2 minutes, with 76% of the
export thread waiting on one-frame-at-a-time VideoToolbox decode through FFmpeg. The macOS
`Decoder` now drives a direct `VTDecompressionSession` with four frames in flight
(`crates/compositor/src/vt_decode_macos.rs`); the frame contract, walker, preview and encoder are
unchanged. Measured export throughput on the same 20-second slice rose from 77 to 207 fps with
identical PTS and pixel hashes. The [rendering performance record](technical-documentation/engineering/rendering-performance.md)
owns the diagnosis, contracts, and table. Gates: 191 Rust unit tests, the ignored
`mac_decode_bench`, `decoder_seek_eof` in both decoder modes, 2,962 vitest tests. Installed and verified with a real
50-minute export through the CLI (15.1 min at 60 fps versus 25.2 min at 30 fps before). The
encoder handoff now defers the Metal wait one frame (+1.5–3.5%, A/B in the same record); export is
at the hardware decoder's ceiling (~390 source frames/s on the M5). Next export lever is capture
settings, not pipelining. A CDP-driven profile of the installed editor on this
project found no renderer long tasks during scrub or playback and a 288 ms reload; automatic
editing functions all measure under 100 ms; the capture "dropped frames" signal was a telemetry
definition error (idle samples counted as drops) and is fixed in `CaptureTelemetry.swift`.
Details and tables are in the rendering performance record. Signed package with all three
changes: `.local-install.noindex/perf-round2-20260911`, installed to `/Applications/Klippt.app` after the full suite passed (2,962 tests); the prior bundle is archived as `installed-before-20260911-round2.app`.

## September 10 preview quality

The [preview quality note](docs/preview-quality-2026-09-10.md) owns the Sharp/Performance
control, persisted viewing preference, implementation and verification.

## September 10 plain product labels

Removed decorative dot separators throughout product labels and metadata. Review effects is
a plain heading without a redundant count. The [implementation note](docs/no-dot-separators-2026-09-10.md)
owns verification. Preserve this preference in Visual direction.

## September 9 Accessibility and control consistency

The [repair and verification note](docs/permission-and-control-consistency-2026-09-09.md) owns the
stale Accessibility grant diagnosis, real recording proof, signing guard and inspector switch
consistency checks. Preserve Developer ID signing for every installed local app.

## September 8 inspector redesign

Olle found the individual panes still incoherent after the UX pass. The
[inspector redesign log](docs/inspector-redesign-2026-09-08.md) owns the pane-by-pane fix,
rendered checks, limits and local installation. Layout and Audio now separate tasks, caption
correction is compact, and shared rows have consistent density. Final suite: 2,944 passed,
one skipped. This is working-tree development work, not a remote commit or public release.

## September 8 UX laws pass

The [UX verification log](docs/ux-laws-2026-09-08.md) maps all frontend skill law entries to
concrete decisions. It owns the numeric-entry, Radix navigation, compact toolbar, review feedback
and export-completion changes and evidence. Selected inspector tools must not use a tiny edge
border. Full suite: 2,941 passed, one skipped. Preserve the unrelated working-tree changes.

## September 8 automatic review

The Automatic inspector now supports reason-backed effect review, jump/Adjust, Keep/Remove and
bulk review. Regeneration preserves manual work and exact dismissed suggestions. Project-switch
tuning isolation and clip-move exclusion identity have regression coverage. The
[verification log](docs/automatic-review-2026-09-08.md) owns live proof, camera continuity results,
limits and local delivery status. Camera geometry passed the focused audit without another fix.

## September 8 clear editing wins

Caption word correction, named visual presets and bounded long-project agent still previews are
implemented. The [verification log](docs/recordly-clear-wins-2026-09-08.md) owns scope, tests,
Mac UI/native proof, local install and the camera-monitor shadow follow-up. The canonical local
app remains `/Applications/Klippt.app`; existing user project appearance is preserved. This is a
working-tree development checkpoint, not a new release gate result or remote commit.

## September 7 agent editing development checkpoint

The opt-in CLI foundation and editable morning proof are recorded in the
[verification log](docs/agent-cli-implementation-log-2026-09-07.md). Use the
[agent CLI guide](technical-documentation/agent-cli.md) for commands and current limits.
The proof video is `artifacts/agent-proof-2026-09-07/morning-proof.mp4`; its `.klippt` document and
source media are beside it. This development slice does not change the beta/release gates below.

## Product in one paragraph

Klippt is a proprietary, Mac-first recorder and editor for creators. Its core advantage is
clip-native recording: record a section, pause, remove a bad clip, continue, and return to a
polished editable timeline. Screen, camera, microphone, system audio, cursor input, and safe
interaction telemetry remain separate enough for later editing. Automatic direction, pause
shortening, transcripts, layouts, and audio delivery are normal reversible edits. The product must
feel **calm, intelligent, and powerful**.

## Current working state

The core Mac flow works in development and in a locally signed package:

1. Open the idle recording HUD and select a screen or window.
2. Select microphone, system audio, camera, and cursor settings.
3. Record, Pause, Continue, and remove the previous clip.
4. Stop and return to the editor.
5. Split, remove, restore, reorder, and insert clips.
6. Generate or edit ordinary Screen Zoom and Camera Emphasis regions.
7. Shorten pauses, transcribe local audio, and apply optional delivery controls.
8. Export MP4 or GIF through the native compositor and atomic publisher.

This is not yet an outside beta. The beta gate still needs release and long-session proof.

## Work completed in the latest hardening wave

### Export and cache reliability — `17d38ed9`

- Unknown-duration imported media now receives a real duration before MP4 or GIF estimation and
  publication.
- Native export verifies stream structure and duration before publication.
- Export remains atomic: a failed or cancelled export does not replace a good destination file.
- Temporary browser source copies use a bounded OPFS lifecycle instead of accumulating indefinitely.

### Desktop security and release pipeline — `0e4df20a`

- Electron moved from 41 to supported Electron `44.1.0`.
- Packaged renderer and approved local media use the contained `klippt://app` origin.
- `webSecurity` is enabled. A strict CSP, sandboxing, navigation guards, and child-window guards are
  active.
- Privileged IPC uses central sender validation for origin, top-level frame, window role, and
  payload shape.
- Project media uses opaque grants, canonical path checks, range requests, and restricted CORS.
- Production fuses disable unsafe runtime paths and enforce ASAR integrity.
- Release CI notarizes and staples before it creates the update ZIP. It validates the nested app,
  DMG, update metadata, and source identity.

### Signed helper provenance — `c13d5eb5`

- Helper provenance now ignores only Mach-O link-edit metadata that Developer ID signing is known
  to change.
- Executable-code differences still fail the provenance gate.

### Retina preview workload — `5e7bc7e9`

- The editor previously rendered a 1280×720 CSS preview as a 2560×1440 RGBA frame on a Retina
  display. Each frame was about 14.7 MB.
- `computePreviewRect` now gives the offscreen native preview the visible CSS size. Export keeps its
  independent full resolution.
- The renderer still pulls at about 30 FPS and skips unchanged generations.
- A Retina regression proves device-pixel ratio 2 still creates a 1280×720 native preview for a
  1280×720 visible panel.

Before this fix, local telemetry measured Metal readback at about 19.1 ms mean, 42.5 ms p95,
58.8 ms p99, and 151.0 ms maximum. The p95 missed the 33 ms budget for 30 FPS. The machine also had
36.3 GB of swap in use, so system pressure amplified the problem. A fresh post-fix workload report
is still required.

### macOS Screen Recording permission repair

The installed app and several old builds shared the legacy bundle identifier
`com.etiennelescot.openscreen` but had different signatures. LaunchServices and TCC presented one
misleading enabled row while the running app returned `denied`.

The repair removed stale LaunchServices registrations, reset the bundle-specific Screen Recording
grant, and added the exact installed app once. Runtime checks then returned `granted`. The source
selector opened and returned one screen with a thumbnail plus 35 windows. The current signed app is
installed at `/Applications/Klippt.app`. The previous bundle is recoverable at:

`~/Library/Application Support/Klippt/Backups/Klippt-pre-permission-repair.bundle-backup`

The bundle identifier is still legacy. A Dyberg-owned identifier must replace it before public
distribution. That migration will require a new one-time permission grant.

## Fresh verification at the hardening checkpoint

The latest complete hardening gate passed:

- both TypeScript projects;
- repository lint, with one known warning in a large evidence file;
- 250 Vitest files: 2,668 passed and one intentional skip;
- 20 supply-chain files: 118 tests passed;
- all 166 Rust compositor tests;
- seven browser editor and accessibility flows;
- real Electron MP4 and GIF export tests;
- production renderer and Electron builds;
- package signing, hardened runtime, Electron fuses, and ASAR integrity;
- zero reported npm vulnerabilities;
- all 13 locales and documentation checks;
- two independent code reviews with no remaining finding in the reviewed hardening scope.

The preview-size follow-up passed 18 focused tests, scoped Biome, the production renderer/Electron
build, and Developer ID package verification. It has not yet repeated the complete matrix above.

## What is left, in priority order

### 1. Close the preview performance gate

- Use the installed fixed app and judge play, pause, seek, scrub, resize, and long-timeline feel.
- Capture a fresh `klippt-workload-v1` report at the new CSS-size preview configuration.
- Confirm p95 frame delivery is below 33 ms at 30 FPS and that input delay has no visible spikes.
- Do not start a native `CAMetalLayer` preview unless measured copies remain the bottleneck.

### 2. Prove the packaged creator flow

- Run one 30–90 minute packaged recording with screen, microphone, system audio, and camera where
  available.
- Exercise Pause, Continue, remove-to-zero, Stop, reopen, edits, transcript, pause shortening, and
  final export.
- Test capture failure, device loss, low disk space, sleep/wake, crash recovery, and relaunch.
- Confirm the final MP4 decodes, stays in sync, and can be uploaded without repair.

### 3. Finish the release path

- Create an authorized fresh notarized and stapled artifact from the current source.
- Move Apple and R2 credentials into the GitHub `release` environment after the hardened workflow
  reaches the release branch.
- Publish immutable update artifacts and the first feed manifests.
- Prove a quarantined version N to N+1 update with signature, bundle, hash, and rollback checks.
- Arrange a clean or second-Mac install test. If Olle has no spare Mac, use an outside tester with a
  clean user account and capture the same evidence.

### 4. Freeze product identity

- Select and freeze a Dyberg-owned bundle identifier. `app.klippt.desktop` is the current candidate.
- Migrate user data, TCC permissions, Keychain state, update identity, file associations, recent
  projects, and recovery journals without deleting the legacy data.
- Remove remaining visible OpenScreen identity from shipped metadata and end-user surfaces.
- Keep the upstream MIT notice and all generated third-party notices.

### 5. Finish the paid-beta surface

- Configure real Lemon Squeezy store, product, variant, checkout, webhook, and licence identifiers.
- Test purchase, activation, offline grace, cancellation, restore, and read-only expiry behavior.
- Publish the one-page `klippt.app` site with privacy, terms/EULA, refund, support, company details,
  consent, and unsubscribe behavior.
- Keep commercial enforcement disabled until the full real checkout path passes.

### 6. Validate creator-quality features

- Add consented Swedish, English, technical-term, code-switching, and long-session fixtures to the
  creator corpus.
- Tune automatic direction only from labelled corrections. Do not add another detector by default.
- Validate decoded AAC loudness, true peak, duration, priming, tail, and discontinuities.
- Keep Clean Voice optional and out of paid packages until model redistribution rights and the
  labelled audio-quality gate pass.
- Build editable 16:9, 9:16, and 1:1 delivery variants from one project. Include a flexible vertical
  split with screen/camera order, proportions, and direct screen framing.

### 7. Continue differentiation after beta trust is proven

- Complete the shared typed command service for UI, CLI, and agent parity.
- Add named creator presets.
- Add custom vocabulary and safe text-based editing.
- Add fast media insertion with automatic motion and transitions.
- Evaluate native AVFoundation camera capture, ProRes/source bundles, and automatic vertical
  reframing behind measured gates.

## Known risks and constraints

- The current bundle identifier can make TCC state ambiguous when several differently signed builds
  exist. Keep only the intended app registered during tests.
- The current installed package is Developer ID signed but is not the final notarized beta artifact.
- Large source recordings and browser source caches can consume many gigabytes. Keep recovery first;
  clean disposable caches, not source media.
- The creator corpus manifest exists but contains no approved private media by default. Unit tests do
  not replace real long-session evidence.
- The automatic direction engine is deliberately deterministic. Add policy values and labelled
  examples before adding branches for individual timestamps.
- Do not let optional transcription, cleanup, or analysis block Record, Pause, Continue, Stop,
  project opening, or basic editing.
- Do not use TestSprite.

## Architecture map

| Area | Current owner |
| --- | --- |
| Product behavior and language | [`AGENTS.md`](AGENTS.md) |
| Delivery sequence and commercial gates | [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) |
| Detailed research-backed task ledger | [`docs/cutting-edge-execution-plan.md`](docs/cutting-edge-execution-plan.md) |
| Current process map | [`technical-documentation/architecture/overview.md`](technical-documentation/architecture/overview.md) |
| Project document and migrations | [`technical-documentation/architecture/document-model.md`](technical-documentation/architecture/document-model.md) |
| Capture and HUD | [`technical-documentation/architecture/recording.md`](technical-documentation/architecture/recording.md) |
| Preview | [`technical-documentation/architecture/preview.md`](technical-documentation/architecture/preview.md) |
| Export | [`technical-documentation/architecture/export-pipeline.md`](technical-documentation/architecture/export-pipeline.md) |
| Renderer/main security boundary | [`technical-documentation/architecture/native-bridge.md`](technical-documentation/architecture/native-bridge.md) |
| Packaging and release | [`technical-documentation/engineering/build-and-packaging.md`](technical-documentation/engineering/build-and-packaging.md) and [`release-and-secrets.md`](technical-documentation/engineering/release-and-secrets.md) |
| Performance evidence | [`technical-documentation/engineering/rendering-performance.md`](technical-documentation/engineering/rendering-performance.md) and [`workload-telemetry.md`](technical-documentation/engineering/workload-telemetry.md) |
| Manual release proof | [`technical-documentation/testing/manual-e2e-checklist.md`](technical-documentation/testing/manual-e2e-checklist.md) |
| UI system | [`design/DESIGN.md`](design/DESIGN.md) and [`docs/ui-system-audit-2026-08-30.md`](docs/ui-system-audit-2026-08-30.md) |

## Documentation status

- This handoff pass audited all 71 tracked or pending Markdown paths in the repository. It updated
  the files whose product state, architecture, release state, or agent guidance had changed.
  Accurate specialist references were left intact. `THIRD-PARTY-NOTICES.md` and the vendored
  PipeWire README remain upstream/legal records and were not rewritten.
- `AGENTS.md`, `PRODUCT_PLAN.md`, `HANDOFF.md`, `design/DESIGN.md`, and
  `technical-documentation/` are current sources.
- `docs/ui-system-audit-2026-08-30.md`, the STT POC report, and older benchmark sections are dated
  evidence. They do not override current code or this handoff.
- `ROADMAP.md` is the inherited OpenScreen roadmap and is historical only.
- `website/docs/` is the inherited OpenScreen Docusaurus content. Its pages are marked as drafts so
  they cannot be mistaken for the planned original `klippt.app` beta site.
- `openscreen-*` helper, environment-variable, rein, and internal schema names remain where changing
  them would break compatibility. A legacy internal identifier is not current product branding.

## Normal commands

Use the pinned Node `22.22.1` and npm `10.9.4`. Use npm only.

```bash
npm install
npm run dev
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npx vitest --run path/to/test.ts
npm run test
npm run lint
npm run i18n:check
npm run docs:check
npm run build:native:mac
npm run build-vite
```

The normal Vite/Electron build does not prove that the native helper is current. Rebuild and stage
the native Mac helpers before a package or real capture check.

## Performance implementation — 2026-09-05

The [audit](docs/performance-audit-2026-09-04.md) was followed by an authorized
[implementation and verification pass](docs/performance-implementation-2026-09-05.md).
The performance commit builds on `8635cda9`; the older committed checkpoint above
remains historical. Export audio and decoder memory are bounded, preview presentation is
serialized and rate-limited, auxiliary windows load less JavaScript, history shares immutable
data, caches have retention rules, and confirmed retired code/dependencies were removed.
Packaging fixtures and CI setup were simplified without dropping the release gates.

The implementation note records unit/build/type/lint results, independent review, a real
60-second 2560 × 1440 capture/export, GUI clip editing, and measured 5/30-minute and 500-source
native memory probes. Test typecheck now passes. Real GUI testing also exposed an existing
terminal-seek defect and legacy opening defects. The rebuilt GUI verifies the fixes;
the implementation note records the final runtime evidence and review.

## Next recommended slice

Agent CLI planning update, 2026-09-07: Olle selected normal Codex through the CLI and deferred
local models and the learned ranker. The [agent CLI foundation plan](docs/agent-cli-implementation-plan-2026-09-07.md)
defines research corrections, command contracts, shared ownership, visual readback, staged delivery,
and verification. Implementation is now authorized and active. Continue from the
[overnight implementation log](docs/agent-cli-implementation-log-2026-09-07.md), including the
expanded media-folder workflow and morning proof edit. The committed checkpoint and release
gates below remain unchanged until new verification is recorded.

Finish W5.1 without adding new architecture:

1. Run the fixed installed app through play, seek, scrub, and resize on the long project.
2. Save a fresh workload report.
3. Compare the new frame-delivery percentiles with the pre-fix numbers in this handoff.
4. If the target passes, mark W5.1 complete and move to the packaged 30–90 minute flow.
5. If it fails, profile the remaining readback, IPC, or main-thread stage before changing code.

## External references used for the latest decisions

- [Electron performance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron `systemPreferences`](https://www.electronjs.org/docs/latest/api/system-preferences)
- [Apple ScreenCaptureKit capture guidance](https://developer.apple.com/documentation/screencapturekit/capturing-screen-content-in-macos)
- [Apple Metal resource synchronization](https://developer.apple.com/documentation/metal/resource-synchronization)


### Camera shape follow-up — 2026-09-07

Added native squircle camera, separate 0–50% corner slider, persisted/CLI-accessible rounding,
and explicit Video Effects labels with visible descriptions in all locales. The open morning
proof uses squircle at 40% rounding. New artifact `artifacts/agent-proof-2026-09-07/squircle.mp4`
and editable `proof-squircle.klippt` preserve earlier examples. Full suite (2,856 passing), types,
Vite build, native geometry/GPU tests, Mac addon, real editor and export checks passed; review
correction for block-layout mask resolution confirmed. See the Sept 7 implementation log for
exact evidence and platform/packaging limits. Changes remain in the existing dirty worktree.


Camera clarification: squircle is now a corner style on source-proportioned rectangular frames.
The separate camera aspect control supports source/1:1/4:3/16:9/9:16. The managed proof is saved
as16:9 with40%corners. Latest example: `artifacts/agent-proof-2026-09-07/squircle-rectangle.mp4`.
Fullsuite2,860passed; native33geometrytests, build, MacUI, export and independentreview passed.


### Visual quality research — 2026-09-07

Olle rejected the capability proof as a visual-quality reference. Canonical research is in the
vault: `Agent/03 - Research/2026-09-07 Giving Klippt a coherent premium visual and motion system.md`.
Interactive browser study: `artifacts/premium-design-study-2026-09-07/index.html`.
It is a design reference, not a native export or implemented style system. Research identifies
native font registration/identity and coordinated entrance-hold-exit timing as quality gaps.
See the synthesis for the three curated formats, licenses, proposed values and proof requirements.
