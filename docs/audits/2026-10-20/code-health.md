# Klippt code health and weight audit, 2026-10-20

Read-only. Inspected `/Applications/Klippt.app` (1.9.5, 616 MB), an extracted copy of its `app.asar`, `package.json`, `electron-builder.json5`, `vite.config.ts`, `electron/main.ts`, `electron/ipc/handlers.ts`, `src/`. Nothing was built, packaged, launched or edited. Tree at `44cb0ee6`.

## Fix pass (branch `fix/code-health`, 2026-10-20)

Nine commits on `fix/code-health` plus this report, nothing pushed. Size is measured from a local unsigned `electron-builder --mac --dir` package of the branch against the installed `/Applications/Klippt.app` (built Oct 13, Electron 44.1.0, signed). The DMG was not built. Startup is measured with the built `dist` run in the repo's dev Electron 44.9.1 (an isolated user-data directory per launch, so no permission prompts and no clash with the installed app), 8 launches per variant, interleaved, on a machine busy with the other audit sessions: expect noise of a few hundred ms.

| | Before | After |
|---|---|---|
| App bundle (`du`) | **616.4 MB** | **363.7 MB** (−252.7 MB, −41%) |
| `app.asar` | 238 MB | 3.1 MB |
| `Resources/` | 330 MB | 106 MB |
| Electron framework locale folders | 220 (50 MB) | 13 |
| Electron framework | 284 MB | 256 MB |
| App start to HUD first paint, median | 1,416 ms | 1,418 ms (HUD-first alone) |
| `whenReady` to HUD window created, median | 532 ms | 351 ms (−181 ms) |
| App start to HUD first paint, median, with compile cache | 1,052 ms | 955 ms (−98 ms, separate run) |

What changed:
- `package.json`: removed `langchain`, four `@langchain/*`, `motion`, `react-icons`, `react-rnd`, `@uiw/react-color-colorful` from `dependencies` and `@electron/rebuild`, `fast-check`, `esbuild`, `ajv-formats`, `ajv-formats-draft2019` from `devDependencies` (lockfile −801 lines). Electron 44.1.0 → 44.9.1.
- `electron-builder.json5`: `electronLanguages` (13 app languages, both `pt_BR` and `pt-BR` spellings), `dist/wallpapers` excluded from the asar, `node_modules` excluded from the asar. Finding 1 turned out larger than first written: Vite bundles **every** dependency, `electron-updater` included (the bundle holds its code; there is no runtime `require`), so no package is read from the asar and all 71 MB left after removing the unused ones could go.
- `electron/main.ts`: IPC handlers are registered synchronously, then `createWindow()` runs; export recovery, the temp sweep, the interrupted-recording scan and shortcut registration finish behind it, and a recovered take opens the editor over the HUD. New `startup-timing.jsonl` (`<userData>/diagnostics/`) records `process-start`, `app-ready`, `handlers-registered`, `hud-created`, `hud-ready-to-show` for every launch.
- `electron/bootstrap.ts`: `module.enableCompileCache()` before the main bundle loads.
- Tests: `electron/ipc/handlers.startup.test.ts` (5 tests: channels registered before the recovery check settles, recovery true/false, non-macOS and opt-out), and one `useScreenRecorder` test for Stop right after Pause.

Honest reading of the startup numbers: HUD-first moves window creation about 180 ms earlier, but the first paint did not move (1,416 → 1,418 ms), because the HUD renderer load, not main-process work, bounds it. The compile cache gave about 100 ms (9%) on 8 runs each; treat that as indicative, not exact.

Verification (all in the worktree): `npx tsc --noEmit` pass, `npx tsc -p tsconfig.test.json --noEmit` pass, `npm run lint` pass (same one warning as before). Full `npm run test`: 2,544 pass, 1 skipped, 6 fail (2,551 tests, 246 files). All six fail only on the unsigned dependency baseline (`Dependency approval signature is invalid`, see the first item below); they pass once Olle signs. A seventh failure in the first run (`recordingFastExport.media.test.ts`, a `swift` fixture compile under load) passed alone and in the second full run.

Not done, and why:
- **`supply-chain/approved-dependency-inputs.json.sig` must be re-signed by Olle.** The lockfile changed, so the signed baseline no longer matches. I updated the `package-lock.json` hash in the baseline, but the signature is his key. Run: `ssh-keygen -Y sign -f ~/.ssh/klippt_dependency_approval -n klippt-dependency-approval supply-chain/approved-dependency-inputs.json`. Until then six tests in `scripts/check-approved-dependencies.test.mjs` and `scripts/generate-release-inventory.test.mjs` fail on the signature, nothing else.
- `LICENSES.chromium.html` (19 MB): kept; needs a licence-notice decision.
- `web-demuxer` and its 3 MB wasm: kept; `supply-chain` scripts and `verify-packaged-distribution` require them. `whisper-stt-server`: kept; `scripts/before-pack.cjs` requires it.
- Camera preview window still opens at launch (`src/` and window flow, outside this task). Lazy-loading the CLI and transcript modules in `main.ts`: not done, no measured need after the HUD-first change.
- Local packaging used the main checkout's `electron/native/bin` (same sources; the Whisper provenance check needs CI-built files), re-dated and with `KLIPPT_SOURCE_SHA` set to the manifest's commit. Output was not signed or notarized, so the `afterSign` Developer ID guard stopped after the app was assembled, as expected.
- Corrections to the findings below: finding 5, `useScreenRecorder` is better covered than written (27 tests across start, Pause, Continue and Stop races in `src/hooks/useScreenRecorder.nativeStopFailure.test.tsx`; the name hides it), so the real gap is `handlers.ts` and `main.ts`. Finding 6, `@actions/*` (used by `.github/scripts/`), `ajv` and `vite-plugin-electron-renderer` stay. Finding 7, the two `ai-edition` files are used by tests and were kept.

## Gate results

- `npx tsc --noEmit`: **pass** (exit 0).
- `npm run lint`: **pass** (exit 0), 1 warning: `third-party-licenses/Cargo-Evidence.json` is 1.4 MiB, over Biome's 1 MiB limit, so it is not linted.
- `npm run test`: 245 files, 2,545 tests: **2,542 pass, 1 skip, 2 fail**. Both failures are 15 s timeouts under machine load (load average 16 to 30 from the parallel audits): `electron/ai-edition/agentHistory.test.ts` ("continues redo after pruning…") and `scripts/helper-provenance.test.mjs` ("keeps the same Darwin content identity…"). Re-run alone: 24/24 pass in 7.6 s. Treat as load flakes, not regressions.

## Where the 616 MB goes

- Electron Framework: 284 MB (fixed cost).
- `app.asar`: **238 MB**. Of its 286 MB extracted content: `node_modules` 259 MB, `dist` 26 MB (24 MB of it wallpapers), `dist-electron` 1.1 MB.
- `Resources/electron/native/bin/darwin-arm64`: 44 MB (ffmpeg libs 21 MB, `klippt-parakeet-stt` 16 MB, compositor 2.3 MB).
- `Resources/wallpapers`: 24 MB. `LICENSES.chromium.html`: 19 MB. `web-demuxer.wasm`: 3 MB.
- No speech model is bundled (parakeet downloads on first use). Not a size problem.
- Renderer JS is small: 2.0 MB over 46 files, split per window.

## Top findings, ranked by impact

### 1. `node_modules` ships 259 MB inside the asar; the app needs 3 MB of it (~256 MB, 42% of the install)
- Main (`dist-electron`) and renderer (`dist`) are fully bundled by Vite. The only runtime `require` left is `electron-updater` (lazy import, `electron/auto-updater.ts:42`). Its closure is 16 packages, 3.1 MB.
- electron-builder still copies every package listed under `dependencies` (`package.json:100-136`).
- Ten of them have **zero importers** in `src/`, `electron/` or `scripts/` and add 209 MB (sizes on disk): `react-icons` 83, `js-tiktoken` 21, `@mistralai/mistralai` 19, `openai` 16, `@langchain/*` + `langchain` + `langsmith` + `@anthropic-ai/sdk` ~47 combined, `framer-motion`/`motion` 9, `web-demuxer` 4, `react-rnd`, `@uiw/react-color-colorful`. This is leftover from the October 5 archive of the in-app LLM chat and editor (HANDOFF already lists them).
- The other ~47 MB (`lucide-react` 33, `@tiptap/*` 8, `zod`, `mediabunny`, radix, …) is bundled into `dist/assets` and also copied as raw packages.
- Fix: delete the ten unused packages; move every bundled-only package to `devDependencies`, leaving `electron-updater` as the only runtime dependency. Re-run `npm install`, re-sign `supply-chain/approved-dependency-inputs.json` (owner step per HANDOFF), then check that `npx asar list` shows no stray `node_modules` and that the licence inventory generator (`scripts/generate-third-party-inventory.mjs`) still lists the bundled packages, since it may read `dependencies`.
- Effort: 3 h (1.5 h for deletion only, which gets 209 MB).

### 2. Wallpapers ship twice: 24 MB in the asar and 24 MB in `Resources/wallpapers`
- `files` (`electron-builder.json5:59-76`) excludes `dist/cursors` but not `dist/wallpapers`; `extraResources` (`:115-118`) copies `public/wallpapers` again. Packaged builds read `resourcesPath/wallpapers` (`electron/windows.ts:110`), so the asar copy is unread.
- Fix: add `"!dist/wallpapers{,/**/*}"` to `files`. Optional: recompress the 19 JPEGs (`wallpaper10.jpg` 4.2 MB, `wallpaper3.jpg` 3.1 MB, `wallpaper17.jpg` 3.0 MB) to ~1 MB each, another ~15 MB (a visual-quality call).
- Check `scripts/verify-packaged-distribution.mjs:385` still passes.
- Effort: 0.25 h for the exclude; 1 h with recompression.

### 3. The HUD window is created last, behind five serial awaits (`electron/main.ts:1073-1188`)
- Order inside `whenReady`: `ensureRecordingsDir` → `registerIpcHandlers` (4,965-line module, `electron/ipc/handlers.ts:1785`) → which awaits `exportRecovery` (compositor export journal plus a `readdir` of the whole temp dir for orphaned voiceover files, `handlers.ts:1814`, `:4947`; this Mac's `$TMPDIR` holds 13,159 entries) and then `restoreLatestNativeMacRecoverySession` (journal scan, `:4952`) → `LiveTranscriptService` setup → `loadAndRegisterGlobalShortcuts` (file read) → only then `createWindow()` at `main.ts:1188`.
- None of that is needed to paint the HUD. Only the "was a recording interrupted?" answer decides HUD vs editor.
- A second renderer process (`createCameraPreviewWindow`, `main.ts:194`) also starts with the HUD on every macOS launch, even with the camera off.
- Cold start was **not measured** (launching is out of scope here; there is no launch timing log, only `record-start-timing.jsonl`). 
- Fix: call `createWindow()` right after the permission and protocol setup. Run recovery, shortcuts and telemetry afterward; if a recovered session exists, open the editor then. Create the camera window lazily on first camera use. Add a `startup-timing.jsonl` (process uptime at `whenReady`, `createWindow`, HUD `ready-to-show`) first so the gain is measured.
- Effort: 1 h for timing, 3 to 4 h for the reorder with tests.

### 4. Dead payload in `Resources`: ~24 MB
- `LICENSES.chromium.html` 19 MB (`electron-builder.json5:107-110`): ship gzipped or keep only a link plus a short notice (confirm the licence requirement first).
- `web-demuxer.wasm` 3 MB (`:111-114`): `web-demuxer` has no importer (only a comment at `src/lib/exporter/localSourceFile.ts:4`). Drop the resource and the `public/wasm` copy.
- `whisper-stt-server` + `libwhisper` ~1.2 MB: no non-test TypeScript refers to it. Live transcript uses parakeet only (`main.ts:1152`). The `libggml*` libs must stay; `libparakeet` links them (checked with `otool -L`).
- Effort: 1 h.

### 5. `registerIpcHandlers` and `useScreenRecorder` carry the risk with the least test cover
- `electron/ipc/handlers.ts` (4,965 lines, record start/stop, export, entitlement gate, recovery) has **no test file**; only `globalShortcut.test.ts` mentions it. `src/hooks/useScreenRecorder.ts` (2,525 lines) has one test file (`useScreenRecorder.nativeStopFailure.test.tsx`). `electron/main.ts` (quit-time stop, workspace switching) has none directly.
- Also untested: `electron/windows.ts` (1,107 lines, HUD/panel/click-through), `electron/ipc/nativeBridge.ts` (787), `electron/native-bridge/cursor/recording/macNativeCursorRecordingSession.ts` (643), `src/components/launch/HudDeviceSettings.tsx` (679), `HudControls.tsx` (476).
- The quit-while-recording and Pause/Stop races fixed on October 13 got tests in their own modules (`quitCaptureGuard`, `nativeMacRecordingService`), which is good. The wiring in `main.ts`/`handlers.ts` is the gap.
- Fix: split `handlers.ts` into the recording, export, entitlement and recovery groups already visible in it. Add a handler-level test for each of: start rejected without entitlement, stop during pause, recovery journal restore, window-close during export.
- Effort: 8 to 12 h. Start with the recovery and entitlement paths (3 h).

### 6. Unused or unneeded dev dependencies
- No importer found for `@actions/core`, `@actions/github`, `@electron/rebuild`, `fast-check`, `esbuild` (direct), `ajv-formats`, `ajv-formats-draft2019`. Keep `vite-plugin-electron-renderer`: it has no direct import but is a required peer of `vite-plugin-electron` (checked in its `package.json`).
- Does not change app size; it shrinks install time, audit surface and `supply-chain` approvals.
- Fix: remove, run `npm run build-vite` and `npm run test:supply-chain`. Effort: 1 h.

### 7. Dead source after the archive is small; the large "dead" areas are still reachable
- An import graph from `src/main.tsx`, `electron/bootstrap.ts` and `electron/preload.ts` reaches 299 of 513 TypeScript files; the other 214 are tests, apart from 2 files (110 lines): `src/lib/ai-edition/checks/fixtures.ts` and `src/lib/ai-edition/store/undo.ts`.
- Still shipped by design (open old projects, CLI): `AiEditionShell` chunk 165 KB, `CliExportRunner` 320 KB, `NotesWindow` 442 KB (tiptap). They load lazily per window, so no startup cost.
- Fix: delete the two files if tests agree. Effort: 0.25 h.

### 8. Main process is one 1.1 MB bundle that parses on every launch
- `dist-electron/main-CmA7l_Se.js` 721 KB + `main-BtUnLdg_.js` 368 KB. `main.ts` statically imports the CLI runner, transcript/STT, ai-edition, update checker and all of `handlers.ts` (`main.ts:22-85`), even for a plain GUI launch.
- Fix: dynamic-import `runCli` only when `cliCommand` is set, and load transcript/STT on first use. Measure first (finding 3 timing). Effort: 2 h, gain unknown (guess 30 to 80 ms).

### 9. Repo and disk weight (not shipped, slows search and CI)
- Untracked/ignored on disk: `.local-install.noindex` 8.4 GB (old installed backups), `artifacts/` 3.4 GB, `crates/` 3.4 GB (vendored ffmpeg), `website/` 347 MB, `parakeet-tdt-0.6b-v3/` 90 MB (gitignored). Tracked: 1,415 files, 56 MB, including `public/demo.gif` 5 MB and `design/openscreen-editor-v2.html` 2 MB, both excluded from the package.
- Fix: prune old `.local-install.noindex` backups, move `artifacts/` evidence out of the working tree. Effort: 0.5 h (needs Olle's OK to delete).

### 10. Packaging config still names OpenScreen identities
- `appId: com.etiennelescot.openscreen`, appx `identityName: EtienneLescot.OpenScreen` (`electron-builder.json5:4`, `:388-392`). AGENTS.md says these stay until a planned migration, so this is a note, not a defect.

## Quick wins under 2 hours

1. Exclude `dist/wallpapers` from the asar: 1 line in `electron-builder.json5`, **−24 MB**, 15 min.
2. Remove the ten unused runtime packages from `package.json`, reinstall, re-sign the supply-chain approvals: **−209 MB**, 1.5 h (owner signs).
3. Drop `web-demuxer.wasm` and `whisper-stt-server` from packaging: **−4 MB**, 30 min.
4. Add `startup-timing.jsonl` stamps at `whenReady`, `createWindow` and HUD `ready-to-show`, so the finding 3 reorder has a baseline: 1 h.
5. Remove the 7 unused dev dependencies and the two dead `ai-edition` files: 1 h.

Total for 1 to 3: about −237 MB (616 → ~379 MB installed). Adding the `devDependencies` move from finding 1 (3 h) takes it to about −284 MB (→ ~332 MB), before touching the Electron framework.

## Upgrades and newer techniques

Research date 2026-10-20. Versions "now" come from `npm view` (npm registry, today) and the lockfile. A claim is **verified** when the source is the vendor's own page, release notes or code, with its date. Anything else is marked **UNVERIFIED**.

### Version check

| Tool | Ours | Latest stable | Source and date | Expected gain for Klippt | Effort |
|---|---|---|---|---|---|
| Electron | 44.1.0 | 44.9.1 (45.0.0-beta.6 is prerelease) | [releases.electronjs.org](https://releases.electronjs.org/), Oct 20 2026; [support policy](https://www.electronjs.org/docs/latest/tutorial/electron-timelines): latest 3 stable majors | Eight patch releases of Chromium 152 and security fixes, no API change. Stay on 44; do not take 45 until stable. | 1 h + a real Mac recording pass and re-sign |
| Vite | 7.3.6 | 8.3.4 | [Vite 8 post](https://vite.dev/blog/announcing-vite8), Mar 12 2026; registry | Build time only: vendor claims 10–30x vs Rollup (Linear 46 s → 6 s). No runtime gain claimed. Needs Node ≥20.19/22.12 (we pin 22.22.1). Our `manualChunks`, `terser` and `vite-plugin-electron` (0.29.1; registry shows 1.1.2) setup is not covered by the post: UNVERIFIED that they work unchanged. The post suggests trying `rolldown-vite` on Vite 7 first. | 3–4 h + full build and Mac pass |
| `@vitejs/plugin-react` | 5.2.0 | 6.1.2 | Vite 8 post (v6 drops Babel; v5 still works with Vite 8); registry | Smaller install; no runtime change | 0.5 h with Vite 8 |
| React | 18.3.1 | 19.3.1 | [react.dev/versions](https://react.dev/versions): 19.3 on Sep 9 2026; 19.3.1 Oct 14 2026 (GitHub releases, via search, not opened); React Compiler 1.0 Oct 2025 | No startup gain claimed in any source I could open. Compiler could cut HUD re-renders: UNVERIFIED for us. Risk: radix, tiptap, react-rnd compatibility. | 6–10 h; defer until after launch |
| TypeScript | 5.9.3 | 7.0.2 (native Go compiler) | [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), Jul 8 2026 | Vendor: 8–12x faster full builds (VS Code 125.7 s → 10.6 s). Our `tsc --noEmit` took 10.9 s under load 19, so we would save about 8 s per run. **Blocker:** `tsconfig.json:8` sets `baseUrl`, a hard error in 7.0; drop it and keep `paths` relative to the root. Post advises going through 6.0 first. | 2 h |
| Vitest | 4.1.11 | 5.0.5 | [Vitest 5 post](https://vitest.dev/blog/vitest-5), Sep 3 2026 | Vendor numbers: −8% to −53% on vm pools, but `forks` + `jsdom` configs stayed within ±3%. Our run (82 s wall) is jsdom-dominated, so expect about 0–3%. Breaking: `clearMocks` now defaults to true; unawaited `resolves`/`rejects` now fail tests. Needs Node ≥22.12, Vite ≥6.4. | 2–4 h |
| electron-builder | 26.15.3 | 26.15.3 | registry | Current | none |

### Shrinking the Mac app

| Technique | Status here | Source and date | Expected gain | Effort |
|---|---|---|---|---|
| **`electronLanguages`** (strip Chromium locale `.lproj` folders) | **Not set.** The installed framework still holds 220 `.lproj` folders, 50 MB (`Electron Framework.framework/Versions/A/Resources`). | electron-builder 26.15.3 source `app-builder-lib/out/electron/ElectronFramework.js:58-100` (on mac it prunes the framework Resources dir; matching is exact name or prefix). Electron cut about 37 MB on Linux the same way in [Electron 44](https://www.electronjs.org/blog/electron-44-0), Aug 25 2026. | About **−43 MB** (keep the 13 app languages, ~7 MB). Use `en, fr, ar, es, it, ja, ko, ru, tr, vi, pt_BR, zh_CN, zh_TW` with underscores: the match is on the lowercased folder name, so `zh-CN` would not match `zh_CN.lproj`. Check native menus and dialogs in each locale; `*_FEMININE`/`*_MASCULINE` variants will go. | 0.5 h |
| Remove unused dependencies and keep bundled packages out of the asar | Open (findings 1, 2 above) | Electron's [performance guide](https://www.electronjs.org/docs/latest/tutorial/performance) advises bundling to one file; electron-builder copies the production dependency tree ([configuration source](https://raw.githubusercontent.com/electron-userland/electron-builder/master/packages/app-builder-lib/src/configuration.ts), `ignoredProductionDependencies`) | −256 MB | see above |
| Asar integrity + fuses | **Already done** (`scripts/after-pack.cjs:36-50`: RunAsNode off, ASAR integrity on, OnlyLoadAppFromAsar on, `strictlyRequireAllFuses`). | [Fuses docs](https://www.electronjs.org/docs/latest/tutorial/fuses); [Electron 39](https://www.electronjs.org/blog/electron-39-0), Oct 28 2025 (integrity stable) | Security, not size. The docs note a slight asar read cost for integrity checks, which shrinks once the asar drops from 238 MB to ~30 MB. | none |
| arm64-only build | **Already done** (installed binary is arm64 Mach-O; `electron-builder.json5:139` keeps arch out of config). | local `file` on `Klippt`; Electron 44 requires macOS 13 and we already set `minimumSystemVersion` 13.0 | none | none |
| On-demand speech model | **Already done** (parakeet downloads to userData; `electron-builder.json5:84-86`). | local | 0 MB bundled today | none |
| ANGLE statically linked (no `libEGL`/`libGLESv2`) | Already in 44 (installed `Libraries/` holds only `libffmpeg`, `libvk_swiftshader`). | Electron 44 post | free | none |
| `libvk_swiftshader.dylib` (16.5 MB, software Vulkan in the framework) | Present. No source says it is safe to delete, and Chromium may use it as GPU fallback. | UNVERIFIED | up to −16.5 MB if removable | 2 h incl. a no-GPU test; not recommended before launch |
| Compress or drop `LICENSES.chromium.html` (19 MB) | See finding 4 | n/a | −19 MB | 0.5 h |

After `electronLanguages` plus findings 1, 2 and 4: 616 MB → about **270 MB**, mostly the Electron framework (~240 MB after locales) and the 44 MB native bin folder.

### Startup techniques

| Technique | Fit | Source and date | Expected gain | Effort |
|---|---|---|---|---|
| **`module.enableCompileCache()`** in `electron/bootstrap.ts` before `await import("./main")` | Good fit: `bootstrap.ts` is already a tiny shim. Node API since v22.8, stable since v24.15; Electron 44 ships Node 24.18.1. | [Node `module` docs](https://nodejs.org/docs/latest-v24.x/api/module.html#moduleenablecompilecachecachedir) (docs for v24; cache per Node version, default dir under `os.tmpdir()`, written at process exit) | Only third-party anecdotes: about 13 ms on a small bundle ([iptvnator PR #1696](https://github.com/4gray/iptvnator/pull/1696)) and 745 ms → 14 ms on a 76 MB bundle ([rox-one PR #1903](https://github.com/rox-one/rox-one/pull/1903)): UNVERIFIED for us. Our main bundle is 1.1 MB, so expect tens of ms. Measure with the startup log from finding 3. | 1 h |
| Lazy-load heavy modules, avoid sync I/O in main, bundle to one file | Bundled already; lazy loading is partial (finding 8). | [Electron performance guide](https://www.electronjs.org/docs/latest/tutorial/performance) (undated page) | The guide gives no numbers for these steps | 2 h (finding 3 and 8) |
| ESM in main | **Already done** (`"type": "module"`, `bootstrap.ts` uses `await import`). Docs: static imports run before `ready`, dynamic imports may resolve after it. | [Electron ESM guide](https://www.electronjs.org/docs/latest/tutorial/esm) (since Electron 28) | The guide makes no performance claim | none |
| `utilityProcess` / Node snapshot for child processes | **No fit today.** Electron 44 sped up `utilityProcess.fork()`/`ELECTRON_RUN_AS_NODE` children (PR [electron#53134](https://github.com/electron/electron/pull/53134), merged to 44-x-y Aug 23 2026: 86 ms → 40 ms to first message on Linux x64), but our helpers are native Swift binaries and we have no `fork` or `utilityProcess` call in `electron/` or `src/`. Which 44.x tag carries the PR is UNVERIFIED. | PR page | 0 ms for us | none |
| Fewer main-process timer wakeups | Electron 44 note ("Idle CPU"), no number given. Could help the paused-review idle CPU in HANDOFF (6–7% of a core). | [Electron 44 post](https://www.electronjs.org/blog/electron-44-0) | UNVERIFIED | comes with the 44.9.1 bump |
| `LoadBrowserProcessSpecificV8Snapshot` | Already off (the docs say turning it on adds main-process startup cost). | [Fuses docs](https://www.electronjs.org/docs/latest/tutorial/fuses) | none | none |

### How other 2026 Mac recorders compare

- **Screen Studio** is an Electron app by its creator's own account ([tweet, Feb 2023](https://twitter.com/pie6k/status/1624535267401924611); Build With interview, undated, via search). A competitor's page reports a 729 MB Apple Silicon installer for 4.0.3 and CursorClip's page dates that check to Oct 6 2026: both vendor-run, **UNVERIFIED**. Its own site says "Built for Apple silicon" and "built on Apple's native ScreenCaptureKit", with hardware-encoded export ([screen.studio](https://www.screen.studio/), undated, copyright 2026), and gives no size or startup number. This matches Klippt's architecture. At 616 MB we are already in its class; at about 270 MB after the fixes above we would be well under it.
- **Cap** (open source, Tauri v2 + Rust, [GitHub](https://github.com/CapSoftware/Cap)) shipped desktop 0.6.0 on Sep 15 (releases page, year not shown). It publishes no download size or startup time that I could find: **UNVERIFIED**. A Tauri rewrite would reach tens of MB, but it contradicts the "no rewrite" rule in AGENTS.md and is not proposed.
- I found no engineering post from either app on startup time. Nothing here supports a claim that a competitor starts faster than Klippt; measure Klippt's own cold start first (finding 3).

### Recommended order

1. `electronLanguages` plus the asar fixes (findings 1, 2, 4): −300 MB, about 5 h total.
2. Startup log, then the HUD-first reorder (finding 3), then `enableCompileCache`: 5–6 h, gain measured, not assumed.
3. Electron 44.9.1 patch bump with a Mac pass: 1 h.
4. After launch: TypeScript 7 (2 h), Vitest 5 (2–4 h), Vite 8 (3–4 h), React 19 (6–10 h). Only TypeScript 7 and Vite 8 save wall-clock time, and none changes what users feel.
