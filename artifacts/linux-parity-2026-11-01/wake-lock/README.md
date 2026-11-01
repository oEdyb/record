# Linux display-awake guard — isolated D-Bus check (2026-11-01)

Question: does Electron 44.9.1's `powerSaveBlocker.start("prevent-display-sleep")` reach
the session idle-inhibit service on Linux, which is what `RecordingWakeLock` relies on?

Method (no host session, no GPU, no capture): `dbus-run-session` starts a private bus.
`mock_screensaver.py` owns `org.freedesktop.ScreenSaver` there and logs each call.
`electron-main.js` (run with `ELECTRON_RUN_AS_NODE` unset, `--no-sandbox --disable-gpu
--ozone-platform=headless`, `nice -n 19`) starts the blocker, waits 1.5 s, stops it.

Result (`calls.log`): one `Inhibit` and one `UnInhibit` with the matching cookie, issued
by the Electron binary. `isStarted` went true then false.

Why it matters on this machine: Olle's Niri session owns `org.freedesktop.ScreenSaver`
(`busctl --user list`, pid of `niri`), so the same call is honored there. This check did not
touch that session; actual Niri idle behavior during a long take is not measured.

Not covered: compositors without that service. Chromium's behavior there was not measured;
`RecordingWakeLock` only guarantees that a throwing blocker cannot fail the take
(`recordingWakeLock.test.ts`).
