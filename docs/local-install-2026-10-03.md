# Signed local installation — 2026-10-03

The user explicitly authorized installing the overnight build after asking whether it was installed.
This supersedes the earlier prohibition on replacing the installed app for this local installation.
The release pipeline, remote branches, and Resolve remain untouched.

## Build and identity

Source commit: `08c403167bbebd2312c28a40620f3af1107db113`, including product code in
`15d00ad5a818ad92c535412162576e57cd12d369`.

Rebuilt ScreenCaptureKit/cursor, Parakeet, Metal compositor, Whisper and Vite bundles using the
existing scripts and pinned Node 22.22.1/npm 10.9.4. Whisper provenance verifies built upstream
checkouts against the pinned CMake revisions and binds the staged files to this source commit.
Packaged an arm64 directory build under `.local-install.noindex/overnight-2026-10-03`, with
`--publish never` and the existing Dyberg Developer ID. No pipeline files changed.

The existing `afterSign` guard passed. App and cursor-helper designated requirements are identical
to the installed version. All 124 packaged compiled code files match the clean build byte for byte.
The previous app backup is:
`/Users/olle/Library/Application Support/Klippt/Archived Apps.noindex/Klippt-before-overnight-2026-10-03.bundle-backup`.
Its deep, strict signature verification passed.

## Installation status

Pending: the installed app began an actual recording during packaging. Replacement is deferred
until that session closes; no stop, quit, force-kill, permission reset, or media deletion was sent.

## Remaining release limitation

The public distribution verifier rejects `dist/.vite/manifest.json` as an unapproved build output.
This is the same documented limitation as the September 7 local install. Its failed log is preserved;
it was not reported as passed or bypassed. The signed local build is not a notarized/public release.
No release policy, allowlist, or security check was changed to resolve it.

Evidence: `artifacts/local-install-2026-10-03/`.
