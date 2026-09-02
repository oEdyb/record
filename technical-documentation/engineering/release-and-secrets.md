# Release and secrets

Klippt's release machinery lives in `.github/workflows/prerelease.yml`, `promote.yml`, and `build.yml`. The workflow requires signing, notarization, public-feed, and publication credentials from the `release` environment. Repository variables hold non-secret configuration. The hardened workflow is implemented, but the current external setup still needs the Apple and R2 secrets moved to that environment before the first current release. This page is the operational reference for cutting releases and maintaining those credentials; [`../../HANDOFF.md`](../../HANDOFF.md) tracks the live release gate.

## Release flow

### Prepare and sign a release candidate

Run the `Prepare a release candidate` workflow (`prerelease.yml`) with:

- `bump`: `patch`, `minor`, or `major`; default `minor`.
- `rc_number`: the numeric `rc.N` counter; default `1`.
- `target_version`: optional stable-version override such as `2.0.0`.

The workflow computes `X.Y.Z-rc.N`, migrates items from `Next Release` to the `vX.Y.Z` milestone, creates or reuses `release/vX.Y.Z`, and commits the prerelease version. It does not create a tag or start a release build. The workflow summary shows the exact frozen SHA and a local SSH-signing command.

Run that command on Olle's Mac. The private release key stays at `~/.ssh/klippt_dependency_approval`; it never enters GitHub Actions. The annotated signed tag push starts `build.yml`. The source resolver accepts only the exact Ed25519 public key stored in the external repository variable `KLIPPT_RELEASE_PUBLIC_KEY`, the signer identity `131144165+oEdyb@users.noreply.github.com`, and the commit resolved from the tag. An unsigned, lightweight, mismatched, or replaced tag fails before any package job starts.

RC tags are signed and notarized exactly like stable ones. That keeps testers out of `xattr -rd com.apple.quarantine`, and exercises the whole credential path on every candidate instead of first proving it on the promotion build.

### Promote to stable

Run `Prepare RC promotion to stable` (`promote.yml`) with:

- `rc_tag`: required tag matching `vX.Y.Z-(rc|beta|alpha).N`.

The workflow verifies the RC signature against the external release key. It also requires the frozen release branch tip to equal the tested RC commit. If the branch moved, cut and test a new RC. The workflow changes `package.json` and `package-lock.json` to the stable version, pushes that exact commit, and syncs it to `main`. It does not create the stable tag. Sign the exact SHA from the workflow summary on Olle's Mac. The signed tag starts `build.yml`.

`build.yml` checks out one resolved SHA everywhere. It runs the supply-chain gates and source-bound Whisper build before platform packaging. The release creates a private GitHub draft first. It then publishes and verifies immutable update artifacts, validates and publishes the mutable feeds, fetches every public file to compare size and SHA-512, and publishes the draft last. A stable `release: published` event closes the milestone, announces Discord, and starts Homebrew, WinGet, Nix, and AUR.

The supply-chain job also creates the exact `web-demuxer.wasm` corresponding-source offer from the
approved source lock. The publisher downloads that source-bound artifact before staging a release.
The wrapper archive, FFmpeg archive, source manifest, and relinking instructions are uploaded to the
private GitHub draft and the immutable public artifact path before any mutable update manifest is
published. The release contract tests fail if the source offer is missing or staged too late.

All production publishers share the `klippt-production-release-publish` concurrency group. GitHub
runs only one job in that group at a time. Before the first external write, a stable publisher fetches
the public `latest.json` without cache. It rejects an older version. A same-version retry is allowed
only when the published source commit is identical. Network errors, invalid JSON, an unknown source,
or an oversized manifest stop publication. This keeps a slower old build from replacing a newer
update feed. The rule follows GitHub's official
[deployment concurrency contract](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

### Release branches (the contract)

Every released version has **exactly one frozen branch**, named for the stable version, living from the first RC cut onward:

```text
release/vX.Y.Z         created at rc.1, frozen through promote, kept for backports
release/vX.Y.Z-sync    ephemeral, created by promote to merge into main
```

The name carries **no `-rc.N` suffix**. `prerelease.yml` and `promote.yml` must resolve the same ref, and every RC of a version re-cuts from this one branch.

1. **`prerelease.yml` creates the branch at rc.1 and reuses it for later RCs.** It must never delete or recreate it: that would drop the cherry-picks and silently re-cut from `main`, defeating the freeze this contract exists to guarantee.
2. **`promote.yml` is the only automated writer** that turns `-rc.N` into the stable version on the branch. Only Olle's local release key can turn that prepared commit into a release tag.
3. **`main` is never frozen.** Development continues as usual; the release branch is the freeze.
4. **Cherry-picks during the RC window** are committed manually by a maintainer (`git checkout release/vX.Y.Z && git cherry-pick <sha>`), then rerun `prerelease.yml` with the next `rc_number` to re-tag the branch tip.

Only cherry-picked bug fixes land on the branch between cut and promote. Features, refactors, and CI/docs changes are **not** applied — they live on `main` and ship in the next cycle. `git log release/vX.Y.Z..main --oneline` lists exactly what is *not* in the RC.

The branch **stays around** indefinitely: it is the frozen history of the release, useful for backports and forensics. Retiring one is a manual decision, taken only once a future major supersedes the line it froze.

This contract exists because of the **v1.6.0 incident (2026-07-05)**: the original `promote.yml` checked out `main`, so the stable tag captured the post-RC tip of `main` rather than the RC snapshot. Twenty-three commits (Tiptap, NotesWindow, an in-recorder lint button, AI handoff) shipped in v1.6.0 without ever having been in v1.6.0-rc.1. The re-release the same day used `release/v1.6.0` and cherry-picked only the commits that were genuinely safe.

Day-to-day branching, PR, and review procedure is maintained in [the operational git workflow](../../.harness/docs/git-workflow.md).

### Manual fallback

When the dispatch UI is unavailable, the release can be cut from a shell. Set the version with `.github/scripts/set-release-version.mjs` — the same script both workflows call — and **never with a hand-rolled `sed` on `package.json`**: the script also writes `package-lock.json`, and a release commit that bumps only `package.json` ships a lockfile whose root version disagrees with the package it locks. `npm ci` does not reject that (the root `version` field is not a dependency, so the sync check ignores it), which is how three releases shipped with the mismatch before anyone noticed.

```bash
RC=1.5.0-rc.1                          # bump the rc.N for every later candidate

# Cut RC (skips milestone migration and Discord announce)
git checkout -b release/v1.5.0 main    # rc.2+: git checkout release/v1.5.0 instead
node .github/scripts/set-release-version.mjs "$RC"
git commit -am "chore(release): bump to $RC [skip ci]"
git push origin release/v1.5.0
git -c user.name='Olle Dyberg' \
  -c user.email='131144165+oEdyb@users.noreply.github.com' \
  -c gpg.format=ssh \
  -c user.signingkey="$HOME/.ssh/klippt_dependency_approval" \
  tag -s -m "Klippt v$RC" "v$RC" HEAD
git push origin "refs/tags/v$RC"

# Promote (skips milestone close and Discord announce)
git checkout release/v1.5.0
node .github/scripts/set-release-version.mjs 1.5.0
git commit -am "chore(release): bump to 1.5.0 [skip ci]"
git push origin release/v1.5.0
git -c user.name='Olle Dyberg' \
  -c user.email='131144165+oEdyb@users.noreply.github.com' \
  -c gpg.format=ssh \
  -c user.signingkey="$HOME/.ssh/klippt_dependency_approval" \
  tag -s -m "Klippt v1.5.0" v1.5.0 HEAD
git push origin refs/tags/v1.5.0
```

A tag pushed with your own credentials **does** fire `build.yml`'s `push:` trigger, so the release publishes on its own and no explicit dispatch is needed — that restriction only applies to `GITHUB_TOKEN`. Either way the same `build.yml` builds and publishes.

The fallback skips milestone migration/closure, release-branch automation, main synchronization, and Discord announcements, so the operator must preserve the freeze and the version/tag match by hand.

### Backports / patch on a previous line

For a `v1.4.2` while `v1.5.0` is in flight:

1. Branch `release/1.4.x` from the `v1.4.0` (or `v1.4.1`) tag.
2. Cherry-pick the fix commits.
3. Push the branch, then create a signed annotated `v1.4.2-rc.1` tag on the branch tip with the release key.
4. `git push origin release/1.4.x v1.4.2-rc.1` — `build.yml` works from any branch.

No new workflow code is needed; the tag-pushed trigger is branch-agnostic.

### Issue tracking during a release cycle

- **Daily state**: issues/PRs accumulate in the rolling `Next Release` milestone. `merged-pr-bookkeeping.yml` adds them automatically on PR merge; maintainers can also drag issues in by hand.
- **At RC cut**: `prerelease.yml` snapshots `Next Release` into a versioned `vX.Y.Z` milestone. The rolling milestone is left open and empty for new work.
- **Between RC cut and promote**: any PR that merges during the RC window lands back in the empty `Next Release`. It is **not** retroactively added to `vX.Y.Z`. If a critical fix lands, cut `vX.Y.Z-rc.(N+1)` instead of promoting.
- **After stable publication**: `announce-release.yml` closes the `vX.Y.Z` milestone and uses its issues to populate the Discord release announcement.

## Required release credential

### `KLIPPT_RELEASE_TOKEN`

This fine-grained personal access token creates and publishes GitHub releases, closes the release milestone, and lets the release event start downstream automation. It cannot sign release tags. Preparation workflows use their explicitly scoped `GITHUB_TOKEN`; they do not receive this token.

Grant the token access only to `oEdyb/record` with:

- Contents: read and write.
- Issues: read and write.
- Pull requests: read and write.
- Actions: read and write, for explicit build dispatch.
- Metadata: read-only.

Create a fine-grained token, set a finite expiry, and save it as an environment secret:

```bash
gh secret set KLIPPT_RELEASE_TOKEN --env release --body "<token>" --repo oEdyb/record
```

Rotate it by creating the replacement with the same repository and scopes, updating the secret, verifying a non-destructive workflow/API operation, then revoking the old token. Do not revoke the previous token until the replacement is installed.

The repository permits the explicitly write-scoped promotion workflow to create its release-sync PR. The workflow uses a normal rebase merge and has no branch-protection bypass.

## Apple signing and notarization

Run `npm run release:check:mac` before a local public build. The command requires a real
`Developer ID Application` identity. An `Apple Development` identity is valid for development,
but Gatekeeper rejects it for public distribution.

`build.yml` enables signing only when all of these `release` environment secrets are present:

| Secret | Purpose |
|---|---|
| `MAC_CERTIFICATE_P12` | Base64-encoded Developer ID Application certificate and private key imported into a temporary keychain. |
| `MAC_CERTIFICATE_PASSWORD` | Password protecting the P12 archive. |
| `MAC_CSC_NAME` | Identity name without the `Developer ID Application:` prefix, passed to electron-builder and `codesign`. |
| `APPLE_ID` | Apple account used by `notarytool`. |
| `APPLE_TEAM_ID` | Apple Developer team identifier. |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password used by `notarytool`. |

The certificate account needs Developer ID signing capability, and the Apple account/app-specific password must be able to submit notarization requests for the team. Every release tag signs the DMG, notarizes it, inspects Apple's result log, and staples and validates both the DMG and its nested app, pre-releases included. The auto-update ZIP is then built from that stapled app because ZIP archives cannot carry a stapled ticket themselves. A release fails if any value is missing. An artifact-only build uses the separate `artifact-build` environment and can produce an ad-hoc development DMG without receiving release secrets.

`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_ACCOUNT_ID` also belong in the `release` environment. Before the first W0.3 release, recreate the Apple and R2 secrets there, verify their names with `gh secret list --env release --repo oEdyb/record`, then delete the repository-level copies. Do not delete the old copies before the W0.3 workflow is on the release branch.

Rotate the certificate by exporting a replacement P12, base64-encoding it without line-wrap changes, updating the P12/password/name secrets together, testing a stable-format manual build, then revoking the old certificate if required. Rotate the app-specific password in Apple ID settings, replace `APPLE_APP_SPECIFIC_PASSWORD`, verify notarization, and revoke the old password. `APPLE_ID` and `APPLE_TEAM_ID` normally change only when the owning account or team changes.

## Microsoft Store publishing

`build.yml`'s `publish-msstore` job submits the appx to the Store through the [Microsoft Store Developer CLI](https://learn.microsoft.com/en-us/windows/apps/publish/msstore-dev-cli/github-actions). It runs for **stable versions only**, whether that comes from a pushed `vX.Y.Z` tag or from a manual `workflow_dispatch` whose `release_tag` is a stable one. An RC is excluded either way: it would go through certification and land on every user's machine as an automatic update.

| Name | Kind | Purpose |
|---|---|---|
| `MSSTORE_PRODUCT_ID` | Variable | Store product ID (`9MXQ1HQJL5G5`). Gates the whole job, so a fork never publishes to our listing. |
| `AZURE_AD_TENANT_ID` | Secret | Entra tenant associated with the Partner Center account. |
| `AZURE_AD_APPLICATION_CLIENT_ID` | Secret | Application (client) ID of the Entra app registration. |
| `AZURE_AD_APPLICATION_SECRET` | Secret | Client secret of that registration. The only real credential here. |
| `SELLER_ID` | Secret | Publisher/Seller ID from Partner Center account settings. |

With none of them set the job warns and skips, leaving the appx to be uploaded by hand from the run's artifacts; with some but not all it fails, on the same reasoning as the Apple path.

One-time setup, in order — each step depends on the previous one:

1. Associate an Entra tenant with the Partner Center account.
2. Register an application in Entra ID and create a client secret for it.
3. In Partner Center, under **Account settings → User management → Microsoft Entra applications**, add that application and give it the **Manager** role. Tenant and client IDs alone are not enough; the failure is an authorization error at submit time.
4. Set the four secrets and the variable.

Note what this does and does not remove. It removes the manual upload — which is worth having in itself: 1.8.0 ended up with two different packages under one version because the artifact was downloaded twice and both copies uploaded, and Partner Center rejects that outright. It does **not** remove certification: every submission still waits for Microsoft to validate it, and the update only goes live afterwards.

Two constraints from Microsoft's documentation: automated updates through GitHub Actions are supported **for free products only**, and the app must already be published and live in the Store — the API cannot create a listing, only submit to an existing one.

`msstore submission updateMetadata` can also drive the Store listing text from a versioned `metadata.json`, which would replace the CSV export/import round-trip. Not wired up here.

**It has submitted nothing yet.** v1.9.5 was the job's first real run — it did not exist on the v1.9.1 or v1.9.2 builds — and it failed: `We could not find a project publisher for the project at …Openscreen.Setup.1.9.5.appx`. Credentials were fine; the CLI reported the configuration valid and resolved the product. The call was wrong. `msstore publish` takes a **project root** as its positional argument, detects the app type there, and only then accepts a built package through `--inputFile`; the job passed the `.appx` positionally and never checked the repo out, so there was no project to detect. Fixed by adding a checkout (before the artifact download — `actions/checkout` cleans the workspace) and calling `msstore publish . --inputFile <appx> --appId <id>`.

That failure was visible only because the same release carried the fix that reports the submission's real outcome instead of the configuration's. The prior version wrote "Submitted to the Store" whenever credentials resolved, under `always()` — so this exact failure would have shipped as a green success.

**Still unverified, and the next thing likely to break:** `--inputFile` is documented for `.msix` and `.msixupload`, and `build:win:store` produces an `.appx` (`electron-builder --win appx`). Whether the CLI accepts that extension is untested.

### Retrying a Store submission

`publish-msstore.yml` submits an already-built appx on demand: `workflow_dispatch` with a stable `release_tag`, optionally a `run_id` (defaults to the most recent `build.yml` run for that tag), and a **`dry_run`** flag.

It exists because `build.yml`'s own job has no usable retry. Re-running the failed job replays the workflow definition frozen into the original run, so a fix landed afterwards is never picked up. The release workflow now refuses to replace an existing GitHub release or immutable R2 object, which makes a full rebuild the wrong recovery path for a Store-only failure. Before the W0.3 gate, re-dispatching could use `--clobber` and even build from a different source; v1.9.5 hit that older design.

**`dry_run: true` is the only safe way to test this path.** It passes `-nc, --noCommit`, which creates the submission and leaves it in draft instead of sending it to certification. Without it — and this is what `build.yml` does — `msstore publish` commits, so a dispatch fired "just to see whether the `.appx` is accepted" puts a build in front of users. Validate with the dry run first; submit for real only once it comes back clean.

Rotate by issuing a new client secret on the Entra registration, updating `AZURE_AD_APPLICATION_SECRET`, publishing one release to confirm, then deleting the old secret. The tenant, client and seller IDs change only when the registration or account does.

## Discord secrets and variables

| Name | Kind | Used for |
|---|---|---|
| `DISCORD_BOT_TOKEN` | Secret | RC/stable announcements, PR forum sync, roadmap sync, and weekly leaderboard posts. |
| `DISCORD_REVIEWER_ROLE_ID` | Secret | Role mention used by PR-to-Discord synchronization. |
| `DISCORD_RC_TESTING_CHANNEL_ID` | Variable | RC announcement destination. |
| `DISCORD_RELEASE_CHANNEL_ID` | Variable | Stable announcement destination. |
| `DISCORD_PR_FORUM_CHANNEL_ID` | Variable | Forum that receives PR threads. |
| `DISCORD_ALERT_CHANNEL_ID` | Variable | Optional alert destination for PR sync failures. |
| `DISCORD_ROADMAP_CHANNEL_ID` | Variable | Channel containing the synchronized roadmap message. |
| `DISCORD_ROADMAP_MESSAGE_ID` | Variable | Optional explicit message override; pin discovery is otherwise used. |
| `DISCORD_SPOTLIGHT_CHANNEL_ID` | Variable | Weekly leaderboard destination. |

The bot token comes from a Discord application authorized with the `bot` scope. Grant only the channel permissions each automation needs: View Channel, Send Messages, Embed Links, Create Public Threads and Send Messages in Threads for forum use, Manage Threads for forum state, and Manage Messages when roadmap pinning is required. Rotate by resetting the bot token in the Discord developer portal, updating `DISCORD_BOT_TOKEN`, testing a non-release post/sync, then invalidating the old token automatically through the reset. Channel and role IDs are identifiers rather than credentials; update their repository variable/secret when channels or roles are replaced.

## Package registry credentials and variables

| Name | Kind | Required access and use | Rotation |
|---|---|---|---|
| `HOMEBREW_TAP_TOKEN` | Secret | Token accepted by checkout/push for the repository named by `HOMEBREW_TAP_OWNER` and `HOMEBREW_TAP_REPO`; contents write is sufficient for a dedicated tap. | Create a replacement, update the secret, manually dispatch `update-homebrew-cask.yml`, then revoke the old token. |
| `HOMEBREW_TAP_OWNER` | Variable | Owner of the tap repository. | Update when the tap moves. |
| `HOMEBREW_TAP_REPO` | Variable | Tap repository name. | Update when the tap moves. |
| `HOMEBREW_CASK_NAME` | Variable | Cask filename/name; defaults to `openscreen` when unset. | Update with the tap's cask rename. |
| `WINGET_ACC_TOKEN` | Secret | Token consumed by `winget-releaser` to submit to the WinGet community repository; grant the scopes required by that action's upstream submission account and no unrelated repository access. | Replace the token, update the secret, replay `publish-winget.yml` for a stable tag, then revoke the old token. |
| `WINGET_IDENTIFIER` | Variable | Package identifier passed to the WinGet action. | Update only if the Store/community identifier changes. |
| `AUR_SSH_PRIVATE_KEY` | Secret | Private SSH key whose public key is authorized for the configured AUR package repository. | Add a replacement public key to AUR, update the private-key secret, manually dispatch and verify, then remove the old AUR key. |
| `AUR_KNOWN_HOSTS` | Variable | Pinned `aur.archlinux.org` host-key lines; required because strict host checking is enabled. | Replace only after independently verifying an AUR host-key change. |
| `AUR_PACKAGE_NAME` | Variable | AUR repository/package name and workflow gate. | Update if the package is renamed. |

`bump-nix-package.yml` uses the workflow-scoped `GITHUB_TOKEN`; it requires repository contents and pull-request write permissions as declared in the workflow and has no additional long-lived secret.

**Homebrew publishing does not complete yet, and now says so.** `update-homebrew-cask.yml` has never published a cask — not once since it was written for the v1.5.0 pipeline. Neither `HOMEBREW_TAP_OWNER` nor `HOMEBREW_TAP_REPO` has ever existed on this repository, both sat in the job-level `if`, and an unconfigured job resolves to `skipped`, which is green: every release run reads as a success. The same failure as WinGet below, found the same way and fixed the same way — the configuration test now lives in a step that names what is missing (#335). Three things are needed, and the third is the one a variable cannot supply: `HOMEBREW_TAP_OWNER` and `HOMEBREW_TAP_REPO`; the `HOMEBREW_TAP_TOKEN` secret with contents write on that repository; and the tap repository itself, which **must** be named `homebrew-<something>` — that prefix is how `brew tap` resolves a repository at all, so `getopenscreen/openscreen-tap` would be checked out and pushed to successfully and still be untappable. With `getopenscreen/homebrew-openscreen`, the install command is `brew install --cask getopenscreen/openscreen/openscreen`.

The two DMGs attached to a release are always signed, notarized, and stapled. A cask does not add trust; it adds discovery and `brew upgrade`. An artifact-only ad-hoc DMG is never eligible for release publication.

**WinGet publishing does not complete yet, and now says so.** `publish-winget.yml` starts on every stable release; whether it publishes depends on four prerequisites, and it names the missing ones in a `::warning::` instead of passing quietly. It used to pass quietly: the configuration test sat in the job-level `if`, an unconfigured job resolved to `skipped`, and a skipped job is green — so eight releases in a row reported success while publishing nothing, which is how #148 stayed open without anyone noticing. The four are: `WINGET_IDENTIFIER` (set, `OpenScreen.OpenScreen`); `WINGET_ACC_TOKEN` (absent — it must be a *classic* PAT with `public_repo`, since `winget-releaser` does not support fine-grained ones); a fork of `microsoft/winget-pkgs` under `getopenscreen`, which is where the action pushes its branch; and at least one version of the package already merged into `winget-pkgs`, because the action writes each manifest from the previous one and refuses to author the first. That first submission is manual, via `wingetcreate new`.

Note what it would publish before turning it on: `winget-releaser` submits the **NSIS `.exe`** attached to the release to the community repository, and that installer is unsigned. Users who install through the Microsoft Store, or through `winget --source msstore`, get the Store package that Microsoft signs during certification instead. Publishing to the community source therefore adds a second, unsigned route alongside the signed one — worth doing deliberately rather than by flipping a variable.

## Automatic `GITHUB_TOKEN`

GitHub supplies `GITHUB_TOKEN` per run. Workflows use it for semantic PR validation, release-asset reads, issue bookkeeping, and the Nix bump PR. Its scopes come from each workflow's `permissions` block and it is not manually created or rotated. Do not replace it with a PAT unless cross-workflow triggering or external-repository access is actually required.

## Secret-handling rules

- Store credentials as repository or environment secrets, never repository variables or committed files.
- Keep non-sensitive channel IDs, package IDs, repository names, and known-host material in variables.
- Scope tokens to the single repository or external package destination they need.
- Rotate before expiry and verify the replacement before revoking the previous credential.
- Treat workflow logs and manual shell commands as public: pass values through secret inputs/environment variables and never echo them.

The full-history scanner, its exact-fingerprint exception policy, and the response procedure for a
new finding are documented in [dependency and release supply chain](supply-chain.md#secret-findings-and-false-positives).
