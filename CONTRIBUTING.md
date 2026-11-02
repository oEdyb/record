# Contributing

Bug reports and pull requests are welcome.

## Reporting a bug

Open an issue with your OS and desktop (for Linux: distro, compositor, portal backend), the Klippt
version or commit, what you did, and what happened. A screenshot or short recording helps.

## Sending a change

1. Read [`AGENTS.md`](AGENTS.md) and the relevant page in
   [`technical-documentation/`](technical-documentation/README.md).
2. Keep one change per pull request, with a test beside the behavior you changed.
3. Use Node `22.22.1` and npm `10.9.4`. Keep TypeScript strict; no explicit `any`.
4. Keep source media non-destructive and project writes atomic.
5. Run the checks before you open the pull request:

```fish
npx tsc --noEmit
npx tsc -p tsconfig.test.json --noEmit
npm run lint
npm run test
```

Native capture, preview, and export changes need a real run on the platform you touched; say in
the pull request what you ran.

Dependency changes go through the supply-chain gates in `supply-chain/` and `scripts/`. Do not
loosen those checks to get a change through.

## Licence

Klippt is AGPL-3.0-only. By sending a contribution you agree it is licensed under the same terms.
Do not send code you cannot license that way.
