# Accessibility and interaction smoke

Klippt keeps one small browser smoke for the interaction contracts that are easy to break across
the recording HUD and editor. It complements component tests and the packaged-app checklist. It
does not replace a VoiceOver pass on a signed build.

## Contracts

- Every visible interactive control has an accessible name.
- Standard buttons keep native Enter and Space behavior. Tab and Shift-Tab move between controls.
- The editor does not capture Tab for annotation commands. Annotation cycling uses Alt-Down and
  Alt-Up.
- Custom dialogs receive initial focus, contain Tab navigation, close with Escape, and restore focus
  to the control that opened them.
- The chat and timeline splitters expose the ARIA `separator` value contract and support arrow,
  Home, and End keys.
- Tooltips open from keyboard focus. The control name remains available without the tooltip.
- Reduce Motion removes decorative animation but preserves state changes.
- On macOS, the recording HUD first appears with `BrowserWindow.showInactive()`. It remains visible
  and always on top without taking activation from the current application. A deliberate click can
  still focus the HUD.

## Automated coverage

`tests/e2e/accessibility-smoke.spec.ts` exercises the HUD, editor, project dialog, timeline
splitter, annotation project, and export dialog in a real browser. The smoke checks accessible
names, focus movement, keyboard activation, tooltip focus, focus restoration, and reduced motion.

Run the locked CI browser with:

```bash
npm run test:e2e -- tests/e2e/accessibility-smoke.spec.ts
```

For local diagnosis, Playwright can use an installed browser without changing CI:

```bash
PLAYWRIGHT_CHANNEL=chrome E2E_BASE_URL=http://127.0.0.1:5173 \
  npx playwright test tests/e2e/accessibility-smoke.spec.ts
```

Native window activation remains covered by `electron/hudInputPolicy.test.ts` and the manual
packaged-app checklist because a normal browser cannot assert macOS key-window ownership.

## Reference contracts

- [Electron `BrowserWindow.showInactive()`](https://www.electronjs.org/docs/latest/api/browser-window#winshowinactive)
- [Apple Human Interface Guidelines: Accessibility](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple Human Interface Guidelines: Motion](https://developer.apple.com/design/human-interface-guidelines/motion)
- [WAI-ARIA Authoring Practices: Keyboard Interface](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/)
- [WAI-ARIA Authoring Practices: Window Splitter](https://www.w3.org/WAI/ARIA/apg/patterns/windowsplitter/)
- [Playwright locators](https://playwright.dev/docs/locators)
- [Playwright ARIA snapshots](https://playwright.dev/docs/aria-snapshots)
