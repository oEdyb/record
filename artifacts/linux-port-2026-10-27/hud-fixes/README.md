# Linux HUD fixes — October 27

Source: `85a25a4985311f707286d20e47bba9984a44f4c8`.
Ubuntu-floor AppImage: `release/linux-port-20261027-85a25a49/`.
See [result](result.json) for hash and verification scope.

Removed stale geometry mutation disabling native logo dragging while Linux state
resolved. Restored the visible Source chip, wired to the existing native chooser.
The normal mounted AppImage moved with private compositor input, then opened the
KDE sharing picker from Source. Escape restored the HUD. No new media was recorded.
Only the two affected suites ran: 137 tests. Both typechecks, changed-file Biome,
design policy, documentation and package checks pass. No full suite/native rebuild.

Private screenshots: `/tmp/klippt-hud-fix-ready.png`,
`/tmp/klippt-hud-fix-dragged.png`, `/tmp/klippt-hud-fix-picker-ready.png`,
`/tmp/klippt-hud-fix-cancelled.png`. Routine tests did not operate the host desktop.

The blue rectangle matches Niri's configured focus color and padded transparent
window. A local Niri rule disables the decoration for matching floating Klippt
windows; config backup is `~/.config/niri/config.kdl.before-klippt-hud-20261027`.
`niri validate` passes. Exact Niri appearance and dragging still require the user's
reopened app; KWin evidence does not establish that compositor's behavior.

React Doctor repeats its existing effect-cleanup finding in the geometry hook;
the existing cleanup disconnects both observers, cancels animation work and removes
listeners. No new subscription was added.
