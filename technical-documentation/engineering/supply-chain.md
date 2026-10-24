# Dependency and release supply chain

Klippt derives dependency checks, the release inventory, and the software bill of materials from
reviewed source files and lockfiles. It does not inspect a developer's existing `node_modules` or
native build cache. The policy is enforced by `.github/workflows/supply-chain.yml`, while each
platform job in `.github/workflows/build.yml` adds its final unpacked payload and distribution
artifacts after packaging and signing.

## Reproducible baseline

- Node `22.22.1` and npm `10.9.4` are the repository baseline. The shared setup action verifies both
  versions before it runs `npm ci`.
- Rust CI uses Rust `1.97.1`, `cargo-audit` `0.22.2`, and `cargo-deny` `0.20.2`.
- Semgrep uses CLI `1.175.0` and the official rules at commit
  `40b8c63f75dc7c22c8a77482d73bfb864b146f7e`.
- Gitleaks uses release `8.30.1`; CI verifies the downloaded archive before it runs the scanner.
- GitHub Actions in the supply-chain workflow use reviewed full commit SHAs.

Use `npm ci` only in a clean checkout or disposable CI workspace. For an existing development
worktree, use the normal npm install workflow so npm does not erase unrelated local state.

## Continuous checks

The supply-chain workflow contains these gates. `build.yml` calls the complete workflow as a
required reusable job before it starts any release platform build:

| Gate | Contract |
|---|---|
| npm | The locked desktop graph has no high or critical advisory and registry signatures verify. |
| Website npm | Only the exact reviewed build-tool advisories in `supply-chain/npm-advisory-exceptions.json` may remain. A new or changed high or critical advisory fails. |
| Dependency approval | Every npm lock, Cargo lock/manifest, Swift manifest/resolution, FFmpeg pin set, and model manifest must match the reviewed SHA-256 baseline in `supply-chain/approved-dependency-inputs.json`. The exact baseline bytes must also carry Olle's detached Ed25519 signature. |
| Cargo | Repository discovery must match `supply-chain/cargo-graphs.json`. Every discovered lockfile passes `cargo audit`; every graph passes the advisory, licence, source, wildcard, and reviewed-duplicate policy. Advisory exceptions belong to one named graph and cannot hide the same dependency in a shipped graph. |
| Pull request dependencies | GitHub dependency review rejects a newly introduced high-severity dependency. |
| Static analysis | Pull requests and pushes reject new Warning or Error Semgrep findings. Scheduled and manual full scans reject Error findings across the tracked source baseline. |
| Secrets | Gitleaks scans the complete product history and uploads only a redacted report. |
| Inventory | The source inventory and CycloneDX document must generate and pass strict CycloneDX 1.7 validation. |
| Licence inventory | Every external Cargo package, shipped model, WebAssembly artifact, and reviewed bundled asset must have a source-backed distribution status and licence expression. Generated notice files must match those inputs exactly. |

Every platform package job depends on the complete reusable result. A tag or manual release cannot
bypass the dependency, static-analysis, or secret gates.

Run the local JavaScript checks with:

```bash
npm run test:supply-chain
npm run supply-chain:audit-website
npm audit --audit-level=high
npm audit signatures
```

The website advisories are confined to Docusaurus build dependencies. They are not part of the
desktop package. Each exception records the exact npm advisory ID, package, severity, scope, review
date, source URL, and reason. Do not use a package-name-only or severity-wide exception.

The dependency approval baseline is intentionally separate from the lockfiles. A dependency change
must update its exact SHA-256 in the baseline after the package, source, licence, advisory state, and
need are reviewed. CI discovers npm, Cargo, and Swift inputs, so a nested npm graph or new native
manifest cannot avoid this update. Klippt prohibits `npm-shrinkwrap.json` because npm gives it
precedence over `package-lock.json`; accepting both would make the approved and restored graphs
ambiguous.

The baseline must be signed with the private key at
`~/.ssh/klippt_dependency_approval`. The private key stays outside GitHub and the repository. CI
pins the one matching public Ed25519 key, the signer identity `olle@klippt.app`, and the namespace
`klippt-dependency-approval`. It verifies the signature before dependency checks, platform builds,
and inventory generation. A matching hash is evidence of a recorded review decision, not evidence
that the dependency is safe by itself.

After a dependency review, update the baseline and replace its signature with:

```bash
ssh-keygen -Y sign \
  -f ~/.ssh/klippt_dependency_approval \
  -n klippt-dependency-approval \
  supply-chain/approved-dependency-inputs.json
```

Back up the private key in Olle's encrypted credential backup. If the private key is lost or
compromised, stop releases, create a new Ed25519 key, replace the pinned public key, re-review the
complete dependency baseline, and sign it with the new key. Record the rotation in the project log
before the next release.

GitHub's current private-repository plan does not support required environment reviewers. Olle is
also the only maintainer, so pull-request self-review cannot form an independent approval boundary.
Release workflows therefore prepare commits but never create tags. Olle signs each exact release
commit locally with the private Ed25519 key. The matching public key lives outside the source tree
in `KLIPPT_RELEASE_PUBLIC_KEY`, and `build.yml` verifies the annotated tag before any package job.
The `release` environment accepts only `v*` tag deployments. No other account can receive write,
tag, or release authority while this is the approval boundary.

The Rust advisory exceptions are exact advisory IDs. The two tract-related exceptions belong to the
development-only Clean Voice graph. Release packaging still excludes that helper. A new advisory,
source, wildcard dependency, or duplicate version fails until it receives a narrow review.

Semgrep can partially parse some valid TypeScript import-type and Vitest generic syntax. Those files
remain in the scan. The workflow does not promote this known parser warning to an infrastructure
failure; matching security findings still fail through `--error`.

The pinned upstream Semgrep set labels its native rules as C only. Klippt converts those exact rule
files to Semgrep's C++ parser for the scan, then verifies that every tracked `.cpp` implementation
appears in the full-scan report. This prevents the Windows capture and Whisper helpers from silently
falling outside static analysis.

## Release inventory and SBOM

`scripts/generate-release-inventory.mjs` reads these authorities:

- the root npm lockfile, including Electron as a packaged runtime;
- all three Cargo lockfiles;
- FluidAudio's Swift `Package.resolved`;
- the immutable FFmpeg archive and source pins in `scripts/ffmpeg-pins.mjs`;
- the checked-in WebAssembly file and its actual SHA-256;
- each on-device speech model's immutable source revision and expected SHA-256;
- the Clean Voice model identity, marked as excluded from release;
- every physical file in the target's final unpacked application payload, after package exclusions
  and macOS signing;
- every final installer, package, update ZIP, or disk image, with its exact size and SHA-256.

Payload symlinks may resolve only inside the packaged tree. An escaping or broken file symlink fails
inventory generation. Framework directory aliases are recorded through their physical target once.
Each packaged file is hashed from its resolved bytes.

Generate a source-only inventory with:

```bash
npm run supply-chain:inventory
```

A platform release job supplies `--package-dir`, one or more `--artifact` values, `--platform`,
`--arch`, and the source commit. It writes these target-specific files next to the packages:

```text
klippt-release-inventory-<platform>-<arch>.json
klippt-release-sbom-<platform>-<arch>.cdx.json
```

The SBOM uses CycloneDX 1.7 and is validated against the official schema before publication. The
inventory is the richer Klippt record; it keeps source roles, targets, lockfile paths, hashes,
configure flags, and release-exclusion state that a generic SBOM cannot always express.

## Licences, models, and bundled assets

The paid-package notice set has four reviewed input families:

- `supply-chain/cargo-license-inventory.json` is generated from every discovered locked Cargo graph
  with `cargo metadata --locked`. It records 410 unique external package identities and fails when
  a locked package has no SPDX licence expression or complete licence evidence. A `LICENSE*` or
  `COPYING*` filename is not sufficient: relative-path pointers, short stubs, and files without
  substantive licence terms do not count as full text. If a crate omits the terms, the signed
  `supply-chain/cargo-license-supplements.json` policy must bind its exact name, version, source,
  repository, declared licence, crates.io checksum, and published source revision to complete
  reviewed standard terms and a copyright notice. An absent, stale, mismatched, or unused supplement
  fails.
  The deterministic `third-party-licenses/Cargo-Evidence.json` catalog stores each exact evidence
  document once and maps every package to its content hash, size, source filename, and catalogue path.
- `supply-chain/model-rights.json` records the exact source revision, licence evidence, and release
  status for each speech or audio model. The DeepFilterNet engine can use MIT code, but its embedded
  model artifact remains excluded until the artifact's commercial distribution right is confirmed.
- `supply-chain/bundled-assets.json` records reviewed shipped and excluded asset groups. Paid builds
  ship Klippt-owned icons, the reviewed default cursor sprites, Geist and 15 Google families under
  OFL-1.1, and Permanent Marker under Apache-2.0. Each Google family has exact WOFF2 output patterns
  and a pinned license notice; binary URLs and hashes are recorded in
  `artifacts/release-optimization-2026-10-24/font-provenance.json`. The inherited third-party cursor
  packs and legacy OpenScreen marketing images stay out of the app.
- `supply-chain/web-demuxer.json` binds the checked-in WebAssembly bytes to their exact source,
  FFmpeg configuration, Emscripten image, hashes, and relinking instructions.

`npm run supply-chain:notices` regenerates `THIRD-PARTY-INVENTORY.json` from the release inventory
and these reviewed policies. The generated file includes the shipped components, excluded-only
components, asset groups, and hashes for the complete texts under `third-party-licenses/`. Do not
hand-edit either generated inventory.

## `web-demuxer.wasm` corresponding source

The shipped `web-demuxer.wasm` has SHA-256
`f33a4d44f60dc2e6ca63b06063ae6de575b2b86cd45d92378e21bd8a01ff12d7`. It is byte-identical to the
full build in `web-demuxer@4.0.0`. The source lock binds wrapper commit
`91721712b063bd65ac5963aa4e03e7eda4b17eff` to FFmpeg commit
`e38092ef9395d7049f871ef4d5411eb410e283e0` and Emscripten `3.1.60`.

Run this command to verify the installed npm package and checked-in binary, or to generate the
matching source offer:

```bash
npm run supply-chain:web-demuxer
node scripts/web-demuxer-source.mjs --write --output-dir <empty-directory>
```

The source offer contains the verified wrapper archive, FFmpeg archive, source manifest, and exact
relinking instructions. A clean x86 Emscripten rebuild produced the same SHA-256 on 2026-08-28.
Release CI generates this source offer from the approved lock. The seven global files contain the
two WebAssembly source archives, the native macOS FFmpeg source, the BtbN FFmpeg source and build
source, one manifest, and one relinking guide. Each platform build also emits its packaged FFmpeg
file hashes after the final application signature, embedded configuration, source mapping, and
target-specific relinking guide. The
publisher requires all release-target evidence before it stages a stable release. The WebAssembly
file ships outside ASAR as
`Contents/Resources/web-demuxer.wasm`, so a recipient can replace it with a compatible relinked
build without modifying the signed ASAR payload.

## Final package policy

`scripts/verify-packaged-distribution.mjs` inspects physical package files and every ASAR entry
before release inventory generation. It accepts only exact per-target native paths and exact
reviewed visual/font bytes. It rejects unknown native helpers, wrong-target native files, unreviewed
models, excluded cursor or legacy asset packs, Clean Voice artifacts, changed notice bytes, and
every extra WebAssembly file. Whisper and its sidecars must have a source-bound helper manifest.
On macOS, that manifest hashes the complete Mach-O content after removing only the replaceable code
signature blob, so Developer ID signing cannot invalidate provenance and a code/data change still
fails. The app-owned `resources` directory is a fail-closed boundary: every physical path must be
reviewed, and executable or image magic is checked without trusting its name or extension. Electron
framework resources are outside this app-owned boundary, but the release inventory still records
and hashes every framework file. The signed `supply-chain/bundled-assets.json` policy separates
reviewed assets, generated application code, required entrypoints, and exact Electron Builder
exclusions. Every packaged first-party file under `dist/` and `dist-electron/` must have the same
portable path, size, and full SHA-256 as an approved file in the clean build output. Every approved
non-excluded build output must also appear in ASAR. Generated JavaScript and CSS must parse as their
claimed type. This rule does not trust an extension, a generated-looking filename, or file-header
classification by itself. ASAR policy checks use the normalized archive path stored by the archive
reader; the human-readable `app.asar!/path` value is never parsed back into a security decision.
This keeps valid `!` characters in archive directory names from changing the policy path. Archived
command scripts are also limited to exact reviewed paths, sizes,
and SHA-256 hashes. An approved package contains exactly one standalone
`resources/web-demuxer.wasm`, the version-matched Electron `LICENSES.chromium.html`, and exact
copies of the generated Klippt notice, inventory, and licence evidence.

## Secret findings and false positives

Treat a finding as a real secret until a person verifies otherwise:

1. Stop release work that could expose the value.
2. Revoke or rotate a live credential first.
3. Remove the current-tree copy and check related logs and artifacts.
4. If the finding is proven harmless or already invalid, add only its exact Gitleaks fingerprint to
   `.gitleaksignore`.
5. Add a nearby comment with the date, origin, and reason.
6. Remove the exception when the inherited history or rule no longer needs it.

Never allowlist a whole path, rule, file type, or value pattern. Reports stay redacted. The one
current exception is an inherited OpenScreen-history fingerprint and does not allow the same pattern
at another commit or line.

## Updating a dependency

Update the relevant lockfile or immutable pin, then run the matching local gates. If a policy must
change, keep the exception exact and record why the current shipped or excluded scope is safe. A
release inventory change must be visible in review. Do not hand-edit a generated inventory or SBOM.
