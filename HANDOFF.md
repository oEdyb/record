# Klippt Linux handoff — October 26, 2026

Current worktree: `/home/olle/dev/screenrec-linux`, branch `feat/linux-port`.
Original `/home/olle/dev/screenrec` remains untouched. Draft PR:
https://github.com/oEdyb/record/pull/1.

The current candidate, evidence and remaining gates are maintained in
[Linux acceptance](docs/linux-port-acceptance-2026-10-26.md). Read that record
before running another check or packaging pass. The
[implementation log](docs/linux-port-2026-10-26.md) is chronological evidence;
older “current” builds and limitations describe their own checkpoint.

Linux shares the recording lifecycle, projects, review and export with macOS.
Its Rust helper owns portal/PipeWire capture, per-clip writers and isolated
audio originals; renderer camera files have a durable clip ledger. Windows
remains later work behind the same capture contract. Preserve compatibility
identifiers and persisted data; no global Mac-name cleanup is needed to ship.

## Current delivery

Source follow-up in the current candidate: Linux Record restores compatible portal grants;
Settings → Source chooses afresh before recording or while paused. Private KWin
native and built-app checks pass. Actual Niri grant reuse also passes after
registering the portable AppImage with its user desktop launcher.
See [focused evidence](artifacts/linux-port-2026-10-26/remembered-source/README.md).
The normal-FUSE AppImage passed private OS-driven Source → Record without another
picker → Stop/review; its 2.35-second native clip fully decodes.

Latest portable runtime: `a4f92422d7cfb871edf1e50a417063274985edab`,
`release/linux-port-20261026-a4f92422/`. All four Ubuntu-floor formats and
normal mounted package policy pass. The addon is byte-identical to `6bdd95af`,
whose packaged export preserved the real
four-source take without an override, restoring the screen's two missing frames:
871 muxer-reported frames/14.516 s, full decoding, correct audio and unchanged
originals. Normal CLI exit is 0. This closes the final software candidate checkpoint.

Four-source handoff evidence is in
`artifacts/linux-port-2026-10-26/four-source-export/`: two clips, eight original
hashes preserved, isolated 660/440 Hz audio, correct OTIO/FCPXML tracks, and a
reproduced/fixed rendered-tail mismatch. No full-suite rerun.

## What is left, in priority order

1. Actual Niri and physical-device acceptance remains user-driven unless Olle
   explicitly authorizes physical-session automation. Existing private KWin
   evidence does not establish that coverage.
2. Keep the finite acceptance record current. No routine full suites, hour soaks
   or four-format rebuilds without a concrete changed risk.
3. Broader GPU/desktops, physical timing and Mac regression are compatibility
   gates. Windows is later work. Do not turn those into indefinite synthetic
   retesting or a claim of universal parity.

Global Pause/Continue works in the private lab. Open App's callback arrives but
Wayland focus is denied; KDE shortcut admission becomes inactive after relaunch
despite listed bindings. The independent Electron control reproduces both.
Keep the limitation explicit; do not rewrite registration without new evidence.
Wayland own-window exclusion is also unresolved.

## Working rules

- Only affected tests. Linux GUI/input/audio/portal checks use `agent-lab`; read
  `~/.local/share/agent-lab/README.md`. Stop the owned lab after testing.
- The private lab and owned build container are stopped. Never operate the host
  pointer, windows, clipboard or audio for routine verification.
- No public release or merge to main is authorized by a successful local build.
  CI, Diagnostic artifact and Supply chain workflows are currently disabled by
  Olle; earlier runs hit the billing/spending block. Keep that external gate
  explicit and do not re-enable workflows without instruction.
- The native helper's strict Clippy passes at its checkpoint. Compositor strict
  Clippy has existing generated-binding/unused-code findings; do not suppress
  them or call that gate green. Formatting and scoped tests are separate evidence.

The independent direction review found the architecture sound and recommended
finishing a usable candidate instead of extending synthetic verification loops.
Historical Mac/editor/CLI handoffs remain in
[the previous handoff](https://github.com/oEdyb/record/blob/f8ae4c1ef1097c98c7204e10e85df1759d04763a/HANDOFF.md).
Current product and compatibility rules remain in `AGENTS.md` and
`technical-documentation/product-behavior.md`.
