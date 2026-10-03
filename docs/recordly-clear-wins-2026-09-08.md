# Clear editing wins — September 8

Implementation authorized after the Recordly source/UI audit. The selected editing features and recording camera-shadow fix are implemented, verified and installed locally.

## Scope

- Correct recognized words from a selected caption without changing the audio or timing. Use the source transcript and existing document undo/save path.
- Save and apply named visual presets. Coordinate background, screen framing decoration, camera corners and caption appearance. Preserve canvas geometry, camera placement, source crops, speech, translations, audio and timeline content.
- Replace the short-project agent preview workaround with a bounded composed still at the requested edited time. Preserve clip/trim/speed and effect time bases.
- Correct horizontal-pan shortcut help.

No Recordly code is copied. Automatic direction tuning, new detectors, video overlays, karaoke alignment and external models are outside this implementation slice.

## Design and references

Keep the existing graphite/white/steel-blue tokens, Geist UI and compact trailing inspector. Use the project Radix Popover wrapper for presets: focus management, Escape, collision boundaries and constrained height come from the installed primitive. The picker uses ordinary named rows and a nearby Save action. No new library, separate settings screen or visual theme.

Primary references inspected: [Radix Popover](https://www.radix-ui.com/primitives/docs/components/popover), [React external-store contract](https://react.dev/reference/react/useSyncExternalStore), [React state reset](https://react.dev/learn/preserving-and-resetting-state), plus the exact installed primitives and existing project-save/history contracts. Caption draft state resets when the selected source/document changes. The existing preset model has an explicit appearance allowlist and bounded versioned storage.

## Acceptance checks

1. Select a caption, correct a word and save once. Transcript and caption agree; audio and timing do not change. Undo/reload retain the expected result.
2. Switching project, caption or language cannot save a stale correction into another selection.
3. Apply and undo a preset as one document edit. Save/reuse a named preset. Preserve cuts, translations, output size and camera position.
4. A late frame in a 14-minute project renders without rendering the preceding video. Report its time, size and exact document snapshot.
5. Failed storage/rendering/saves show failure and preserve good state. Inputs remain keyboard reachable; popovers fit the editor width.
6. Inspect the changed UI on the real Mac, check native frame/render behavior, and run the combined suite before installing the verified local package.

## Evidence

- Full unit suite: **282 files passed, 2,890 tests passed, one skipped**. After final correction-form spacing/copy changes, the affected 11 tests passed again. App and test typechecks passed. Lint passed with the existing oversized Cargo evidence warning. All 12 locale trees pass key validation; new copy uses English fallback outside English. Documentation checks passed.
- Independent review found two issues and verified their fixes: source-word IDs must survive grouping (including overlap/zero-duration words), and sparse VFR seeks must not choose a future frame. No open correctness findings remain in the reviewed editing slice.
- Real Mac editor: opened a copy of the existing 20.3-second recording edit. Corrected “You” to “We”; the canvas, timeline and persisted transcript agreed. Undo restored “You”. Compared persisted documents: word identity/timing, assets and timeline were preserved. Saved/applied a named preset, reopened the editor and found it again; Clean applied as one edit and Undo restored the prior appearance. Screenshots and saved documents are under `artifacts/clear-wins-2026-09-08/`.
- The isolated test profile needed copied media beside the fixture because the normal profile's recording directory is outside its granted roots. This was a fixture permission boundary, not a preview regression. Imports create a new project under that profile's `projects/` directory; the supplied source file is preserved.
- Installed CLI proof: rendered the corrected saved project at 0.1 seconds through the signed app. The composed native frame displays “We can do this kind of”, matching the editor. See `artifacts/clear-wins-2026-09-08/installed-caption-preview.json`.
- Native still proof: a frame at **839.5167 seconds of an 840-second source** rendered at 1280×720 in **2.85 seconds**. A sparse VFR source with frames at 0 and 10 seconds correctly showed the earlier frame at 5 seconds, in **1.15 seconds**. See [native proof](../artifacts/clear-wins-2026-09-08/preview/proof.md).
- Rebuilt the Mac capture helpers and compositor. Recorded a real **19.516667-second, 3420×2214, 60 FPS H.264 desktop clip**, with cursor sidecar; stopped into the editor and observed playback advance. Microphone/system audio/camera were disabled for this capture. This is a focused smoke check, not the long creator-flow release gate.
- Packaged with the existing Developer ID and legacy bundle identity. Deep/strict code signature verification passed before and after replacement of `/Applications/Klippt.app`. The installed editor opens with Presets and Correct words; the user's existing Geist 92px caption style remains. Spotlight returns only the canonical Applications copy. Old packages are retained under `Archived Apps.noindex`. No notarization, public release or remote push occurred.

Logs use `/tmp/klippt-wins-*`. The source tree contains extensive earlier uncommitted work; this task preserves it.

## Recording camera shadow follow-up

Olle reported an extra shadow behind the recording camera monitor during verification. The real desktop screenshot reproduced a dark rectangular backing around the rounded monitor. Native `hasShadow` was already false. The two CSS shadows included an 18px offset/48px blur inside a window with only a 12px transparent gutter, so the shadow was visibly clipped at the rectangular window edge. Replaced them with one compact 3px offset/8px blur/-3px spread shadow inside the existing gutter. Monitor size, position, camera stream and recorded camera layout remain unchanged.

References: [Electron native window shadows](https://www.electronjs.org/docs/latest/api/base-window#winsethasshadowhasshadow), [CSS box shadow](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/box-shadow). The focused camera tests passed (6 tests in 2 files). Rebuilt and signed the app, verified its deep/strict signature, and replaced the same canonical Applications bundle. Compared actual desktop screenshots before and after: the rectangular shadow backing is gone, while the rounded monitor and live camera remain. Evidence: `camera-monitor-before.png` and `camera-monitor-after.png` under the same artifact directory. The screenshot check was in the ready-to-record monitor; its styling is shared during recording. No camera capture or geometry code changed.

Vault milestone links were updated. The vault checker still reports nine pre-existing unrelated issues (eight unregistered directories and one TikTok lifecycle placement); no unrelated vault cleanup was performed.
