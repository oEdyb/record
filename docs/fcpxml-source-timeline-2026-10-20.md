# Final Cut Pro source timeline

## Acceptance

- Separate takes writes `timeline.fcpxml` beside `timeline.otio` and the unchanged media.
- Both files come from one frame-grid plan. No second sync or rounding calculation exists.
- Screen clips form the primary storyline. Camera, microphone, system audio and unidentified
  audio are connected clips at the same timeline frames as the OTIO tracks.
- Media stays byte-identical. `timeline.otio` output is unchanged.
- The document validates against Apple's FCPXML 1.10 DTD.

## References and decisions

- [FCPXML Reference](https://developer.apple.com/documentation/professional-video-applications/fcpxml-reference)
  and its [DTD page](https://developer.apple.com/documentation/professional-video-applications/document-type-definition)
  (1.10, the latest Apple publishes). Final Cut rejects a document that fails the DTD.
- [media-rep](https://developer.apple.com/documentation/professional-video-applications/media-rep):
  `src` may be relative to the FCPXML document (`./file.mov`), so the folder stays movable.
- [Story Elements](https://developer.apple.com/documentation/professional-video-applications/story-elements)
  and [Timing Attributes](https://developer.apple.com/documentation/professional-video-applications/timing-attributes):
  anchored items take a lane and an offset in the base element's local time; times are rational
  seconds and should be whole timeline frames.
- [format](https://developer.apple.com/documentation/professional-video-applications/format):
  audio-only assets use `FFFrameRateUndefined`; a custom format describes the sequence.
- Premiere Pro: Adobe's community announcement and a third-party doc report OTIO import in
  Premiere 25.6 and later. No source showed native FCPXML import. Premiere therefore uses the
  existing `timeline.otio`; no third format.

`planSourceTimeline` in `sourceTimeline.ts` now owns every placement: per track, a list of gaps
and clips in whole 60 fps frames. `buildSourceTimeline` maps it to OTIO; a golden comparison of
two fixtures (missing camera, short audio, unidentified audio, sub-frame span, 30 fractional
cuts) produced byte-identical OTIO JSON before and after. Gap and omission warnings now say
"the timelines" instead of naming one file.

`sourceTimelineFcpxml.ts` maps the same plan to FCPXML. The screen track's items become the
spine (`asset-clip` or `gap`). Every other clip anchors to the spine piece holding its first
frame, at that piece's local start plus the frame delta. Lanes: camera 1, microphone −1
(`dialogue`), system −2 (`effects`), unidentified −3 with no role. Screen and camera use
`srcEnable="video"`; audio clips use `srcEnable="audio"`, so a screen file's embedded audio is
placed only on the unidentified lane when no standalone originals exist. The sequence is a custom
60 fps format at the first screen's pixel size.

## Verification

Evidence: `artifacts/fcpxml-handoff-2026-10-20/` (git-ignored).

- Ran `exportSourceHandoff` with the bundled FFmpeg on a real October 9 project: nine
  Pause/Continue takes, each with camera, microphone and system audio (147.8 s), plus one added
  5-second cut inside take 7. The original project file was not modified.
- All 36 exported media files match their originals by SHA-256.
- The real `timeline.fcpxml` (40 clips, 4 lanes) and a synthetic one passed `xmllint --dtdvalid`
  against the 1.10 DTD from Apple's DTD page.
- Unit tests check rational time output, reject sub-frame values, and resolve every FCPXML clip
  to its absolute frame and source start, matching the plan clip for clip. Cases: two-take cuts,
  camera lead, late and short camera, a short screen tail that becomes a spine gap, unidentified
  audio, 100 fractional cuts without drift, and escaping.

## Limits

- **Not imported into Final Cut Pro or Premiere Pro.** Neither is installed on this Mac. No
  screenshots of an imported timeline exist yet.
- Camera media at 30 fps can start on a 1/60 s boundary; Final Cut may round that to a camera frame.
- Exact sub-frame source offsets are kept only in OTIO metadata, not in FCPXML.
- Roles use Final Cut's built-in Dialogue and Effects. Custom role names were not tried.
- Connected clips move with the screen clip they anchor to; a camera or audio clip that runs past
  its screen piece still anchors to that piece.
