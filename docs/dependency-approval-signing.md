# Dependency approval signing

Six tests stay red until Olle signs the dependency approval. Only Olle can do this.

## What to do

Run this in a checkout of the latest `main`, on the machine that holds the key:

```fish
git switch main; and git pull --ff-only; and npm ci; and npx install-electron --no; and npm run supply-chain:approve; and npm run test:supply-chain
```

`npm run supply-chain:approve` lists each input you are approving and refreshes its hash. It then
asks ssh-keygen to sign with `~/.ssh/klippt_dependency_approval`, verifies the signature and
regenerates `THIRD-PARTY-INVENTORY.json`. Read the list before you enter the passphrase. To stop,
press Ctrl-C, then run `git restore supply-chain` to bring back the old signature.

Then save it:

```fish
git add supply-chain THIRD-PARTY-INVENTORY.json; and git commit -m "Approve dependency inputs"; and git push
```

Sign last. Any later change to one of these inputs makes the signature stale, and the command has to
run again.

## Which key

- Private key: `~/.ssh/klippt_dependency_approval`.
- Public key: `supply-chain/dependency-approval-key.pub`
  (`ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIJh45uLBO7GJLfTMh5xLBQ01wBY3f5QMnoQzFG1jx3Ap`).
- Signer identity: `olle@klippt.app`. Namespace: `klippt-dependency-approval`.

On 2026-11-03 the private key was not on the Linux PC, and neither key in `~/.ssh` there matches.
The last signature was made on 2026-10-24, so look on the Mac and in the encrypted credential backup
first.

If the key is lost, create a new one and pin it. This also needs the re-review below, because a new
key is a new root of trust:

```fish
ssh-keygen -t ed25519 -C olle@klippt.app -f ~/.ssh/klippt_dependency_approval
cut -d' ' -f1,2 ~/.ssh/klippt_dependency_approval.pub > supply-chain/dependency-approval-key.pub
```

Add `supply-chain/dependency-approval-key.pub` to the commit and record the rotation in the project
log.

## Which tests turn green

- `scripts/check-approved-dependencies.test.mjs`: "matches every current npm, Cargo, CMake, Swift,
  FFmpeg, and model input".
- `scripts/generate-release-inventory.test.mjs`: "rejects a source label that is not an exact
  commit", "creates a deterministic, valid CycloneDX 1.7 SBOM with every source family", "rejects a
  native staging symlink that escapes the packaged tree", "hashes the complete packaged payload and
  final distribution artifacts", and "verifies and inventories the source-bound native helper
  manifest".

`npm run supply-chain:notices` also passes after signing, because the regenerated inventory is
current.

## What you are approving

The signature covers everything that changed since 2026-10-24, not only the Parakeet model. Twelve
inputs had drifted before this work: the Cargo manifests, `package-lock.json`,
`website/package-lock.json`, `electron/stt/modelManager.ts`, `scripts/ffmpeg-pins.mjs` and
`supply-chain/bundled-assets.json`. `supply-chain/model-rights.json` joins them. To see what changed
in one of them, run `git log -p --since=2026-10-24 -- <path>`.

Licence decision inside this approval: `csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8` has
no licence tag. It is recorded as CC-BY-4.0 because it is k2-fsa's ONNX export of NVIDIA's CC-BY-4.0
model. The export's author never stated this directly. Signing means you accept that reading.

## Why the signature stays

The gate was never about sales. It stops a changed lockfile, native manifest or model pin from
reaching a release without a recorded decision by Olle. A public repository accepts outside pull
requests, so that matters more now. CODEOWNERS alone cannot replace it, because Olle is the only
maintainer. Nothing was removed or weakened.

The `Supply chain` workflow is currently disabled on GitHub, so CI does not enforce this today.
`build.yml` still calls it before any release build.
