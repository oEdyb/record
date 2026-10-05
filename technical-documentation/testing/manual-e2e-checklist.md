# Manual end-to-end checklist

> **Current beta gate:** Start with [`../../HANDOFF.md`](../../HANDOFF.md). The current package must
> complete the 30–90 minute creator flow, a post-Retina-fix preview workload run, a fresh notarized
> install, and a quarantined N-to-N+1 update before outside beta.

This checklist covers the real desktop capture-to-export path: the parts that unit, browser, and Playwright tests cannot exercise, including real screen capture, a physical webcam, the system tray, the native compositor, and export. Run it before promoting a release candidate and after any change to native capture, preview, or export.

The editor, transcription, caption generation, and in-app chat were archived on 2026-10-05 (tag `archive/pre-cleanup-2026-10-05`); their checks were removed from this file. The review window is the only shell. Existing projects still open and render their stored zooms, captions, annotations, B-roll, and trims, so the compositor and export sections keep those checks.

## How to run this

1. Drive the real Electron app with computer-use — real OS mouse and keyboard events. Start a dev build with `npm run dev`, or launch the packaged build under test.

   "Manual" here usually means an agent holding the mouse, so the tempting shortcut is not a browser shim: it is driving the real app through CDP instead. **Do not.** Playwright's `.click()`, `javascript_tool`-dispatched pointer events and anything else synthesised into the renderer arrive *below* the OS hit-test. On Windows and macOS the HUD is input-transparent until a real cursor move lifts it, so an injected click fires the DOM handler and comes back green while the path a user actually takes was never exercised at all.

   That trap is specific to the HUD and the countdown overlay — they are the only click-through windows; the editor is an ordinary one, and an injected click there does reach the handler a user would reach. The reason not to inject in the editor either is the first line of this file: this checklist covers what unit, browser and **Playwright** tests cannot. Drive it the way those tests already drive it and you have re-run the coverage you had, then written "passed" beside the parts nothing checked.
2. The app is single-instance per `userData` path. If a leftover Electron/OpenScreen process still holds the lock, stop that process before relaunching; a second launch can exit successfully without opening a window. The lock is held by the OS and is released when the process dies, so there is nothing to delete on disk.
3. From a worktree, link or junction `node_modules` to the main checkout and provide the prebuilt native capture binaries for the platform before starting the dev build. **Date those binaries against the change you came to test.** Nothing rebuilds them, so an older helper runs the old code path in silence: the recording succeeds and the thing you were checking for is simply absent. See AGENTS.md for how to check one and how to rebuild it; when you cannot, test the CI-built artifact, because a dev build cannot answer a native question.
4. Grant computer-use access to the process name that actually owns the window: `electron.exe` or `Electron.app` for a dev build, and `Klippt.exe` or `Klippt.app` for the current package. Do not grant access only to the installed app name when testing a dev build — it resolves to the *installed* executable and reports success while the dev window stays masked. This is step 4 and not step 1 for a reason: a dev build is not an installed app, so the resolver cannot find it until it is running and owns a window, and one unresolvable name voids the whole request.

   **Ask for everything in ONE call — after the launches above, before the first check.** `request_access` takes a list, and once a grant is in place the rest of the pass runs without a single further prompt: a full capture-to-export run is dozens of clicks and none of them ask again. So the only thing keeping a human at the keyboard is *how many* dialogs you raise and *when*. Raise one, before the first check, and the operator can walk away for the rest of the run; discover a fourth app you need an hour in and they cannot. That is also why this cannot move earlier — the resolver needs the app running, and one unresolvable name voids the batch. Beyond the app under test, ask for:

   - the desktop shell — the tray icon and the native save dialogs live there, and the tray is the only reliable way back to the HUD;
   - the OS settings app — needed to change display scaling, which is how DPI checks are run (see AGENTS.md; "the machine is at 100%" is not a reason to skip them).

   **Name them the way the Start menu does, in the system's own language.** The resolver matches installed-app display names, not executables: on a French Windows the shell is `Explorateur de fichiers` and `explorer.exe` fails outright — `notInstalled`, with a nonsense suggestion attached — which then voids every other name in the same call. On an English install it is `File Explorer`. When unsure, ask rather than guess; the tool lists the installed names it knows.

   There is no way to pre-approve any of this in config: the request has to be answered live. That is upstream ([claude-code#46907](https://github.com/anthropics/claude-code/issues/46907), closed stale), and `bypassPermissions` does not cover it either ([#43172](https://github.com/anthropics/claude-code/issues/43172)). Batching is the whole mitigation.
5. Read [AGENTS.md](../../AGENTS.md) for the computer-use mechanics, screenshot permissions, tray interaction, and cleanup procedure. Read one check, perform it, observe the result, then continue; close each modal or popover with `Esc` before the next check.
6. The recording HUD is protected from capture by default and is invisible in screenshots. For this session only, launch with `OPENSCREEN_DISABLE_CONTENT_PROTECTION=1`; this is the environment variable checked before `setContentProtection(true)`. Unset it before making any recording whose HUD must not appear in the video.
7. A preview screenshot is downscaled. Settle every pixel-level question by exporting a frame and measuring the exported frame, not by judging fine edges, corners, shadows, or alignment from the preview screenshot.
8. Keep the first real recording or imported project available for the review and export sections. Log crashes, hangs, data loss, security issues, and reproducible visual failures as soon as they occur.
9. The compositor and export sections need a built native compositor addon. A dev build from a worktree needs the compositor addon installed for its platform, not only the capture binaries. When a prerequisite is missing, record the section as skipped with the reason; do not mark it passed.
10. Keep one project saved by an earlier release, with zooms, captions, annotations, and trims, for the compositor and persistence checks.

## Launch and HUD

- [ ] Start the app and confirm one launch window appears without a startup crash.
- [ ] Confirm the launch window remains usable after the first device enumeration completes.
- [ ] Confirm the HUD is visible when content protection is disabled for the test session.
- [ ] Activate `[data-testid="launch-tray-layout-button"]` and confirm the tray changes between horizontal and vertical layouts.
- [ ] Confirm the chosen tray layout remains coherent when the HUD grows to show recording controls.
- [ ] Activate `[data-testid="hud-drag-handle"]`, drag the HUD across most of the primary display, and confirm it follows the pointer without drift.
- [ ] Release the drag and confirm the HUD stays at the dropped position instead of jumping.
- [ ] Activate the language button by its visible language code and confirm a menu of locale choices opens.
- [ ] Press `Esc` with the language menu open and confirm it closes without changing the locale.
- [ ] Activate the minimize control and confirm the HUD hides without quitting the app.
- [ ] Refocus the app from its system-tray icon and confirm the HUD returns to the foreground.
- [ ] Activate the close control while idle and confirm the HUD closes cleanly.
- [ ] Relaunch the app after closing it and confirm the single-instance behavior does not leave a duplicate HUD.

## Source selection and recording

- [ ] Activate `[data-testid="launch-source-selector-button"]` and confirm the source selector opens.
- [ ] Select a screen or application card with `data-testid="source-selector-card"`, activate `[data-testid="source-selector-share-button"]`, and confirm the selector closes with the source name on the HUD.
- [ ] Confirm `[data-testid="launch-record-button"]` is disabled until a source is selected, then activate it and confirm recording starts with a red stop state and an increasing elapsed timer.
- [ ] Confirm the configured system-audio, microphone, webcam, and cursor states remain visible while recording.
- [ ] Activate the recording control's pause action and confirm the timer stops advancing, then resume and confirm it advances again.
- [ ] Activate the restart action while recording and confirm the current recording is discarded and a fresh recording begins.
- [ ] Activate the cancel action while recording and confirm recording ends without opening an editor for the canceled take.
- [ ] Confirm stopping opens the review window with the recorded screen asset loaded.
- [ ] On Windows, stop once with system audio, microphone, webcam, and cursor all disabled and confirm the editor opens within a few seconds.
- [ ] Record once with microphone only and confirm the resulting playback contains audible microphone audio.
- [ ] Record once with system audio only and confirm the resulting playback contains audible system audio.
- [ ] Record with microphone and system audio enabled and confirm both sources are audible and reasonably balanced.

## Review window opens and loads the project

- [ ] Confirm the review window opens after a successful stop with the recorded asset.
- [ ] Confirm `[data-testid="preview"]` is present and its current-time value starts at the beginning of the project.
- [ ] Confirm the loaded video is visible in the preview rather than an empty state or broken-video state.
- [ ] Confirm the toolbar offers Record, Add clip, Recordings, and Save video, and that Save video is enabled once the recording is ready.

## Transport and preview

- [ ] Activate the playback control with the `aria-label` for play/pause and confirm `[data-testid="preview"]` changes `data-is-playing` from `false` to `true`.
- [ ] Activate play/pause again and confirm playback stops and the preview reports `data-is-playing="false"`.
- [ ] Confirm the transport time readout advances while playback is running.
- [ ] Confirm the playhead advances with the video instead of remaining at its starting position.
- [ ] Drag the transport seek range control with the `aria-label` for seeking and confirm `[data-testid="preview"]` reports the new current time.
- [ ] Seek while paused and confirm the preview frame changes to the selected time.
- [ ] Seek while playing and confirm playback continues from the new time without a visible stuck frame.
- [ ] With a webcam recording, confirm the webcam picture-in-picture appears aligned with the screen content.
- [ ] Confirm the preview's webcam, cursor, background, and region effects remain synchronized while scrubbing.

## Native compositor preview and export — v1.8.0

- [ ] Confirm `[data-testid="native-compositor-mount"]` shows a live composited preview rather than an empty surface.
- [ ] Confirm `[data-testid="native-compositor-error"]` is absent during a normal run.
- [ ] Scrub back and forth across a clip boundary several times and confirm the preview keeps up without a stall on each crossing.
- [ ] Seek to the very end of the project and confirm the last frame is shown instead of a blank or stuck frame.
- [ ] Confirm no loading overlay remains on top of an already valid preview frame.
- [ ] On a machine with no compatible GPU, confirm `[data-testid="native-compositor-cpu-notice"]` appears, the export dialog shows its CPU warning, and the export still completes.
- [ ] Export the same project on macOS and on Windows and compare frames at identical timestamps for background, blur, shadow, roundness, padding, cursor, and text.
- [ ] On macOS, export an MP4 from a project with audio and confirm the output has audio.
- [ ] On macOS, export a frame containing a text annotation and confirm the text is upright, centred in its box, and that its background plate fits the text.
- [ ] On macOS, export a frame containing a blur annotation and confirm the area is actually obscured.
- [ ] On macOS, export a range with the cursor visible and confirm the cursor and its trail are rendered.
- [ ] On macOS, export frames with each 3D rotation preset and confirm the tilt matches the Windows render.
- [ ] On macOS, export a frame with background blur enabled and confirm it matches the Windows render.
- [ ] Export a range containing a zoom with an annotation and captions on screen, and confirm neither follows the zoom in the exported frames.
- [ ] Confirm the packaged macOS app refuses to start or reports clearly when the compositor addon is missing, rather than failing at first render.

## Export

- [ ] Confirm the toolbar Save video control is disabled when the project has no asset.
- [ ] With a loaded project, activate Save video and confirm the save dialog opens with Separate takes selected by default.
- [ ] Choose One video and confirm the dialog offers MP4 and GIF format choices.
- [ ] Select MP4 and confirm quality choices include a lower tier, a balanced tier, and Source.
- [ ] Select each available MP4 quality and confirm the displayed output dimensions update.
- [ ] Select 24, 30, and 60 FPS and confirm the selected frame rate remains visible.
- [ ] Select H.264 and H.265 and confirm the selected codec remains visible.
- [ ] Select GIF and confirm GIF frame-rate, size, and loop controls appear.
- [ ] Change GIF frame rate and size, toggle looping, and confirm the summary reflects the choices.
- [ ] Start an MP4 export and confirm the native rendering progress reports advancing frames or percentage.
- [ ] Confirm the export dialog reports a saved output path after MP4 completes.
- [ ] Open the exported MP4 outside the app and confirm it plays through the expected duration with audio when the source has audio.
- [ ] Start a GIF export and confirm frame rendering and file writing complete without an unhandled error.
- [ ] Open the exported GIF outside the app and confirm it contains the expected motion and loop behavior.
- [ ] Export a GIF from colour-rich footage long enough to exhaust the encoder's first code widths, and confirm no frame degrades into corrupted stripes or shifted colours partway through.
- [ ] Open that GIF in a second viewer and confirm both decoders agree, since a code-width defect can decode differently per viewer.
- [ ] Export a project containing audio, a trim, a speed region, a zoom, an annotation, captions, and webcam layout changes when available.
- [ ] Compare that exported result with the preview for timing, skipped intervals, audio, webcam, captions, and effects.
- [ ] For every pixel-level comparison, export a frame and measure it with an image tool rather than relying on a preview screenshot.

## Settings, shortcuts, themes, i18n

- [ ] Open Settings from the review toolbar's More menu and confirm the shortcuts configuration dialog opens.
- [ ] Change one shortcut, save it, use the new key in the review window, and confirm it triggers the configured action.
- [ ] Confirm `Ctrl/Cmd+S` opens the save dialog.
- [ ] Choose a non-English locale from the HUD language menu and confirm the review window's labels change, then switch back to English.
- [ ] Press `Esc` or click outside an open menu, popover, or dialog and confirm it closes.

## Persistence (save, reopen, reload)

- [ ] Record two clips, remove one, and confirm the project is saved after each committed clip and removal without a save prompt.
- [ ] Reopen the project from Recordings and confirm the asset, clip order, and each clip's in/out survive reopen.
- [ ] Confirm the seekable duration after reopen reaches the recording duration, not merely the end of the last region.
- [ ] Open a project saved by a previous release and confirm it loads without a schema error.
- [ ] Confirm that project's stored trims, zooms, annotations, captions, and full-camera regions render in the preview on the clip content they covered before.
- [ ] Reopen it a second time and confirm nothing shifted on the round-trip.

## Platform-specific

### Windows

- [ ] Run the complete capture-to-export flow on real Windows with the packaged build.
- [ ] Confirm a screen source and a single-window source both produce non-black video.
- [ ] Confirm the system tray icon appears and changes to a recording state while recording.
- [ ] Right-click the tray icon while recording, choose Stop Recording, and confirm the editor opens.
- [ ] Confirm the HUD and notes window are excluded from captured video when content protection is enabled.
- [ ] Disable hardware H.264 if the test machine supports that diagnostic path and confirm the software-encoder notice is clear and non-blocking.
- [ ] Switch the recording HUD between displays and confirm it remains positioned on the intended display.
- [ ] Switch the desktop to an odd-pixel window size and confirm the recorded frame dimensions remain valid.
- [ ] Open Settings diagnostics when available and confirm a diagnostic bundle can be written.

### macOS

- [ ] Run the complete capture-to-export flow on real macOS with the packaged build.
- [ ] Grant screen-recording, microphone, and camera permissions and confirm the app reflects the granted devices.
- [ ] Record while switching Spaces with the HUD visible and confirm recording continues.
- [ ] Stop a recording and confirm the editor opens without a crash during native recorder shutdown.
- [ ] Confirm the tray or menu-bar item can refocus the HUD after it is hidden.
- [ ] Confirm the HUD and notes window are excluded from captured video when content protection is enabled.
- [ ] Confirm a physical webcam picture-in-picture records and plays back with the selected layout.
- [ ] Export MP4 and GIF and confirm both files open in a native macOS media viewer.
- [ ] Confirm closing and relaunching the packaged app does not leave an orphaned capture or editor window.
- [ ] On the newest supported macOS, confirm the HUD and notes windows are visible on screen rather than blanked by content protection.
- [ ] Confirm the HUD opens without waiting for the microphone permission prompt to be answered.
- [ ] Confirm the packaged `.app` contains the compositor addon and that the addon carries no build-machine path.
- [ ] Confirm the packaged `.app` bundles its ffmpeg libraries and runs on a machine with no developer toolchain installed.

### Linux

- [ ] Run the complete record-to-export flow on real Linux with the supported packaged or development build.
- [ ] Confirm the HUD remains interactive on the supported Linux window manager.
- [ ] Select a screen source in the compositor's portal picker and confirm the resulting recording is not black.
- [ ] **Select a single WINDOW in the portal picker and confirm the recording contains only that window, at the window's dimensions — not the whole screen.** Check the pixel size, not just the look of it: `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 <file>` should report the window's size, never the monitor's. This is the case that shipped broken in 1.8.0.
- [ ] Record twice in a row and confirm the portal picker appears BOTH times, and that choosing a different source the second time actually changes what is recorded.
- [ ] Confirm the HUD shows no in-app source button on Linux, and that the record button starts a recording directly instead of opening a picker.
- [ ] Confirm the portal picker appears BEFORE the 3-2-1 countdown, not during or after it.
- [ ] Start the same flow from the review window's Record control and confirm it behaves identically to the HUD — no source row, picker first, then countdown.
- [ ] Cancel the countdown after answering the picker and confirm the compositor's "screen is being shared" indicator goes away rather than lingering.
- [ ] Confirm the system tray or supported desktop indicator can refocus the HUD when it is hidden.
- [ ] Confirm microphone capture works with a physical device and the chosen device is audible in playback.
- [ ] Confirm the webcam toggle reflects the available physical camera or clearly reports that no camera is available.
- [ ] Confirm the native compositor preview loads without a blank surface or renderer crash.
- [ ] Export MP4 and GIF and confirm the files open in a system media player.
- [ ] Close and relaunch the app and confirm a saved project can be reopened without data loss.

## Results log

| Date | Build / tag | Platform | Pass/fail | Notes |
|------|-------------|----------|-----------|-------|
| 2026-07-31 | dev build, `claude/e2e-tests-v1-8-0-474894` (e9578f09) | macOS 26.5, M1 | Partial — 1 defect | Ran launch/HUD, media, modifier anchoring, and export. **Defect: a dangling asset blanks the preview.** Modifier anchoring across a reorder verified in preview and in the exported frames. macOS export produced 1280×720 h264 + AAC at ~2× realtime. Chat sections skipped: no AI provider configured. HUD drag not runnable under computer-use (drop point is the desktop). |
| 2026-08-13 | installed `v1.9.5-rc.1` | Windows 11 26200, 1920×1080 @ 100% | Partial — 1 defect | Ran launch/HUD, source selection, recording, stop, editor open. Fragmented MP4 confirmed on the shipped artifact: 48 `moof`+`mdat` pairs over 47.6s, `mvex` present, `mfra` on clean stop. **Defect: a recording that survives a helper kill is thrown away by the app** — killing `wgc-capture.exe` mid-recording leaves a fully decodable 41s file (2460 packets, `ffmpeg -f null -` exit 0) with no `.session.json` and no `.cursor.json`, and stop answers "The recording could not be saved". Fixed in #363, re-verified end to end. Truncation ablation at 60%: plain MP4 unreadable, fragmented plays 29s. **A dev build cannot test any of this** — the prebuilt worktree helper predated the change and silently ran the old path. Editor/export/chat sections not run. |
| 2026-08-14 | `release/v1.9.5` @ `b1b81de5` (rc.2 candidate: dev TS + the CI-built rc.1 native payload, which is byte-identical since no native source changed) | Windows 11 26200, 1920×1080 @ 100% | Pass — no defect | Regression net across the 65 commits since **v1.9.2**, not just the rc.2 delta. Four recordings. Every one a fragmented MP4 (`mvex` + ~1 `moof`/s, `mfra` only on a clean stop). GPU DXGI path still correctly opt-in (`videoInput: cpu-rgb32`) — the #336 regression has not crept back. No capture-pacing drift: HUD `00:59` → 60.067s at 60/1. Waveform correct in both directions: absent with no audio track, rendered with one. Audio muxes into the fragmented container (AAC 48k stereo) with 15 ms A/V drift, under one frame. Compositor renders and exports with no camera declared. **#366**: reopening returns to the saved project with its settings (Blur BG on, padding 9%) and mints no second project — 167→168 across a whole new recording. **#363**: helper killed mid-recording → editor opens on the recovered take (46 `moof`, no `mfra`), all three sidecars written, imported once. Export MP4 1080p60 **from that recovered take**: 46.0s / 2760 packets, decodes clean, duration matches the source exactly. Tray refocus works. NOT covered: DPI scaling — **not re-run here, already validated when `60bb6d7c` / `71cc88d6` landed**; note that the display scale is a setting, so "this machine is at 100%" is never a reason a DPI bug cannot be tested (flip it to 150%, ~2 min). Also not covered: webcam PiP and the export webcam fixes, microphone, GIF, macOS/Linux, AI sections, packaging. |
| 2026-08-14 | installed `v1.9.5-rc.1`, macOS Apple Silicon DMG (CI-built, Developer ID signed). **rc.2 is not published** — only rc.1 exists on Releases; no native source changed between `v1.9.5-rc.1` and `origin/release/v1.9.5`, so this artifact already carries the rc.2 native payload, but #366 (cross-platform TS) is absent from it | macOS 26.5 (25F71), M1, 1920×1080 @ 2× | **Fail — 1 blocker** | **The plan's assertion-1 criterion does not hold on macOS, in both directions.** On a clean stop `AVAssetWriter.finishWriting()` collapses the fragments into a normal movie: `ftyp mdat moov`, `mvex` ABSENT, 0 `moof`, no `mfra` (45 s / 44.4 MB run). That is exactly the shape the plan calls the headline failure — and the pre-`a6795d23` control recording (2026-08-10) has the *same* shape — so **a clean-stop box walk cannot distinguish fragmented from plain on macOS; only the kill test can.** Fragmenting *is* active: the takes whose writer died mid-fragment retain `mvex` + ~1 `moof` per second of media (shipped-build writer-failure samples: 35 `moof`/36.0 s, 14/15.0 s, 3/4.0 s; plus 18 on a surviving-helper kill). The one kill on the shipped build is the exception that proves the scope — capture had already stalled ~12 s before the kill, so it carries `mvex` but **0 `moof`** and only 1.0 s. No macOS file, clean or killed, ever carried `mfra`. **Blocker: every app-driven recording truncates, then the app discards it.** (Root cause and fix reported in #375 — the fragments carry a negative composition offset in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines the field as unsigned, because frame reordering was left on; `AVVideoAllowFrameReorderingKey: false` clears it and restores the crash-resilience the fragmenting was for. Verified at helper level there; **this rc.1 run only reproduced the failure and validated nothing about the fix**. Re-run this section against a CI build carrying #375 before rc.2 ships.) 3/3 takes stopped writing early while the HUD kept counting — media 4.0 s / 36.0 s / 15.0 s against HUD `02:02` / `01:30` / `01:04`. Helper emits `{"event":"error","code":"writer-failed"}`; main log `AVFoundationErrorDomain Code=-11800 … (-16341)`. Stop then hangs ~30 s on "Saving…" and drops the take: no `.session.json`, no `.cursor.json`, no editor. The app *does* surface the raw error in a toast (confirmed by hand on the same machine at 13:28–13:35 — my automated runs screenshotted after it auto-dismissed, so an earlier draft of this row wrongly said there was none). 44,561,966 / 328,337,979 / 139,631,607 / 17,187,009 bytes decodable and thrown away (147 GB free — not disk). Reproduced standalone with the shipped helper at 1080p30/8 Mbps, 2/2 (~9 s, ~5 s), so it is not confined to the app's 4K60 path — but do not read that as load-independent: append rate demonstrably modulates how reliably it bites (#375 measures it reliable at ~57 fps and intermittent at 30 fps). **Reproduced by hand, no automation involved**, on six takes recording a YouTube page — and those six separate the trigger cleanly: **system audio ON → 3/3 died at ~1.0 s and minted 0 projects; system audio OFF → 3/3 survived (3.3 s, 7.4 s, 25.0 s) and minted 1 project each.** **Audio is not the condition, only an accelerant** — a controlled run with system audio off *and not one screenshot taken during the capture* (the screenshot layer hides non-allowlisted windows, so it was the last confound worth eliminating) died the same way: 8.008 s of video, 79,004,330 bytes then flat for 76 s with the helper still alive, 7 `moof`, 0 sidecars, 0 projects, same `-11800`/`-16341`. What audio changes is the window: with a track it is ~1 s, without one ~4–40 s. That reconciles the by-hand takes with mine — a take short enough to stop before the writer dies is clean, which is why 3.3 s and 7.4 s survived and 8.0 s did not, and why the 25.0 s one minted a project while still carrying `mvex` (never cleanly finalised). **Turning audio off is therefore not a safe workaround.** Untested here: microphone — this Mac has no input device, and whether a mic track triggers the same path is an inference, not a measurement. **Helper A/B narrows the with-audio path to the fragmentation line**: helper built twice from source identical to the rc.1 tag, differing only by `writer.movieFragmentInterval` (701 vs 700 lines) — with system audio at 1080p30, WITH the line `writer-failed` 2/2 (2.0 s, 1.0 s), WITHOUT it clean `recording-stopped` 3/3 (40.6 s, 37.9 s, 37.6 s). **Read those counts as a sample, not a law**: a later rebuild of the with-the-line arm survived 22.2 s at the same settings, so the failure is probabilistic and rate-dependent, and the byte-level evidence in #375 is what actually carries the case. The video-only local-vs-shipped gap (local survived 45 s, shipped failed 5/5) is explained by the same variable rather than by the released artifact — the shipped runs encoded at 56.6 fps against 29 fps locally. **Kill test** is confounded on the shipped build (capture already dead before the kill): 17.19 MB → only 1.0 s / 56 packets, 0 `moof`. On a helper that does not fail, a mid-write kill leaves 18 `moof`, decodes clean (`ffmpeg -v error -f null -` exit 0, 1373 packets) and no `mfra` — the shape the plan expects. **#363 gap confirmed, and on macOS it fires with no kill at all**: `writer-failed` alone loses the take; there is no app-side recovery. **Audio**: AAC 48 kHz stereo muxes into the fragmented container, video start `0.000000` vs audio `0.014479` → 14.5 ms drift, under one frame at 30 fps (measured on the 2.0 s written before the writer died). **Compositor + export pass**: preview renders with no camera declared; export MP4 1080p60 H.264+AAC via `h264_videotoolbox (zero-copy VT)`, 5,726,865 bytes, 318 packets, decodes clean, duration matches to within 7 ms — source 26.713 s minus trims 19.910 + 1.513 = 5.290 s expected vs 5.283 s measured, under one frame at 60 fps. **#366 not runnable as specified** (absent from rc.1, rc.2 unpublished, and record→editor never completes); adjacent behaviour measured on an existing project — close+reopen kept 19→19 projects, exactly ONE project references the recording, and Blur BG / padding survived (`showBlur=true`, `padding=16`). NOT covered: Windows-only DPI and wgc-capture, GIF, AI sections, packaging (per plan); webcam PiP and microphone — this Mac has neither (Device settings reports "No microphone found" / "No camera found"). |
|      |             |          |           |       |
|      |             |          |           |       |
