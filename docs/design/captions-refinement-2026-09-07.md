# Captions inspector and track refinement

For creators editing spoken screen recordings. The panel's job is to style captions; the track's job is to find a phrase in time.

Direction: the existing compact Mac editor, with a clear text-first inspector and a quiet steel-blue caption lane. Reuse Geist body/control typography and tabular numeric values; no decorative display font inside this tool. Existing tokens: dark surface #151519, foreground #e7e7ec, steel-blue #91aac8; light surface #ffffff, foreground #1b1b20, steel-blue #536f91. Keep the app's other semantic colors unchanged.

References: shadcn Field composition (https://ui.shadcn.com/docs/components/base/field) for label/control/group hierarchy; Radix Collapsible (https://www.radix-ui.com/primitives/docs/components/collapsible) for explicit disclosure. Implementation uses existing project InspectorPane/InspectorSection, Radix-backed inputs, and native disclosure. No third-party code copied or dependencies added.

Layout: visibility → text → background → placement → line length → optional language/translation. Move implementation explanations into help, keep actual errors visible. Track: compact chevron + CC icon + caption count; softly filled cue strips, visibly distinct selected cue, no invented timing handles.

Acceptance:
- Font and size are visible without scrolling past translation.
- Section spacing and controls align at the real 260px inspector width; long font values display rather than becoming blank.
- Caption blocks have a legible header, quiet resting state and visible selected/focused state.
- Collapse and keyboard selection work; cue selection still seeks and opens settings.
- Changing appearance retains the same saved document state and export behavior.
- Inspect real app in dark and light themes; no new animation, so reduced-motion behavior is unchanged.

Verification: inspected the running Mac app in dark and light themes at its actual narrow inspector width, including scrolled placement/line-length controls. Keyboard Tab + Enter selects the next cue, seeks, and opens settings. Selected state remains visible when focus leaves the track. Existing user font/size/placement settings retained. Build and app/test typechecks passed; full suite passed (277 files, 2862 tests plus one skip), followed by passing targeted regressions including the added saved-font case. No animation introduced. No phone layout check: this slice is the desktop editor's fixed-width inspector.
