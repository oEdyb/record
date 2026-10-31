# macOS capture audio fixes

## Sources and adaptation

Read the MIT OpenScreen diffs using `gh pr diff N -R getopenscreen/openscreen` for
[710](https://github.com/getopenscreen/openscreen/pull/710),
[717](https://github.com/getopenscreen/openscreen/pull/717),
[648](https://github.com/getopenscreen/openscreen/pull/648),
[1147](https://github.com/getopenscreen/openscreen/pull/1147),
[521](https://github.com/getopenscreen/openscreen/pull/521), and
[1229](https://github.com/getopenscreen/openscreen/pull/1229).
No Recordly code was used. Echo cancellation remains out of scope.

- PCM: derive sample-container width from the ASBD frame size. Decode signed and unsigned
  little-endian integer PCM, including packed 24-bit, high/low aligned 24-in-32, and 8-bit.
  Keep Float32 and the existing timeline/gain mapping. The separate microphone original
  still uses its existing independent writer, without this compatibility conversion.
- Microphones: native ID wins, followed by a unique exact name, followed by a unique name
  with one Chromium transport or USB suffix removed. Ambiguous, partial, and unknown labels
  do not select the first device. A missing specific selection emits `microphone-defaulted`.
  Route this through the existing helper warning and HUD event path to a non-interrupting
  toast, including before recording-start acknowledgement. Explicit Default does not warn.
- Window audio: create an audio-only SCStream with a display filter excluding no applications;
  exclude the helper's own process audio in its configuration. Disable audio on the window
  video stream. Deliver the full mix to both the existing system original and compatibility
  writers. Keep the auxiliary stream through Pause/Continue and video stream replacements;
  start/stop it transactionally when paused settings change. Stop it before finalization.
  Reject duplicate window audio and retired-stream samples. Unlike upstream's warning-only
  fallback, failure to start required system audio rejects startup/reconfiguration. Active
  audio failure uses the existing terminal capture recovery path; paused failure retries on
  Continue. This preserves Klippt's loud-failure requirement.

## Added coverage

- `AudioTrackMixerPCMTests`: 10 integer layouts, sample polarity, gain, stereo mono mapping,
  frame count, packed containers and high/low alignment. Builds real CMSampleBuffers.
- `MicrophoneDeviceSelectionTests`: all five suffix forms, native ID precedence, whitespace,
  exact decorated names, ambiguous/partial/unknown names, default versus fallback warnings.
- `CaptureSetupTests`: independent audio required only for enabled window system audio;
  48 kHz stereo, current-process exclusion, microphone disabled on the auxiliary stream.
- `RecordingStreamRecoveryTests`: independent full-mix routing, duplicate rejection, retired
  sources, screen routing, and return to primary-stream audio.
- `useScreenRecorder.nativeStopFailure.test.tsx`: fallback toast before startup and during
  recording without pausing; existing fixture explicitly selects Darwin.

## Verification

- `npm run build:native:mac`: passed, darwin-arm64 helpers rebuilt after final Swift edits.
- `node scripts/test-macos-capture-helper.mjs`: 104 tests passed. Existing async semaphore
  warning remains in `ScreenCaptureRecorderResumeTests.swift`.
- `npx tsc --noEmit`: passed.
- `npx tsc -p tsconfig.test.json --noEmit`: passed.
- Targeted Vitest: 181 tests passed across the recorder hook, helper client, recording service.
- `npm run lint -- <touched TS files>`: passed. The script also checks the repository;
  its existing oversized `third-party-licenses/Cargo-Evidence.json` warning remains.
- `npm run test`, once: 3299 passed, 9 failed, 15 skipped. Eight failures are the supplied
  baseline: check-approved-dependencies (1), check-cargo-graphs (2), generate-release-inventory
  (5). The ninth is `handoffProvenance.media.test.ts`, because this fresh checkout does not
  have a discoverable bundled FFmpeg. Rechecking that test with the already installed
  `OPENSCREEN_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg` passed (1 test).
- `swift build --package-path electron/native/screencapturekit --scratch-path
  /tmp/klippt-strict-capture-build -Xswiftc -strict-concurrency=complete`: passed with existing
  concurrency warnings in the package. This is not a claim that the entire existing package
  compiles in Swift 6 language mode; its manifest remains at the established 5.9 baseline.
- `git diff --check`: passed.

## Required real-app pass

Not performed: this development helper has no TCC grant. Nothing was installed in
`/Applications`; the running Klippt was not controlled, quit, or used to play sound.

The parent must verify a window recording while another application produces system audio;
inspect both the untouched system original and compatibility playback for audibility, level,
sync, and no doubled audio. Verify microphone-only/system-only/both/neither, an actual integer
PCM microphone, decorated device selection, a disconnected selected mic's visible fallback
warning, repeated Pause/Continue, window/display switching and audio toggling while paused,
Stop immediately after Pause, and recoverable system-audio stream failure. Originals, project
metadata, playback, and separate-source handoff must agree.
