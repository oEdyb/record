# Archived OpenScreen docs site

This Docusaurus tree is inherited upstream documentation. It does not describe the current Klippt
alpha and must not be published as Klippt product guidance. Current status lives in
[`../HANDOFF.md`](../HANDOFF.md). The planned `klippt.app` beta site is a separate, original one-page
product surface.

Docusaurus 3 site. Lives in `website/` inside the monorepo. Deployed to GitHub Pages via `.github/workflows/docs.yml`.

## Develop

```sh
cd website
npm install
npm run dev      # http://localhost:3000/openscreen/
```

## Build

```sh
npm run build    # outputs to website/build/
npm run serve    # serves the built site locally
```

## Type-check

```sh
npm run typecheck
```

## Notes

- Site URL: <https://getopenscreen.github.io/openscreen/>
- The base URL is `/openscreen/` because the org-level Pages site hosts multiple projects.
- Docs migration from `docs/` (root) → `website/docs/` happens in a follow-up PR. For now only the intro page is published.
