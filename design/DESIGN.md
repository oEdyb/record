# Klippt design system

Klippt must feel calm, intelligent, and powerful. It should help a creator move from recording to a publishable video without the visual load of a traditional editor.

## Source of truth

[`src/styles/design-tokens.css`](../src/styles/design-tokens.css) is the only production token authority. Tailwind maps semantic utilities to these tokens in [`tailwind.config.cjs`](../tailwind.config.cjs). [`design/tokens/v4.css`](tokens/v4.css) is generated for design specimens.

Run `npm run design:sync` after a token change. `npm run docs:check` fails if the mirror is stale.

## Visual direction

The editor uses restrained graphite surfaces. The preview and timeline carry the visual hierarchy. The inspector stays flat and quiet.

| Role | Dark value | Use |
|---|---:|---|
| Canvas | `#0d0d10` | App and stage background |
| Panel | `#151519` | Inspector and primary panels |
| Raised control | `#1c1c21` | Menus, segmented tracks, hover surfaces |
| Primary text | `#e7e7ec` | Labels and headings |
| Muted text | `#92929d` | Secondary detail |
| Editor accent | `#91aac8` | Selection, playhead, slider range, automatic edits |
| Danger | `#f87171` | Recording, destructive actions, errors |

White and graphite are the product identity. Steel blue is a functional editor color. Green is semantic success or live audio only.

## Typography

- Geist is the interface face.
- Geist Mono is for time, values, resolution, frame rate, and technical data.
- The base interface size is 13 pixels.
- Ordinary labels use sentence case.
- Keep values truthful and visible next to their controls.
- Do not use text below 11 pixels.

## Editor geometry

- Top bar: 56 pixels.
- Inspector pane: 344 pixels.
- Inspector rail: 48 pixels.
- Inspector header: 48 pixels.
- Stage inset: 16 pixels.
- Inspector controls follow a 4-pixel spacing base.
- The preview remains dominant at 1024 pixels and above.
- The timeline is a precise work surface, not a decorative footer.

## Inspector rules

- Use one flat surface. Do not place ordinary settings in cards.
- Separate groups with space and a hairline divider.
- Keep one control geometry for each control type.
- Use `InspectorPane`, `InspectorRow`, `InspectorSlider`, `InspectorSwitch`, `InspectorSegmentedControl`, and `InspectorDisclosure` from [`src/components/ui/inspector/`](../src/components/ui/inspector/).
- Put short explanations in tooltips or the pane help popover. Do not keep long help text open in the normal layout.
- Hide controls that cannot affect the selected media. Disable controls only when the disabled state explains useful context.
- Use direct manipulation in the preview for framing and position when possible. Keep numeric controls as the precise alternative.

## Interaction

- Hover: change one surface step and increase text contrast.
- Focus: use the editor-accent focus ring.
- Press: use a small contrast change. Do not bounce the chrome.
- Pointer slider changes commit on release.
- Keyboard slider changes commit as one short burst after idle or blur.
- Popovers, selects, switches, sliders, and toggle groups use the installed Radix primitives through Klippt wrappers.
- Custom trigger leaves must spread props and forward refs when used with `asChild`.

## Motion

- Fast chrome response: 120 milliseconds.
- Normal state transition: 180 milliseconds.
- Standard easing: `cubic-bezier(0.2, 0, 0, 1)`.
- Animate opacity and transform when possible.
- Use motion to explain state or continuity. Do not add decorative motion.
- Disable non-essential transitions under `prefers-reduced-motion: reduce`.

## Iconography and copy

- Use Lucide line icons for ordinary actions.
- Use the Klippt mark from `design/assets/logo-icon.png`; do not redraw it in components.
- Use short action labels: Record, Pause, Continue, Remove, Export.
- Do not use emoji or generic AI marketing language in product chrome.
- Do not show persistent “Saved” chrome. Show a short confirmation only when the user needs it.

## Product signature

The signature flow is the calm recording HUD becoming the exact editor timeline. Recording, clips, automatic direction, and manual correction must feel like one continuous tool.
