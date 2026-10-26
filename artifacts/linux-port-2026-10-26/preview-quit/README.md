# Clean-quit preview finalization — October 26, 2026

The immutable `3a177e66` package left preview reports running after normal exit.
Source now uses Electron's final `will-quit` boundary, after capture's existing
before-quit save guard and after windows close. It stops active previews, joins
pending detached teardown, marks only live preview workloads successful and
flushes their durable JSON writes. Capture/export outcomes and previously failed
previews retain their own status. Logout/shutdown bypasses waiting. Repeated Quit
requests cannot skip an active flush; asynchronous report I/O is capped at two
seconds and write failures are logged before exit continues.

The first telemetry-only development check saved the report but crashed in a
still-running NVIDIA preview worker during process exit. It is not a passing
result. `destroyView` normally detached view destruction to keep UI responsive;
final shutdown now explicitly joins both current views and previous teardown
threads before library unload. Ordinary view changes remain asynchronous. The
synchronous final join runs with all windows closed; the two-second asynchronous
flush timer cannot preempt native thread joining.

The rebuilt production bundle under pinned Electron 44.9.1 with the rebuilt
host Linux addon passes real private lab Recordings → Play → Close. The observing
parent process records child exit code **0**, observed 253 ms after Close. The
loaded addon path and SHA are retained in `proof.json`. The completed report
persists `succeeded` and `preview-completed`; a fresh app launch leaves its bytes
and status unchanged. `completed-workload.log` preserves the original JSON bytes
and matches the report SHA. Screenshots contain only the owned fixture.

This is a production-bundle/host-addon development check, not a rebuilt portable
AppImage. The previous floor packages remain `3a177e66`; all formats need the new
addon and JS before claiming portable delivery. No native capture code changed.

Validation: 92 affected JS tests pass, with one existing skip; one native shutdown
regression passes. App/build and test TypeScript checks and touched-file Biome
pass. No full suite. Fresh scoped review reports no introduced high-confidence
P1/P2 findings. Strict addon Clippy remains blocked by unchanged eight-argument
`sync_transport` (`too_many_arguments`); no lint suppression or ABI refactor was
added. Its error is retained. Shared Mac hardware and rebuilt portable checks
remain gates. Private lab stopped after testing.

Primary contract: https://raw.githubusercontent.com/electron/electron/v44.9.1/docs/api/app.md
(`will-quit` occurs after window closure and can be deferred with preventDefault).
Native lifetime is established by the existing LiveView Drop's render-thread join.
