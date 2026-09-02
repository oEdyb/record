# Contributing to Klippt

Klippt is a private proprietary product. Do not open upstream OpenScreen issues or pull requests for
Klippt product work.

## Before a change

1. Read [`HANDOFF.md`](HANDOFF.md), [`AGENTS.md`](AGENTS.md), and the relevant technical document.
2. Inspect the current code, tests, lockfiles, and pinned versions.
3. For a new feature or substantial change, read current official documentation and maintained
   reference code before you choose an API or implementation pattern.
4. Keep the change inside one clear product or runtime boundary.

## Development rules

- Use Node `22.22.1`, npm `10.9.4`, and npm only.
- Keep TypeScript strict. Do not add explicit `any`.
- Preserve unrelated changes in a dirty worktree.
- Keep source media non-destructive and project writes atomic.
- Add focused tests beside the changed behavior.
- Do not use TestSprite.
- Rebuild native helpers before you trust native capture, preview, or export behavior.
- Use Conventional Commit messages for repository commits.

## Verification

Run focused checks while you work. Run the complete relevant gate before handoff.

```bash
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npx vitest --run path/to/test.ts
npm run lint
npm run i18n:check
npm run docs:check
npm run build-vite
```

Use `npm run test` once for a completed code slice. Native capture, preview, export, and packaging
changes also need the real Mac checks in
[`technical-documentation/testing/manual-e2e-checklist.md`](technical-documentation/testing/manual-e2e-checklist.md).

## Branches and releases

The private remote is `origin`. The OpenScreen remote is fetch-only `upstream`; never push Klippt
work there. Stable release branches use `release/vX.Y.Z`. Do not publish an artifact until its
source commit, helper provenance, signature, notarization, notices, and update metadata all pass the
release contract.

Current status and remaining release work live in [`HANDOFF.md`](HANDOFF.md).
