# Quit during active screen/camera capture — October 26, 2026

The exact `c8bc3812` AppImage finalized a 52-second screen/camera take on WM
close but remained alive with no app windows. Both MP4 files fully decode and
the camera association is durable. The process was observed alive well after
the 20-second exit deadline, then intentionally sent SIGTERM for cleanup. Its
later code-0 exit after that signal is not a passing original Close result.
`baseline-camera-proof.json` preserves the failed run and saved-media hashes.

A private production-bundle trace shows Quit call 1 closing the windows, followed
by `will-quit`. Quit call 2 from workload cleanup returns without another
`before-quit` or `quit`. Electron 44.9.1 checks is_quitting_ at Quit entry and
resets it only after the will-quit observer returns. Promise reactions from the
native window-close callback can therefore reenter too early.

The initial no-window probe did not reproduce this and was not accepted as
proof. The corrected probe creates an owned hidden BrowserWindow: before the
fix it reaches its two-second cleanup deadline and exits 3; after the fix it
exits 0 without the deadline. `electron-before.json`, `electron-after.json`
and `electron-window-probe.cjs` retain the real Electron regression. The probe
uses the existing TypeScript transpiler and has a guard-source override so it
can compare revisions without changing the worktree. The label selects an
isolated diagnostic profile and output file; it changes no product behavior.

The fix schedules final app.quit with setImmediate after all preview teardown
and report writes finish. Capture/camera completion, the two-second async flush
budget and logout policy stay intact. 24 affected tests pass across workload
quit, capture quit and workload persistence; the new microtask regression fails
before the fix. App build/typecheck and test typecheck pass. No full suite.

The rebuilt host production bundle, without preload/debug instrumentation,
records with the synthetic camera and closes via real private Alt+F4 while still
recording. Exit code is 0 within 223 ms. The screen has 432 fully decoded H.264
frames at 1920×1080/60 fps over 7.2 seconds; camera has 145 frames at 3840×2160,
about 20 fps over 7.2499 seconds. Offset is 1 ms. Container differences do not
establish physical clock parity. Session/journal associations persist before
exit; relaunch restores the take, creates its review project and shows the
camera. Both media hashes are unchanged. Host proof is separate from portable
verification, which follows the runtime commit.

All GUI, input, portals and synthetic camera activity uses the private KWin
agent-lab. No physical camera or microphone is opened. The diagnostic native
stack inspection used a process-local PR_SET_PTRACER preload only on an owned
lab process; no system ptrace setting changed, and it is absent from passing
host/package checks. No media bytes or preload binary are committed.

Primary contract: https://github.com/electron/electron/blob/v44.9.1/shell/browser/browser.cc
(Quit and NotifyAndShutdown), plus the pinned app lifecycle documentation.
