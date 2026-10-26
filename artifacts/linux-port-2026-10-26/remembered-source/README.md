# Remembered Linux source grants — October 26, 2026

Linux Record now supplies the last compatible ScreenCast restore token. Source is
available in idle settings as well as paused settings and always requests a fresh
chooser. Unchanged Continue retains its live portal session.

Tokens live only in the main-owned recording directory, in a mode-0600 receipt.
Claiming atomically removes a token before use; only the rotated token is saved.
Cursor-mode changes, missing/corrupt receipts, revoked grants or unsupported
persistence return to the normal chooser. An explicit choice discards the prior
receipt even if cancelled, so later Record cannot silently select the former
source. A cancelled paused replacement still leaves its current capture intact.
Replacement receipts commit after usable-frame adoption. The cache location is
fixed at helper startup and survives renderer-driven audio reconfiguration.

## Focused evidence

`probe.py` runs only inside `agent-lab klippt`. Native traces/media remain in its
private `remembered-source/` directory; `result.json` contains no tokens.

- First grant: real KDE chooser, owned teal window, 2.1-second NVENC video.
- Reuse: no chooser, source-selected at 249 ms from process launch; same node and
  decoded background as the first recording. Rotated receipt remains mode 0600.
- Explicit choice: chooser opens despite an existing grant. Selecting the purple
  fixture changes the node and decoded background. Fully decodable 2.1 seconds.
- Cancel: Escape produces portal-cancelled, no frames, no receipt. Next Record
  opens the chooser, and its explicitly selected purple source fully decodes.
- Built production renderer/main with the final native helper: idle Source opens
  the real chooser without opening audio/camera writers. Choosing a source returns
  to idle; two recordings then restore it without another chooser, persist session
  manifests, and open review. The second Record control entered recording state
  in 137 ms; this is a UI observation, not calibrated first-packet latency.
- Built-app integration used the repository's Electron/CDP harness. An additional
  private compositor-input pass reached New recording → Settings → Source and
  selected the other owned window through the native chooser. Its later Record
  still required consent in that case; backend restoration is not guaranteed. No host input,
  clipboard, picker or audio was used.

Protocol probes ran during implementation; their first binary hash was not
retained. `result.json` separately identifies the rebuilt helper used by the app
checks after the immutable cache-path correction. This is development evidence,
not a new immutable portable release or a complete manual release checklist.

Affected checks: portal/grant and request native tests, focused renderer/HUD and
IPC suites, both TypeScript checks, touched-file Biome, helper strict Clippy and
formatting. No full suite or new hour soak. Latest React Doctor reports a generic
complexity warning in the existing large hook; no new correctness finding in this
slice. Its branch-wide scan also flags the unchanged HUD geometry hook.

Exact Niri/GNOME portal persistence and physical devices remain unverified by this
KWin pass. Backends may still require consent; Klippt requests supported grant
reuse rather than bypassing compositor policy. Mac is unchanged by the grant path.

Contract: [ScreenCast v4+ persistence and single-use restore tokens](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html),
checked against the pinned ashpd 0.9.3 source (`PersistMode::ExplicitlyRevoked`,
`StartResponse::restore_token`).
