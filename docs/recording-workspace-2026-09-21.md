# Project recording workspace

Acceptance checks:
- Editor Record opens an idle compact pill; capture starts only from the pill.
- Expand/collapse and Escape work without changing the editor insertion position.
- Each project's source, microphone, camera, format, audio and cursor choices survive switching projects and restarting.
- Missing capture sources require selection, rather than capturing another screen.
- Restoring preferences does not overwrite the selected microphone during enumeration.
- A standalone recording keeps its setup when imported into its new project.

Scope: recording setup store and IPC handlers, recorder preference readiness,
LaunchWindow layout/device restoration, focused tests, product behavior and handoff.
Existing worktree changes are preserved.

Primary sources: Electron 44.1.0 (package lock and installed types),
[desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer),
[DesktopCapturerSource](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source).
Refresh saved source identity against current sources; use stable display_id for
screens, exact ID for windows, never a same-name window. Do not enumerate Linux
portal sources on workspace entry. Hardware setup is local per-project metadata,
separate from timeline content and undo.

Implementation:
- Project setup lives in hashed local sidecar files under userData/project-recording-setups.
  Setup writes and workspace changes share a queue. A failed write surfaces through IPC.
- Source refresh restores Electron's source object as well as its UI identity. Missing sources
  retain their saved identity for reconnection while the live selection is empty.
- The idle pill uses the existing Record, Studio and Expand controls. Active recording keeps
  its existing Stop/Pause/Backspace controls. Preferences finish loading before Start is enabled.
- Microphone enumeration gives an available saved device priority and resolves its native name.
- A warm editor receives an explicit return event; macOS did not reliably deliver the expected
  visibility event in the live test. Record waits for an in-progress editor restoration.

Scope expanded to electron/main.ts, preload.ts, electron-env.d.ts and NewEditorShell.tsx to
repair this observed editor return path. No capture-helper source or project media was edited.

Verification:
- Full suite: 3,782 passed, 1 existing skip. Later focused checks: 94 passed.
- App/test typechecks, lint, translations, and documentation checks passed. Lint retains two
  existing warnings (an empty test callback and the oversized Cargo license evidence file).
- macOS capture helpers rebuilt with npm run build:native:mac.
- Fresh-context review: no remaining findings after settings-write and editor-resume races fixed.
- Real Electron 44.1.0 development app, isolated artifact userData: compact entry, expand/collapse,
  Escape, source restoration and return to the editor passed. A 500 ms delay on preference disk
  writes reproduced the risk; concurrent update/clear/restore retained the new settings.
- Screenshots idle-compact.png, idle-expanded.png and restored-compact.png inspected.
- artifacts/recording-workspace-2026-09-21/live-report.json is the passing round-trip report.

- Real project A → B → A restored A's microphone, camera, device IDs and cursor choice,
  despite B having camera and microphone disabled. App restart also restored A's saved source.
- A fresh 3.46-second Mac desktop recording produced 3420×2214 H.264 screen video, AAC audio
  tracks and a separate 1920×1080 camera file. Stop imported the recording into A and cleared
  the workspace context. The editor showed the new clip, waveform and camera preview.
- Live editor playback advanced to 0.832 seconds after reopening the recorded project; playback.png inspected.
- Both screen/audio and camera files fully decoded without errors. Device and editor screenshots
  were inspected. capture-report.json records the successful test.

Limits: no signed installation or packaged build; /Applications/Klippt.app is unchanged.
No new Windows/Linux hardware or export validation. Existing projects without saved setup use
current app preferences on their first return, then retain their own setup.



Vault recording: the canonical screenrec card and daily ledger were updated. The vault checker
reports eight unrelated unregistered directories (website, lab and lab/image-triangles,
Agent/03 - Business and its Digital Products/Claude Code Guide/templates tree, and
Agent/02 - Content/Material). No vault cleanup was attempted. See vault-check.log.
