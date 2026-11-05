Recording hardening, real failure tests and installed-package evidence: [Linux recording hardening](docs/recording-hardening-2026-11-05.md).
Mac Record delivery: missing/loading owner reproduced; writer-confirmed requests now
create the owner and wait for loaded controls. Signed real-window and CLI evidence,
review fixes and limits: [Record delivery investigation](docs/studio-record-drop-investigation.md).
Sync fix already exists on main as `291af252c` and `6b09a4fb5`; no duplicate patch.

Recording window regressions and private desktop test gates: [recording windows](docs/recording-window-regressions.md).

Review handoff patch: canvas readiness now requires the current take's composed screen,
with native pre-decode publication suppressed. Local build and automated gates are recorded
in [Studio review frame readiness](docs/studio-review-frame-readiness.md).
Parent still needs cold/warm screen-capture verification; the installed app is untouched.

# Klippt Linux handoff — October 26, 2026

Current worktree: `/home/olle/dev/screenrec-linux`, branch `feat/linux-port`.
Original `/home/olle/dev/screenrec` remains untouched. Draft PR:
https://github.com/oEdyb/record/pull/1.

Parity pass of November 1, 2026 (branch `linux/parity-2026-11-01`, based on this PR's head,
unpushed): checklist, three fixes and five blockers in
[Linux parity](docs/linux-parity-2026-11-01.md). No capture was run in that pass.

The current candidate, evidence and remaining gates are maintained in
[Linux acceptance](docs/linux-port-acceptance-2026-10-26.md). Read that record
before running another check or packaging pass. The
[implementation log](docs/linux-port-2026-10-26.md) is chronological evidence;
older “current” builds and limitations describe their own checkpoint.

Linux shares the recording lifecycle, projects, review and export with macOS.
Its Rust helper owns portal/PipeWire capture, per-clip writers and isolated
audio originals; renderer camera files have a durable clip ledger. Windows
remains later work behind the same capture contract. Preserve compatibility
identifiers and persisted data; no global Mac-name cleanup is needed to ship.

## Current delivery

Source follow-up in the current candidate: Linux Record restores compatible portal grants;
Settings → Source chooses afresh before recording or while paused. Private KWin
native and built-app checks pass. Actual Niri grant reuse also passes after
registering the portable AppImage with its user desktop launcher.
See [focused evidence](artifacts/linux-port-2026-10-26/remembered-source/README.md).
The normal-FUSE AppImage passed private OS-driven Source → Record without another
picker → Stop/review; its 2.35-second native clip fully decodes.

Latest portable AppImage: `e0659bff`, `release/linux-port-20261028-e0659bff/`.
Recording readiness check corrected Linux's Default microphone sentinel mapping.
Olle's saved raw Xstrm selection still reproduced EasyEffects peer substitution;
only Klippt's input preference changed to explicitly verified Easy Effects Source.
Final normal mounted app passes actual webcam + actual processed mic + system
sound, Pause/Continue, review, eight decoded originals and private marker checks.
89 affected tests, both typechecks, lint, Ubuntu-floor build and package policy
pass. No full suite. Physical speaking levels/lip-sync remain unverified; lab
resource-limit stalls are documented, not counted as passes.
[Readiness evidence](artifacts/linux-port-2026-10-28/recording-readiness/README.md).
The prior `a6aad6b5` actual two-monitor preview/visibility pass remains applicable
to the unchanged preview code; [evidence](artifacts/linux-port-2026-10-27/second-monitor-preview/README.md).

Previous portable AppImage: `cde7e19b5a74fb3b5c4bbf22cfaeab66e27d3ffa`,
`release/linux-port-20261027-cde7e19b/`. Linux now creates the shared live camera
monitor and hides it with the pill during monitor/unknown capture, preserving
separate camera recording. Explicit Easy Effects Source selection resolves its
virtual node; actual wrong-source rejection remains intact. 46 affected tests,
both typechecks and portable package policy pass; normal mounted camera workflow
passes with synthetic video. Physical OBSBOT test returned EBUSY in the running
user app, which was left untouched. Fully quit/reopen and intentionally select
Easy Effects Source when using its processing. Local Niri camera placement/focus
rule is installed and privately verified. [Evidence](artifacts/linux-port-2026-10-27/camera-virtual-audio/README.md).

Previous portable AppImage: `7cfe5453559965211849fdc3ea8b6ae143d39d44`,
`release/linux-port-20261027-7cfe5453/`. Monitor/unknown-source capture hides the
pill before Start/Continue; acknowledged Pause restores it. Niri shortcuts:
Ctrl+Alt+R Pause/Continue, Ctrl+Alt+S Stop, Ctrl+Alt+O controls. Koett keeps
Ctrl+Shift+Space; actual concurrent private microphone capture passes. The
launcher and validated Niri bindings are installed; fully quit/reopen old builds.
Settings opening stays below the stationary pill in private nested Niri.
[Focused evidence](artifacts/linux-port-2026-10-27/recording-controls/README.md).
The preceding `8c3838db` compact toast correction remains included.
The earlier `85a25a49` corrected dragging and Source access. User-reported HUD issues corrected: native
logo dragging survives platform initialization and the visible Source chip opens
the real portal. The normal AppImage passed private compositor dragging and
chooser/cancellation; 137 affected tests and both typechecks pass. The launcher
points to this build. A validated local Niri rule removes the reported blue focus
background for floating Klippt windows. Exact Niri appearance/dragging awaits the
user reopening it. [Evidence](artifacts/linux-port-2026-10-27/hud-fixes/README.md).
All 27 regular ELFs match `a4f92422`, retaining native media evidence.

Previous four-format inventory: `release/linux-port-20261026-a4f92422/`. Its Ubuntu-floor formats and
normal mounted package policy pass. The addon is byte-identical to `6bdd95af`,
whose packaged export preserved the real
four-source take without an override, restoring the screen's two missing frames:
871 muxer-reported frames/14.516 s, full decoding, correct audio and unchanged
originals. Normal CLI exit is 0. This closes the final software candidate checkpoint.

Four-source handoff evidence is in
`artifacts/linux-port-2026-10-26/four-source-export/`: two clips, eight original
hashes preserved, isolated 660/440 Hz audio, correct OTIO/FCPXML tracks, and a
reproduced/fixed rendered-tail mismatch. No full-suite rerun.

Actual Niri everyday check also passes the focused recording/review/export
journey: two clips, six identical originals, and a fully decodable 740-frame /
12.333-second One video. Default mic PCM was nearly silent, so spoken-voice
quality remains unverified. [Evidence](artifacts/linux-port-2026-10-26/niri-everyday/README.md).

## What is left, in priority order

1. Monitor auto-hide and noncolliding controls pass private packaged checks;
   exact physical Niri input and monitor placement remain unverified. Do not
   claim invisible own-window exclusion or a second-monitor exemption. The
   user confirmed the cursor is present; that investigation is closed.
2. Spoken microphone quality and calibrated device timing remain unverified.
   A short actual OBSBOT packaged recording now passes; no timing calibration. The authorized actual-Niri recording, Pause/Continue,
   review, both exports and normal Quit have passed within their stated scope.
3. Keep the finite acceptance record current. No routine full suites, hour soaks
   or four-format rebuilds without a concrete changed risk.
4. Broader GPU/desktops, physical timing and Mac regression are compatibility
   gates. Windows is later work. Do not turn those into indefinite synthetic
   retesting or a claim of universal parity.

Global Pause/Continue works in the private lab. Open App's callback arrives but
Wayland focus is denied; KDE shortcut admission becomes inactive after relaunch
despite listed bindings. The independent Electron control reproduces both.
Keep the limitation explicit; do not rewrite registration without new evidence.
The candidate uses conservative auto-hide instead of own-window exclusion.
Owned Niri HUD activation and local compositor bindings address control access
without claiming the independent Electron backend issue itself is repaired.

## Working rules

- Only affected tests. Linux GUI/input/audio/portal checks use `agent-lab`; read
  `~/.local/share/agent-lab/README.md`. Stop the owned lab after testing.
- The private lab and owned build container are stopped. Never operate the host
  pointer, windows, clipboard or audio for routine verification.
- No public release or merge to main is authorized by a successful local build.
  CI, Diagnostic artifact and Supply chain workflows are currently disabled by
  Olle; earlier runs hit the billing/spending block. Keep that external gate
  explicit and do not re-enable workflows without instruction.
- The native helper's strict Clippy passes at its checkpoint. Compositor strict
  Clippy has existing generated-binding/unused-code findings; do not suppress
  them or call that gate green. Formatting and scoped tests are separate evidence.

The independent direction review found the architecture sound and recommended
finishing a usable candidate instead of extending synthetic verification loops.
Historical Mac/editor/CLI handoffs remain in
[the previous handoff](https://github.com/oEdyb/record/blob/f8ae4c1ef1097c98c7204e10e85df1759d04763a/HANDOFF.md).
Current product and compatibility rules remain in `AGENTS.md` and
`technical-documentation/product-behavior.md`.

Reusable lessons and development-skill routing: [Linux porting playbook](docs/linux-porting-playbook.md).

## Clean dialogue, slice 1 (October 30, 2026)

Clean-cut source handoff now derives `clean-dialogue.wav` from isolated microphones at
48 kHz / 24-bit, retaining channel count. Its sample map comes directly from the
60 fps microphone plan (800 samples/frame), including offset and gaps. Only the
clean-cut OTIO adds Clean dialogue and disables replaced original microphone clips;
full OTIO, FCPXML and original media stay unchanged. No mixed-audio fallback.

The pure plan centers a 20 ms equal-power blend on the frame-locked seam (a blind
listening test rated a shift toward the energy minimum no better). Speech-neighbor gap measurements are
not available on this export input, so it uses the agreed 20 ms fallback. Fades
are bounded to one third of adjacent pieces. Handles must stay inside the pre-clean-cut project's retained frame ranges;
otherwise use a 3 ms fade out/in without borrowing. Seam-local peak attenuation
prevents blend overload. Decoding spools float PCM to temporary disk, with bounded
sample windows and incremental output, abort cleanup, and no whole-take PCM in RAM.
Different microphone channel counts fail explicitly rather than silently downmixing;
classic WAV output fails above its 4 GiB limit. Allow staging disk space for decoded
float sources as well as the derived WAV.

Contracts checked: [OTIO format](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html),
[OTIO enabled serialization](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/main/src/opentimelineio/item.cpp),
existing bundled FFmpeg runner and timeline writer, and read-only `seam/framelock.py`
in the STT bakeoff. Verified in Resolve Studio 21.1 on a real 62 s recording: imported
with the source folder, all clips link, original microphone clips arrive disabled, and the
Clean dialogue clip matches the microphone sample for sample at every piece.

## Forced aligner download (October 31, 2026)

Clean cut never aligned on installed Macs: `alignerModels` looked for a model only a dev
script (`scripts/convert-wav2vec2-coreml.py`) produced, in a folder the app does not read.
The app now downloads `ssmall256/wav2vec2-base-960h-ctc-coreml` (MIT, torchaudio
WAV2VEC2_ASR_BASE_960H, compiled Core ML, about 189 MB, pinned revision and SHA-256) to
`stt-models/wav2vec2-base-960h-ctc-coreml` on the first Clean cut, writes `labels.json`
beside it, and falls back to recognizer times when the download fails. The helper now reads
the model's input and output names from `labels.json`. On the same recording, its times
match the dev conversion for 95% of words, at most 20 ms apart; a word Parakeet stretched over
4.5 s is placed at 0.2 s and a 1.7 s silence is cut. Add the model to the release notices.

Next: in-app review playback parity; move user cuts to energy minima through
main-process IPC; clean-cut FCPXML lane; system-audio stems; generative healing.
A real desktop capture and editor import/listening pass remain required; synthetic
media evidence alone does not establish those gates.

Slice verification: both TypeScript checks and Biome pass. Targeted planner,
renderer and source-handoff tests: 41 passed, including real bundled-FFmpeg
stereo PCM equality outside blends, duration/offset, overload and abort cleanup.
Synthetic complete handoff verifies originals, disabled microphone clips only in
the clean OTIO, derived manifest/README and one-second WAV duration (FFmpeg;
ffprobe when available). Full suite run: 3,209 passed, eight failed, 15 skipped;
failures are unchanged dependency-approval/Cargo graph/release-inventory policy
checks (missing parakeet-linux policy coverage). Native-addon and atomic-export
failures did not occur in this run. No application installation or commits.

## Separate takes provenance

Handoff v4 carries stable recording ids in media names, per-clip provenance,
full/clean edit maps, explicit stream offsets, hashes and ffprobe stream facts.
Cursor JSON is copied unchanged with extracted embedded PNGs and clock/coordinate
contracts. Clean dialogue uses sample-precision mic offsets with frame-locked lengths.
Existing Clean dialogue and aligner-download changes are preserved; no commit or reset.
Real-project evidence is in `/tmp/klippt-provenance/evidence.json`; source userData was read only.

Provenance verification: both TypeScript gates and `biome check electron` pass;
focused export/cleanCut/stt run: 221 passed, 3 skipped. Real cached clean cut:
11 pieces, 3 markers; exact 89.800458 ms mic offset gives source sample 48490
at screen frame 66, cross-correlation lag 0 (8,000 samples). Five original
files match SHA-256. Full suite has 8 supply-chain policy failures across
check-approved-dependencies, check-cargo-graphs and generate-release-inventory:
parakeet-linux inputs are missing from the existing approval/graph policies.
No editor import, packaged-app or new desktop capture validation was performed.


## Studio transitions (October 31, 2026)

Branch `t3/smooth-window-transitions`: Finish waits for token-matched review-ready
or 1500 ms, preserves Studio bounds, and fades only after review can show. Studio
mode survives review without a pill flash. Camera/replay surfaces wait for media;
native fades retarget rapid reversals. Implementation, sources and gate evidence:
[Studio transitions](docs/studio-window-transitions-2026-10-31.md).
Both TypeScript checks and touched-source Biome pass; 75 targeted tests pass.
Full suite with Homebrew FFmpeg: 3326 passed, 13 failed (eight known policy failures,
five export tests missing compositor_view.node). Parent owns packaging, real
60 fps transition/capture-exclusion validation and Finish/re-record cycles.
No installed app was changed or driven.
