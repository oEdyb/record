# Klippt UI system audit

> This is dated implementation evidence, not the current task queue. Use
> [`../HANDOFF.md`](../HANDOFF.md) for current status and next work.

**As of:** 2026-08-30

**Scope:** Editor shell, floating inspector, timeline controls, dialogs, menus, recording HUD, and motion

**Method:** `frontend-design` was the primary design method. `impeccable`, `review-animations`, and `find-animation-opportunities` supplied supporting technical checks. The first implementation wave followed the audit in the same branch.

## Implementation result

The first UI-system wave is complete. It changed the foundation without replacing the product's current visual identity.

- `src/styles/design-tokens.css` is the one production token authority. The design specimen is generated from it.
- Popover and Tooltip triggers now forward refs and pass a composed-trigger regression test.
- One Radix-based inspector layer now owns panes, rows, switches, sliders, segmented controls, disclosures, help, and icon buttons.
- Video Effects, Background, Layout, Cursor, Audio, Automatic Editing, Captions, Transcript, and selection controls use the shared layer directly or through compatibility wrappers.
- The empty editor keeps the facet rail for orientation but collapses irrelevant settings.
- Language selection and multi-clip selection use one keyboard-safe menu primitive.
- The persistent `Saved` label is gone. Save state remains available to assistive technology, and unsaved work stays visible on the Save icon.
- The timeline clip boundary is now a two-pixel neutral edge instead of a five-pixel stripe.

### Right inspector refinement

The second implementation pass standardized the active right inspector with one measured layout:

- 344-pixel pane width and 48-pixel facet rail;
- 48-pixel fixed header and optional 48-pixel action toolbar;
- 16-pixel content gutter and section rhythm;
- 44-pixel standard rows;
- 32-pixel standard controls with an 8-pixel radius.

The pass used screenshots of the live Background, Effects, Layout, Cursor, Audio, Automatic Editing, and Transcript panes at 1710 by 1107 logical pixels. It compared each pane against the same alignment grid after implementation.

The Audio pane now waits for an explicit **Analyze pauses** action. The analysis job lives in a project-scoped Zustand store instead of the pane component, so switching inspector tabs does not cancel active work. Results from an old project revision are discarded.

Transcript actions now have their own toolbar instead of competing with the title. Automatic Editing groups screen direction and camera emphasis separately. Cursor uses the same section, row, switch, and slider primitives as the other panes. Captions now uses the shared geometry tokens for its fields and status controls.

This pass adds no UI dependency. It adapts the field anatomy from shadcn/ui and the behavior-based grouping model from coss to the existing Radix foundation.

### Dialog system refinement

The editor's duplicate custom modal shell now uses the existing Radix Dialog foundation. One
Klippt layer owns the overlay, 12-pixel radius, 24-pixel inset, header, body-only scrolling,
footer, close control, motion, and four task-based widths. The old reversed `wide` flag is gone:
normal forms no longer open at 960 pixels while nominally wide dialogs open at 720 pixels.

New/Open Project, Edit Clip, Insert Source, Source Transcript, Chat History, Provider Settings,
Export, unsaved confirmations, entitlement, empty-state errors, and Keyboard Shortcuts now share
the same behavior foundation. Keyboard Shortcuts also moved from hard-coded slate and green
classes to the Klippt token system. Browser checks at 1512×982, 1100×700, 1024×700, and 900×620
confirmed initial focus, trapped keyboard navigation, Escape restoration, visible compact-dialog
actions, named controls, and reduced motion. The normal New Project dialog is 720 pixels; only the
media-heavy Export dialog keeps the 960-pixel size.

This wave does not claim a literal 20/20 yet. Native VoiceOver, Increased Contrast, and the
remaining icon and tooltip audit remain. The UI foundation is now strong enough to improve those
areas without creating more local systems.

## Decision

Keep the current shell, preview, timeline, recording HUD, typography, and product palette.

Do not add another component library or replace Klippt with a stock design system. The visual result is already coherent. The main problem is implementation drift behind the interface:

- two design authorities disagree about the product palette;
- the shared UI layer and the editor use different styling conventions;
- several inspector controls rebuild interaction behavior that installed Radix primitives already provide;
- some panes still use different spacing, grouping, and selection rules.

The next UI work should standardize the foundation, then migrate one pane at a time. It should not start with a broad visual redesign.

## Target direction

Klippt is an **Operate** surface: creators use it repeatedly to complete precise work. The interface must optimize for speed, scanability, confidence, and familiar Mac behavior.

The visual direction remains:

- calm graphite and soft-white product chrome;
- muted steel blue only for editor selection, playhead, and automatic edits;
- red only for recording and destructive actions;
- green only for transient success and live audio;
- Geist for interface text and Geist Mono for time, values, and technical data;
- one continuous inspector surface with hairline section dividers;
- one Lucide-style icon family;
- short, purposeful motion that never delays frequent editing actions.

The calm floating HUD and the precise timeline are the strongest product-specific visual signatures. Preserve them.

## Audit health

| Dimension | Score | Main finding |
| --- | ---: | --- |
| Accessibility | 4/4 | Shared Radix controls, named interactions, focus restoration, keyboard menus, and reduced-motion smoke tests pass. Native VoiceOver remains a release check. |
| Performance | 4/4 | Changed motion uses opacity/transform, short durations, correct transform origins, and reduced-motion fallbacks. |
| Responsive desktop layout | 4/4 | The editor and migrated dialogs remain usable from 900 through 1512 CSS pixels without horizontal overflow or hidden actions. |
| Theming | 4/4 | Production and design specimens now use the same graphite, white, steel-blue, and red token system. |
| Implementation integrity | 3/4 | The main inspector and menu systems are shared. Large legacy UI modules and dialog families still need gradual extraction. |
| **Total** | **19/20** | **Strong foundation. Finish native accessibility and icon/tooltip standardization next.** |

### Implementation integrity verdict

**Pass.** The rendered product is coherent and specific to Klippt. The main editor now expresses that result through one token authority, one inspector system, and one menu system.

### Executive summary

- Current audit health: **19/20 — Strong**.
- Initial findings: **9 total — 0 P0, 2 P1, 5 P2, and 2 P3**.
- Resolved in this wave: both P1 findings, the shared-control finding, empty-project context, main menu accessibility, and new-surface motion consistency.
- Remaining work: native accessibility checks, icon/tooltip standardization, and gradual extraction from large modules during real feature work.

### Resolution matrix

| Finding | Status |
| --- | --- |
| Conflicting token authorities | Resolved |
| Radix trigger refs | Resolved |
| Rebuilt inspector behavior | Resolved for active editor panes |
| Inspector geometry drift | Resolved for active facet panes and the dialog family |
| Empty-project inspector clutter | Resolved |
| Tabs, menus, and small hit targets | Resolved on migrated surfaces |
| Large UI modules | Open; extract only with real feature work |
| Icon and tooltip treatment | Open |
| Motion-token drift | Resolved on changed surfaces; legacy progress bars remain profile-led |

## Findings

### P1 — The repository has two conflicting UI sources of truth

**Category:** Theming / Implementation integrity

**Suggested command:** `$impeccable document`

**Evidence**

- `AGENTS.md` and `src/styles/design-tokens.css` define the current monochrome Klippt palette.
- `design/SKILL.md`, `design/DESIGN.md`, `design/readme.md`, and `design/tokens/v4.css` still describe OpenScreen and emerald as the brand accent.
- `design/tokens/v4.css` says it is a verbatim copy of the production tokens, but it now differs in palette, dark mode, focus rings, editor accents, and geometry tokens.
- `src/index.css` also declares shadcn-style HSL variables with names such as `--accent`, `--border`, and `--muted`. Production tokens need the `:root:root` specificity workaround to win.

**Impact**

A future component or agent can follow the wrong file and reintroduce green, old spacing, or incompatible token formats. This is the likely source of the green-theme regressions already seen in the app.

**Recommendation**

Make `src/styles/design-tokens.css` the only token authority. Update or clearly archive the old OpenScreen design kit. Remove or rename the conflicting legacy HSL aliases instead of relying on specificity. Generate any design specimens from the production token source.

### P1 — Radix trigger wrappers do not forward refs

**Category:** Accessibility / Implementation integrity

**Standard:** Radix Composition

**Suggested command:** `$impeccable harden`

**Evidence**

`src/components/ui/popover.tsx` and `src/components/ui/tooltip.tsx` wrap Radix triggers in normal function components. The timeline composes both triggers with `asChild`, and React reports that a function component cannot receive a ref.

Radix uses these refs for measurement, focus, and positioning. Its composition guide requires leaf components used through `asChild` to spread props and forward refs.

**Impact**

Popover anchoring and focus restoration can become inconsistent. The warning also hides future composition errors in the console.

**Recommendation**

Convert all Radix leaf wrappers to `React.forwardRef`, keep prop spreading, and add one composed Tooltip + Popover regression test.

### P2 — Inspector behavior is rebuilt instead of shared

**Category:** Accessibility / Implementation integrity

**Standard:** WAI-ARIA control patterns through Radix Primitives

**Suggested command:** `$impeccable distill`

**Evidence**

- `RightPanes.tsx` defines a custom `Toggle` with `aria-pressed`, while `@radix-ui/react-switch` is installed.
- `SliderCell` uses a native range input with manual pointer and keyboard commit handling, while `@radix-ui/react-slider` supplies `onValueChange` and `onValueCommit`.
- Background uses a manual `role="tablist"`, but its buttons are missing `role="tab"`, `aria-selected`, panel relationships, and arrow-key navigation. Radix Tabs is installed.
- Pacing presets form a custom single-choice segmented control. Radix Toggle Group is installed.
- The clip picker is a hand-built menu. Radix Dropdown Menu is installed.
- Pane help is a hand-built absolute note. It does not get the dismissal and focus behavior of the shared Popover.

**Impact**

Controls that look similar can behave differently with the keyboard, focus, touch, and accessibility tools. Each pane also needs separate fixes when a design rule changes.

**Recommendation**

Create a thin Klippt inspector layer over the installed Radix primitives:

- `InspectorPane`
- `InspectorSection`
- `InspectorRow`
- `InspectorSlider`
- `InspectorSwitch`
- `SegmentedControl`
- `IconButton`
- `InspectorDisclosure`

Keep project logic in the current panes. Move only visual and interaction behavior into the shared layer.

### P2 — Inspector geometry still drifts between panes

**Category:** Theming / Implementation integrity

**Suggested command:** `$impeccable layout`

**Evidence**

The current CSS has both flat and card-style paths. Some child elements add `var(--sp-4)` margins or padding inside a body that already has `var(--sp-4)` padding. Control heights vary between 28, 30, 32, 34, and 36 pixels without a clear role-based rule.

The Audio pane is close to the intended flat model. Background, captions, selection panes, and older settings still mix separate inset and card rules.

**Impact**

The right inspector wastes horizontal space and feels assembled from different passes. Labels, values, sliders, and segmented controls do not align to one stable grid.

**Recommendation**

Use one 16-pixel pane inset. Let children use zero horizontal inset unless they are real option tiles. Use one section rhythm and three explicit control sizes:

- 28 pixels for compact icon and segmented controls;
- 32 pixels for standard inspector controls;
- 36 pixels for primary actions and full-width fields.

Do not make an ordinary slider or toggle row a card.

### P2 — Empty-project context shows irrelevant inspector controls

**Category:** Implementation integrity

**Suggested command:** `$impeccable clarify`

**Evidence**

The empty editor is visually clean, but the inspector can still show disabled effects for a project that does not exist.

**Impact**

The disabled controls compete with the actual first actions: Record, New project, and Open project.

**Recommendation**

When no project exists, replace the inspector body with one quiet contextual message or collapse the inspector body. Keep the main empty-state actions unchanged.

### P2 — A few accessibility details remain below the Mac target

**Category:** Accessibility

**Standard:** Apple accessibility guidance and WAI-ARIA patterns

**Suggested command:** `$impeccable harden`

**Evidence**

- Background sub-tabs do not implement the complete tabs pattern.
- The custom clip menu has roles but does not supply menu focus movement, Escape handling, or outside-click dismissal.
- Inspector info buttons are 18 by 18 CSS pixels. Apple currently recommends at least 20 by 20 points for macOS controls.

**Impact**

Keyboard and motor-access users get less predictable controls, especially inside the dense inspector.

**Recommendation**

Use the installed Radix behavior and increase the invisible hit target for info controls to at least 20 by 20 pixels. Keep the icon itself small.

### P2 — Large UI modules make consistency work expensive

**Category:** Implementation integrity / Performance

**Suggested command:** `$impeccable distill`

**Evidence**

- `NewEditorShell.module.css`: 3,291 lines
- `RightPanes.tsx`: 2,460 lines
- `Modals.tsx`: 2,126 lines
- `EditorShellV4.module.css`: 2,025 lines
- `V4Timeline.tsx`: 1,764 lines

**Impact**

The file size does not directly harm the user. It does make local UI changes harder to reason about and encourages new one-off styles because the reusable boundary is unclear.

**Recommendation**

Extract by stable responsibility during real UI migrations. Do not perform a file-splitting-only refactor. The first useful boundary is `components/ui/inspector/`; later boundaries can follow timeline toolbar, timeline lanes, and modal families.

### P3 — Icon and tooltip treatment is not fully unified

**Category:** Theming / Implementation integrity

**Suggested command:** `$impeccable polish`

**Evidence**

Most editor controls use Lucide. `HudIcons.tsx` also imports Bootstrap, Font Awesome, Feather, Material, and Radix icon packages. Some icon buttons use the shared Tooltip, while others rely on the browser `title` attribute.

**Impact**

Stroke weight and tooltip timing can drift. The current HUD still looks good, so this is not a reason to redesign it.

**Recommendation**

Add one `IconButton` primitive with size, tone, pressed state, label, and Tooltip behavior. Migrate icons only when a matching Lucide or deliberate custom glyph preserves the current silhouette.

### P3 — Motion tokens are not applied consistently

**Category:** Performance / Accessibility

**Standard:** Apple motion and Reduce Motion guidance

**Suggested command:** `$impeccable polish`

**Evidence**

The code avoids `transition: all`, large bounces, and decorative motion. Reduced-motion rules exist for the HUD and popups. Some state movement still uses generic `ease` instead of the shared curve, and two determinate progress bars animate `width`.

**Impact**

This is polish, not a current usability problem.

**Recommendation**

Use the shared 120/180 ms motion tokens. Use `var(--ease)` for moving state, and use `scaleX` for progress only if profiling shows that width updates matter. Do not add Motion or another animation package for these changes.

## Component decision matrix

| UI job | Current approach | Standard approach |
| --- | --- | --- |
| Option menu | `AppSelect` over Radix Select | **Keep.** This is the strongest current shared control. |
| Inspector switch | `InspectorSwitch` over Radix Switch | **Keep.** One semantic switch with Klippt tokens. |
| Inspector slider | `InspectorSlider` over Radix Slider | **Keep.** Live preview plus one persisted commit per gesture. |
| Background mode | Shared single-choice segmented control | **Keep.** It represents one mode choice and includes roving keyboard focus. |
| Pacing preset | Shared single-choice segmented control | **Keep.** Natural, Balanced, and Tight now use the same behavior as other segmented choices. |
| Advanced settings | Shared native-details disclosure | **Keep.** The audio and inspector paths now share one reduced-motion treatment. |
| Pane help | Shared Radix Popover | **Keep.** Context stays hidden until requested. |
| Clip picker | Shared Radix Dropdown Menu | **Keep.** Focus, Escape, typeahead, and outside dismissal come from Radix. |
| Icon controls | Local buttons and browser titles | Shared `IconButton` plus Tooltip. |
| Timeline toolbar | Manual toolbar | Keep the visuals. Add documented roving focus or Radix Toolbar only if the keyboard model needs it. |
| Dialogs | Generic shadcn-style wrapper plus bespoke dialogs | Restyle one local Radix Dialog primitive to Klippt tokens, then migrate by dialog family. |

Do not install coss or another UI kit. coss has useful examples of compact field and group anatomy, but it uses Base UI and would create a second behavior foundation. Borrow the layout ideas only.

## Motion verdict

Klippt already has close to the right amount of interface motion. The app is a high-frequency editing tool, so most extra animation candidates fail the frequency test.

### Worth keeping or refining

| Location | Purpose | Recommendation |
| --- | --- | --- |
| Recording HUD full-to-compact transition | Spatial consistency and state indication | Keep the current one-surface morph. Use 180 ms `var(--ease)` and a reduced-motion state change without translation or scaling. |
| Clip-history removal | State indication | Keep the 140–180 ms collapse required by the product guide. Preserve the immediate state change under Reduce Motion. |
| Selects, popovers, and tooltips | Prevent a jarring appearance | Keep 125–180 ms opacity plus 0.97-to-1 scale from the Radix transform origin. Fix refs before tuning motion. |

### Deliberately rejected

- Timeline scrubbing and playhead movement: these happen continuously and must track input directly.
- Inspector rail navigation: users can activate it tens of times per session. Extra movement would make the editor feel slower.
- Keyboard commands and mode changes: frequent keyboard actions should respond immediately.
- Slider thumbs and numeric values: direct manipulation must remain attached to the pointer.
- Decorative stage or empty-state animation: it would compete with the creator's video and weaken the calm product posture.

## Implementation order

### UI-0 — Establish one authority and repair composition

1. Make the production token file canonical and remove the stale emerald guidance.
2. Remove the conflicting token formats from `src/index.css` or give the legacy aliases unique names.
3. Fix Radix wrapper refs and add the composed-trigger regression test.

This slice removes the highest-risk causes of future visual regressions without changing the intended look.

### UI-1 — Build the inspector primitive layer

1. Add the eight small inspector primitives listed above.
2. Use existing tokens and Radix packages only.
3. Migrate Video Effects first because it exercises rows, sliders, switches, labels, values, help, and section rhythm.
4. Compare before-and-after screenshots at 1024 and 1440 CSS pixels.

### UI-2 — Migrate the remaining inspector panes

Migrate Background, Layout, Cursor, Audio, Automatic, Captions, Transcript, and selected-region panes. Keep each pane's product logic unchanged. Use Basic and Advanced grouping where a normal creator does not need every parameter.

### UI-3 — Standardize dialogs, menus, and toolbars

Migrate the clip picker, pane help, icon buttons, and dialog families. Keep the current timeline layout and export hierarchy unless a real usability test shows a problem.

### UI-4 — Final motion and accessibility pass

Run keyboard, VoiceOver, Increased Contrast, larger-text, and Reduce Motion checks. Tune motion only after geometry and behavior are stable.

## Recommended Impeccable passes

1. **P1 — `$impeccable document`:** establish one current production design authority and retire the stale emerald guidance.
2. **P1 — `$impeccable harden`:** fix Radix ref composition, tabs, menus, dismissal, focus, and Mac hit targets.
3. **P2 — `$impeccable distill`:** create the thin inspector primitive layer and migrate Video Effects first.
4. **P2 — `$impeccable layout`:** normalize inspector insets, row rhythm, and control sizes.
5. **P3 — `$impeccable polish`:** unify icons, tooltip treatment, and the remaining motion-token details after migration.

These passes can run one at a time, together, or in a different order after UI-0. Re-run the
Impeccable audit after the fixes to measure the score again.

## Positive findings to protect

- The content-first editor composition is clear at both tested desktop widths.
- The recording HUD is calm, compact, and product-specific.
- The timeline is visually precise without excessive decoration.
- `AppSelect` keeps option menus inside Klippt's theme and already uses Radix correctly.
- The current palette expresses the calm, intelligent, powerful direction.
- Most controls have useful accessible names and visible focus states.
- The focused editor, export, and HUD accessibility smoke flows pass when run independently.
- The code has no broad `transition: all` problem and already includes reduced-motion handling on key animated surfaces.

## Verified false positives

- Keep Geist. It is deliberate, self-hosted product typography, not a generic marketing choice.
- Keep the timeline clip-edge marker. It communicates a real edit boundary rather than adding decorative structure.
- Do not replace progress bars only because they transition width. Treat that as a profiling-led polish task.

## Dialog and workspace latency follow-up

The shared Radix dialog shell now owns all editor modal geometry. Keyboard Shortcuts uses the same
shell, spacing, focus behavior, and neutral palette as the other dialogs. The settings open state is
isolated from the shortcut-data context, so opening the cog no longer rerenders the full editor.
The frequent dialog entrance is 120 ms with four pixels of travel. On the populated long-timeline
project, the dialog was fully visible in a screenshot taken 150 ms after the real click.

The editor window now stays warm while the recording HUD is active. Electron hides the editor
instead of destroying its Chromium renderer, enables background throttling for the hidden editor,
and destroys the native preview view until the editor becomes visible again. A real HUD-to-editor
round trip measured 143.5 ms from the native menu event to an on-screen maximized editor. Cold
startup still waits for `ready-to-show`. Warm and cold native File commands both deliver after the
main frame is ready.

The focused performance regression set has 77 passing tests. TypeScript, scoped Biome, and the
production renderer, Electron main, and preload bundles pass. The production build still reports
the existing large renderer chunk and Electron circular-chunk warnings.

## Current references

- [Radix composition](https://www.radix-ui.com/primitives/docs/guides/composition)
- [Radix components](https://www.radix-ui.com/primitives/docs/components)
- [Radix Slider](https://www.radix-ui.com/primitives/docs/components/slider)
- [Radix Switch](https://www.radix-ui.com/primitives/docs/components/switch)
- [Radix Tabs](https://www.radix-ui.com/primitives/docs/components/tabs)
- [Radix Toggle Group](https://www.radix-ui.com/primitives/docs/components/toggle-group)
- [Radix Toolbar](https://www.radix-ui.com/primitives/docs/components/toolbar)
- [Radix accessibility overview](https://www.radix-ui.com/primitives/docs/overview/accessibility)
- [Apple accessibility guidance](https://developer.apple.com/design/human-interface-guidelines/accessibility)
- [Apple motion guidance](https://developer.apple.com/design/human-interface-guidelines/motion)
- [Designing for macOS](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos/)
- [Screen Studio aspect-ratio guide](https://preview.screen.studio/guide/aspect-ratio)
- [Screen Studio changelog](https://screen.studio/changelog)
- [coss Group reference](https://coss.com/ui/docs/components/group)
- [coss Field reference](https://coss.com/ui/docs/components/field)
- [shadcn/ui Field reference](https://ui.shadcn.com/docs/components/field)
- [Zustand documentation and source](https://github.com/pmndrs/zustand)
- [Vercel Web Interface Guidelines](https://github.com/vercel-labs/web-interface-guidelines)
- [Electron performance guidance](https://www.electronjs.org/docs/latest/tutorial/performance)
- [Electron BrowserWindow lifecycle and background throttling](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron WebContents loading state](https://www.electronjs.org/docs/latest/api/web-contents#contentsisloadingmainframe)
- [React context update behavior](https://react.dev/reference/react/useContext)
