# Automatic review and camera continuity — September 8, 2026

## Implemented

The Automatic inspector now lists generated effect groups with saved trigger reasons, playback
times, jump, Adjust, Keep and Remove. Keep all and Remove all save one edit. Four groups are shown
per page. Adjust opens the existing timeline inspector; it does not create another effect model.
No new dependencies or detector thresholds were introduced.

Keep changes ownership to manual. Remove persists bounded exact-effect exclusions (5,000 entries,
2,048 characters each). Regeneration filters these after planning. Source-millisecond identity
survives clip moves and floating-point rematerialization. Changed timing or framing remains eligible.
The pane explains this limit and provides Allow dismissed effects again. Legacy effects report
missing trigger evidence honestly. New strings use English fallback in the other locales.

The whole tuning pane is keyed by project ID. Leaving a project cancels queued work and prevents
old failures from appearing in the new project. Review cancels pending tuning before saving.

## Sources and review

- [React: Updating arrays in state](https://react.dev/learn/updating-arrays-in-state): immutable
  document transformations; resolve bulk members once, then construct one candidate.
- [React: Preserving and resetting state](https://react.dev/learn/preserving-and-resetting-state):
  project identity resets the complete tuning session.
- [Radix Popover](https://www.radix-ui.com/primitives/docs/components/popover): retain the existing
  inspector component system and keyboard behavior rather than adding a UI dependency.

Independent review found two issues: floating-point exclusion identity after clip movement, and
queued tuning state crossing projects. Both were fixed with regressions. Final review reported
no remaining findings.

## Verification

- Full suite: 283 files passed; 2,908 tests passed, one skipped.
- App and test TypeScript checks passed. Vite build and 12-locale i18n validation passed.
- Biome passed with the existing oversized Cargo evidence warning. Generated probe output was
  formatted; its generated unused constants have a file-local lint annotation.
- Real Mac editor proof used a copy of the August 17 screen/camera recording in an isolated profile.
  Regeneration produced two screen groups and two camera groups with actual saved reasons.
  Jump sought 12.95 seconds. Adjust opened the existing Zoom inspector.
- Live Keep, Remove and Regenerate preserved the exact kept camera region, excluded all four
  members of the removed screen group, and preserved assets and timeline. Saved snapshots and
  a screenshot are in `artifacts/automatic-review-2026-09-08/`.
- The development native file picker did not enable Open for the test copy. The fixture was seeded
  in the isolated project library instead. Media initially outside that profile's permitted paths
  failed clearly; copying it into the isolated recordings directory restored preview and analysis.
  This proof does not establish a passing native Browse-files flow.

## Camera continuity

No additional production camera change was needed. The current native implementation and
TypeScript geometry matched within 0.001 pixel over 23,088 samples. Boundary samples, reverse
evaluation, native seeking and a real MP4 export passed the focused geometry checks.
One of 14 reverse-seek frame pairs had a small camera-pixel difference with identical geometry;
its decoder cause is unconfirmed. This is not a claim of perfect pixel determinism or editorial
quality across all footage. The [camera audit](../artifacts/camera-motion-2026-09-08/README.md)
owns the full measurements and proof video.

## Local delivery

Signed with Developer ID Application: Dyberg & Co AB (LF8KF3G42Q), then installed at
`/Applications/Klippt.app`. Deep strict signature checks passed for packaged, staged and installed
bundles. The previous bundle is retained in `Archived Apps.noindex/installed-before-automatic-review-20260908.app`.
The installed app reopened the existing 20.3-second project, with its caption lane intact, and
displayed the new Automatic review controls. No new app identity or permission grant was used.
This is a working-tree development checkpoint, not a public release or a remote commit.

Spotlight returned only `/Applications/Klippt.app` after installation. Project card and Agent Log
were updated. Vault validation reports the same nine unrelated lifecycle/directory errors; no
unrelated vault content was changed.
