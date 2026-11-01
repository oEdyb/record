# Chromium renderer crash diagnosis — 2026-10-30

## Finding

**Both original Media-thread SIGTRAPs are PartitionAlloc out-of-memory aborts, not Chromium media CHECK failures.** Their instruction pointers resolve to the same `partition_alloc::internal::OnNoMemoryInternal(size_t)` instruction. A controlled allocation-failure experiment reproduces the Media-thread abort in the **previous, pre-Studio build**, while decoding the pill's hidden screen replay, with webcam and microphone disabled and no Studio window.

The exact reason allocations failed in the two original runs remains unproven. The original cores are truncated before the crashing threads' stacks. The shared lab's pressure is a plausible contributor, not a demonstrated exclusive cause. No natural crash recurred during this pass. Do not turn the controlled memory-limit experiment into a claim that the original processes reached that limit.

**Recommended change:** stop creating/loading replay media while its surface is closed or hidden, then handle HUD renderer death in the main process so capture can be recovered. Neither rejecting short clips nor disabling accelerated decoding is justified as the root fix by this evidence.

All source references below are pinned to **e750a47d**, because another agent was editing the checkout during diagnosis. No source edits, build, commit, or push were performed here.

Evidence directory: [artifacts/studio-bughunt-2026-10-30/crash](../../artifacts/studio-bughunt-2026-10-30/crash/), abbreviated **E** below.

## Exact crash identification and CHECK text

The original crashes have these addresses:

| Run / host PID | Crashing PC | Executable load base | Relative address |
| --- | --- | --- | --- |
| flow / 3943523 | `0x5652f457d7a8` | `0x5652eb162000` | `0x941b7a8` |
| studio-ui / 3977844 | `0x55e782a297a8` | `0x55e77960e000` | `0x941b7a8` |

The official Electron **44.9.1 Linux x64 symbols** identify:

```text
FUNC 941b790 1a 0 partition_alloc::internal::OnNoMemoryInternal(unsigned long)
941b7a8 2 85 .../partition_alloc/oom.cc
```

The executable ELF build ID is `250bc0f8e9443b3363fbabdc954636b974bb6622`, matching the symbol file's `INFO CODE_ID`. Breakpad module ID: `F8C00B2544E9333B63FBABDC954636B90`. The function contains `int3` at `0x941b7a7`; Linux reports the instruction pointer immediately after it, `0x941b7a8`.

**Exact CHECK/FATAL message: none.** This abort calls `PA_IMMEDIATE_CRASH()` directly. It does not construct a CHECK message. The matching Chromium source explicitly forbids allocating/logging work in this handler. Launching with `--enable-logging=stderr --v=0` therefore does not produce a hidden media CHECK string for this failure.

The original stack that can honestly be recovered is:

```text
Media thread
#0 partition_alloc::internal::OnNoMemoryInternal(size_t)
   partition_alloc/oom.cc:85, executable+0x941b7a8
#1 unavailable: original systemd core is truncated before this thread's stack
```

`original-flow-gdb.txt`, `original-ui-gdb.txt`, `original-crash-symbolization.json`, and `electron-build-id.txt` preserve the identification. The two exported `.core` files are sparse, truncated 32 GiB files; their physical disk usage is much smaller. GDB records the missing stack address explicitly. No caller stack is inferred from unrelated registers.

Crash-time journal metadata is preserved in `original-3943523-metadata.json` and `original-3977844-metadata.json`. The renderers had approximately **168 MiB / 123 MiB RSS**, **852 MiB / 781 MiB VmData**, and a **32 GiB RLIMIT_DATA**. Those numbers do **not** show a renderer consuming 32 GiB or establish an unbounded renderer leak. The old lab `oom_kill:0` is compatible with an application abort after an allocation failure; it is not evidence that every allocation succeeded.

Primary sources:

- [Official Electron symbols](https://github.com/electron/electron/releases/download/v44.9.1/electron-v44.9.1-linux-x64-symbols.zip), retained as `electron-symbols.zip` and extracted `electron.sym`.
- [Pinned Chromium OOM handler](https://chromium.googlesource.com/chromium/src/+/152.0.7977.167/base/allocator/partition_allocator/src/partition_alloc/oom.cc), retained as `chromium-oom.cc`.
- [Pinned FFmpeg decoder](https://chromium.googlesource.com/chromium/src/+/152.0.7977.167/media/filters/ffmpeg_video_decoder.cc), retained as `chromium-ffmpeg-video-decoder.cc`.

## Smallest reproduced failure

This is an **explicit fault injection**, not a natural-pressure reproduction:

1. Launch the previous **a9e39d01** AppImage in `crash-diag`, with Chromium logging and CDP port 19361.
2. Camera off, mic off, no model, no Studio. Choose Virtual-0 and record/pause a normal clip.
3. Leave the pill replay closed. Its `<video preload="auto">` still loads the screen file.
4. Attach GDB only to this lab's HUD renderer. Break at `FFmpegVideoDecoder::GetVideoBuffer`.
5. At that breakpoint, reduce **only this renderer's soft RLIMIT_DATA** from 32 GiB to its current VmData. Resume the decoder.

One decoder allocation then triggers the same OOM function on the Media thread. In this run, the failed page-commit request was **4096 bytes**. The decoder's request reaches the allocator through:

```text
media::FFmpegVideoDecoder::GetVideoBuffer                 +0x764ca7c
media::FrameBufferPool::GetFrameBuffer                    +0x716245b
base::UncheckedCalloc                                    +0x93f66c7
base::allocator::dispatcher::...AllocZeroInitializedUncheckedFn
partition_alloc::PartitionRoot::Alloc                    +0x410ea8a
partition_alloc::internal::PartitionBucket::SlowPathAlloc +0x410db98
partition_alloc::internal::SetSystemPagesAccessInternal   +0x410e412
partition_alloc::internal::OnNoMemory                     +0x941b7d6
partition_alloc::TerminateBecauseOutOfMemory              +0x941b7b9
partition_alloc::internal::OnNoMemoryInternal              +0x941b790
```

GDB's ordinary unwind contains spurious frames because this is a stripped Electron renderer. `previous-decoder-oom-gdb.txt` also includes an explicit frame-pointer walk (`FP #...`); the function names above come from that walk and the official symbols in `previous-decoder-oom-symbols.txt`. The limit was injected only after the decoder breakpoint was reached. `decoder-limit.gdb` preserves the commands, `decoder-limit-target.txt` identifies the lab PID/executable/base, and `previous-app.log` preserves Chromium stderr.

A separate preliminary limit experiment on the Studio build failed in Blink's allocator on another thread (`fresh-oom-gdb.txt`). That experiment confirms generic allocator failure but is **not** represented as a Media-thread stack or as the original trigger.

## Factor isolation and runtime results

All launches used the unchanged packaged AppImages, private compositor/portal/audio, and `--enable-logging=stderr --v=0 --remote-debugging-port=19361`. Camera runs also used both fake-media flags, avoiding physical devices. The disabled-decode and default-decode camera profiles were separate; results are bounded observations, not a statistical regression test.

| Variant | Completed rapid cycles | Result |
| --- | ---: | --- |
| Studio build, default decode, webcam off, Studio unopened | 20 | No natural renderer crash; clips include 133–166 ms |
| Same take, Studio open, webcam off | 20 | No natural renderer crash |
| Same take, private mic and copied Parakeet model | 15 | No natural renderer crash |
| Same configuration, private speech played during each clip | 4 | No natural crash; actual transcript cache contains the fixture text |
| Previous build, default decode, webcam/mic off, no Studio | 20 | No natural crash; rapid clips approximately 333–366 ms |
| Previous build, decoder-specific memory limit | 1 failure | Media-thread allocator OOM before next completed cycle |
| Studio build, accelerated video decode disabled, camera off, Studio unopened | 10 | No natural crash |
| Same take, Studio open, camera off | 10 | No natural crash |
| Same take, synthetic camera on | 10 | No natural crash; webcam MP4s were written |
| Studio build, default decode, synthetic camera on, Studio unopened | 10 | No natural crash; webcam MP4s were written |
| Same take, Studio open | 10 | No natural crash |

Evidence: corresponding `*.jsonl` action/state records and `*.txt` cycle output; `recorded-durations.json`; `speech-transcript-cache.json`; `run1-app.log`, `previous-app.log`, `disabled-decode-app.log`, and `default-camera-app.log`. The helpers are adapted from the earlier testers' `k.py`, `drive.py`, and cycle script. They resolve each window by kind because window indices change. `matrix.py` waits for enabled Pause/Resume controls instead of assuming the click completes native capture immediately.

### What each candidate explains

- **Pill screen replay:** directly demonstrated as sufficient to enter the failing software decoder in the controlled previous-build experiment. No camera stream, MediaRecorder, or Studio is required for that reproduction.
- **Short/zero-length file:** the original four flow screen files all fully decode with FFmpeg. The last has a real **0.271354 s** H.264 stream at 1920×1080, despite a native clip duration of 250 ms. It is not an empty or malformed zero-length file. `original-media-check.json` records each decode. Natural sub-0.5-second cycles also passed. No minimum safe duration is established.
- **Hardware decode:** CDP Media properties name **`FFmpegVideoDecoder`**, `kIsPlatformVideoDecoder:false`, in this lab, including the default-decode camera run. The original second crash already had accelerated video decoding disabled. VA-API/NVDEC is therefore not a required trigger, and disabling it is not a proven cure. NVENC in native capture logs is the encoder and does not establish Chromium's replay decoder.
- **Webcam capture/MediaRecorder:** exercised with real synthetic-camera files; not necessary for the controlled crash. Physical camera behavior was deliberately not tested.
- **Two replay renderers:** both pill and Studio can load the same paused clip; this duplicates decoder work. It is neither a file corruption mechanism nor necessary for the controlled failure. `pre-pressure-media.jsonl` shows both loading the same file. `default-camera-media.json` shows a HUD video with `hidden:true`, `ready:4`, and software-decoder properties while its replay has never been opened.
- **Memory pressure:** allocation failure is established. Which original resource prevented allocation is not. No new cgroup OOM kill occurred. The normal test runs had substantially more headroom than the earlier saturated lab; artificial RLIMIT_DATA exhaustion is a different resource boundary. Global commit pressure, cgroup pressure, and an allocator-specific failure cannot be distinguished using the truncated originals.

The empty black private desktop explains black screen pixels in some screenshots from this pass. These are not a reproduction of the earlier black/hung Studio defect. The final camera/default run additionally uses a bright private Kitty fixture. `final-default-desktop.png` visibly shows the recorded green terminal in Studio; `final-media-summary.json` shows both HUD and Studio at readyState 4. The first and last synthetic camera originals fully decode as 3840×2160 H.264 (`synthetic-camera-file-check.json`). The earlier screenshot/control-timeout hang remains a separate unresolved observation; sharing its root cause with the OOMs is not established.

## Regression assessment

**The allocator abort and hidden-pill decode path are pre-existing; a Studio-induced increase in failure frequency remains unproven.** The old build reproduces the Media-thread OOM under the decoder-specific fault, with no Studio. `HudClipPeek.tsx` has no diff between a9e39d01 and e750a47d (`hud-replay-commit-diff.txt` is empty; `hud-replay-blob-ids.txt` records identical Git blob IDs).

Studio adds another replay renderer and automatic model work, so it can increase aggregate memory demand. This is a plausible pressure amplifier, not proof that e750a47d introduced the original allocation failure. Clean bounded runs in both builds cannot establish equal long-run crash rates.

## Concrete fix recommendation

1. **Unload closed replay media.** At `src/components/launch/HudClipPeek.tsx:333` and `:347`, mount the screen/camera `<video>` elements only while `open` is true. Keep the surrounding component/hooks if needed for keyboard/state behavior. `hidden={!open}` at `:324` currently leaves `src` and `preload="auto"` active. `LaunchWindow.tsx:2420` mounts this component at every completed pause, even when the user never requested replay. On close/unmount, pause and release the source; if retaining the DOM node, remove `src`/`srcObject` and call `load()` to abort the media pipeline. Verify reopening/seeking still works. Merely checking `readyState` or catching `play()` cannot catch a native allocator abort.
2. **Apply the same lifetime rule to Studio.** At `src/components/studio/StudioReplay.tsx:180` and `:195`, load media only when that replay surface is usable/visible; release it when switching back to the pill or entering capture preparation. Avoid keeping a paused, hidden decoder alive just to preserve a playhead; preserve the position in state instead. This reduces demand without discarding valid short clips.
3. **Recover when the control owner dies.** Add HUD `render-process-gone` handling at `electron/windows.ts:687` / main-process window wiring. Stop/finalize native capture through its existing service, retain durable originals, publish a recoverable failure, and route to recovery/review. Clear/reject outstanding Studio commands at `electron/studio/studioController.ts:107` and `src/components/studio/StudioWindow.tsx:67`. A renderer whose camera stream died cannot safely resume by pretending it still owns that stream.

Items 1–2 are supported resource-reduction mitigations, not a verified elimination of the unexplained original allocation failure. Item 3 fixes the independently demonstrated permanent loss of controls. The other agent's in-progress crash handling was not built or tested by this diagnosis.

Do not add a 500 ms clip rejection, silently drop originals, or disable Linux decode globally based on this evidence. Raising/removing the shared lab budget is also not an application fix.

## Lab verification recipe

Use a new lab-owned profile for each comparison. Keep the default and disabled-decode camera launches identical except for the decode flag. Keep mic/model fixed within each pair. Do not reuse the artificial lowered-limit renderer as a normal baseline.

```bash
agent-lab start crash-diag
agent-lab launch crash-diag -- /absolute/path/to/fixed/Klippt.AppImage \
  --enable-logging=stderr --v=0 --remote-debugging-port=19361
# Journal: journalctl --user -u <printed-client-unit> --no-pager
# All app commands stay lab-scoped:
agent-lab run crash-diag -- /home/olle/.local/bin/klippt-agent windows
# Resolve HUD by kind; Source -> private Share Virtual-0 -> Record.
python3 artifacts/studio-bughunt-2026-10-30/crash/matrix.py fixed-tiny 100 .05
```

- First confirm **zero HUD replay players while the replay is closed**, using CDP `Media.enable` and DOM inspection, across at least 100 pauses. Open replay, verify one healthy player and playback, close it, verify decoder teardown. `capture-media.cjs` records properties; `k.py` drives only this lab.
- Repeat with Studio opened/closed, camera off/on using fake-media flags, copied model plus private speech, and default/disabled accelerated decode. Check actual file durations, decoded webcam files, bright replay pixels, all controls, transcript output, and stable process memory after warmup. Record counts and memory samples rather than treating one clean run as proof.
- For deterministic failure coverage, use `decoder-limit-gdb.py` then GDB as below. The helper checks the target cgroup and operates only on the lab HUD. At the decoder breakpoint it injects a soft memory limit. Offsets are valid **only for this Electron build ID**; regenerate symbols/addresses after an Electron upgrade.

```bash
python3 artifacts/studio-bughunt-2026-10-30/crash/decoder-limit-gdb.py
gdb -batch -x artifacts/studio-bughunt-2026-10-30/crash/decoder-limit.gdb
```

- Before the lazy-media fix, the decoder breakpoint can be reached by an ordinary completed pause with replay closed. After the fix, closed replay must not reach it. Opening replay under forced allocation exhaustion may still terminate Chromium; that test should now demonstrate main-process recovery and durable media instead of permanently disabled Studio buttons. This distinguishes allocation avoidance from crash recovery.
- For a future natural recurrence, attach the OOM breakpoint with an explicit frame-pointer walk **without** the RLIMIT_DATA-injection breakpoint, and sample cgroup memory plus `/proc/meminfo`/limits. That is the outstanding step needed to identify why the original kernel/allocator allocation failed.
- Finish with `agent-lab stop crash-diag`. All diagnostic app/helper signals and input stay in the lab. The only host-profile access in this pass was copying the specified speech model. No source/build changes or application test gates were needed for this documentation-only investigation.

## Handoff verification

129 natural rapid cycles completed without renderer death (`completed-cycles.json`). The controlled previous-build decoder allocation fault hit the OOM breakpoint. `npm run docs:check` passed (`docs-check.txt`). The private lab was stopped and its stopped state checked (`shutdown.txt`). No application source changes or code-test claims are part of this diagnosis.
