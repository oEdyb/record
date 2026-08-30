# Klippt design package

This directory contains design guidance, assets, specimens, and the generated token mirror for Klippt.

## Start here

1. Read [`DESIGN.md`](DESIGN.md).
2. Use [`../src/styles/design-tokens.css`](../src/styles/design-tokens.css) for production code.
3. Use the shared React controls in [`../src/components/ui/`](../src/components/ui/).
4. Run `npm run design:sync` after a token change.
5. Run `npm run docs:check` before handoff.

## Current files

- `SKILL.md` routes design work to the current Klippt rules.
- `DESIGN.md` defines the visual direction and interaction rules.
- `styles.css` loads the specimen package.
- `tokens/v4.css` is a generated mirror of the production tokens.
- `assets/logo-icon.png` is the current Klippt mark.
- `components/` and `guidelines/` contain design specimens. They are references, not production component sources.
- `ui_kits/editor/` contains historical visual studies. Production code is authoritative when a study conflicts with the app.

## Production component boundary

Use these shared layers before adding local controls:

- `src/components/ui/inspector/` for panes, rows, sliders, switches, segmented controls, disclosures, and icon buttons.
- `src/components/ui/app-select.tsx` for option menus.
- `src/components/ui/popover.tsx` for anchored menus and help.
- `src/components/ui/tooltip.tsx` for short hover and keyboard help.

The installed Radix packages provide behavior. Klippt CSS modules provide the visual system. Do not add another UI kit to solve the same control types.

## Legacy specimens

Some older specimen token files remain because historical design cards import their names. `tokens/v4.css` loads last and wins conflicts. Do not use the old emerald or OpenScreen guidance for product work.
