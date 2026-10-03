# Preview quality control

Olle found the one-pixel-per-CSS-pixel preview too soft. Sharp now uses display pixel density and is the default. Performance retains the previous resolution. The compact shared AppSelect sits below the preview, uses existing monochrome tokens, and stays separate from export. No decorative separator or extra icon. Two named options limit choice overhead; a standard Radix select provides keyboard selection and visible focus.

The choice is a validated device-local preference, separate from document settings, Undo and exports. Native target resizing follows quality changes and display-density changes without recreating the decoder. A quality change during asynchronous native creation is applied when the view becomes available. Existing frame-generation guards reject responses that overlap a resize.

Primary references checked before implementation:
- [MDN devicePixelRatio](https://developer.mozilla.org/en-US/docs/Web/API/Window/devicePixelRatio): Retina canvas backing resolution and change detection with matchMedia.
- [Radix Select](https://www.radix-ui.com/primitives/docs/components/select): keyboard and controlled selection, used through existing AppSelect.
- Installed compositor source: setRect invokes resize and recomposes paused frames while retaining the decoder.

Acceptance: visible sharpness changes on real footage; switching does not reset playback; preference survives reopening; control stays accessible without covering footage; export settings remain independent.

Evidence and command logs: `artifacts/preview-quality-2026-09-10/`.

Checks: 2,961 unit tests pass, one skipped, across 286 files. App/test typechecks, i18n, lint, macOS helpers and production Vite build pass. Lint retains the existing oversized license-evidence warning. Independent review reports no findings.

Installed the signed app at `/Applications/Klippt.app`; deep strict verification passes and app/cursor designated requirements match the previous installation. The prior build remains in `~/Library/Application Support/Klippt/Archived Apps.noindex/installed-before-preview-quality-20260910.bundle-backup`.

Real Mac verification: recorded `recording-1789030387832-clip-0001.mp4`, saved and played it. Compared Sharp and Performance on the same final frame: Sharp visibly improves small desktop text. The control fits below the preview without covering footage. Keyboard selection works. Performance survives a complete quit/relaunch. Switched from Performance to Sharp during playback; transport continued to 18.13 seconds without restarting. Left the app on Sharp. Screenshots and accessibility evidence are in the artifact folder. Physical multi-display movement was not available; the density listener follows the documented matchMedia contract.

## Follow-up: resize flicker

Olle reported flicker while resizing. The resize callback changed the visible canvas backing dimensions before the native replacement frame arrived. [MDN canvas width](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/width) confirms this clears the bitmap. A deterministic regression failed because the old 2×2 frame was cleared to a new 4×4 buffer before a replacement was ready.

Removed the premature visible-canvas resize. Native target resizing still happens immediately; CSS scales the old visible frame until a validated new frame is ready. The accepted-frame path changes backing dimensions and paints in one synchronous turn. Existing stale-frame guards and bitmap cleanup remain intact. The regression covers both native delivery delay and bitmap creation delay. Independent review found no issues. Initial creation still initializes the backing buffer once.

Full suite: 2,962 passed, one skipped. Targeted hook tests: 17 passed. App/test TypeScript checks, lint and production build pass. Native sources/binaries are unchanged from the helper build verified earlier in this slice. Evidence: `artifacts/preview-resize-2026-09-10/`.

Installed and verified the follow-up build in `/Applications/Klippt.app`, preserving both permission identities. Saved a new desktop recording (`recording-1789031527288-clip-0001.mp4`) and tested dragging the preview boundary smaller while paused, then larger during playback. The frame remained visible in the captured resize states; playback advanced to 10.77 seconds. Restored the original timeline height (243.4297) and retained Sharp. Regression evidence covers the asynchronous gap between visible states. Screenshots: `drag-up.png` and `drag-playing.png`. Prior app retained as `installed-before-preview-resize-20260910.bundle-backup` in the existing archived apps location.
