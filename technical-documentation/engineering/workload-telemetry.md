# Workload telemetry

Klippt records local, privacy-safe performance reports for capture, native preview, and native
export. The reports show which media path ran, where time was spent, what resources were available,
and which fallback or failure occurred. Telemetry observes the workload. It never changes capture
resolution, source frame rate, export quality, or product behavior.

The current preview-performance comparison must record the native preview width and height. The
2026-09-01 baseline used 2560×1440 for a 1280×720 visible Retina panel and measured Metal readback at
about 42.5 ms p95. The fixed build uses the visible CSS size. Keep the old and new reports as a
matched before/after pair; do not infer the result from the unit test alone.

## Storage and lifecycle

The main process owns `WorkloadTelemetryService` in
`electron/diagnostics/workloadTelemetry.ts`. Reports use the `klippt-workload-v1` format and live in
`<userData>/diagnostics/workloads/`. A report contains a random workload ID. It does not contain a
project ID or media identifier.

- A resource sample runs every 5 seconds while at least one workload is active.
- A running report is written durably when it starts and at most every 30 seconds after that.
- A terminal report is written when the workload succeeds, fails, is cancelled, is discarded, or
  recovers a partial capture.
- A report left in `running` state after a process exit becomes `interrupted` on the next launch.
- Clean quit stops and joins native previews after windows close, completes live preview reports,
  and waits for durable writes. The async flush has a two-second deadline; failure is logged and
  quit continues. Logout/shutdown skips waiting. Capture and export keep their own outcomes.
  Final Quit is scheduled on a new event-loop turn so an empty flush cannot reenter Electron
  before its native window-close callback resets the quitting flag.
- The store keeps at most 100 reports and removes reports older than 30 days.
- The support diagnostic ZIP includes the 20 newest reports. Normal reports never leave the Mac on
  their own.

Metric series are bounded. Each metric keeps at most 8,192 values and each report keeps at most
2,160 resource samples and 1,024 events. Numeric series store count, minimum, maximum, mean, P50,
P95, and P99.

## Report contents

Every report identifies only a fixed workload kind, operation, platform, status, phases, structured
event codes, fixed fallback codes, and fixed media-path codes. Configuration contains numeric frame
rates and dimensions only.

| Workload | Measurements |
|---|---|
| macOS capture | Requested and delivered screen FPS; complete and non-complete ScreenCaptureKit frames; writer backpressure and append failures; per-clip screen timestamp drift; microphone and system-audio drift against the latest screen timestamp; peak AAC queue bytes and chunks; cumulative AAC-input backpressure time; clip finalization; thermal state; Low Power Mode |
| Windows capture | Requested FPS; delivered FPS from the helper pacing line; GPU-bridge contention drops; encoder, camera, and total stop time; selected Media Foundation path and recorded fallback |
| Browser camera | Requested FPS from the recording request; delivered FPS from the shared camera preview stream; media-clock drift from `mediaTime`, `presentedFrames`, and the track frame rate |
| Browser recording writes | Completed `Writable.write` callback latency and a structured disk-full transition |
| Native preview | GPU readback time from Rust; native bridge time; renderer IPC time; browser draw time; long main-thread task duration; compositor backend; process resources |
| Native MP4 export | End-to-end native phase, frames, media duration, output bytes, throughput, actual encoder name and hardware flag, encoder fallback, decoder path, compositor backend, process resources, and disk capacity |
| Native GIF export | End-to-end native phase, frames, media duration, output bytes, throughput, software path, process resources, and disk capacity |

The Electron resource sampler records main-process private memory, total Klippt process working set,
total Klippt CPU use, system free memory, the GPU process working set as an explicit GPU-memory
estimate, disk space available to the active output directory, battery state, thermal state, and CPU
speed limit. Resource gaps stay as gaps. A sampler failure never interrupts media work.

## Timing boundaries

The browser recording metric starts before `RecordingStreamRegistry.append()` and stops in the
`Writable.write` callback. Node defines that callback as the point at which the chunk has been fully
handled. This measures the existing write path and performs no extra disk I/O.

The native preview metric separates these boundaries:

1. Rust times `readback_direct()`.
2. Electron times the native add-on call.
3. The renderer times the typed native-bridge request, including structured-clone transfer.
4. The renderer times `ImageData`, bitmap creation, and canvas draw.
5. `PerformanceObserver` records browser long tasks when Chromium supports that entry type.

The renderer batches fixed numeric preview timings for five seconds. It never sends DOM attribution,
element text, or a page name.

## Encoder and pressure limits

Native MP4 export reports the encoder that FFmpeg opened and whether that selected encoder is a
hardware encoder. It also records a hardware-to-software fallback. This is an actual runtime result.

The macOS capture helper uses AVAssetWriter. AVAssetWriter does not expose its private
VideoToolbox compression session, so Klippt does not label that capture encoder as confirmed
hardware. Apple exposes actual hardware use on a directly owned `VTCompressionSession`; Klippt can
make that claim only after capture moves to that boundary or to another API that returns the selected
encoder.

Chromium owns the current webcam capture session. `MediaStreamTrack` exposes frame rate and media
timestamps, but it does not expose AVFoundation's camera system-pressure state. Camera pressure is
therefore recorded as `unknown`, not guessed. Native AVFoundation camera capture can replace this
value when that later product slice owns the device session.

Windows and Linux helpers expose fewer counters than ScreenCaptureKit. Missing counters remain
absent. The report never converts an unavailable value into zero.

## Privacy boundary

The report schema cannot store free-form labels. The workload directory and report ID are the only
filesystem data used for persistence. The output directory may be passed to `statfs`, but the path is
not copied into the report.

Reports exclude:

- filenames and paths;
- URLs;
- project names and window titles;
- transcripts;
- cursor and keyboard events;
- audio and video.

If Klippt later adds remote crash or performance reporting, that system needs separate consent and a
separate structured schema. This local service is not a remote telemetry transport.

## Primary references

- [Electron process metrics](https://www.electronjs.org/docs/latest/api/structures/process-metric)
- [Electron `app.getAppMetrics()`](https://www.electronjs.org/docs/latest/api/app/#appgetappmetrics)
- [Electron `process.getProcessMemoryInfo()`](https://www.electronjs.org/docs/latest/api/process#processgetprocessmemoryinfo)
- [Node writable stream callback and backpressure](https://nodejs.org/api/stream.html#writablewritechunk-encoding-callback)
- [Apple AVAssetWriter](https://developer.apple.com/documentation/avfoundation/avassetwriter)
- [Apple AVAssetWriterInput readiness](https://developer.apple.com/documentation/avfoundation/avassetwriterinput/isreadyformoremediadata)
- [Apple AVVideoEncoderSpecificationKey](https://developer.apple.com/documentation/avfoundation/avvideoencoderspecificationkey)
- [Apple hardware-required VideoToolbox encoder selection](https://developer.apple.com/documentation/videotoolbox/kvtvideoencoderspecification_requirehardwareacceleratedvideoencoder)
- [W3C Long Tasks](https://www.w3.org/TR/longtasks-1/)
- [MDN PerformanceObserver](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver)
