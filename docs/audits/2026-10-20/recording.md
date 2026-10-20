# Recording path audit (macOS), October 20, 2026

Read-only audit of the Swift capture helper (`electron/native/screencapturekit`), the main-process
service and helper client (`electron/recording`), the recovery journal, and the HUD state in
`src/hooks/useScreenRecorder.ts`. Nothing was built, launched or edited.

Evidence used:
- The source at `main` `44cb0ee6`.
- The macOS SDK headers installed with Xcode (`ScreenCaptureKit.framework/Headers/SCStream.h`,
  `Foundation.framework/Headers/NSProcessInfo.h`). Apple's web docs return empty pages to the
  fetch tool, so the headers are the primary source.
- Existing diagnostics in `~/Library/Application Support/openscreen/diagnostics/` (50 starts,
  50 stops, 10 helper warnings, October 5–16), read only.
- `docs/hardware-usage-2026-10-08.md` (CPU and disk measured on a five-minute High take).

What the path already does well: fragmented MP4/MOV writers with frame reordering off, a durable
recovery journal written before media exists, launch-time restore, a loud
`writer-failed-during-capture` path that stops the HUD, serialized helper commands, and the app
hidden from capture by process. The findings below are what remains.

Ranked by user impact: lost or silently broken takes first, then cost, then latency.

## Fix status (branch `fix/recording`, October 20, 2026)

All ten findings and the quick wins are fixed on `fix/recording`; technique F is not adopted.
Verification ran locally only (no CI):
- `npx tsc --noEmit`, `npx tsc -p tsconfig.test.json --noEmit`, `npm run lint`: pass.
- Full vitest suite: 2,549 passed, 7 skipped, 0 failed.
- Swift helper suite (`scripts/test-macos-capture-helper.mjs`): 84 passed.
- `npm run build:native:mac`: pass.

The helper was A/B tested against the installed 1.9.5 helper (copied from
`/Applications/Klippt.app`, October 13) by driving both over stdin on this Mac:
- MacBook Air, 60 Hz display, macOS 26.6.2.
- Load average 130–350 from other builds, so the CPU numbers are noisy.

| # | Fix | Commit | Measured |
|---|---|---|---|
| 1 | `.idleDisplaySleepDisabled` joins the process activity | `b718dc06` | Unit test only; a full idle-sleep wait was not run |
| 2 | A quit that stops the take and is then cancelled sends `native-mac-recording-stopped-by-app`; the HUD opens review with the saved result | `b8de6981` | Unit tests (service and HUD) |
| 3 | `streamDidBecomeInactive/Active` (15.2+), screen lock and system sleep auto-Pause a live take with a toast | `0abb51a7` | Unit tests; not triggered live (a lock would interrupt the user) |
| 4 | High asks for `0.9 / fps` (OBS's 10% headroom), queue depth 8 | `234c52b8` | Delivered 60.0 fps, 0 dropped frames, helper CPU 14.4% → 13.2% while recording; the 120 Hz saving is unmeasured (60 Hz panel) |
| 5 | Screen captured as 420v with the BT.709 matrix | `77aa5fb9` | Files tagged `tv/bt709`; mean difference from a screenshot about 2 levels for both formats, saturated UI colours 2–3 levels for both |
| 6 | Start refused below 1 GiB free; during a take, a toast at 5 and 1 minutes left, and an auto-Pause below 512 MiB | `ecfcebd7` | Unit tests; not run on a small disk image |
| 7 | A paused stream drops to 5 fps after 10 s paused; window lists refresh every 8 s instead of 3–4 s | `8302c98c`, `1819ea45` | Paused 12 s: helper 2.0% → 0.1%, replayd 6.9% → 4.6%; see the Continue trade-off below |
| 8 | stdin EOF and SIGTERM finalize the clip through the command lane, then exit | `ef9c2afc` | SIGTERM after 3 s: old helper killed, file cut at 2.0 s, no stop event; new helper exits 0 with a 3.05 s clip after 464 ms. EOF: old helper 2.25 s, no stop event; new helper 3.01 s with a stop event |
| 9 | Events are parsed from stdout only; stderr is kept for diagnostics | `d5065aff` | Unit test with interleaved chunks |
| 10 | The second journal rewrite after the first frame is gone; Start waits only for writes already queued | `bdcf7b70` | Dev app: `recovery-updated` 0 ms (10–11 ms on October 16). The cache-rejection reason was already logged (`helper:start-stage:shareable-content:*`) |

Also fixed:
- **Technique D:** −3817, −3821 and −3822 get plain stop messages (`6218ad3d`).
- **Technique E:** the public microphone API replaces the KVC path on macOS 15+ (`6218ad3d`).
- **A bug found during testing (pre-existing):** with the microphone on, a first clip shorter
  than the microphone's start time failed Pause with "Original track … microphone.mov received no
  source samples". The installed helper failed 2 of 3 such runs. Now a clip shorter than the 2 s
  source allowance keeps its screen file and reports `original-empty` (`8d34fcb7`); 0 of 6 runs
  failed. A longer clip with no microphone samples still fails loudly.

AGENTS.md gates, run with the new helper:
- **Sub-second clips:** six per run.
- **Pause/Continue:** five cycles per run.
- **Pause then Stop:** at once, per run.
- **Audio combinations:** none, mic, system and both.
- **Result:** every file decodes with ffmpeg and no errors.
- **Continue latency (interleaved):** old helper p50 64 ms; new helper p50 53 ms (max 218 ms
  under load).

Real dev-app pass from the worktree build, screen with mic and system audio:
- **Sequence:** record 12 s, Pause for 21 s, Continue, a 0.28 s clip, then Pause and Stop at once.
- **Result:** four clips, each with screen, mic and system files, BT.709-tagged and decoding
  cleanly. Review opened with "0:24 total, 4 clips".
- **Long-pause cost:** Continue after the 21 s pause returned in 349 ms, against 157–211 ms for
  short pauses, because the frame rate has to be restored first. The harness showed the same
  (146 ms against 25 ms). The 10 s delay keeps quick Pause/Continue at full speed.

Seen but not fixed:
- **Start under extreme load:** at load average 260–346, both helpers failed some starts.
  - New helper: 2 of 20 with "startup exceeded two seconds waiting for the video timeline".
  - Old helper: hung silently after `ready` twice.
  - Neither happened at normal load.
- **Mic level meter:** the dev app logged `Error starting audio level monitoring` in the
  renderer. It is outside this branch and was not investigated.

Not verified here:
- **Camera combinations:** this shell has no camera permission.
- **120 Hz saving:** needs a ProMotion panel.
- **Colour:** checked only on this desktop's content.
- **Live triggers:** closing a recorded window, lid close, and a full disk.

Handoff:
- **Technique F (low-light camera noise reduction):** needs macOS 27; this Mac runs 26.6.2, so it
  cannot be checked. It is left for a 27 test machine.
- **Other areas:** nothing on this branch needed `package.json`, `electron/main.ts` startup
  order, `src/components`, export or `crates/`.

---

## 1. The display can sleep (and lock) in the middle of a take

- **Where:** `electron/native/screencapturekit/Sources/OpenScreenScreenCaptureKitHelper/RecordingProcessActivity.swift:27`
  begins the activity with `[.userInitiated, .latencyCritical]`. Nothing else in `electron/` or
  `src/` holds a display assertion (no `powerSaveBlocker`, no `IOPMAssertion`).
- **Why it matters:** in `NSProcessInfo.h`, `NSActivityUserInitiated` is
  `0x00FFFFFF | NSActivityIdleSystemSleepDisabled`. `NSActivityIdleDisplaySleepDisabled` is
  bit 40 and is not included. So the Mac stays awake, but the display follows the user's
  "turn display off when inactive" timer.
- **Impact:** a talking-head take over a static slide or code, with no mouse or keyboard input,
  passes the inactivity timer (often a few minutes on battery). The display turns off, and
  with "require password after display off" the screen locks. The take keeps counting and
  records a black or locked screen. The user finds out in review.
- **Fix:** add `.idleDisplaySleepDisabled` to the recording lease only (not the finalization
  lease). Keep it while paused, because the user is still in the session.
- **Effort:** 0.5 h code, 1 h live check (set display-off to 1 minute, record 2 minutes hands-off).
- **Confidence:** High on the code; Medium on the exact effect, which was not reproduced.

## 2. A cancelled quit leaves the HUD counting a take that main already stopped

- **Where:** `electron/recording/quitCaptureGuard.ts:15-24` calls
  `stopNativeMacCaptureForQuit` (`electron/ipc/handlers.ts:201-203`), which runs
  `nativeMacRecordingService.stop(false)` (`electron/recording/nativeMacRecordingService.ts:271-288`).
  The stop ends in `onRecordingStateChange(false)` (`:700`). That reaches tray and main state only;
  no `webContents.send` tells the HUD. The HUD's 250 ms timer
  (`src/hooks/useScreenRecorder.ts:2400-2425`) keeps running from `nativeMacRecording.current`.
- **Impact:** if a window or dialog cancels the quit, the user sees a live timer and keeps
  talking into a take that has ended. Nothing is captured after the quit attempt. This is the
  open item from the October 13 handoff review.
- **Fix:** send one renderer event when main stops a take on its own (quit, or any future
  main-side stop), carrying the stored session. The HUD then clears its native state and opens
  review, the same as a normal Stop result.
- **Effort:** 1.5 h including a unit test of the guard → event path.
- **Confidence:** High (code traced; matches the handoff note).

## 3. A source that goes away mid-take is recorded as a frozen frame, with no warning

- **Where:** the helper implements only `stream(_:didStopWithError:)`
  (`ScreenCaptureRecorder.swift:543-562`). It does not implement `streamDidBecomeInactive` /
  `streamDidBecomeActive` (available since macOS 15.2, `SCStream.h:654-665`). It has no sleep,
  wake or screen-lock observer. `.blank`, `.suspended` and `.stopped` frames are only counted in
  telemetry (`CaptureTelemetry.swift:117-124`).
- **Impact:** on High (the default), the cadence timer
  (`ScreenCaptureRecorder.swift:1364-1405`) keeps appending the last written frame. If the
  recorded window is closed, or the display sleeps (finding 1), or the screen locks, the file
  holds a frozen picture while the HUD counts normally. Lid close mid-take (system sleep) is
  untested; the handoff still lists "sleep/wake" and "low disk space" as open tests
  (`HANDOFF.md:819`).
- **Fix:**
  1. Implement both delegate callbacks on macOS 15.2+ and emit a `source-inactive` warning.
  2. Show it on the HUD, or auto-Pause so the frozen stretch is its own clip that the user can remove.
  3. Pause (finalize the clip) on `NSWorkspace.willSleepNotification` and the screen-lock
     notification.
- **Effort:** 4 h plus 1 h live test (close the recorded window, lock the screen, close the lid).
- **Confidence:** Medium. The missing handling is certain; how ScreenCaptureKit behaves on each
  event was not reproduced.

## 4. High asks ScreenCaptureKit for every display refresh, but writes 60 fps

- **Where:** `CaptureSetup.swift:131-134` sets `minimumFrameInterval = .zero` for High. The
  header (`SCStream.h:238`) says zero means "capture at display's native refresh rate". High is
  the default (`src/lib/recording/recordingQuality.ts:3`). The cadence timer then writes a
  fixed fps grid.
- **Impact:** on 120 Hz ProMotion MacBook Pros, busy content can be delivered at up to twice
  the written rate. Each extra frame costs WindowServer composition, replayd, the
  sample-queue hop and a frame-cache swap. On the October 8 take, replayd used 14.9% of a core,
  the helper 32.0%, and WindowServer rose from 38.6% to 54.4% (`docs/hardware-usage-2026-10-08.md`).
  The delivered-versus-written split was not logged, so the share caused by this setting is
  unknown.
- **Fix:** set `minimumFrameInterval = 1/fps` for High too. Record `screenSamples`,
  `repeatedVideoFrames` and helper CPU before and after on a 120 Hz panel. Watch for more
  repeated frames from phase drift between delivery and the cadence grid.
- **Effort:** 0.5 h code, 2 h A/B measurement.
- **Confidence:** Medium (the documented behavior is certain; the size of the saving is not measured).

## 5. The screen stream is BGRA; the encoder needs YUV

- **Where:** `CaptureSetup.swift:137` sets `pixelFormat = kCVPixelFormatType_32BGRA`. The camera
  moved to 4:2:0 on October 13 for the same reason (`NativeCameraCapture.swift:82`).
- **Impact:** at 3420x2214, a BGRA frame is about 30 MB against about 11 MB in 420v. At 60 fps
  that is roughly 1.8 GB/s against 0.7 GB/s of surface traffic. VideoToolbox then converts every
  frame to YUV before encoding. This is memory bandwidth and energy spent on every frame of
  every take.
- **Fix:** capture `420v` with `colorMatrix = kCGDisplayStreamYCbCrMatrix_ITU_R_709_2` (the
  header allows it only for 420v/420f, `SCStream.h:301-304`). Before switching, confirm three
  things:
  1. Colour tags and a side-by-side colour check against a current BGRA take (sRGB/P3 content,
     red UI text).
  2. The resume screenshot seed (`ScreenCaptureRecorder.swift:469`) follows the same configuration.
  3. Preview and export read the result unchanged (they read the encoded MP4, so they should).
- **Effort:** 2 h code, 3 h colour and CPU verification.
- **Confidence:** Medium (the direction is standard; the measured win and colour fidelity need the check).

## 6. No free-space check before or during a take

- **Where:** no `volumeAvailableCapacity*` or `statfs` call in the recording path (grep finds
  one only in `electron/export/atomicExport.ts` and diagnostics). Bitrate caps:
  `RecordingCadence.swift:62-81`. The screen cap is 136 Mbps on High; the camera runs 36 Mbps at
  1080p30 High and up to about 82 Mbps at 4K60 High.
- **Impact:** measured 29 GB per hour on a static desktop (October 8); busy screens approach
  the cap, about 60 GB per hour for the screen alone. When the disk fills, the writer fails
  mid-sentence. The failure path is loud and keeps what was written, but the take ends without
  warning, and the durable session writes fail on the same full disk.
- **Fix:**
  1. Before Record, check `volumeAvailableCapacityForImportantUsage` for the recordings
     folder and block below a floor (for example 2 GB).
  2. During the take, sample free space every 10 s in main and warn on the HUD when fewer than
     about 5 minutes remain at the observed write rate.
- **Effort:** 3 h plus a test on a small disk image.
- **Confidence:** High that the check is missing; Medium on full-disk behavior (untested, listed
  open in `HANDOFF.md:819`).

## 7. Pause and idle standby keep capture work running

- **Where:**
  - Pause finalizes the clip but keeps the screen stream at full rate and the camera running
    (`ScreenCaptureRecorder.swift:383-424`). Every frame is still observed into the frame cache
    (`:579-584`).
  - Pause and standby refetch `SCShareableContent` every 3 s and 4 s
    (`ScreenCaptureRecorder.swift:420`, `HelperWarmup.swift` `keepFresh(every: 4)`), for up to
    10 minutes of standby.
- **Impact:** measured with the HUD open and idle, before Record: replayd 8.6% plus helper
  3.6% of a core, mostly the refresh (`docs/hardware-usage-2026-10-08.md`). Paused helper and
  replayd CPU has not been measured. A user who leaves the HUD open or a take paused on battery
  pays for it.
- **Fix:**
  1. While paused, lower the stream to about 5 fps with `updateConfiguration` (size unchanged,
     so it avoids the costly resize path noted at `:278-280`), and restore it before the resume
     seed. Measure the Continue latency this adds.
  2. Refresh shareable content only while the HUD window is focused, or every 9 s to match the
     10 s `maxAgeSeconds`.
- **Effort:** 3 h plus 1 h measurement.
- **Confidence:** Medium (idle cost measured; paused cost and Continue-latency effect not).

## 8. The helper exits without finalizing on stdin EOF or SIGTERM

- **Where:** `OpenScreenScreenCaptureKitHelper.swift:31-71`. When `readLine()` returns nil
  (main crashed or was killed), the loop ends and the process returns without `recorder.stop()`.
  `NativeMacHelperClient.kill()` sends SIGTERM (`nativeMacHelperClient.ts:98-111`). The helper
  installs no handler, so SIGTERM also skips finalization.
- **Impact:** the take survives through the fragmented files and the journal. Up to the last
  second of screen media and the original `.mov` tails can be lost, and the clip comes back as
  provisional with a recovery warning instead of a clean clip. Launch restores only the newest
  journal at a time (`nativeMacRecoveryJournal.ts:292-315`).
- **Fix:** on EOF, submit `stop()` through the command executor, then exit. Add a SIGTERM
  `DispatchSource` that does the same, bounded by the existing 1 s kill window.
- **Effort:** 1.5 h including a helper test.
- **Confidence:** High on the code; impact Low–Medium because recovery already covers most of it.

## 9. stdout and stderr share one line buffer in the helper client

- **Where:** `electron/recording/nativeMacHelperClient.ts:331-349` appends both streams to the
  same `lineBuffer`.
- **Impact:** a stderr chunk that arrives while a JSON line is split across stdout chunks
  corrupts that line, and the event is dropped.
  - If the dropped line is `recording-stopped`, Stop resolves on exit code 0 with the fallback
    clips (`:229-233`), without the final clip. The clip then returns only through journal
    recovery, as provisional with a warning.
  - If the dropped line is `recording-started`, Start fails after its 10 s timeout.
  - How often the helper or its frameworks write to stderr is unknown.
- **Fix:** give each stream its own line buffer and parse events from stdout only. Keep stderr
  in `outputBuffer` for diagnostics.
- **Effort:** 0.5 h plus a test with interleaved chunks.
- **Confidence:** Medium (the corruption mechanism is certain; how often it happens is unknown).

## 10. Start latency: good median, slow tail, and the HUD starts late

- **Data:** 47 successful starts, October 5–16 (`record-start-timing.jsonl`).
  - Click to returned: p50 359 ms; slowest five 0.9–3.6 s.
  - Slow starts come from `helper:ready` (up to 1,938 ms: shareable-content miss and camera
    setup) and `helper:recording-started` (up to 1,123 ms: first frame and cadence catch-up).
- **Where:** `nativeMacRecordingService.ts:228-237`. After the helper is already writing,
  `persistRecoverySession()` (`recovery-updated`, p50 20 ms, max 286 ms) runs before
  `onRecordingStateChange(true)` and the return to the HUD.
- **Impact:** every take's file starts that much earlier than the HUD timer. The tail is
  occasional seconds-long waits after pressing Record.
- **Fix:**
  1. Make the post-start journal update non-blocking: a failure already routes to the fatal path,
     as in `storeOriginalStarted`.
  2. Log the cache-rejection reason and camera-format time for every start, so the next audit
     can split the slow tail.
- **Effort:** 1 h.
- **Confidence:** High for the data; Medium that the tail can be cut without a deeper change.

---

## Checked and not raised

- The optimistic Pause flip in the HUD (`useScreenRecorder.ts:2108-2141`) reverts when main
  reports `paused !== true`, and the fatal-error event stops the timer
  (`useScreenRecorder.ts:1122-1138`).
- Start and Continue wait for helper confirmation before the HUD changes.
- The app's own windows are excluded by process in the `SCContentFilter` (`CaptureSetup.swift:61-73`).
- Newer APIs considered and not recommended now:
  - `SCRecordingOutput` (macOS 15) cannot do per-clip segmentation, separate original tracks or
    the cadence grid.
  - Public `captureMicrophone` / `SCStreamOutputType.microphone` (macOS 15) would only replace
    the KVC and raw-value 2 now used (`CaptureSetup.swift:6,155-159`). This is a low-risk
    tidy-up, not a user-facing fix.
  - `SCClipBufferingOutput` and `SCStream.capturing` require macOS 27 and are out of scope.

## Newer techniques worth adopting

Researched October 20, 2026. Only techniques that ship in a released OS or library count as
recommendations. Status on that date:
- macOS 27 shipped September 14, 2026 ([MacRumors](https://www.macrumors.com/2026/09/10/macos-27-golden-gate-release-date/)).
- macOS 27.2 is at release candidate.
- This Mac runs 26.6.2.
- API availability comes from the headers of the installed Xcode 27.1 SDK (build 27A9275), which
  are Apple's primary declaration of each API.

Blogs and forums are marked **UNVERIFIED**.

### Adopt

**A. Throttle High to the written frame rate**
- **Source:** WWDC22 "Take ScreenCaptureKit to the next level", June 2022,
  <https://developer.apple.com/videos/play/wwdc2022/10155/>. Apple's guidance: "when requesting
  60 fps, set the minimal interval to 1/60". `SCStream.h:238` says zero means the display's
  native refresh rate.
- **Replaces:** `CaptureSetup.swift:131-134` (`.zero` on High). See finding 4.
- **Minimum macOS:** 12.3.
- **Effort:** 0.5 h plus 2 h A/B.

**B. Capture 420v instead of BGRA for the encoded screen track**
- **Source:** the same WWDC22 session, June 2022: "use pixel format YUV420 for encoding and
  streaming", with `kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange` in its sample. Pair it with
  `colorMatrix` (`SCStream.h:301-304`).
- **Replaces:** `CaptureSetup.swift:137`. See finding 5.
- **Minimum macOS:** 12.3.
- **Effort:** 5 h including the colour check.
- **Also from the session:** the app must return surfaces within `minimumFrameInterval ×
  (queueDepth − 1)`, or ScreenCaptureKit stalls and drops frames. `RecordingFrameCache` holds up
  to three pool surfaces long-term (`RecordingFrameCache.swift`), plus the first frame, against
  `queueDepth = 6` (`CaptureSetup.swift:135`).
- **Fix for that:** raise `queueDepth` to the documented maximum of 8, or copy the one frame
  that must outlive the pool. Smaller frames (420v) make either choice cheaper.

**C. React to the stream going inactive and active**
- **Source:** `streamDidBecomeInactive:` / `streamDidBecomeActive:`, macOS 15.2 (released
  December 2024), `SCStream.h:654-665`; Apple doc
  <https://developer.apple.com/documentation/screencapturekit/scstreamdelegate>. The header says
  the inactive call "occurs for all content filter types".
- **Replaces:** nothing today. Add it next to `stream(_:didStopWithError:)`
  (`ScreenCaptureRecorder.swift:543`). See finding 3.
- **Minimum macOS:** 15.2.
- **Effort:** 2 h of finding 3's 4 h.

**D. Name the system's own stop reasons**
- **Source:** `SCStreamErrorSystemStoppedStream` (−3821), macOS 15.0, and
  `SCStreamErrorInsufficientStorage` (−3822), macOS 27.0 (`SCError.h:35-36`).
- **Replaces:** the generic `"\(error)"` message in `capture-stopped-with-error`
  (`OpenScreenScreenCaptureKitHelper.swift:21-26`) and the HUD toast. A specific message, such as
  "macOS stopped the capture" or "the disk is full", tells the user what to do next.
- **Note:** −3822 is the stream's own report. Klippt writes with `AVAssetWriter`, so finding 6's
  free-space check is still needed. This error is the backstop on 27+.
- **Minimum macOS:** 15.0 (−3821), 27.0 (−3822).
- **Effort:** 1 h.

**E. Use the public microphone API instead of KVC and a raw value**
- **Source:** WWDC24 "Capture HDR content with ScreenCaptureKit", June 2024,
  <https://developer.apple.com/videos/play/wwdc2024/10088/>, which introduces `captureMicrophone`
  and `microphoneCaptureDeviceID`. Header: `SCStream.h:37,380-385`.
- **Replaces:** `setValue(_:forKey: "captureMicrophone")`, the `responds(to:)` probe and
  `screenCaptureKitMicrophoneOutputTypeRawValue = 2` (`CaptureSetup.swift:6,155-159,202-208`).
- **Benefit:** no user-facing change. It removes a private-looking code path that a future
  release could break silently.
- **Minimum macOS:** 15.0.
- **Effort:** 1 h.

**F. Low-light noise reduction on the camera connection**
- **Source:** `AVCaptureConnection.lowLightVideoNoiseReductionSupported` /
  `lowLightVideoNoiseReductionEnabled`, macOS 27.0 (`AVCaptureSession.h:1278-1288`). It is on by
  default only for movie-file outputs; Klippt uses a video data output, so it is off unless set.
- **Replaces:** nothing today in `NativeCameraCapture.swift:74-84`. The October 8 camera test
  found the dark take "spends its extra bits reproducing sensor noise"
  (`docs/hardware-usage-2026-10-08.md`).
- **Minimum macOS:** 27.0, and only on camera formats that report support.
- **Effort:** 1 h code, 2 h dark-room A/B for quality and power. The header warns it costs
  additional power.

### Considered, not recommended now

- **`SCRecordingOutput`** (macOS 15, WWDC24 10088). It writes the file inside ScreenCaptureKit,
  but Klippt needs per-clip writers, the fixed fps grid, separate original tracks, fragmenting
  and seeded resumes, which this API does not expose (`SCRecordingOutput.h`).
- **HDR capture presets** (`captureDynamicRange` macOS 15; `CaptureHDRRecordingPreservedSDRHDR10`
  macOS 26, `SCStream.h:220-224`). Klippt delivers SDR H.264 for YouTube. HDR would touch preview,
  compositor and export, which is a product decision rather than a recording fix.
- **`SCClipBufferingOutput`, `SCRecordingEditor`, `SCStream.capturing`** (macOS 27). These are
  for instant-replay clips of at most 15 s (`SCClipBufferingOutput.h`), a system-owned preview
  UI, and a state flag. None fits a take-based recorder. The WWDC26 framework change is mainly
  ScreenCaptureKit arriving on iOS, iPadOS, tvOS and visionOS 27 (headers;
  [Mac OTAKARA, June 2026](https://www.macotakara.jp/news/entry-51358.html), UNVERIFIED
  secondary).
- **`AVCaptureSession` deferred start** (macOS 26, `AVCaptureSession.h:653-707`). It defers extra
  outputs until the first one has a frame. Klippt's camera session has one output, so there is
  nothing to defer.
- **`AVAssetWriter.usesProVideoStorage`** (macOS 27). It applies to pre-allocated storage for
  high-rate formats such as ProRes; Klippt writes H.264.
- **The monthly screen-recording re-approval prompt** (macOS 15+) still appears for direct
  ScreenCaptureKit apps. The only documented way around it is Apple's content-sharing picker,
  `SCContentSharingPicker`. Sources:
  [9to5Mac, August 14, 2024](https://9to5mac.com/2024/08/14/macos-sequoia-screen-recording-prompt-monthly/);
  [Michael Tsai, August 8, 2024](https://mjtsai.com/blog/2024/08/08/sequoia-screen-recording-prompts-and-the-persistent-content-capture-entitlement/).
  Both are UNVERIFIED for macOS 26/27; Apple has published nothing on the cadence. The UI audit
  covers the user-facing side (`docs/audits/2026-10-20/ui.md`).

### What other Mac recorders do (October 2026)

Cap and OBS were read from source. Screen Studio and CleanShot X publish only changelogs.

**Cap** (open source, `CapSoftware/Cap` at `main` `cb129725`, October 20, 2026; release
`cap-v0.6.0` was September 15, 2026). Verified from source:
- **Capture:** 420v (NV12) with an sRGB colour space, `minimumFrameInterval = 1/fps`, and
  `queueDepth` scaled with fps up to 8. File:
  [`crates/recording/src/sources/screen_capture/macos.rs`](https://github.com/CapSoftware/Cap/blob/main/crates/recording/src/sources/screen_capture/macos.rs),
  last changed September 4, 2026.
  This supports techniques **A** and **B**.
- **Disk:** refuses to start below about 500 MB, polls free space every 2 s during a take, and
  warns at 2 GB. File:
  [`crates/utils/src/disk_space.rs`](https://github.com/CapSoftware/Cap/blob/main/crates/utils/src/disk_space.rs).
  This supports finding 6.
- **Sleep and stream loss:**
  - Observes NSWorkspace will-sleep, did-wake and screen sleep
    ([`apps/desktop/src-tauri/src/power_observer.rs`](https://github.com/CapSoftware/Cap/blob/main/apps/desktop/src-tauri/src/power_observer.rs)).
  - On `SCStreamErrorSystemStoppedStream`, it rebuilds the stream a bounded number of times
    after checking that the display still exists; otherwise it reports the capture target as
    lost.
  - This supports finding 3 and technique **D**. Cap holds no display-sleep assertion either,
    so finding 1 is not something competitors have solved.
- **Pause:** keeps capturing and shifts later timestamps by the pause length (Klippt instead
  finalizes a clip per pause). Its studio mode writes 2 s fMP4 segments through ffmpeg
  `h264_videotoolbox`; Klippt's 1 s `movieFragmentInterval` is already equivalent for crash
  safety.

**OBS Studio** (verified from `plugins/mac-capture/mac-sck-video-capture.m`):
- **Since 32.0.0 (September 22, 2025):** `queueDepth = 8` and `minimumFrameInterval` = 0.9 × the
  output frame time (commit `4e7152bd7`, August 20, 2025). That is the same idea as **A**, with
  10% headroom so a frame is never one tick late. The same headroom is worth testing for
  Klippt's cadence grid.
- **33.0 (rc2, October 16, 2026, not final):** moves to 64-bit half-float RGBA on macOS 15+ for
  colour accuracy. OBS composites in its own GPU pipeline before encoding; Klippt encodes the
  capture directly, so this is not a model for us.

**Screen Studio** ([changelog](https://screen.studio/changelog), vendor, verified but thin):
- 3.2.0 (April 8, 2025): Pause and "Improved recording recovery system".
- 3.2.2 (May 14, 2025): "Better low disk space warnings during recording".
- Nothing published on pixel format, HEVC, HDR or 120 fps.
- The low-disk warning is a market expectation that Klippt lacks (finding 6).

**CleanShot X** ([changelog](https://cleanshot.com/changelog), vendor):
- 5.0 (September 1, 2026) adds hardware-encoded export.
- Nothing on its capture pipeline.

**OpenScreen upstream** (`getopenscreen/openscreen`, the MIT base). UNVERIFIED against Apple:
- PR #658 (merged September 14, 2026) reports that on macOS 26.5 about 3% of resumes produce a
  video timestamp that does not advance. `AVAssetWriter` then fails with −16364.
- Klippt already rejects non-increasing timestamps for the screen
  (`ScreenCaptureRecorder.swift:618`) and for originals (`OriginalTrackWriter.swift:60`). No
  action needed; keep those guards.

**Nonstrict blog** (ScreenCaptureKit specialists, UNVERIFIED blog, late 2024):
- Audio can drop out when a device such as AirPods connects mid-take; detect the gap from
  timestamps and pad silence.
- Klippt's `AudioTrackMixer` already places samples by timestamp and pads holes up to a limit
  (`AudioTrackMixer.swift:19-24, 59-61`). Worth one live check with AirPods connecting mid-take.

## Quick wins under 2 hours

1. Keep the display awake while recording (finding 1): 0.5 h code, 1 h check.
2. Tell the HUD when main stops a take (finding 2): 1.5 h.
3. Separate stdout and stderr parsing in the helper client (finding 9): 0.5 h.
4. Finalize on stdin EOF and SIGTERM in the helper (finding 8): 1.5 h.
5. Take the post-start journal write off the critical path (finding 10): 1 h.
6. Set `minimumFrameInterval = 1/fps` on High (finding 4): 0.5 h code, then the 2 h A/B before
   shipping it.
