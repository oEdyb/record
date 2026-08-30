---
name: klippt-design
description: Use this skill to design or review Klippt interfaces. Klippt is a calm, intelligent, powerful recording and editing tool for creators. This file routes agents to the current production tokens and product rules.
user-invocable: true
---

Read `DESIGN.md` and `readme.md` before visual work.

Production code must use `src/styles/design-tokens.css`. Do not create a second palette. Run `npm run design:sync` after a token change; `design/tokens/v4.css` is a generated specimen mirror.

Core direction:

- Dark graphite canvas with quiet white chrome.
- Muted steel blue only for editor selection, time, and automatic-edit state.
- Red only for recording, destructive actions, and errors.
- Green only for semantic success or live audio state. It is not a brand color.
- Geist for UI. Geist Mono for time, values, and technical data.
- One flat 344-pixel inspector next to a 48-pixel facet rail.
- No cards inside ordinary inspector sections.
- Short, purposeful motion. Respect reduced motion.
- Lucide icons only, except the Klippt logo and purpose-built media glyphs.

Use the shared primitives in `src/components/ui/inspector/`, `app-select.tsx`, `popover.tsx`, and `tooltip.tsx`. Do not add another component library for controls already covered by these files.
