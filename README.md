# Klippt

Klippt is a private, Mac-first screen recorder for creators. Record in clean clips, remove a bad
section while recording, review the take, and hand off the untouched sources or save one video.

The project started from the MIT-licensed OpenScreen continuation. Klippt is now a separate
proprietary commercial product. Legacy OpenScreen identifiers remain only where a compatibility-safe
migration has not happened yet. The upstream copyright and permission notice remain in
[`LICENSE`](LICENSE), with the complete package inventory in
[`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

## Start here

- [`HANDOFF.md`](HANDOFF.md) — current branch, completed work, verification, risks, and next actions.
- [`AGENTS.md`](AGENTS.md) — durable product behavior and engineering rules.
- [`PRODUCT_PLAN.md`](PRODUCT_PLAN.md) — active delivery order and release gates.
- [`technical-documentation/`](technical-documentation/README.md) — current architecture,
  engineering, and test references.
- [`design/DESIGN.md`](design/DESIGN.md) — production UI system.

## Current state

The Mac core works: clip-native Record, Pause, Continue, Remove previous clip, Stop, review,
untouched-source handoff, and native MP4/GIF export. The editor UI, in-app chat, `klippt agent`
CLI, automatic direction, and transcription were archived on 2026-10-05 (tag
`archive/pre-cleanup-2026-10-05`); existing projects still open and render their stored edits. The current checkpoint uses Electron `44.9.1`, a contained
`klippt://app` origin, central privileged-IPC validation, production fuses, ASAR integrity, and an
atomic export publisher.

Klippt is not ready for an outside beta yet. The remaining gate is a fresh notarized package, a real
N to N+1 update, a complete packaged 30–90 minute creator flow, and clean or second-Mac proof. See
the [handoff](HANDOFF.md#what-is-left-in-priority-order) for the exact order.

## Development

Use Node `22.22.1`, npm `10.9.4`, and npm only.

```bash
npm install
npm run dev
```

Useful checks:

```bash
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npm run test
npm run lint
npm run i18n:check
npm run docs:check
npm run build-vite
```

The normal app build does not rebuild every native helper. Read
[`technical-documentation/engineering/build-and-packaging.md`](technical-documentation/engineering/build-and-packaging.md)
before you trust a package or native result.

## Product rule

Keep source media recoverable. Automatic edits, audio treatment, framing, and layout stay
reversible. Optional analysis must never block the recording path.
