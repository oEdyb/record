# Synchronized source timeline

## Acceptance

- Separate takes exports an importable `timeline.otio` beside the original media.
- Resolve imports screen V1, camera V2, microphone A1 and system A2 without mixed audio doubling.
- Retained spans and take order agree across all tracks. Camera offsets produce gaps or source trims, never negative source times.
- Missing sources leave gaps; short media does not shift later clips. Fractional cuts use one shared frame grid without accumulating rounding drift.
- Media links resolve from the exported folder, including after moving it. Original recordings and projects remain unchanged.
- Existing source recovery and incomplete-export cleanup remain intact. Automated checks and an isolated Resolve import verify the result.

Scope: source handoff service, focused OTIO writer and tests, source export panel and contract, product behavior and handoff docs. Test artifacts stay under `artifacts/resolve-handoff-2026-09-21/`.

## References and decisions

- [OTIO format](https://opentimelineio.readthedocs.io/en/latest/tutorials/otio-file-format-specification.html): typed schema objects, rational time, track gaps and external media references.
- [OTIO 0.18.1 Clip implementation](https://github.com/AcademySoftwareFoundation/OpenTimelineIO/blob/v0.18.1/src/opentimelineio/clip.cpp): versioned media-reference serialization. Use a restricted writer for this fixed interchange subset; no general parser or new Python runtime requirement. Validate against Resolve's native OTIO reader and exporter.
- Resolve Studio 21.1 local scripting reference: `ImportTimelineFromFile` accepts OTIO; read imported track items to verify placements and source ranges.

This is an editable source timeline. It includes cuts and synchronization, with original-speed sources. Klippt's layouts, zooms, captions, cursor effects, speed effects, B-roll and audio processing are excluded and disclosed.

## Implementation

`sourceTimeline.ts` writes the fixed OTIO interchange subset without changing media. The timeline
uses 60 fps, matching recording and export defaults. It does not infer an editing frame rate from
variable-frame-rate media averages. Boundaries round on a shared cumulative clock with a small
floating-point tie tolerance. Camera time subtracts its recorded start and offset, then intersects
the available source range. Gaps fill missing optional tracks and short stream tails.

The export probes decoded WAV durations independently. Screen and camera references appear only
on video tracks; no embedded mixed audio is placed on the audio tracks. Untagged audio gets a
separate, explicitly unidentified track. Full camera media remains available even if hidden in
Klippt. Camera-file audio is copied as a source but is not added to the timeline.

Relative media names keep the folder portable. The README gives timeline import instructions and
limitations. The manifest includes the timeline filename and rate and remains the last completion
write. Failed preparation removes only the newly created export folder.

Review caught a provisional-duration regression: bounding already trimmed fragments rejected a
valid trim extending beyond actual media. The service now excludes fully removed original clips,
bounds the remaining originals, then reapplies their trims. An entirely zero-frame edit is rejected
with an actionable message instead of returning an empty timeline. Both cases have regression tests.

## Verification

Evidence: `artifacts/resolve-handoff-2026-09-21/`.

- Development Electron app: recorded a fresh 4.517-second Mac screen, camera, microphone and system
  audio take. Playback advanced. Actual Separate takes button exported all four files and OTIO;
  success and ready screenshots were inspected. Cancellation cleared success without claiming a new export.
- `live-export-report.json` records the successful export. Earlier harness attempts exposed a stale
  system-audio preference in direct test setup and a greedy output-path expression; reran through
  the visible system-audio control and corrected the harness. These were not OTIO export failures.
- Resolve Studio 21.1.0.17 imported the fresh export with two video and two audio tracks. Camera
  source start was 55/60 seconds for a recorded 911 ms lead. Audio referenced only isolated WAVs.
  Playback advanced from 00:00:01:00 to 00:00:04:31. Screen and camera stills decoded successfully.
- A separate two-take real-media fixture checked cuts at 2 and 3 seconds, a 4-second source in-point,
  a 775 ms camera lead and a 500 ms camera delay. Track positions matched the OTIO values; the
  delayed camera started at frame 210 while its screen and audio started at frame 180.
- Moved the fixture folder to a path containing spaces and Unicode before import. All media linked
  to the moved folder without search options. Resolve selected 60 fps from OTIO despite a 24 fps
  default project. `resolve-cuts-report.json` contains checked source and timeline positions.
- Full suite: 3,793 passed, one existing skip across 356 files. Both typechecks, lint, i18n and docs
  passed. Lint retains two existing warnings. Focused timeline/handoff tests passed after review fixes.
- Independent review finished with no remaining findings. Resolve's original Swarm project and
  `20 Full edit — YouTube audio master` timeline were restored after testing.

## Limits

The installed `/Applications/Klippt.app` was not replaced. No new native helper source or capture
format was introduced. This change was exercised in the development app. Windows, Linux, other
editors and older Resolve releases were not exercised. Audio is decoded from existing AAC capture;
24-bit WAV export does not restore information lost during capture encoding. Visual effects and
speed changes are not transferred. Source positions are frame-aligned, not sample-accurate camera
offsets. Resolve does not automatically link the four items as one editing group.
