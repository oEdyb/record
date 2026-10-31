# Studio window and media transitions

Implementation branch: `t3/smooth-window-transitions`.

Finish leaves Studio up while the hidden review consumes the take. A per-handoff token,
validated against the review's webContents, gates the explicit `review-ready` signal.
The renderer waits for import, current video data and two animation frames. Main shows
review in Studio's bounds before Studio fades. Both sides have a 1500 ms escape path;
a finishing review retains its loading cover until current video data exists, even if
that deadline expires. Opening Studio cancels pending handoffs and late signals.

Studio ownership now survives Finish. Returning from review creates the HUD hidden,
so its ready-to-show handler cannot flash the pill. No deferred HUD callback reopens
Studio after the user has reversed their choice.

Native opacity uses 180 ms entry/Finish and 120 ms exit with cubic ease-out, sampled
at 16 ms intervals. These match the existing 180/120 ms design tokens and keep exits
short. Content scales from .98 about the pill's position using the existing pill's
cubic-bezier(.23, 1, .32, 1). Opacity retargets its current value and cancels stale
completion callbacks. Focus changes synchronously. The outgoing pill stays visible
until entry completes, avoiding an empty frame. Capture guards bypass all fades.
macOS's current reduced-motion preference bypasses native animation; CSS reduced
motion bypasses all content animation. Linux native window swaps stay instant.

Camera hides its surface and Live badge until a bitmap has been drawn. Replay hides
the entire stage, including the recorded camera overlay, until the screen video's
loadeddata/seeked event. Each new source/load resets this gate. Reveals and local
layout entrances use Studio's existing 120 ms ease, opacity and transforms only.

Sources checked before implementation:
- Electron BrowserWindow: https://www.electronjs.org/docs/latest/api/browser-window
  ready-to-show means the page painted, not that recording import/media finished;
  getOpacity/setOpacity are macOS/Windows APIs, so Linux uses an instant swap.
- Video frame presentation: https://developer.mozilla.org/en-US/docs/Web/API/HTMLVideoElement/requestVideoFrameCallback
  Frame submission and metadata are distinct. Readiness checks use drawable current
  data followed by paint, rather than metadata alone.
- Existing pill motion: commit `23fd616647801b27cba98548400676cf13d45a05`.

Verification: both TypeScript checks pass; targeted Studio/controller/review tests:
75 passed. Biome passes on touched source files. No strings changed. Full suite:
Default environment: 3319 passed, 15 skipped, 9 failed (the eight known
dependency/Cargo/inventory policy failures plus a missing worktree FFmpeg fixture).
With OPENSCREEN_FFMPEG_PATH=/opt/homebrew/bin/ffmpeg: 3326 passed, 5 skipped,
13 failed: the eight policy failures plus five recordingFastExport media tests
requiring the absent worktree compositor_view.node. Provenance and source-handoff
media tests pass with Homebrew FFmpeg. A run against the other checkout's staged
FFmpeg failed its media tests because its runtime staging is unavailable here.
No source changes were made to resolve those unrelated environment failures.

No installation, running-app control, audio playback or new desktop capture was
performed. Parent must package and inspect Finish/re-record, rapid reversal,
reduced motion, frame timing and capture exclusion with a real 60 fps capture.
