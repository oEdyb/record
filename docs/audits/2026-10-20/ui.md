# UI and first-run audit (2026-10-20)

- **Scope:** what a new paying user sees and feels in Klippt. That covers the HUD, the
  permissions, the first recording, review, Save video, the trial and license screens, settings,
  empty states, errors and accessibility.
- **Method:** a read-only walk through the code of:
  - `src/components`, `src/styles`, `src/i18n`
  - `electron/windows.ts`, `electron/main.ts`, `electron/ipc/handlers.ts`, `electron/entitlements`
- **What was not checked during the audit:** no screenshots were taken, so visual claims came from
  CSS values. The fix pass added screenshots; see "Fix status".

**Yardsticks** (each finding cites the one it breaks):

- **frontend.md:** `~/dev/skills/skills/development/references/frontend.md`. Its sections cited
  here are "Completion gate", "Restraint and self-critique" and "More on writing in design".
- **UX laws:** `references/frontend-ux-laws.md`, cited by law number.
- **Olle's taste:** `references/frontend-olle-approved-styles.md`.
- **Web Interface Guidelines (WIG):** Vercel's, fetched today from
  `vercel-labs/web-interface-guidelines/command.md`.
- **Emil Kowalski:** the `emil-design-eng` skill, `find-animation-opportunities` (the motion
  section) and `break-ui` (the worst-case data section, review only).
- **Apple HIG:** the Privacy, Onboarding, Alerts, Accessibility and Menu bar pages.
- **Competitors:** public docs from Screen Studio, CleanShot X and Loom. Competitor permission flows
  are thinly documented, so unverified competitor claims are marked UNVERIFIED.

Findings are ranked by their impact on a first impression.

## Fix status (branch `fix/ui-polish`, 2026-10-20)

Screenshots are in [`ui-screens/`](ui-screens/). `01-hud-idle.png` is the real dev Electron
window. Computer-use access to the dev app was declined, so the other screens were rendered from
the same renderer code in a browser, with a stubbed Electron bridge. The tray menu was not
screenshotted. The HUD, the review window and the dialogs are dark-only (`applyTheme("dark")`), so
there is no light mode to capture.

Gates run locally on the final branch: `tsc --noEmit`, the test typecheck, `npm run lint` and
`npm run i18n:check` pass, and the full `npm run test` run passes (250 files, 2568 tests, 1 skipped).

| # | Status | Commit | Screenshot |
|---|---|---|---|
| 1 | Fixed in the renderer: an HUD permission panel asks for each permission before macOS does, with live status, Open Settings and Quit & Reopen; no screen probe at launch. Open: mic prompt at launch (handoff A) | `522c96fc0` | 02, 03 |
| 2 | Fixed: only shipping features, the $19 / $99 price line, a new title | `1d01bffdb` | 08 |
| 3 | Fixed: the menu item is "Keyboard Shortcuts…", and the list holds only keys the recorder and review handle | `6c7ecae0f` | 06, 07 |
| 4 | Fixed: the dialog is "Save video" end to end, with "Separate files" / "One video" tabs, the details folded into "What's included", and all copy translated | `56ffbf908` | 09, 10 |
| 5 | Fixed: "N days left" badge, visible down to 520 px, a "starts after your first recording" line, toasts for trial start and activation | `1d01bffdb` | 05, 08 |
| 6 | Partly fixed: the IPC prefix is stripped in the renderer (`src/lib/ipcErrorMessage.ts`), a failed prepare has its own title, and the npm text is gone. Open: recorder toasts and entitlement codes (handoffs B, C) | `1d01bffdb`, `56ffbf908`, `522c96fc0` | none |
| 7 | Fixed: every locale is translated, the native alerts and File menu go through `mainT`, and `i18n:check` now fails on untranslated multi-word phrases | `f5703bdca`, `edd8c761d` | none |
| 8 | Partly fixed: a `--hud-*` token group feeds the HUD and picker, and secondary text moved to white 0.58. Remaining raw values: 91 in `LaunchWindow.module.css`, 18 in `SourceSelector.module.css` (mostly shadows and state tints) | `dc034b18f` | 01 |
| 9 | Fixed: focus-visible rings, `:active` scale, no hover lift, a reduced-motion guard, a key-format placeholder | `1d01bffdb` | 08 |
| 10 | Fixed: 180 ms digit fade (opacity only under Reduce Motion), `aria-live`, "Press Record again to cancel". No countdown toggle | `23c31c274` | 04 |
| 11 | Partly fixed: Start Recording and Show Recorder in the menu. Open: trial line and Settings… (handoff D) | `f831a9599` | none |
| 12 | Copy fixed and localized. Open: "Record Without It" (handoff E) | `522c96fc0` | none |

**Behaviour changes to know about:**

- In the quick review mode, the Save dialog's primary button is now "Save video…". The
  `ExportDialog.flow.test.tsx` quick-mode tests click that label.
- The Separate files panel says "Save files…" and "Files saved". `SourceExportPanel.test.tsx` now
  renders with the real `I18nProvider` and asserts that copy.
- Record checks permissions that were cached at mount and on window focus, so the click stays
  instant. A permission changed in System Settings is seen once Klippt's window gets focus again.

**Handoffs (areas this branch does not own):**

- **A. Startup, code-health:** `electron/main.ts:1049-1057` asks for the microphone at launch.
  Remove it. The HUD permission panel now asks when a mic recording starts.
- **B. Recording, audit-recording:** `src/hooks/useScreenRecorder.ts` shows raw `error.message`
  in toasts at lines 723, 748, 816, 825, 864, 881, 899, 979, 1004, 1009, 1023, 1137, 1675, 1999,
  2042, 2171, 2215, 2275 and 2299. Map the failure codes to a few human sentences and keep the raw
  text behind "Details". `ipcErrorMessage()` already strips the IPC prefix.
- **C. Entitlements, audit-launch:** the `electron/entitlements` handlers should return
  `{ ok: false, code }` instead of throwing. The "Lemon Squeezy" provider name reaches
  user-visible errors in `lemonSqueezyProvider.ts:44`, `:89` and `:99`.
- **D. Tray trial line:** `updateTrayMenu` in `electron/main.ts` has no entitlement snapshot. A
  "Trial: N days left" item needs the main-process entitlement service. A ⌘, "Settings…"
  app-menu item was also left undone.
- **E. Record Without It (audit-recording):** the Accessibility alert needs a button that switches
  the cursor mode to System and starts recording. That is recording-state logic.
- **F. OpenScreen names (audit-launch):** no user-visible "OpenScreen" text is left in `src/` or the
  locales, and commit `dc5a78fbb` removed the unused OpenScreen logo and demo GIF. What remains is
  internal: storage keys, message IDs, the legacy `.openscreen` extension, comments, the Swift and
  Rust helper names, and `public/openscreen.png`. That file already shows the Klippt mark under a
  legacy name. The `!dist/demo.gif` rule in `electron-builder.json5` is now stale.
- **Not verified:** the panel window's Spaces behaviour over full-screen apps (Cherry Studio
  #21253), and a fresh-macOS-user pass of the permission panel against the real TCC prompts.

## 1. The macOS Screen Recording prompt appears at launch, with no explanation, and the first Record click can do nothing

- **Where:**
  - `src/components/launch/defaultRecordingSource.ts:22`
  - `src/components/launch/LaunchWindow.tsx:650`
  - `electron/ipc/handlers.ts:2136-2146` and `:2100-2116`
  - `src/components/launch/openSourceSelectorFlow.ts:46-63`
  - `electron/recording/nativeMacCapturePermissions.ts:21-23`
- **What the user sees:**
  - **Prompt at launch.** The HUD mounts and calls `ensureDefaultRecordingSource`. That calls
    `getSources`, which calls `desktopCapturer.getSources` with no permission check. On a fresh
    install this fires the system Screen Recording prompt the moment the app opens, before the
    user clicks anything and before Klippt has said a word. The code comment at `handlers.ts:2100`
    confirms that `getSources` is the call that triggers it.
  - **Silent Record click.** If the user presses Record while the prompt is pending, the retry loop
    polls for 6 s. When the status turns `denied`, the loop returns without calling
    `open-source-selector` again. That call is the only one that shows the "Open System Settings"
    dialog. So the HUD shows nothing at all.
  - **Restart nobody guides.** After the user turns Klippt on in System Settings, macOS normally asks
    them to "Quit & Reopen". Klippt only mentions this in the copy shown when the source picker is
    empty. Nothing detects the grant and carries on.
  - **Mic prompt at launch.** Correction made during the fix pass: `electron/main.ts:1049-1057`
    calls `askForMediaAccess("microphone")` at startup, so the microphone prompt also appears at
    launch, not after the countdown as first written here.
- **Rules broken:**
  - HIG Privacy: "Avoid requesting permission at launch unless the data or resource is required."
    A pre-alert screen has one "Continue" button.
  - frontend.md, Completion gate: "Relevant empty, loading, error, success, locked, and permission
    states give a clear next action."
  - UX law 6, Doherty threshold: acknowledge input promptly. The silent Record click fails this.
  - UX law 10, Peak-end rule: make difficult moments recoverable. The first run is the peak.
- **Competitor:** Screen Studio asks for all four permissions from one first-launch screen, with
  buttons that deep-link to Settings (screen.studio/guide/setting-up-permissions). UNVERIFIED:
  whether it shows live status.
- **Proposed fix:**
  - Gate `readSources` and `ensureDefaultRecordingSource` on
    `getMediaAccessStatus("screen") === "granted"`.
  - Add one "Ready to record" HUD panel, shown when any permission is missing:
    - Rows for Screen Recording and Microphone. Camera and Accessibility appear only when enabled.
    - Live status on each row, polled every second while the panel is open.
    - One "Open Settings" button per row.
    - A "Quit & Reopen" button (`app.relaunch()`) once Screen Recording flips to granted.
  - Ask for the microphone from this panel, not after the countdown.
- **Effort:** 6-8 h, including tests and one pass on a fresh macOS user account.

## 2. The purchase dialog sells features that were removed on October 5

- **Where:**
  - `src/i18n/locales/en/editor.json:165` and `:175`
  - `src/components/entitlements/EntitlementDialog.tsx:44-60`
  - The same keys in all 13 locales.
- **What the user sees:**
  - "Your trial includes the complete recorder, editor, automatic direction, and finished exports."
  - "Editable automatic zooms, Camera Emphasis, and silence removal."
  - The editor, automatic direction, zoom suggestions and pause analysis were all archived at
    `archive/pre-cleanup-2026-10-05`.
  - This is the screen where the user decides to pay, and it promises features the app no longer
    has.
- **Rules broken:**
  - frontend.md, More on writing in design: "Describe what something does in plain terms rather
    than selling it."
  - frontend.md, Completion gate: "The interface serves the named user, subject, and page job."
  - UX law 10, Peak-end rule: never show success before it is real. The same applies to promises.
- **Proposed fix:**
  - Three benefits that ship today:
    - Pause/Continue clips with Remove previous clip.
    - Untouched separate screen, camera and audio files.
    - One-click One video at source quality.
  - Rewrite `descriptionTrial` to match.
  - Show "$19/month or $99/year" under the primary button.
  - Update all locales, or fall back to English for these keys until each is translated.
- **Effort:** 1-2 h.

## 3. Settings in the review window opens an editor shortcut list

- **Where:**
  - `src/components/ai-edition/RecordingReviewShell.tsx:871-873`
  - `src/lib/shortcuts.ts:1-13` and `:40-76`
  - `src/components/video-editor/ShortcutsConfigDialog.tsx:146` and `:200`
- **What the user sees:**
  - More → Settings opens "Keyboard Shortcuts".
  - It lists Add Zoom, Add Trim, Add Speed, Add Annotation, Add Full Camera, Delete Selected,
    Copy/Paste, Cycle Annotations, Pan Timeline and Zoom Timeline.
  - None of these exist in a recorder-only product.
  - The real recording settings (quality, devices, cursor, language) live only in the HUD.
- **Rules broken:**
  - UX law 3, Jakob's law: on a Mac, "Settings…" is ⌘, and opens the app's settings.
  - UX law 1, Hick's law: eleven choices, all of them irrelevant.
  - frontend.md, More on writing in design: "Name things by what people control and recognize."
  - frontend.md, Restraint: "Remove one accessory." Here it is a whole dialog's worth.
- **Proposed fix:**
  - Trim `SHORTCUT_ACTIONS` and `FIXED_SHORTCUTS` to Open app, Pause/Continue, Play/Pause and
    Frame back/forward. Keep stored keys readable.
  - Rename the menu item "Keyboard Shortcuts…".
  - Add an app-menu item "Settings… ⌘," that opens the HUD settings panel.
- **Effort:** 2-3 h.

## 4. "Save video" opens a dialog titled "Export", on the "Separate takes" tab, with technical copy

- **Where:**
  - `src/components/ai-edition/ExportDialog.tsx:491-520`
  - `src/lib/ai-edition/store/editingPreferences.ts:79`
  - `src/components/ai-edition/SourceExportPanel.tsx:47-56` and `:108`
  - The `exportDialog.subtitle` key.
- **What the user sees:**
  - The primary button says **Save video**. The dialog it opens is titled "Export" and starts on
    "Separate takes". That default is the product decision.
  - The tab shows two paragraphs about "complete original bytes", an "importable timeline", OTIO
    and "editable cursor overlays".
  - The tab's primary button says "Export sources…".
  - The video path's subtitle says "Render the timeline to a file", which is editor language.
  - The finish toast reads "/long/path, 0:28 of video exported in 0:05".
- **Rules broken:**
  - frontend.md, More on writing in design: "An action keeps the same name through the whole
    flow." Here it goes Save video → Export → Export sources… → "Video exported".
  - UX law 15, Tesler's law: the system should carry the complexity. The OTIO details belong
    behind a disclosure.
  - UX law 10, Peak-end rule: the ending should state what happened and the next step.
  - WIG Content: "Specific button labels".
- **Competitor:** Screen Studio's export goes format, then settings, then a progress window that
  shows the output path (screen.studio/guide/exporting-the-video).
- **Proposed fix:**
  - Title the dialog "Save video".
  - Tabs: "Separate files" / "One video". Each gets one plain line, e.g. "Screen, camera and audio
    as separate files for your editor."
  - Move the OTIO and cursor details behind a "What's included" disclosure.
  - Buttons: "Save files…" / "Save video…".
  - Toast: "Saved <file name> (0:28)" with a "Show in Finder" action.
  - Move all strings into `editor.json`.
  - Keep the remembered default.
- **Effort:** 3-4 h.

## 5. The trial starts silently, its badge is ambiguous, and the compact review hides the badge

- **Where:**
  - `src/components/ai-edition/RecordingReviewShell.tsx:104-118`
  - `src/components/ai-edition/RecordingReviewToolbar.module.css:83`
  - `src/i18n/locales/en/editor.json:154-156`
  - `src/lib/entitlements/store.ts:71-73`
- **What the user sees:**
  - Before the first recording, the badge says "14-day trial". Clicking it opens the sales dialog,
    which never says the clock has not started.
  - After the first durable recording, the badge flips to "Trial 14 days". That reads like a plan
    name, not a countdown.
  - The badge is `display: none` below 1000 px. The compact review player is sized to the video and
    has a 480 px minimum (`electron/compactReviewGeometry.ts:1`). So the first review screen a user
    ever sees most likely hides the trial status completely. This is inferred from the geometry,
    not seen on screen.
  - Activating a license closes the dialog with no confirmation.
- **Rules broken:**
  - frontend.md, Completion gate: "locked … states give a clear next action."
  - UX law 11, Zeigarnik: "show truthful progress."
  - UX law 6, Doherty threshold: show feedback after an action. Activation gives none.
  - HIG Onboarding: keep licensing out of onboarding and show it after the user has had value.
    The timing is right; the moment is simply missing.
- **Proposed fix:**
  - On the first `trial-not-started → trial-active` transition, show one quiet toast: "Your 14-day
    trial started. Everything you record stays yours."
  - Change the badge text to "14 days left" and keep it visible in the compact review (icon plus
    number below 860 px).
  - Add one dialog line before the trial starts: "The trial starts after your first recording."
  - Toast "Klippt Pro is active" after activation.
- **Effort:** 2-3 h.

## 6. Raw technical or wrongly toned error text reaches the user

- **Where:**
  - `src/lib/entitlements/store.ts:75` and `electron/entitlements/ipc.ts:35-38`
  - `electron/entitlements/lemonSqueezyProvider.ts:44`, `:89`, `:99`
  - `src/hooks/useScreenRecorder.ts:816`, `:825`, `:1009`, `:1137`, `:1675`, `:1999`
  - `src/components/ai-edition/RecordingReviewShell.tsx:857`
  - `electron/ipc/handlers.ts:2338`
- **What the user sees:**
  - **License errors.** They are thrown across `ipcRenderer.invoke`, which prefixes them. The user
    reads "Error invoking remote method 'entitlement:activate': Error: This license is not active."
  - **Provider name leaks.** "Could not reach Lemon Squeezy."
  - **Recording failures.** These show raw `error.message` text, e.g. "Failed to stop native macOS
    recording" or "Failed to prepare recording".
  - **Wrong title.** A failed review prepare uses "Preparing recording…" as the error title.
  - **Developer instructions.** The missing-helper dialog tells customers to run
    `npm run build:native:mac`.
- **Rules broken:**
  - frontend.md, More on writing in design: "Explain what went wrong and how to fix it … never
    vague about what happened."
  - WIG Content: "Error messages include fix/next step."
  - HIG Alerts: the title names the specific problem, and the buttons are verbs.
  - UX law 16-17, Postel: keep the user's input when an error happens. The license field does
    keep it, which is good.
- **Proposed fix:**
  - Entitlement handlers return `{ ok: false, code }`. Each code maps to one localized sentence
    with a next step, e.g. "Check the key in your receipt email." or "You're offline. Klippt will
    check again when you reconnect."
  - Recorder failure codes map to four or five human messages. The raw text goes behind "Details",
    the way the review interruption banner already works.
  - The developer dialog says "Reinstall Klippt" instead.
- **Effort:** 4-5 h.

## 7. About 10% of each locale is untranslated English, including the review screen's main buttons

- **Where:**
  - Every `src/i18n/locales/<locale>/editor.json` under `recordingReview.*`
  - `electron/ipc/handlers.ts:2340-2346` and `:2383-2390`
  - `electron/recording/recordingReviewFileMenu.ts:26-38`
  - `src/components/ai-edition/ExportDialog.tsx:511` and `:520`
  - `src/components/ai-edition/SourceExportPanel.tsx:47-112`
- **What the user sees:**
  - In every one of the 12 locales, 36-44 of the 398 values are the English text copied unchanged.
  - That set is the newest review copy: "Save video", "New recording", "Record again", the recovery
    banner, "Search recordings…".
  - On top of that, the permission alerts, the File menu and the Separate takes panel are
    hardcoded in English.
  - The HUD offers "Switch to <your language>" on first run. A user who accepts gets a review
    window whose main buttons are still English.
  - `npm run i18n:check` passes, because it checks only that the keys exist. Measured today with a
    key-by-key comparison against `en`.
- **Rules broken:**
  - WIG Locale & i18n.
  - UX law 13, Law of similarity: the same screen speaks two languages.
  - frontend.md, Completion gate: the "primary workflow works end to end".
- **Proposed fix:**
  - Translate the 36-44 keys per locale.
  - Extend `scripts/i18n-check.mjs` to fail when a non-`en` value equals the `en` value, with an
    allow-list for brand names and units.
  - Route the native dialog and menu strings through `mainT`.
- **Effort:** 3-4 h, plus translation.

## 8. The HUD is its own visual system: 123 raw colours, 14 radii and failing contrast

- **Where:**
  - `src/components/launch/LaunchWindow.module.css`: 123 raw `rgba`/hex colours against 11
    `var(--…)` tokens; radii of 1, 2, 2.5, 4, 8, 10, 13, 14, 16, 18, 20, 22, 25 and 999 px; type
    sizes of 10, 11, 12 and 13 px.
  - `src/components/launch/SourceSelector.module.css`: 26 raw colours, 2 tokens.
  - Contrast lines: `LaunchWindow.module.css:522`, `:550`, `:711`, `:894`, `:931`;
    `SourceSelector.module.css:210`.
- **What the user sees:**
  - The review window is built on `design-tokens.css`. The HUD is hand-tuned.
  - So the two surfaces a new user meets in their first minute share no tokens for surface, ink,
    muted text or radius. The HUD pill is `rgba(18,21,26,.94)`; the review surfaces are `#151519`.
  - Secondary 11 px HUD text sits at white 0.4 on that pill: about **3.8:1**, calculated from the
    pill colour. That covers the mic hint, the empty device lists, the setup tile details and the
    camera fallback. The picker fallback is at 0.3.
- **Rules broken:**
  - frontend.md, Completion gate: "Spacing, control heights, type hierarchy, radii, icons, and
    action placement follow a small, consistent system."
  - F3: inspect and use the project's tokens.
  - UX law 13, Law of similarity.
  - HIG Accessibility: 4.5:1 for text up to 17 pt.
  - Olle's styles: "One accent … Everything else is ink and muted." The tokens already encode this.
    The HUD just doesn't read them.
- **Proposed fix:**
  - Add a `--hud-*` token group in `design-tokens.css` and point the HUD and picker at it: surface,
    ink, `--hud-muted` at white 0.55 (about 6.2:1), border.
  - Collapse the radii to four steps: 4, 10, 18 and pill.
  - Keep white 0.4 for chevrons and other non-text marks only.
- **Effort:** 3-4 h, plus a screenshot pass of every HUD state.

## 9. Keyboard focus is invisible in the purchase dialog, and its button has no press feedback

- **Where:** `src/components/entitlements/EntitlementDialog.module.css:68-129`
- **What the user sees:**
  - The license field has `outline: 0`. Its focus ring is a 3 px shadow at 4% white, which is
    effectively invisible.
  - "Get Klippt Pro", "Activate" and "Manage" have no `:focus-visible` and no `:active` style.
  - The primary button's hover lift (`translateY(-1px)`) ignores Reduce Motion and has no
    `(hover: hover)` gate.
  - The license placeholder has no example of the key format.
- **Rules broken:**
  - WIG Focus States: "never outline:none without focus replacement".
  - WIG Forms: placeholders "show example pattern".
  - Emil: "Buttons must feel responsive" (`:active` scale 0.97); hover animation needs a media
    query.
  - frontend.md, Restraint: "visible keyboard focus, and reduced motion respected" is the quality
    floor.
- **Proposed fix:**
  - Reuse the HUD's `:focus-visible` ring.
  - `:active { transform: scale(.97) }` at 160 ms ease-out.
  - Move the hover lift inside `@media (hover: hover) and (prefers-reduced-motion: no-preference)`.
  - Placeholder "XXXXXXXX-XXXX-…".
- **Effort:** 0.5-1 h.

## 10. The countdown is a bare number with no way out and no screen-reader cue

- **Where:**
  - `src/components/launch/CountdownOverlay.tsx:18-28`
  - The cancel path is `LaunchWindow.tsx:820-826`.
- **What the user sees:**
  - A black 50% circle shows 3, 2, 1. The digits swap with no transition.
  - Nothing says that clicking Record again cancels.
  - There is no `role="status"` or `aria-live`, so VoiceOver gives no cue before capture starts.
- **Rules broken:**
  - WIG Accessibility: async updates need `aria-live`.
  - The `find-animation-opportunities` gate passes here: an occasional moment whose purpose is
    preventing a jarring change, under 300 ms.
  - HIG Accessibility: under Reduce Motion, replace movement with fades.
- **Competitor:** Loom makes the countdown optional with "Show recording countdown". UNVERIFIED:
  CleanShot's default.
- **Proposed fix:**
  - Digit enter at `scale(.96)` plus `opacity 0`, rising to settled in 180 ms with the existing
    `--ease`. Opacity only under Reduce Motion.
  - A caption "Click ● to cancel".
  - `role="status" aria-live="assertive"`.
  - Optional: a countdown toggle in HUD Settings.
- **Effort:** 1.5 h, or 3 h with the toggle.

## 11. The menu bar item is a plain "Open" menu with no record action and no plan status

- **Where:** `electron/main.ts:587-640` and `:418-425`
- **What the user sees:**
  - The idle menu has three items: Open, Check for Updates, Quit.
  - Left-clicking the icon opens the HUD instead of the menu.
  - There is no "Start Recording", no shortcut hint and no trial line.
- **Rules broken:**
  - HIG Menu bar: "Display a menu — not a popover."
  - UX law 3, Jakob's law.
  - UX law 8, Minimize target distance: the menu bar is always reachable, even over full-screen
    apps.
- **Competitor:** Screen Studio's menu bar holds the recording controls and "Activate Screen
  Studio" (screen.studio/guide/activating-screen-studio).
- **Proposed fix:** Idle menu items:
  - "Start Recording", with its accelerator.
  - "Recordings…"
  - A disabled "Trial: 12 days left" line that opens the dialog.
  - "Settings…"
- **Effort:** 2 h.

## 12. The Accessibility alert names an internal feature

- **Where:** `electron/ipc/handlers.ts:2329-2357`
- **What the user sees:**
  - "Accessibility access is required for the editable cursor … press record again to start the
    countdown."
  - The user never knowingly chose an "editable cursor", and the alert doesn't say what they gain.
- **Rules broken:**
  - HIG Privacy: the reason is "a brief, complete sentence".
  - frontend.md, More on writing in design: name things by what people recognize, "never by how
    the system is built".
- **Proposed fix:**
  - Title: "Allow Accessibility for a sharp, smooth cursor".
  - Body: "Klippt reads your pointer position so the cursor stays crisp in your video."
  - Buttons: "Open Settings" and "Record Without It". The second switches to the system cursor and
    records.
  - Fold this alert into the finding 1 panel when that ships.
- **Effort:** 1 h, or 0 h if folded into finding 1.

## Layout and hierarchy per screen

### HUD (pill, 50 px)

- **Order today:** drag handle and brand mark → source chip → system audio, mic and camera toggles
  → settings → record. Recording adds pause, remove previous clip and replay.
- **Hierarchy works:**
  - One 40 px primary circle, with the secondary controls at 36 px on the same track. The CSS calls
    this concentric geometry (`LaunchWindow.module.css:46-49`).
  - Red is used only for record. That matches the Von Restorff law (7) and Olle's "one accent"
    rule.
- **Weak spots:**
  - Before a source exists, the record label reads "Please select a source to record". That is a
    sentence where a noun belongs, and "Please" adds nothing.
  - Three icon-only audio and video toggles sit side by side. Their state is shown by icon only, so
    on/off needs a non-colour cue (WIG; HIG "more than color alone").
  - Secondary text contrast is covered in finding 8.
- **Hick (law 1):** six or seven idle controls is fine for a recorder used every day. Don't hide
  them. Fix the labels and contrast instead.

### Review window (compact player → full window)

- **Top bar:** brand mark, title and meta on the left. On the right: trial badge, Expand, Add clip,
  New recording, More, then **Save video** as the only filled button.
- **Hierarchy works:**
  - One primary action (law 7).
  - The ghost buttons collapse to icons below 860 px.
  - Title and meta truncate correctly.
  - The empty state ("Ready to record" plus one button) gives a clear next action.
- **Weak spots:**
  - New recording and Add clip are adjacent ghost buttons with similar icons (dot vs plus). In the
    compact player both are icon-only, so their meaning is carried by tooltip alone. Law 13 asks
    that similar look should mean similar behaviour, and these two do different things.
  - The trial badge is hidden in the compact player (finding 5).
- **Fix:** In compact mode, keep the text label on Add clip, or move New recording into More,
  since ⌘N already covers it.

### Settings

- **Two places today, neither named well:**
  - The HUD Settings panel: quality, devices, cursor, language. This is the real one.
  - The review "Settings": the editor shortcuts (finding 3).
- **Missing entirely:** a ⌘, app-menu item.
- **Wanted layout:** Olle's styles and the Tremor settings reference in the app UI library point
  the same way. Label and description on the left, control on the right, groups divided by
  hairlines. The HUD panel is too narrow for that, so keep it as the quick panel. Make "Settings…
  ⌘," open it, and drop the review copy.

### Onboarding

- **Today:** none. The first screen is the HUD plus a system alert (finding 1).
- **Wanted:** no welcome tour. HIG Onboarding says "fast, fun, and optional" and to postpone
  nonessential setup. Add one permission panel attached to the HUD, then let the first recording
  be the onboarding. The trial-start toast (finding 5) is the only "welcome" needed.

## Motion: where it is missing, and where to leave it alone

The `find-animation-opportunities` gate (frequency → purpose → speed → function), run against the
existing tokens (`--motion-fast` 120 ms, `--motion-base` 180 ms, `--ease`) in `design-tokens.css`.

**Opportunities that pass the gate:**

1. **Countdown digit.**
   - Location: `CountdownOverlay.tsx:22`.
   - Today: the digit swaps instantly. Purpose: preventing a jarring change. Frequency: occasional.
   - Motion: `opacity 0; scale(.96)` → settled, 180 ms `var(--ease)`; under Reduce Motion, opacity
     only.
2. **Purchase dialog button.**
   - Location: `EntitlementDialog.module.css:68`.
   - Today: no press state. Purpose: feedback. Frequency: rare.
   - Motion: `:active scale(.97)`, `transition: transform 160ms ease-out`.
3. **First-run permission rows (new, finding 1).**
   - Today: none. Purpose: state indication. Frequency: rare, first run only.
   - Motion: each row's status dot crossfades grey → green over 180 ms when its grant lands. No
     bounce. This is where the delight budget belongs.
4. **Trial-start toast.**
   - Location: Sonner, already in the app.
   - Today: no moment exists. Purpose: state indication. Frequency: once.
   - Motion: Sonner's default enter. Add nothing.

**Rejected:**

- **HUD record, pause and stop morph:** used tens of times a day and also driven from the keyboard.
  The existing 150 ms presence is the right ceiling, so add nothing.
- **Review transport, seek and frame step:** keyboard-driven and repeated constantly. Never
  animate.
- **Recordings list stagger:** a functional list the user scans to find a take. Motion would slow
  the scan.

**Verdict:**

- The app is already close to right. `usePresence` at 120-150 ms and the reduced-motion blocks in
  10 CSS modules show restraint.
- The highest-leverage single change is the countdown digit plus its cancel caption.

## Worst-case data (break-ui, review only)

- **Long window title in the source chip:** for example "Google Chrome — Klippt pricing · Lemon
  Squeezy checkout — Personal". It truncates with an ellipsis (`LaunchWindow.module.css:615-618`).
  Pass.
- **Long recording title in the review bar:** it truncates and has a `title` tooltip. Pass.
- **Counts of 1:** `metaOne` and `trialDay` exist. Pass.
- **Empty recordings library:** it shows `recordingReview.recordFirst`, "Record a video before
  saving." (`Modals.tsx:227`). That is the wrong sentence for an empty library. Fix: "No recordings
  yet. Press ⌘N to record one." 0.25 h.
- **1,000 recordings:** `filtered.map` renders every row with no virtualization
  (`Modals.tsx:233`). A daily creator reaches several hundred takes within months. Fix:
  `content-visibility: auto` on rows first; virtualize only if a trace shows it is needed. 1 h.
- **Long device names:** e.g. "Elgato Wave:3 (Virtual) — Aggregate Device 2". Device options set
  `min-width: 0` and truncate. Pass, but check this on screen in the screenshot pass.
- **Russian or French badge:** "Пробный период 14 дн." would crowd the review bar at 1000-1100 px.
  This is moot if the badge becomes "14 days left" plus an icon (finding 5).

## Current patterns worth adopting

Research window: October 2025 to October 2026.

- **How sources are marked:** only primary or dated sources are cited. Anything else is marked
  UNVERIFIED.
- **What was not found:** no WWDC26 session page on ScreenCaptureKit or design was found. No
  sources were found for Linear desktop or Arc.

**Patterns, in priority order:**

1. **A one-button pre-permission panel, shown when the feature is first used.**
   - What it looks like:
     - A short purpose sentence.
     - A single "Continue" button that triggers the system alert. No "Allow" and no Cancel.
     - Shown at the moment of use, not at launch.
   - Source: HIG Privacy (https://developer.apple.com/design/human-interface-guidelines/privacy),
     read via Apple's JSON endpoint on 2026-10-20. The HIG "What's new" log was last updated
     2026-10-13.
   - Screen: permissions / onboarding (finding 1).
   - Effort: inside finding 1's 6-8 h.
2. **One permission check shared by onboarding and the main window, plus guided first-run
   onboarding.**
   - Cap shipped both: the shared check in 0.4.81-0.4.82, and guided onboarding in 0.6.0
     (https://cap.so/changelog/desktop, entries 2026-03-27 to 2026-08-31).
   - For Klippt, the HUD panel and `open-source-selector` should read one status function, so they
     can never disagree. That disagreement is the cause of the silent Record click.
   - Screen: permissions.
   - Effort: inside finding 1.
3. **Test the permission path on macOS 27 before launch.**
   - Cap issue #1994 (https://github.com/CapSoftware/Cap/issues/1994, 2026-07-09, macOS 27 beta 3)
     reports the `replayd` permission dialog could not be clicked or dismissed.
   - Cap fixed a main-thread deadlock in its permission code on 2026-08-05.
   - No Apple source on macOS 27 screen-recording prompt changes was found.
   - Screen: permissions.
   - Effort: 1 h test pass on a macOS 27 machine or VM.
4. **Warn when the recorder's own windows can't be hidden from capture.**
   - Cap 0.5.0, 0.5.3 and 0.5.8 (https://cap.so/changelog/desktop, 2026-05-27 to 2026-08-05) did
     four things:
     - excluded its own windows by default
     - warned when a window could not be protected
     - toggled protection only while recording
     - listed floating panels in the exclusion picker
   - Klippt already excludes itself in `SCContentFilter`, as AGENTS.md requires. What is missing is
     the visible warning when exclusion fails.
   - Screen: HUD.
   - Effort: 2 h.
5. **Apple's HUD-panel rules as a checklist for the pill.**
   - The rules:
     - Keep it small.
     - Use colour sparingly.
     - Don't cover the content.
     - Hide the panel when the app is inactive.
     - Don't list the panel in the Window menu.
     - Keep one style across modes.
   - Source: HIG Panels (https://developer.apple.com/design/human-interface-guidelines/panels),
     undated, read 2026-10-20.
   - Klippt's pill meets most of these. The open item is one style across modes, which is
     finding 8's token pass.
   - Screen: HUD.
   - Effort: inside finding 8.
6. **The menu bar extra opens a plain menu, and every action in it also exists elsewhere.**
   - HIG The menu bar (https://developer.apple.com/design/human-interface-guidelines/the-menu-bar)
     says:
     - Show a menu, not a popover.
     - Use a template icon that works in light and dark.
     - Let people turn the extra off.
     - Don't make it the only path to an action, because macOS can hide extras.
   - The page was last changed 2025-06-09.
   - HIG Menus (updated 2026-06-08 per https://developer.apple.com/design/whats-new/) says: give
     icons to all items in a group or to none.
   - Screen: tray (finding 11).
   - Effort: inside finding 11.
7. **Sheet rules for the Save and license dialogs.**
   - The rules: one sheet at a time, and always modal on macOS. A long or repeated task belongs in
     its own panel. Done is paired with Cancel.
   - Source: HIG Sheets (https://developer.apple.com/design/human-interface-guidelines/sheets).
     Button placement was updated on 2026-03-24 per the "What's new" log, but the macOS page gives
     no rule.
   - The Save dialog's "Close" vs "Cancel export" pair already follows this.
   - Screen: save dialog, license.
   - Effort: 0.5 h review.
8. **Keep standard window chrome so Tahoe and macOS 27 refinements apply for free.**
   - Per MacRumors (https://www.macrumors.com/2026/06/09/macos-golden-gate-liquid-glass/,
     2026-06-09), macOS 27 adds:
     - a user transparency slider
     - a shared window corner radius
     - a clearer active-window cue
     - edge-to-edge sidebars
   - UNVERIFIED for Electron windows.
   - The review window uses `titleBarStyle: "hidden"` with `trafficLightPosition`
     (`electron/windows.ts:785-788`), which is the supported Electron path. Don't hard-code a
     window radius or a fake blur over it.
   - Screen: review.
   - Effort: 0 h. This is a constraint for future work.
9. **Don't adopt Liquid Glass through Electron yet.**
   - Electron's glass-effect PR #50415 was closed unmerged on 2026-06-30
     (https://github.com/electron/electron/pull/50415). Electron 41-44 release notes don't mention
     glass (Electron 44: https://www.electronjs.org/blog/electron-44-0, 2026-08-25).
   - The third-party `electron-liquid-glass` reportedly uses the private `NSGlassEffectView`.
     UNVERIFIED.
   - Raycast 2.0 got Liquid Glass by moving to a Swift/AppKit shell around a web view, at a memory
     cost (https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast, 2026-05-14).
   - For Klippt, keep the opaque, token-based HUD. If glass is ever wanted, it belongs to the Swift
     helper, not Electron.
   - Screen: HUD, review.
   - Effort: none now.
10. **Check the HUD panel's Spaces behaviour on Electron 44.**
    - Klippt uses Electron 44.1.0 with `type: "panel"` (`electron/windows.ts:536`, `:657`). It
      calls `setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })` without
      `skipTransformProcessType` (`:575`, `:669`).
    - Cherry Studio issue #21253 (https://github.com/CherryHQ/cherry-studio/issues/21253,
      2026-10-01, Electron 44.2.0, macOS 26) reports that this combination turns the app into an
      accessory app. That breaks full-screen Spaces and makes `ElectronNSPanel` join every Space.
    - UNVERIFIED for Klippt. Test it: record over a full-screen app, switch Spaces, and check that
      the Dock icon stays.
    - Screen: HUD.
    - Effort: 1 h test, 2 h if a fix is needed.
11. **The Electron Tahoe lag fix is already in Klippt.**
    - Electron apps caused system-wide lag on macOS 26 through a `_cornerMask` override
      (https://github.com/electron/electron/pull/48376; The Register, 2025-10-02).
    - It was fixed in Electron 36.9.2, 37.6.0 and 38.2.0. Klippt is on 44.1.0, so nothing to do.
      Recorded here so nobody re-investigates it.
12. **A price that matches the promise.**
    - Screen Studio dropped its one-time license for new buyers, and critics called it misleading
      (AlternativeTo,
      https://alternativeto.net/news/2025/10/screen-studio-has-removed-their-non-subscription-licensing-options-for-new-customers/,
      2025-10-01).
    - Reviews of CleanShot 5's Studio Mode (2026-09-01) listed features users expected and didn't
      get (https://maxfrequency.net/2026/09/03/cleanshot-5-studio-mode/, 2026-09-03).
    - For Klippt, state the price in the dialog and promise only what ships. This reinforces
      finding 2.
    - Screen: license.
    - Effort: inside finding 2.

**User complaints to avoid** (from the same sources):

- Pricing surprises (Screen Studio, 2025-10).
- Paywall promises that the product doesn't keep (CleanShot 5, 2026-09).
- Low legibility on Tahoe's translucent surfaces (HN thread
  https://news.ycombinator.com/item?id=45544044, 2025-10). This argues for Klippt's opaque HUD.
- Permission dialogs that hang on macOS 27 betas (Cap #1994).

## Checked and clean

- **Brand name:** every user-visible name is Klippt. That covers `productName`, About, Hide and
  Quit, the window titles, and the four macOS usage strings (`electron-builder.json5:153-156`).
- **Internal identifiers:** the `openscreen` strings that remain are the appId, storage keys, env
  vars and comments. `AGENTS.md` says to keep them.
- **Linux only:** `build/com.getopenscreen.OpenScreen.metainfo.xml` is not shipped on macOS.
- **Labels:** HUD icon buttons carry `aria-label`/`title`, and the review bar exposes
  `aria-keyshortcuts`.
- **Motion and CSS:** no `transition: all` anywhere in the UI. `prefers-reduced-motion` is honoured
  in 10 modules. The modules missing it are `EntitlementDialog`, `SourceSelector`, `NotesWindow`
  and `VirtualPreview`.
- **Recorder empty state:** the recorder-only review shows "Ready to record". The old editor empty
  state cannot be reached from review.

## Quick wins under 2 hours

1. **#2:** paywall benefits, trial description and price. 1-2 h.
2. **#9:** focus rings, `:active`, the hover and reduced-motion guard, and the license placeholder.
   0.5-1 h.
3. **Empty recordings library copy** (worst-case section). 0.25 h.
4. **#5, copy only:** "14 days left", the "starts after your first recording" line and the
   activation toast. 1 h.
5. **#6, one-liners:** replace the `npm run build:native:mac` text, and stop using "Preparing
   recording…" as an error title. 0.5 h.
6. **#12:** Accessibility alert copy plus a "Record Without It" button. 1 h.
7. **#10 without the toggle:** countdown caption, `aria-live` and the digit fade. 1.5 h.

## Sources

**Skill references:**

- `~/dev/skills/skills/development/references/frontend.md`: Completion gate; Restraint and
  self-critique; More on writing in design.
- `references/frontend-ux-laws.md`, `frontend-olle-approved-styles.md` and
  `frontend-app-ui-library.md` (Tremor settings).
- The skills `web-design-guidelines`, `emil-design-eng`, `find-animation-opportunities` and
  `break-ui`.

**Apple HIG:**

- Privacy: https://developer.apple.com/design/human-interface-guidelines/privacy
- Onboarding: https://developer.apple.com/design/human-interface-guidelines/onboarding
- Alerts: https://developer.apple.com/design/human-interface-guidelines/alerts
- Accessibility: https://developer.apple.com/design/human-interface-guidelines/accessibility
- Menu bar: https://developer.apple.com/design/human-interface-guidelines/the-menu-bar

**Competitors:**

- Screen Studio:
  - https://screen.studio/guide/setting-up-permissions
  - https://screen.studio/guide/starting-finishing-the-recording
  - https://screen.studio/guide/exporting-the-video
  - https://screen.studio/guide/activating-screen-studio
- CleanShot X: https://cleanshot.com/changelog and https://cleanshot.com/pricing
- Loom for macOS: https://support.atlassian.com/loom/docs/get-started-with-loom-for-macos

**Other:**

- WIG: https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
  (fetched 2026-10-20).
- macOS Sequoia monthly re-prompt:
  https://tidbits.com/2024/09/23/how-to-avoid-sequoias-repetitive-screen-recording-permissions-prompts/
