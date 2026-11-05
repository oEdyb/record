# Recording hardening on the Linux PC

Private fixtures only. The installed profile and user recordings were never modified or opened in Klippt. Heavy commands used the shared flock, a 12 GiB scope, idle I/O, nice 19, and at most four jobs. Artifacts live under `~/.cache/klippt-work/take-check/`.

## Camera timing

`9e32a322f`: the Linux helper acknowledged Start/Continue after encoding setup, and the renderer used that delayed acknowledgement as the clip epoch. Continue also reset the epoch after persistence. The helper now sends its actual clip epoch and the client/renderer preserve it. Native regression delays acknowledgement by 80 ms; client/service/recorder tests cover the timestamp and legacy fallback.

Read-only user take: `~/.config/Klippt/recordings/recording-1793840267863.session.json`. Camera 28.201/29.583/30.025 fps, maximum gaps 164.866/167.333/41.867 ms; camera minus screen durations +42.212/+218.879/−75.921 ms. The largest gaps occur near the beginning. These separate-file durations include different acquisition starts and Stop/ack tails; they do not by themselves measure clock drift. The 107 superseded frames are a screen mailbox lifecycle counter, including unencoded startup/paused activity, not 107 proved missing camera frames.

Private 4K fake camera, explicitly 30 fps, no added load versus two CPU workers with the test pinned to four cores: original runs yielded 28.831/29.522 fps, maxima 427.334/134.000 ms. Instrumentation in the actual Klippt camera path found 347 input and 347 encoded frames without added load, with the same approximately 100 ms input/output gap. Under added load the bounded observer saw 367 frames and the file retained 378; both had approximately 490 ms maximum gaps. The observer is a lower bound under load, so that count is not a claim of exact source-frame accounting.

An independent Electron camera writer (no Klippt recording code) captured input timestamps and encoded frames. No added load: 448 input/448 output, 29.8665/29.8672 fps, max gaps 99.600/99.533 ms. Added load: 448/448, 29.9331/29.9336 fps, max gaps 60.100/60.167 ms. Thus input/Chromium scheduling can produce early gaps before the writer, without physical webcam hardware. “No added load” does not mean the entire shared PC was idle. No physical webcam or clap-marker test was performed; exact hardware-versus-load causation in the old take remains unknown. No frame duplication or resampling was used to hide gaps.

Evidence: `camera-native-tests.log`, `first-fixes-check.log`, `timing-30-comparison.json`, `camera-control-comparison.json`, `timing-incoming-{idle,load}.log` and the corresponding private run artifacts.

## Microphone level

No gain change was found in the native writer: Linux writes original microphone samples before applying the constant mix gain. Pause/Continue retain its audio session unless reconfigured. User originals measured means −63.4/−63.6/−31.2 dBFS and peaks −40.3/−39.6/−13.4 dBFS. Private constant input remained approximately −37 dBFS with and without added load.

A separate Klippt meter fault was found and fixed in `3731124d8`: the idle/device level meters and permission probe requested browser voice-processing defaults. A private real Pulse source with a constant tone had unchanged source volume, but processed readings ranged −75.60 to −60.76 dBFS (median −65.53); explicit unprocessed input stayed approximately −70.95 dBFS. Meters/probes now explicitly disable automatic gain, echo cancellation and noise suppression. Four hook regressions pass, and the real window flow reads back all three flags disabled. React Doctor's full score remained 46/100 before and after; its pre-existing findings were not suppressed. Evidence: `meter-red.log`, `meter-green.log`, `meter-control/meter-results.json`, `final-hung-meter-flow.log`.

Chromium's [Pulse input implementation](https://chromium.googlesource.com/chromium/src/media/+/refs/heads/main/audio/pulse/pulse_input.cc) also has a render-side AGC route to source volume; disabling processing prevents meters from requesting it. The virtual-source test did not reproduce a hardware-volume change. The old files lack source identity and gain history, so they cannot prove whether the 32 dB difference was hardware, OS/default source, speech level or a meter-induced device change. The native writer alone cannot rule out upstream changes. No automatic recording boost was added.

## Other fixes

- `9373cc2e2`, `c96d48eb5`: old-schema history undo bypassed document migration. A real gzip schema-7 history snapshot now goes through the shared schema loader (15 tests).
- `22add6aca`: raw FFmpeg INVALIDDATA from `avcodec_receive_frame` reached preview/export UI. The bridge preserves internal logging and returns a readable damaged/incomplete-video message. Two regressions and an actual deliberately corrupted private media copy through Studio export pass (`corrupt-flow-2.log`).
- `cd778a94b`: actual FFmpeg ENOSPC during rendering was classified as a generic rendering failure; EROFS exposed a raw filesystem error. Export now explains insufficient space/read-only destinations. Actual capped 80 MiB tmpfs tests passed for full preflight, filling during render, read-only mount, and cancellation of a real running FFmpeg child. Existing destination bytes remained unchanged, with no staging leaks (`filesystem-faults-fixed.log`, `fs-faults/results.json`; 27 transaction tests).
- `1e9c6396c`: hung Stop recovered readable media but retained a 60-second provisional duration. Recovery now uses the probed duration; timeout wording is readable. Freezing only the private capture helper, pressing Stop, waiting for its watchdog and reopening/replaying/decoding every track passed (`hung-stop-fixed.log`).
- `ee7e95505`: legacy `file://` parsing dropped literal `#`/`?` filename suffixes. Both import paths now share a parser preserving those filesystem characters; encoded paths still decode. 36 tests include actual filesystem reads. Legacy references are treated as filesystem paths, not media-fragment seek directives.
- `74cfd5991`: relinking checked screen/camera only and never registered original mic/system audio. The registry and project-open path now restore missing audio roles from a known recording association, retain good paths and refuse unknown guesses. Real filesystem relocation and service/approval tests passed; combined targeted suite 195 passed. Historical entries with no known audio association still require explicit relinking rather than guessing.
- `beff5709c`: Linux HUD content resizing still used `setSize` on a fixed Wayland window. A real private baseline failed restore height (112 versus 160); atomic fixed bounds pass. Fourteen HUD unit tests pass.
- `c8111bdb9`: unexpected ENOSPC left a partially written last MP4 fragment. The failed native writer now retains complete fragments after closing its own output. An actual full 80 MiB filesystem retains 180 frames and strictly decodes with no damaged tail; the helper reports its failure. At most the incomplete final fragment is lost. Native suite after boundary/close hardening (`43b11382a`): 152 passed, 4 explicitly ignored children/private-filesystem cases; both ENOSPC cases were explicitly run sequentially and passed. Disk exhaustion during Stop retained 105 frames; exhaustion while writing retained 180; both strictly decode. Fragment-header truncation was tested at every byte boundary, RED before the follow-up fix and GREEN after. The user's recordings were never passed through this code by the agent.

## Real failure flows

`b403fd7d2` adds reusable fault scenarios to `scripts/recording-window-flow.mjs` and padded copy/export to the normal five-minute flow. It also fixes dev-window selection (hidden editor and HUD share a title), retries a private KWin script registration race and stops portal-picker polling after worker exit. Diagnostic short runs are explicitly separate from the normal five-minute gate.

- `--fault=pause-stop`: actual production commands sent together while Studio is open; saved review, replay and all-track decode pass (`pause-stop-final.log`).
- `--fault=mic-unplug`: remove only the private Pulse/PipeWire source mid-take; recording stays active, Stop/replay/all-track decode pass (`mic-unplug-final.log`). Physical USB unplug is not covered.
- `--fault=crash`: SIGKILL only the private app, relaunch its private profile; startup journal recovery, review and all-track decode pass (`crash-flow.log`). A sudden power loss is not covered.
- `--fault=disk-low`: fill a private 2 GiB tmpfs volume until about 200 MiB remains. The real storage guard auto-pauses; Stop/review/all-track decode pass (`disk-low-flow-3.log`). A separate native writer test exhausts the disk completely, beyond the guard's reserve.
- `--fault=corrupt`: corrupt only a private copied file's H.264 packet payloads; Studio reports readable damaged frames (`corrupt-flow-2.log`).
- `--fault=cancel`: press the actual Studio “Stop saving” control at 4% frame progress; no output is published (`cancel-native-flow-2.log`, `run-D5cXdj/cancel-progress.json`).
- `--fault=export`: short diagnostic copy/export; padding 50, no account, full duration and strict decode pass (`durable-export.log`, run `run-nwXlyS`). The normal no-argument flow retains its 301-second capture and now also exports.

These run on private KWin for real PipeWire capture. Each flow also checks geometry on nested niri. Nested niri cannot supply the required GBM-backed capture path here, so a real niri recording/revocation test remains unproven. Compositors decline native maximize requests on the fixed windows; app Expand/Collapse and dev Electron native maximize/restore are checked separately. The packaged binary retains its debugger/security fuses. Full/read-only destination faults were exercised against the production transaction layer with real filesystems, rather than through the native file picker; native happy export, damaged-media error and cancellation were exercised through Studio.

## Installed export evidence

Before reinstall, installed `6a9b3c9c3` exported a COPY of a private take through Studio, without account, with saved padding 50. Output `run-pKu5iX/export.mp4.mp4`: 960×576 H.264 60 fps, 12.016016 s video and 12.016000 s AAC. Strict complete decode passed. Extracted frame shows the padded image and legible fixture text. This is visual evidence, not an objective camera-lens sharpness calibration. No user recording was exported.

## Final verification and installation

Initial normal run: 3,400 unit tests passed, the same six signature-dependent supply-chain tests failed, and the real 301-second recording/replay/all-track-decode/padded-export flow passed (`full-normal-test.log`, run `run-3OWcjO`). TypeScript, lint and docs checks passed (`final-static.log`; lint has a pre-existing oversized-file warning). Main subsequently received independently developed recording-start fixes; these were merged before final PC verification.

Combined-main normal run reports 3,433 unit tests passed and the same six signature-dependent failures. Its 311.616-second recording, Stop, review and all-track decoding passed, and Studio saved its padded export. A newly added harness assertion then incorrectly rejected 1920×1080 output for not equalling its 960×576 input; this was a test assumption, not a product failure. The assertion now rejects actual resolution reduction. `final-export-flow.log` returned success through the corrected real UI flow. The retained full export separately passed strict complete decoding, 311.616016-second length versus 311.616 expected, and five distinct decoded frame hashes in its last second. Audio mean/peak were −34.2/−30.0 dBFS. Start/middle/end extracted frames have visible padding and legible fine calibration text. Evidence: `combined-export-validation.log`, `full-export-tail-sharpness.log`, run `run-tRJeX9`. The original combined command returned 1, including that corrected assertion and the six signature failures; it is not reported as wholly green. Both production and strict test TypeScript checks, lint and docs checks passed before that run. No dependency signature or approval gate was changed.

Pending package build, naturally exited installed process, dated-backup swap, and installed-package five-minute recording/export flow. Do not interpret earlier development or old-package results as the final new installed result.

## Root-cause source locations

- Camera epoch: `electron/native/pipewire-capture/src/clips.rs:251`, `src/hooks/useScreenRecorder.ts:1582` and the Continue epoch propagation.
- Meter processing: `src/hooks/useAudioLevelMeter.ts:43`, permission probe `src/hooks/useMicrophoneDevices.ts:86`.
- Full/read-only export errors: `electron/export/atomicExport.ts:266` and `:278`.
- Hung-Stop duration: `electron/recording/nativeMacRecoveryJournal.ts:148`.
- Failed MP4 write/close recovery: `electron/native/pipewire-capture/src/encoder.rs:1130`, `:1150`, `:1183`, and `src/mp4_tail.rs` in that crate.
- Legacy URL delimiters: `src/lib/legacyFileUrl.ts:17`.
- Stale audio relinking: `electron/media/projectMediaRelinker.ts:45`, `electron/media/mediaLinksRegistry.ts:39`.
- Old-schema undo: `electron/ai-edition/agentHistory.ts:279`.
- Readable decoding error: `electron/ipc/nativeErrorMessage.ts:1`, applied at the native bridge boundary.
- Fixed HUD bounds: `electron/windows.ts:191`.

Decisions: retain raw originals and report uncertainty; no automatic mic boost, synthetic frame insertion, guessed audio relinks, dependency signing or gate suppression. Private KWin supplies capture proof; nested niri supplies geometry proof only. Cross-platform shared changes retain legacy protocol/schema compatibility; this PC run is not new Mac/Windows runtime evidence.
