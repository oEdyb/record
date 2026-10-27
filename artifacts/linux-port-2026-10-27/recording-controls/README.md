# Recording controls and Koett coexistence — October 27

Source `7cfe5453559965211849fdc3ea8b6ae143d39d44`; normal-FUSE Ubuntu-floor
AppImage in `release/linux-port-20261027-7cfe5453/`. SHA256:
`e332be780968c5d7fdf83521e26999f703facf23c4b8858498bf5d570abb0a59`.

## Behavior

Monitor and unknown-source recordings hide Klippt before Start/Continue, with a
150 ms unmap allowance. Confirmed Pause restores controls. Open/tray while hidden
requests Pause before showing. Window-only capture can retain controls. Unknown
Wayland monitor placement means no second-monitor exemption is claimed.
Linux defaults migrate the previous Open/Pause defaults to Ctrl+Alt+O/R while
preserving custom settings. Koett keeps Ctrl+Shift+Space. Local validated Niri
bindings invoke the AppImage directly: Ctrl+Alt+R Pause/Continue, Ctrl+Alt+S Stop,
Ctrl+Alt+O controls. Fully quit/reopen an older app to load this behavior.

The owned-window Niri activation helper focuses only one floating Klippt HUD
matching this process, app ID and title. Private nested Niri verification changed
focus from owned background window id 4 to this app's id 2. Plain Electron focus
was insufficient over a private KWin fullscreen fixture; that limitation is not
claimed solved universally.

## Real checks

- Private KWin monitor capture, normal mounted AppImage, NVENC: three committed
  clips, 42,216 / 11,783 / 266 ms. All 3,259 video frames decoded. Every frame was
  scanned at 480×270 for the red record/Stop indicator: zero matching pixels.
  All six isolated audio originals fully decode. See [results](result.json).
- Actual private compositor key events sent through focused nested Niri bindings
  drove Continue → Pause → Continue → Stop. The first three timer states were
  explicitly awaited; Stop closed the HUD and opened populated review with three
  clips. Initial virtual-keyboard injection did not exercise bindings. The final
  harness incorrectly awaited navigation on the closed HUD instead of a new
  editor page; independent inspection confirmed the populated review and manifest.
  No shortcut-latency numbers are claimed from this run.
- Actual Koett plus Klippt shared the same private virtual microphone concurrently.
  Koett transcribed the supplied official 7.435-second test sample (21 words).
  Klippt's 8,183 ms take produced separate microphone/system originals, each
  788,480 decoded interleaved float samples. RMS 0.068867 / 0.068904; peaks
  0.767983 / 0.786835. No physical audio device or host Koett configuration changed.
  This proves concurrent microphone admission, not physical voice quality or
  dictation latency. Koett's own overlay is another app and is not excluded.
- Private nested Niri Settings opening: native position [404,344] stayed fixed,
  window grew 472×112 → 472×466; pill local rectangle [24,38,424,50] and desktop
  top 382 stayed unchanged. Escape did not close Setup, so no collapse result is
  claimed from that attempt.
- [All 33 regular ELF files](native-identity.json), including the Electron runtime,
  match a4f92422 byte-for-byte. Native capture/export performance evidence is
  retained within its original scope; no new universal performance claim.

## Focused verification and limits

Affected controller, shortcut, renderer, IPC startup and focus suites pass. Final
privacy controller: 8 tests. Both typechecks, changed-file Biome, docs/design,
production build and Ubuntu-floor package policy pass. React Doctor repeats the
existing geometry-effect cleanup finding. Held-out reviews caught cancellation,
stale-operation cleanup and stale Stop races; each received a regression and the
final narrow review passed. No full suite, native rebuild or hour soak.

Media tests used private KWin/KDE portal. Nested Niri established layout, owned
focus and compositor binding routing; its nested backend cannot establish native
Niri capture parity. The capped lab reported 30 superseded input frames; this is
not an unrestricted cadence benchmark. Physical Niri keypresses, second-monitor
placement, physical devices and the user's missing cursor sidecar remain gates.
Raw media, screenshots and test transcript remain private outside git.

The launcher and Niri config were updated with backups and syntax validation;
Koett's existing binding was preserved. Routine tests never drove the host seat.

Documentation maintenance: shared development playbook updated locally; checker
reports zero errors and 49 existing path/vendor warnings. The vault project card
and log were updated, but the prescribed vault routing checker is unavailable
on this machine (`/home/olle/dev/vault-tools` is absent).
