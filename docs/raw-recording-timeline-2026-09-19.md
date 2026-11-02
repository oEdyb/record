# Raw recordings and a calm timeline

Requested behavior: new recordings keep their takes without generated edits. Automatic
direction runs from an explicit action. Captions use one continuous strip. B-roll has
real thumbnails directly above the source audio waveform. Existing edits remain readable.

## Acceptance

1. Import both clip sessions and single files without direction or microphone analysis.
2. Explicit automatic editing still generates editable regions and supports undo.
3. New projects start without inherited captions, framing effects or audio processing.
4. Caption seeking/correction works from one strip, including after trims and zooming.
5. B-roll thumbnails and durations match the retained timeline; clicking seeks correctly.
6. Verify the Mac app with real media, focused tests, full unit suite and static checks.

Expected scope: recordingImport, new-project preferences, automatic direction controls,
CaptionTrack, a new B-roll track/thumbnail helper, V4Timeline, matching tests, locale copy,
and product behavior. Preserve unrelated changes in this working checkout.

Visual constraints: existing neutral surfaces, typography and accent tokens; one 28px
caption rail without individual rounded boxes or disclosure controls; 66px B-roll row
above the 66px audio row; no new color palette, decorative controls or empty lanes.

References: React 18.3.1 is installed. React's event/effect guidance places explicit
generation in user actions, not mount effects:
https://react.dev/learn/you-might-not-need-an-effect
Existing projectVideoOverlays and timeline projection are the timing authority.
The export renderer currently always renders; raw defaults alone do not prove a
stream-copy export. The confirmed separate-take source handoff is implemented below.

## Evidence

- Full suite: 354 files; 3,774 passed and one existing skip. Both typechecks,
  lint, i18n and docs checks passed. Logs: `artifacts/raw-recording-timeline-2026-09-19/gates/sources-final/`.
- Focused import/preferences/timeline checks passed. Tests that expected automatic
  import edits or inherited effects now assert the explicitly requested plain defaults.
  Existing rendered-export tests select One video before exercising that unchanged flow.
- Real Mac Electron 44.1.0 development build, launched from
  `dist-electron/bootstrap.js`, with private test profiles. Original test project SHA-256
  stayed `8d975e72be0f7c40bdccf01028c5cd3f3ec73cf7e3f6e4d129bba489e095dac8`.
- Existing 11-minute project cloned through the CLI: 988 captions use one strip;
  39 real B-roll thumbnails loaded. Caption click opened correction and sought to
  speech. Keyboard activation of B-roll sought correctly. Screenshots inspected at
  1710 and 1024 px; export inspected at the Mac minimum of 800 px. No phone target.
- Real recorded-media import: both single-file and two-take sessions start with zero
  zooms/trims, captions disabled, no frame effects or audio mastering, and source ratio.
  The two-take fixture retained both camera links and original offsets. Fixture paths
  were canonicalized after the first fixture used inconsistent `/tmp` aliases.
- Two real takes (61.683 seconds total): source handoff completed in 1,622 ms on this
  Mac. Eight media files: two screen MP4s, two camera MOVs, two microphone WAVs, and
  two system WAVs. Screen SHA-256 values match originals. Three decoded camera frames
  at each of 0, 12 and 29 seconds match after remux. Encoded packet hashes differ
  between container framing, so they are not used as a pixel-equivalence claim.
  See `artifacts/raw-recording-timeline-2026-09-19/source-handoff-proof.json`.
- Independent review found inherited canvas shape and nonzero-timestamp audio issues.
  Both were fixed. A real FFmpeg regression verifies a one-second H.264 MKV starting
  at PTS 5, microphone delayed 200 ms, one-second MOV/WAV output, leading silence,
  and one-second manifest bounds. Final review: no findings.
- Web Design Guidelines review: native buttons, accessible cue/source labels,
  visible keyboard focus, decorative image alt text, clipped long names, and
  offscreen media culling. Thumbnail geometry is fixed by its positioned parent.
  Real Mac checks cover idle, busy, canceled, error, success and compact export states.
- Build: `npm run build-vite` passed. Packaging/signing/install was not run. No native
  capture helper changed, no fresh desktop recording or new continuous render was
  made. Existing real recordings exercised import, preview and source handoff. The
  One video path was checked through its UI and existing export flow tests.
- The handoff is source media plus agent timing data; it is not a Resolve/FCPXML
  timeline. Partial trims remain in source media and are described in the manifest.
  Existing visual edits and editable cursor overlays are not baked into sources.
  Some legacy codecs still need conversion in the destination editor. Large-project
  source-export timing and actual import of this new bundle into Resolve are unverified.
- No installed app replacement, commit, push, or change to Resolve. The CLI remains.
  The vault routing check reports eight pre-existing unregistered directories;
  `artifacts/raw-recording-timeline-2026-09-19/vault-check.log` records them.

### Visual evidence

- `artifacts/raw-recording-timeline-2026-09-19/timeline-final-wide.png`
- `artifacts/raw-recording-timeline-2026-09-19/timeline-final-zoom.png`
- `artifacts/raw-recording-timeline-2026-09-19/timeline-final-compact.png`
- `artifacts/raw-recording-timeline-2026-09-19/raw-import-wide.png`
- `artifacts/raw-recording-timeline-2026-09-19/source-export-final-wide.png`
- `artifacts/raw-recording-timeline-2026-09-19/source-export-final-800.png`
- `artifacts/raw-recording-timeline-2026-09-19/one-video-final-wide.png`

Thumbnail behavior follows currentTime seeking and canvas drawImage contracts:
https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime
https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/drawImage
Audio timing uses the pinned FFmpeg aresample contract, preserving input-relative
track delay while normalizing a nonzero container origin:
https://ffmpeg.org/ffmpeg-filters.html#aresample-1


## Separate-source handoff (confirmed during implementation)

Olle selected separate sources for Resolve. Extend this slice with a Separate takes export
surface, typed native bridge request, and main-process source handoff service. Copy
kept screen/camera recordings into a unique folder, unpack microphone/system audio
without mastering, and save take order, retained source spans, and camera sync offsets.
Do not render video or bake effects. The manifest is for the editing agent, not a
Resolve timeline interchange file. Exclude removed takes and preserve originals.
Validate all source permissions; choose the destination in a native folder dialog.

Primary contracts: Electron showOpenDialog (44.1.0 installed), Node 22 copyFile
COPYFILE_EXCL / mkdtemp, pinned FFmpeg 8.1.2 stream-copy, and the existing qac/qab
audio identity parser. Camera H.264 in WebM can be remuxed to MOV without encoding.
https://www.electronjs.org/docs/latest/api/dialog
https://nodejs.org/docs/latest-v22.x/api/fs.html
https://ffmpeg.org/ffmpeg.html#Stream-copy

Final wording: Separate takes / One video. No external-editor brand in UI.
Take boundaries come from Pause/Resume; one uninterrupted recording stays one take.

Final failure-message refinement: 10 affected tests passed, test typecheck and lint
passed again, and `build-verified.log` records the final Vite build. The final Mac
UI displayed the writable-folder recovery message and a successful retry. Test-owned
Electron instances were closed. Original recordings and test project are unchanged.
