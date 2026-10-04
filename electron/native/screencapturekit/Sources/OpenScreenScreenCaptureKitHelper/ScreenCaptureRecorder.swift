import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 13.0, *)
final class ScreenCaptureRecorder: NSObject, SCStreamOutput, SCStreamDelegate {
	private struct FinalizedClip {
		let index: Int
		let path: String
		let durationMs: Int
		let originals: [String: Any]

		var payload: [String: Any] {
			var value: [String: Any] = [
				"index": index,
				"screenVideoPath": path,
				"durationMs": durationMs,
			]
			value.merge(originals) { _, next in next }
			return value
		}
	}

	private struct DetachedWriter {
		let writer: AVAssetWriter
		let path: String
		let index: Int
		let started: Bool
		let startTime: CMTime?
		let lastTime: CMTime?
		let lastFrameDuration: CMTime
		let originals: [String: OriginalTrackWriter]
		let sourceOwners: [String: OriginalSourceWriter]
	}

	private var request: RecordingRequest
	private let captureSetupBuilder = CaptureSetupBuilder()
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var streamRecovery = RecordingStreamRecovery()
	private var activeFilter: SCContentFilter?
	private var activeConfiguration: SCStreamConfiguration?
	private var writer: AVAssetWriter?
	private var cameraCapture: NativeCameraCapture?
	private var cameraSample: CMSampleBuffer?
	private var originals: [String: OriginalTrackWriter] = [:]
	private var originalOwners: [String: OriginalSourceWriter] = [:]
	private var readyOriginals: Set<String> = []
	private var readyAudioTracks: Set<String> = []
	private var startup = RecordingStartup()
	private var startupTimer: RecordingStartupWatchdog?
	private var firstScreenFrame: CMSampleBuffer?
	private let diagnosticTiming = ProcessInfo.processInfo.environment["OPENSCREEN_CAPTURE_DIAGNOSTICS"] == "1"
	private var startupTiming: [String: Double] = [:]
	private var cadence: RecordingCadence
	private var cadenceTimer: DispatchSourceTimer?
	private var lastScheduledSourceTime: CMTime?
	private var videoInput: AVAssetWriterInput?
	// The mixed track stays first for HTML5 preview. Tagged source tracks give export clean
	// microphone/system stems without changing the one-file-per-clip project model.
	private var audioInputs: [AVAssetWriterInput] = []
	private var compatibilityAudio: CompatibilityAudioWriter?
	private var didStartWriting = false
	private var startBarrier = RecordingStartBarrier()
	private var frameCache = RecordingFrameCache()
	private var boundaryWarnings = RecordingBoundaryWarnings()
	private var acceptsCachedFrames = true
	private var didReportWriterFailure = false
	private var isStopping = false
	private var isPaused = false
	private var hasTerminalFailure = false
	private var terminationBoundary = RecordingTerminationBoundary()
	private var currentClipIndex = 0
	private var currentClipPath: String?
	private var clipStartTime: CMTime?
	private var clipLastTime: CMTime?
	private var clipLastFrameDuration = CMTime.zero
	private var finalizedClips: [FinalizedClip] = []
	private var nativeMicrophoneEnabled = false
	private var outputWidth = 1920
	private var outputHeight = 1080
	private var captureFrame = CGRect.zero
	private let captureTelemetry: CaptureTelemetry
	private let unexpectedStopHandler: (ScreenCaptureRecorder, Error) -> Void

	init(
		request: RecordingRequest,
		unexpectedStopHandler: @escaping (ScreenCaptureRecorder, Error) -> Void
	) {
		self.request = request
		cadence = RecordingCadence(fps: request.video.fps)
		captureTelemetry = CaptureTelemetry(requestedVideoFps: request.video.fps)
		self.unexpectedStopHandler = unexpectedStopHandler
	}

	func start() async throws {
		try ensureRequestedPermissions(for: request)

		let content = try await SCShareableContent.excludingDesktopWindows(
			false,
			onScreenWindowsOnly: true
		)
		let setup = try captureSetupBuilder.make(from: content, request: request)
		outputWidth = setup.width
		outputHeight = setup.height
		captureFrame = setup.captureFrame
		nativeMicrophoneEnabled = setup.microphoneEnabled
		let stream = try configuredStream(filter: setup.filter, configuration: setup.configuration)
		try await configureCamera(for: request)
		try sampleQueue.sync { try setupWriter(for: currentClipIndex) }

		self.stream = stream
		stateQueue.sync { streamRecovery.install(stream) }
		activeFilter = setup.filter
		activeConfiguration = setup.configuration
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		try await stream.startCapture()
	}

	private func configuredStream(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> SCStream {
		let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		if #available(macOS 15.0, *), let type = SCStreamOutputType(rawValue: screenCaptureKitMicrophoneOutputTypeRawValue) {
			try stream.addStreamOutput(self, type: type, sampleHandlerQueue: sampleQueue)
		}
		return stream
	}

	private func replaceCaptureStream(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws {
		let replacement = try configuredStream(filter: filter, configuration: configuration)
		let previous = stream
		stream = replacement
		stateQueue.sync { streamRecovery.install(replacement) }
		sampleQueue.sync { frameCache.invalidateCapturedFrame() }
		try? await previous?.stopCapture()
		do {
			try await replacement.startCapture()
			guard !stateQueue.sync(execute: { streamRecovery.needsReplacement }) else {
				throw HelperError.sourceNotFound("The selected capture source stopped before recording could continue. Select an available source and try again.")
			}
		} catch {
			stateQueue.sync { streamRecovery.invalidate() }
			try? await replacement.stopCapture()
			throw error
		}
	}

	func reconfigure(with nextRequest: RecordingRequest) async {
		let canReconfigure = stateQueue.sync { !isStopping && isPaused && !hasTerminalFailure }
		guard canReconfigure else {
			emitError(code: "reconfigure-not-paused", message: "Capture setup can change only while paused.")
			return
		}
		// Samples arriving during filter/configuration changes cannot be assigned
		// reliably to either source. A resumed clip must never seed an old source.
		sampleQueue.sync {
			acceptsCachedFrames = false
			frameCache.invalidateCapturedFrame()
		}
		defer {
			sampleQueue.sync {
				frameCache.invalidateCapturedFrame()
				acceptsCachedFrames = true
			}
		}

		do {
			try ensureRequestedPermissions(for: nextRequest)
			let content = try await SCShareableContent.excludingDesktopWindows(
				false,
				onScreenWindowsOnly: true
			)
			let setup = try captureSetupBuilder.make(from: content, request: nextRequest)
			guard let stream else {
				throw HelperError.writerSetupFailed("ScreenCaptureKit stream is not running.")
			}
			guard let previousFilter = activeFilter,
				let previousConfiguration = activeConfiguration
			else {
				throw HelperError.writerSetupFailed("The active ScreenCaptureKit setup is missing.")
			}

			// Await both operations before changing the writer settings. Continue stays
			// disabled in the renderer until this acknowledgement arrives.
			do {
				try await configureCamera(for: nextRequest)
				if !stateQueue.sync(execute: { streamRecovery.needsReplacement }) {
					try await stream.updateConfiguration(setup.configuration)
					try await stream.updateContentFilter(setup.filter)
				}
				if stateQueue.sync(execute: { streamRecovery.needsReplacement }) {
					try await replaceCaptureStream(filter: setup.filter, configuration: setup.configuration)
				}
			} catch {
				var rollback: [(String, () async throws -> Void)] = []
				if !stateQueue.sync(execute: { streamRecovery.needsReplacement }) {
					rollback.append(("configuration", { try await stream.updateConfiguration(previousConfiguration) }))
					rollback.append(("filter", { try await stream.updateContentFilter(previousFilter) }))
				}
				rollback.append(("camera", { try await self.configureCamera(for: self.request) }))
				let rollbackErrors = await RecordingSetupRollback.run(rollback)
				if !rollbackErrors.isEmpty {
					stateQueue.sync { hasTerminalFailure = true }
					emitError(
						code: "writer-failed-during-capture",
						message: "Capture reconfiguration and rollback failed: \(error). Rollback: \(rollbackErrors.joined(separator: "; "))"
					)
					await stop()
					return
				}
				throw error
			}
			request = nextRequest
			cadence = RecordingCadence(fps: nextRequest.video.fps)
			activeFilter = setup.filter
			activeConfiguration = setup.configuration
			outputWidth = setup.width
			outputHeight = setup.height
			captureFrame = setup.captureFrame
			nativeMicrophoneEnabled = setup.microphoneEnabled
			emit([
				"event": "recording-reconfigured",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
				"width": outputWidth,
				"height": outputHeight,
				"captureBounds": captureBoundsPayload(),
			])
		} catch {
			emitError(code: "reconfigure-failed", message: "\(error)")
		}
	}

	func stop() async {
		let requestedEndTime = CMClockGetTime(CMClockGetHostTimeClock())
		let boundary = stateQueue.sync { () -> CMTime? in
			guard !isStopping else { return nil }
			isStopping = true
			return terminationBoundary.endingAt(requestedEndTime)
		}
		guard let endTime = boundary else { return }

		do {
			if !stateQueue.sync(execute: { streamRecovery.needsReplacement }) { try await stream?.stopCapture() }
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}

		await cameraCapture?.stop()
		var finalClipWarning: [String: String]?
		do {
			let finalizeStartedAt = Date()
			if let clip = try await finishCurrentClip(endingAt: endTime) {
				captureTelemetry.recordFinalizedClip(
					durationMs: clip.durationMs,
					finalizeMs: Date().timeIntervalSince(finalizeStartedAt) * 1_000
				)
				finalizedClips.append(clip)
				emit(["event": "clip-finalized", "clip": clip.payload])
			}
		} catch {
			finalClipWarning = [
				"code": "final-clip-failed",
				"message": "\(error)",
			]
			emit([
				"event": "warning",
				"code": "final-clip-failed",
				"message": "\(error)",
			])
		}

		finalClipWarning = boundaryWarnings.stoppedWarning(finalClipWarning: finalClipWarning)
		var stoppedPayload: [String: Any] = [
			"event": "recording-stopped",
			"screenPath": finalizedClips.first?.path ?? request.outputs.screenPath,
			"clips": finalizedClips.map(\.payload),
			"telemetry": captureTelemetry.payload(),
		]
		if let finalClipWarning {
			stoppedPayload["warning"] = finalClipWarning
		}
		emit(stoppedPayload)
	}

	func pause() async {
		let endTime = CMClockGetTime(CMClockGetHostTimeClock())
		let didPause = stateQueue.sync {
			if isStopping || isPaused {
				return false
			}

			isPaused = true
			return true
		}

		guard didPause else { return }
		emit(["event": "clip-finalizing"])
		let boundaryRevision = boundaryWarnings.revision
		do {
			let finalizeStartedAt = Date()
			if let clip = try await finishCurrentClip(endingAt: endTime) {
				captureTelemetry.recordFinalizedClip(
					durationMs: clip.durationMs,
					finalizeMs: Date().timeIntervalSince(finalizeStartedAt) * 1_000
				)
				finalizedClips.append(clip)
				emit(["event": "clip-finalized", "clip": clip.payload])
			}
			if let boundaryFailure = boundaryWarnings.pauseFailure(since: boundaryRevision) {
				// The durable clip has already been acknowledged. Existing paused-error
				// handling keeps it and displays the missing-tail warning immediately.
				emitError(code: "clip-finalize-failed", message: boundaryFailure)
				return
			}
			emit([
				"event": "recording-paused",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
			])
		} catch {
			emitError(code: "clip-finalize-failed", message: "\(error)")
		}
	}

	func resume() async {
		let resumeState = stateQueue.sync {
			(!isStopping && isPaused && !hasTerminalFailure, hasTerminalFailure)
		}
		guard resumeState.0 else {
			if resumeState.1 {
				emitError(
					code: "clip-start-failed",
					message: "The current writer failed. Stop now to keep earlier completed clips."
				)
			}
			return
		}

		let previousClipIndex = currentClipIndex
		do {
			if stateQueue.sync(execute: { streamRecovery.needsReplacement }), let activeFilter, let activeConfiguration {
				try await replaceCaptureStream(filter: activeFilter, configuration: activeConfiguration)
			}
			let nextClipIndex = previousClipIndex + 1
			var seed = try sampleQueue.sync {
				try frameCache.resumedFrame(
					at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps
				)
			}
			if seed == nil, #available(macOS 14.0, *),
				let activeFilter, let activeConfiguration
			{
				// A static screen may produce no new complete frame after a filter
				// change. Capture that filtered source once while still paused.
				let screenshot = try await SCScreenshotManager.captureSampleBuffer(
					contentFilter: activeFilter, configuration: activeConfiguration
				)
				seed = try RecordingFrameCache.retime(
					screenshot, at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps
				)
			}
			let seededWriter = try sampleQueue.sync { () -> (CMSampleBuffer, AVAssetWriterInput, AVAssetWriter)? in
				do {
					try setupWriter(for: nextClipIndex)
				} catch {
					discardCurrentWriterOnSampleQueue()
					throw error
				}
				currentClipIndex = nextClipIndex
				if let sourceSeed = seed {
					// Writer preparation can take hundreds of ms. A resumed clip's
					// host epoch begins after that work, at the first seeded append.
					let seed = try RecordingFrameCache.retime(sourceSeed, at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps)
					frameCache.observe(seed)
					guard let videoInput, let writer, writer.status == .writing else {
						throw HelperError.writerSetupFailed("Unable to start the resumed clip writer.")
					}
					let startTime = CMSampleBufferGetPresentationTimeStamp(seed)
					writer.startSession(atSourceTime: startTime)
					didStartWriting = true
					clipStartTime = startTime
					beginStartup(at: startTime, firstFrame: seed)
					compatibilityAudio?.begin(at: startTime)
					beginOriginals(at: startTime)
					return (seed, videoInput, writer)
				}
				try stateQueue.sync {
					guard !streamRecovery.needsReplacement, !isStopping, !hasTerminalFailure else {
						throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
					}
					isPaused = false
				}
				return nil
			}
			if let (seed, input, writer) = seededWriter {
				// Retry encoder backpressure without waiting for the static screen
				// to change. The same bounded append keeps readiness truthful.
				try await ClosingFrameAppender(sample: seed, input: input, writer: writer, queue: sampleQueue).append()
				try sampleQueue.sync {
					try stateQueue.sync {
						guard !streamRecovery.needsReplacement, !isStopping, !hasTerminalFailure else {
							throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
						}
						isPaused = false
					}
					recordSuccessfulVideoAppend(seed)
				}
			}
		} catch {
			let rejected = sampleQueue.sync { () -> Bool in
				let rejected = stateQueue.sync {
					RecordingStreamRecovery.canRejectResume(paused: isPaused, stopping: isStopping,
						terminalFailure: hasTerminalFailure, acknowledgedClipIndex: startup.isLive ? currentClipIndex : nil,
						previousClipIndex: previousClipIndex)
				}
				guard rejected else { return false }
				discardCurrentWriterOnSampleQueue()
				currentClipIndex = previousClipIndex
				stateQueue.sync { isPaused = true }
				return true
			}
			if rejected { emit(RecordingStreamRecovery.rejectedResumePayload(previousClipIndex: previousClipIndex, message: "\(error)")) }
			else { emitError(code: "clip-start-failed", message: "\(error)") }
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		let disposition = stateQueue.sync { () -> RecordingStreamRecovery.StopDisposition in
			let disposition = streamRecovery.stopped(stream, paused: isPaused, stopping: isStopping)
			if disposition == .activeFailure {
				terminationBoundary.recordFailure(at: CMClockGetTime(CMClockGetHostTimeClock()))
				isPaused = true
				hasTerminalFailure = true
			}
			return disposition
		}
		switch disposition {
		case .ignored: return
		case .pausedSourceUnavailable:
			sampleQueue.async { self.frameCache.invalidateCapturedFrame() }
			emit(["event": "warning", "code": "paused-source-unavailable", "message": "\(error)"])
		case .activeFailure: unexpectedStopHandler(self, error)
		}
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard stateQueue.sync(execute: { streamRecovery.acceptsSamples(from: stream) }), CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		if type == .screen, acceptsCachedFrames {
			let status = CaptureTelemetry.frameStatus(sampleBuffer)
			if status == nil || status == .complete { frameCache.observe(sampleBuffer) }
		}
		if stateQueue.sync(execute: { isPaused || isStopping }) {
			return
		}

		if type == .audio {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: false)
			appendOriginal(sampleBuffer, key: "systemAudioPath")
			appendCompatibilityAudio(sampleBuffer, from: .system)
			return
		}

		if type.rawValue == screenCaptureKitMicrophoneOutputTypeRawValue {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: true)
			appendOriginal(sampleBuffer, key: "microphoneAudioPath")
			appendCompatibilityAudio(sampleBuffer, from: .microphone)
			return
		}

		guard type == .screen else {
			return
		}
		guard captureTelemetry.recordScreenSample(sampleBuffer) else {
			return
		}
		if request.video.quality != "high" || cadence.anchor == nil { appendScreenFrame(sampleBuffer) }
	}

	/// Runs on sampleQueue. Readiness for each clip means an actual appended frame.
	private func appendScreenFrame(_ incoming: CMSampleBuffer, sourceTime: CMTime? = nil) {
		guard let videoInput, let writer else {
			return
		}
		// Initial backpressure cannot replace or discard the first source image.
		let sampleBuffer = clipLastTime == nil ? (firstScreenFrame ?? incoming) : incoming
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		guard presentationTime.isValid, presentationTime.isNumeric else { return }
		if let clipLastTime, presentationTime <= clipLastTime { return }
		if let clipStartTime, presentationTime < clipStartTime { return }
		if !didStartWriting {
			let initializationStarted = DispatchTime.now().uptimeNanoseconds
			if diagnosticTiming {
				startupTiming["firstScreenSourceAgeMs"] = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()) - presentationTime) * 1_000
			}
			guard writer.status == .writing else {
				reportWriterFailure("prepared screen writer stopped")
				return
			}
			writer.startSession(atSourceTime: presentationTime)
			if diagnosticTiming { startupTiming["screenStartSessionMs"] = milliseconds(since: initializationStarted) }
			didStartWriting = true
			clipStartTime = presentationTime
			beginStartup(at: presentationTime, firstFrame: sampleBuffer)
			compatibilityAudio?.begin(at: presentationTime)
			let originalsStarted = DispatchTime.now().uptimeNanoseconds
			beginOriginals(at: presentationTime)
			if diagnosticTiming { startupTiming["beginOriginalsMs"] = milliseconds(since: originalsStarted) }
		}

		if videoInput.isReadyForMoreMediaData {
			let firstAppend = clipLastTime == nil
			let appendStarted = DispatchTime.now().uptimeNanoseconds
			let appended = videoInput.append(sampleBuffer)
			trackTiming(stage: "screenAppend", since: appendStarted)
			if appended {
				recordSuccessfulVideoAppend(sampleBuffer, sourceTime: sourceTime)
				if diagnosticTiming && firstAppend {
					startupTiming["firstScreenAppendMs"] = milliseconds(since: appendStarted)
					startupTiming["firstScreenAppendSourceAgeMs"] = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()) - presentationTime) * 1_000
					emitTiming(stage: "first-screen-append")
				}
			} else {
				captureTelemetry.recordVideoAppendFailure()
				reportWriterFailure("video append")
			}
		} else {
			captureTelemetry.recordVideoBackpressure(retried: request.video.quality == "high")
		}
	}

	private func recordSuccessfulVideoAppend(_ sample: CMSampleBuffer, sourceTime: CMTime? = nil) {
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sample)
		let pixelTime = sourceTime ?? presentationTime
		frameCache.didAppend(sample, sourceTime: pixelTime)
		if request.video.quality == "high", let anchor = cadence.anchor {
			let expected = anchor + CMTime(value: cadence.nextFrame, timescale: CMTimeScale(max(1, request.video.fps)))
			if presentationTime == expected { cadence.didAppend() }
			if lastScheduledSourceTime == pixelTime { captureTelemetry.recordRepeatedVideoFrame() }
			lastScheduledSourceTime = pixelTime
		} else {
			cadenceTimer?.cancel(); cadenceTimer = nil
		}
		firstScreenFrame = nil
		captureTelemetry.recordVideoAppend(at: presentationTime)
		clipLastTime = presentationTime
		let duration = CMSampleBufferGetDuration(sample)
		clipLastFrameDuration = duration.isValid && duration > .zero
			? duration
			: CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
		acknowledgeClipReadiness()
	}

	private func acknowledgeClipReadiness() {
		guard clipLastTime != nil, !stateQueue.sync(execute: { isPaused || isStopping || hasTerminalFailure }) else { return }
		guard !startup.isLive else { return }
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		do {
			try startup.checkDeadline(at: now, videoAppended: true, readyOriginals: readyOriginals, readyAudio: readyAudioTracks)
			var caughtUp = true
			if request.video.quality == "high" { caughtUp = try cadence.dueTimes(at: now, maximumCatchUpFrames: startup.backlogLimit(fps: request.video.fps)).isEmpty }
			guard startup.acknowledge(videoAppended: true, readyOriginals: readyOriginals, readyAudio: readyAudioTracks, gridCaughtUp: caughtUp) else { return }
		} catch { reportWriterFailure("\(error)", detectedAt: startupDeadline.map { min($0, now) } ?? now); return }
		if let clipIndex = startBarrier.acknowledgeAppend(succeeded: true) {
			startupTimer?.cancel(); startupTimer = nil
			if diagnosticTiming { emitTiming(stage: "startup-ready") }
			emit([
				"event": clipIndex == 0 ? "recording-started" : "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
				"clipIndex": clipIndex,
				"width": outputWidth,
				"height": outputHeight,
				"captureBounds": captureBoundsPayload(),
			])
		}
	}

	/// A failed AVAssetWriter keeps accepting appends and keeps answering false, so
	/// a recorder that discards that Bool records nothing while the HUD counts on.
	/// That is how a two-minute recording was already lost by its fourth second and only
	/// said so at finishWriting(). The Windows helper checks every WriteSample
	/// HRESULT and escalates; this is the macOS half of the same contract -- report
	/// once, at the append that actually failed, carrying the live writer.error.
	///
	/// Deliberately not the code finishWriter() emits, and the difference is load
	/// bearing. That one is the terminal result of stopping, and the Electron side
	/// settles its stop on exactly one of `recording-stopped` or `writer-failed`.
	/// Give both sites the same code behind this one-shot guard and a writer that
	/// died mid-capture emits nothing at all at stop, so the stop promise never
	/// settles and every failure becomes the "Saving..." hang instead of an error.
	/// This event answers "when did the writer die"; that one answers "did stopping
	/// work". Two questions, two codes.
	private func reportWriterFailure(_ stage: String, detectedAt: CMTime? = nil) {
		guard !didReportWriterFailure, let writer else {
			return
		}
		didReportWriterFailure = true
		let failureTime = detectedAt ?? CMClockGetTime(CMClockGetHostTimeClock())
		stateQueue.sync {
			terminationBoundary.recordFailure(at: failureTime)
			isPaused = true
			hasTerminalFailure = true
		}
		emitError(
			code: "writer-failed-during-capture",
			message: "\(stage): "
				+ (writer.error.map { "\($0)" }
					?? "AVAssetWriter status \(writer.status.rawValue)"),
		)
	}

	private func ensureRequestedPermissions(for request: RecordingRequest) throws {
		if !CGPreflightScreenCaptureAccess() {
			let granted = CGRequestScreenCaptureAccess()
			if !granted {
				throw HelperError.permissionDenied("Screen recording permission is required for ScreenCaptureKit capture.")
			}
		}

		if request.webcam.enabled, AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
			throw HelperError.permissionDenied("Camera permission is required for native camera capture.")
		}

		if request.audio.microphone.enabled {
			switch AVCaptureDevice.authorizationStatus(for: .audio) {
			case .authorized:
				break
			case .notDetermined:
				let semaphore = DispatchSemaphore(value: 0)
				AVCaptureDevice.requestAccess(for: .audio) { _ in
					semaphore.signal()
				}
				let waitResult = semaphore.wait(timeout: .now() + 30)
				if waitResult == .timedOut || AVCaptureDevice.authorizationStatus(for: .audio) != .authorized {
					throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
				}
			default:
				throw HelperError.permissionDenied("Microphone permission is required for native microphone capture.")
			}
		}
	}

	private func captureBoundsPayload() -> [String: Double] {
		return [
			"x": captureFrame.origin.x,
			"y": captureFrame.origin.y,
			"width": captureFrame.size.width,
			"height": captureFrame.size.height,
		]
	}

	private func clipPath(for index: Int) -> String {
		let requested = URL(fileURLWithPath: request.outputs.screenPath)
		let ext = requested.pathExtension.isEmpty ? "mp4" : requested.pathExtension
		let stem = requested.deletingPathExtension().lastPathComponent
		let suffix = "-clip-0001"
		let base = stem.hasSuffix(suffix) ? String(stem.dropLast(suffix.count)) : stem
		let sequence = String(format: "%04d", index + 1)
		return requested.deletingLastPathComponent()
			.appendingPathComponent("\(base)-clip-\(sequence)")
			.appendingPathExtension(ext)
			.path
	}

	private func setupWriter(for index: Int) throws {
		let outputPath = clipPath(for: index)
		let outputUrl = URL(fileURLWithPath: outputPath)
		try? FileManager.default.removeItem(at: outputUrl)
		try FileManager.default.createDirectory(
			at: outputUrl.deletingLastPathComponent(),
			withIntermediateDirectories: true
		)

		let writer = try AVAssetWriter(outputURL: outputUrl, fileType: .mp4)
		// Costs nothing on a clean stop -- finishWriting() still writes a normal
		// moov -- and is the difference between a readable file and a total loss
		// when the helper dies before reaching it. The Windows helper gets the
		// same property from MFCreateFMPEG4MediaSink; see issues #252/#292/#327.
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		let settings: [String: Any] = [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: outputWidth,
			AVVideoHeightKey: outputHeight,
			AVVideoCompressionPropertiesKey: [
				AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
				AVVideoAverageBitRateKey: RecordingQualityPolicy.bitrate(quality: request.video.quality, legacyBitrate: request.video.bitrate),
				AVVideoExpectedSourceFrameRateKey: request.video.fps,
				// Without this the encoder defaults to B-frames, and a reordered
				// stream needs a composition offset per sample. AVAssetWriter emits
				// those in a version 0 `trun`, where ISO/IEC 14496-12 8.8.8.2 defines
				// the field as UNSIGNED -- so a negative offset goes out as
				// 0xFFFFFFF6 and the fragment writer refuses the fragment it is
				// about to emit. That refusal is -11800 / -16341, raised from the
				// single site in MediaToolbox that writes moof/traf/trun, which is
				// why it appears if and only if movieFragmentInterval is set and
				// lands exactly on a fragment boundary.
				//
				// Turning reordering off makes every offset zero and PTS == DTS, so
				// the fragment stays representable. A screen recorder gives up
				// nothing for it: B-frames buy compression on lookahead-friendly
				// content and cost encode latency, which is the wrong trade for
				// real-time capture.
				//
				// Measured on macOS 26.5 / M1, 1080p with system audio. How reliably
				// the bug bites scales with append rate, so quote the rate with the
				// result: at ~57 fps, the rate the app actually drives, reordering
				// on dies at 13.0s while reordering off stops clean at 31.6s; at
				// 30 fps it is intermittent, dying at 1.0s and 2.0s but once
				// surviving 22.2s. That intermittency is why the byte-level evidence
				// leads here and the run counts only corroborate: the offsets are
				// out of spec in every fragmented file whether or not that
				// particular run happened to die. Reordering off is 3/3 clean across
				// both rates, and a SIGKILL at 25s still leaves 27 readable `moof`.
				AVVideoAllowFrameReorderingKey: false,
			],
		]
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: settings)
		input.expectsMediaDataInRealTime = true

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add H.264 video input to AVAssetWriter.")
		}

		writer.add(input)
		self.writer = writer
		self.videoInput = input
		currentClipPath = outputPath
		didStartWriting = false
		didReportWriterFailure = false
		clipStartTime = nil
		clipLastTime = nil
		clipLastFrameDuration = .zero
		audioInputs = []
		compatibilityAudio = nil

		if request.audio.system.enabled || nativeMicrophoneEnabled {
			// Apple AAC rejects 384 kbps in this real-time AVAssetWriter configuration. Keep
			// each editable capture track at 256 kbps; the final YouTube-ready mix is encoded
			// once at 384 kbps by the native compositor.
			let captureAudioBitRate = 256_000
			let mixedInput = try addAudioInput(
				to: writer,
				bitRate: captureAudioBitRate,
				trackTitle: "screenrec.mix.v1",
				trackLanguageCode: "qaa"
			)
			let systemInput = request.audio.system.enabled
				? try addAudioInput(
					to: writer,
					bitRate: captureAudioBitRate,
					trackTitle: "screenrec.system.v1",
					trackLanguageCode: "qab"
				)
				: nil
			let microphoneInput = nativeMicrophoneEnabled
				? try addAudioInput(
					to: writer,
					bitRate: captureAudioBitRate,
					trackTitle: "screenrec.microphone.v1",
					trackLanguageCode: "qac"
				)
				: nil
			audioInputs = [mixedInput, systemInput, microphoneInput].compactMap { $0 }
			let mixer = AudioTrackMixer(
				mixedInput: mixedInput,
				systemInput: systemInput,
				microphoneInput: microphoneInput,
				includesSystemAudio: request.audio.system.enabled,
				includesMicrophone: nativeMicrophoneEnabled,
				microphoneGain: request.audio.microphone.gain,
				writer: writer
			)
			compatibilityAudio = CompatibilityAudioWriter(writer: writer, mixer: mixer,
				queue: DispatchQueue(label: "app.openscreen.sck-helper.compatibility-audio"))
		}
		originals = [:]
		originalOwners = [:]; readyOriginals = []
		if request.audio.system.enabled { originals["systemAudioPath"] = try originalWriter(screenPath: outputPath, suffix: "system", type: .audio) }
		if nativeMicrophoneEnabled { originals["microphoneAudioPath"] = try originalWriter(screenPath: outputPath, suffix: "microphone", type: .audio) }
		if cameraCapture != nil { originals["webcamVideoPath"] = try originalWriter(screenPath: outputPath, suffix: "webcam", type: .video) }
		for (key, original) in originals {
			let admission = key == "webcamVideoPath"
				? OriginalSourceAdmission(maximumSamples: OriginalSourceAdmission.cameraSamples(fps: cameraCapture!.fps), maximumBytes: OriginalSourceAdmission.maximumCameraBytes)
				: OriginalSourceAdmission()
			originalOwners[key] = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "app.openscreen.sck-helper.original." + key), admission: admission)
		}
		var audioTracks = Set<String>()
		if compatibilityAudio != nil { audioTracks.insert("mixed") }
		if request.audio.system.enabled { audioTracks.insert("system") }
		if nativeMicrophoneEnabled { audioTracks.insert("microphone") }
		startup = RecordingStartup(originals: Set(originals.keys), audioTracks: audioTracks)
		readyAudioTracks = []; firstScreenFrame = nil
		startupTimer?.cancel(); startupTimer = nil
		cadenceTimer?.cancel(); cadenceTimer = nil; cadence.reset(); lastScheduledSourceTime = nil
		captureTelemetry.beginClip()
		frameCache.beginClip()
		startBarrier.prepare(clipIndex: index)
		stateQueue.sync {
			// A fatal recording cannot Continue; healthy newly prepared clips have
			// their own boundary and must never inherit an earlier writer's epoch.
			if !hasTerminalFailure { terminationBoundary = RecordingTerminationBoundary() }
		}
		startupTiming = [:]
		// Apple separates encoder preparation from the session's source timeline.
		// Do all expensive startWriting calls before SCStream starts or the resume
		// seed epoch is chosen, keeping initialization out of the live lag budget.
		let prepareStarted = DispatchTime.now().uptimeNanoseconds
		guard writer.startWriting() else {
			throw HelperError.writerSetupFailed(writer.error.map { "\($0)" } ?? "Unable to prepare the screen encoder.")
		}
		if diagnosticTiming { startupTiming["screenPrepareWritingMs"] = milliseconds(since: prepareStarted) }
		for (key, original) in originals {
			let originalStarted = DispatchTime.now().uptimeNanoseconds
			if let owner = originalOwners[key] { try owner.prepare() } else { try original.prepare() }
			if diagnosticTiming { startupTiming[key + "PrepareWritingMs"] = milliseconds(since: originalStarted) }
		}
		if diagnosticTiming { emitTiming(stage: "writers-prepared") }
	}

	private func detachCurrentWriter(endingAt endTime: CMTime) -> DetachedWriter? {
		sampleQueue.sync {
			guard let writer, let currentClipPath else { return nil }
			let sessionEnd = request.video.quality == "high" && didStartWriting && clipStartTime.map { endTime > $0 } == true ? endTime : nil
			RecordingWriterFinalization.finishInputs(writer: writer, videoInput: videoInput,
				audioInputs: audioInputs, endingAt: sessionEnd)

			let detached = DetachedWriter(
				writer: writer,
				path: currentClipPath,
				index: currentClipIndex,
				started: didStartWriting,
				startTime: clipStartTime,
				lastTime: clipLastTime,
				lastFrameDuration: clipLastFrameDuration,
				originals: originals,
				sourceOwners: originalOwners
			)
			self.originals = [:]
			self.originalOwners = [:]; self.readyOriginals = []
			self.writer = nil
			self.videoInput = nil
			self.audioInputs = []
			self.compatibilityAudio = nil
			self.firstScreenFrame = nil; self.readyAudioTracks = []
			self.startupTimer?.cancel(); self.startupTimer = nil
			self.currentClipPath = nil
			self.didStartWriting = false
			self.clipStartTime = nil
			self.clipLastTime = nil
			self.clipLastFrameDuration = .zero
			return detached
		}
	}

	/// Runs only on `sampleQueue`. It makes a failed next-writer setup retryable without
	/// advancing the authoritative clip index or retaining a half-configured writer.
	private func discardCurrentWriterOnSampleQueue() {
		cadenceTimer?.cancel(); cadenceTimer = nil; cadence.reset()
		startupTimer?.cancel(); startupTimer = nil; startup.cancel(); firstScreenFrame = nil; readyAudioTracks = []
		compatibilityAudio?.cancel()
		for (key, original) in originals {
			if let owner = originalOwners[key] { owner.cancel(remove: true) } else { original.cancel(remove: true) }
		}
		originals = [:]; originalOwners = [:]; readyOriginals = []
		writer?.cancelWriting()
		if let currentClipPath {
			try? FileManager.default.removeItem(atPath: currentClipPath)
		}
		writer = nil
		videoInput = nil
		audioInputs = []
		compatibilityAudio = nil
		currentClipPath = nil
		didStartWriting = false
		clipStartTime = nil
		clipLastTime = nil
		clipLastFrameDuration = .zero
	}

	private func finishCurrentClip(endingAt endTime: CMTime) async throws -> FinalizedClip? {
		sampleQueue.sync { cadenceTimer?.cancel(); cadenceTimer = nil; startupTimer?.cancel(); startupTimer = nil; startup.cancel() }
		let sourceOwners = sampleQueue.sync { Array(originalOwners.values) }
		let (audioOwner, audioClipIndex) = sampleQueue.sync { (compatibilityAudio, currentClipIndex) }
		if let audioOwner { await audioOwner.drain() }
		for owner in sourceOwners { await owner.drain() }

		// Each owner dispatched its metadata/failure before completing drain.
		// Cross this queue barrier before detaching or acknowledging any clip.
		await withCheckedContinuation { continuation in sampleQueue.async { continuation.resume() } }
		// An owner can detect failure before Stop but deliver its callback later.
		// Reconcile that first host timestamp after the callback barrier.
		let effectiveEndTime = stateQueue.sync { terminationBoundary.endingAt(endTime) }
		do {
			let boundary = try sampleQueue.sync { () -> ([CMSampleBuffer], AVAssetWriterInput, AVAssetWriter)? in
				guard didStartWriting, let videoInput, let writer, writer.status == .writing else { return nil }
				let samples: [CMSampleBuffer]
				if request.video.quality == "high" {
					samples = try cadence.closingFrames(endingAt: effectiveEndTime).compactMap { frame in
						try frameCache.boundaryFrame(at: frame.time, duration: frame.duration, fps: request.video.fps)
					}
				} else {
					samples = try frameCache.closingFrame(at: effectiveEndTime, fps: request.video.fps).map { [$0] } ?? []
				}
				if diagnosticTiming {
					startupTiming["closingGridFrames"] = Double(samples.count)
					startupTiming["frozenBoundaryElapsedMs"] = clipStartTime.map { CMTimeGetSeconds(effectiveEndTime - $0) * 1_000 }
					startupTiming["lastFrameBeforeClosingMs"] = clipStartTime.flatMap { start in clipLastTime.map { CMTimeGetSeconds($0 - start) * 1_000 } }
					emitTiming(stage: "closing-boundary")
				}
				return (samples, videoInput, writer)
			}
			if let (samples, input, writer) = boundary, !samples.isEmpty {
				try await ClosingFrameAppender(samples: samples, input: input, writer: writer, queue: sampleQueue) { [self] sample in
					recordSuccessfulVideoAppend(sample, sourceTime: frameCache.writtenSourcePresentationTime)
				}.append()
			}
		} catch {
			// Still finish the writer and preserve every successfully committed frame.
			let message = boundaryWarnings.record(error)
			emit(["event": "warning", "code": "final-screen-frame-failed", "message": message])
		}
		if let audioOwner {
			let finished = await audioOwner.finish()
			sampleQueue.sync {
				guard compatibilityAudio === audioOwner,
					audioOwner.isCurrent(writer: writer, clipIndex: audioClipIndex, currentClipIndex: currentClipIndex) else { return }
				captureTelemetry.recordAudioWriter(maxQueueBytes: max(finished.telemetry.maxPendingBytes, audioOwner.maximumQueuedBytes),
					maxQueueDepth: max(finished.telemetry.maxPendingChunks, audioOwner.maximumQueueDepth), blockedMs: finished.telemetry.blockedMs)
				if let failure = finished.failure { recordCompatibilityFailure(failure.error, detectedAt: failure.hostTime) }
				if diagnosticTiming {
					emit(["event": "capture-timing", "stage": "compatibility-audio-queue", "maximumQueueDepth": audioOwner.maximumQueueDepth,
						"maximumQueuedBytes": audioOwner.maximumQueuedBytes])
				}
			}
		}
		// Every compatibility AAC append has returned on its audio owner before
		// detach applies the frozen endSession and marks the main inputs finished.
		guard let detached = detachCurrentWriter(endingAt: effectiveEndTime) else { return nil }
		guard detached.started else {
			for (key, original) in detached.originals {
				if let owner = detached.sourceOwners[key] { owner.cancel(remove: true) } else { original.cancel(remove: true) }
			}
			detached.writer.cancelWriting()
			try? FileManager.default.removeItem(atPath: detached.path)
			return nil
		}

		await withCheckedContinuation { continuation in
			detached.writer.finishWriting {
				continuation.resume()
			}
		}
		var originalPayload: [String: Any] = [:]
		for (key, original) in detached.originals {
			defer {
				let owner = detached.sourceOwners[key]
				captureTelemetry.recordOriginalWriter(cameraFrames: key == "webcamVideoPath" ? original.appendedSamples : 0, backpressureEvents: original.backpressureEvents, queueDepth: owner?.maximumQueueDepth ?? original.maximumQueueDepth)
				if diagnosticTiming, let owner {
					emit(["event": "capture-timing", "stage": "original-source-queue", "key": key,
						"maximumQueueDepth": owner.maximumQueueDepth, "maximumQueuedBytes": owner.maximumQueuedBytes])
				}
			}
			do {
				let saved: Bool
				if let owner = detached.sourceOwners[key] { saved = try await owner.finish() }
				else { saved = try await original.finish(on: sampleQueue) }
				if saved {
					originalPayload[key] = original.path
					originalPayload[key == "webcamVideoPath" ? "webcamOffsetMs" : key.replacingOccurrences(of: "Path", with: "OffsetMs")] = original.offsetMs
				}
			} catch {
				let message = boundaryWarnings.record(error)
				emit(["event": "warning", "code": "original-track-failed", "message": message])
			}
		}

		guard detached.writer.status == .completed else {
			throw HelperError.writerSetupFailed(
				detached.writer.error.map { "\($0)" }
					?? "AVAssetWriter failed with status \(detached.writer.status.rawValue)."
			)
		}

		let measuredDuration: CMTime
		if let start = detached.startTime, let last = detached.lastTime {
			measuredDuration = CMTimeAdd(CMTimeSubtract(last, start), detached.lastFrameDuration)
		} else {
			measuredDuration = detached.lastFrameDuration
		}
		let assetDuration = try? await AVURLAsset(url: URL(fileURLWithPath: detached.path)).load(.duration)
		let finalizedDuration = assetDuration.flatMap { duration -> CMTime? in
			guard duration.isValid, duration.isNumeric, duration > .zero else { return nil }
			return duration
		} ?? measuredDuration
		let durationSeconds = finalizedDuration.isValid
			? max(0, CMTimeGetSeconds(finalizedDuration))
			: 0
		// Round upward. A session boundary must include the media tail, not cut the
		// final video frame or AAC packet because the container duration had a
		// fractional millisecond.
		let durationMs = max(1, Int(ceil(durationSeconds * 1000)))
		return FinalizedClip(index: detached.index, path: detached.path, durationMs: durationMs, originals: originalPayload)
	}

	private func configureCamera(for nextRequest: RecordingRequest) async throws {
		await cameraCapture?.stop()
		sampleQueue.sync { cameraCapture = nil; cameraSample = nil }
		guard nextRequest.webcam.enabled else { return }
		let camera = try NativeCameraCapture(request: nextRequest, sampleQueue: sampleQueue, onFailure: { [weak self] error in self?.reportWriterFailure("\(error)") }, onDrop: { [weak self] in
			guard let self, !self.stateQueue.sync(execute: { self.isPaused || self.isStopping }) else { return }
			self.captureTelemetry.recordCameraSample(dropped: true)
		}) { [weak self] sample in
			guard let self else { return }
			self.cameraSample = sample
			guard !self.stateQueue.sync(execute: { self.isPaused || self.isStopping }) else { return }
			if self.didStartWriting { self.captureTelemetry.recordCameraSample() }
			self.appendOriginal(sample, key: "webcamVideoPath")
		}
		sampleQueue.sync { cameraCapture = camera }
		try await camera.start()
	}

	private func originalWriter(screenPath: String, suffix: String, type: AVMediaType) throws -> OriginalTrackWriter {
		let path = URL(fileURLWithPath: screenPath).deletingPathExtension().path + "-" + suffix + ".mov"
		let settings = type == .audio ? OriginalTrackWriter.audioSettings : OriginalTrackWriter.videoSettings(
			width: cameraCapture!.width, height: cameraCapture!.height, fps: max(1, Int(cameraCapture!.fps.rounded())),
			bitrate: RecordingQualityPolicy.cameraBitrate(quality: request.video.quality, width: cameraCapture!.width, height: cameraCapture!.height, fps: max(1, Int(cameraCapture!.fps.rounded()))))
		return try OriginalTrackWriter(path: path, mediaType: type, settings: settings)
	}

	private func beginOriginals(at time: CMTime) {
		for (key, original) in originals {
			if let owner = originalOwners[key] { owner.begin(at: time) } else { original.begin(at: time) }
		}
		if let cameraSample, let cameraCapture,
			let seed = try? RecordingFrameCache.retime(cameraSample, at: time, fps: max(1, Int(cameraCapture.fps.rounded()))) {
			appendOriginal(seed, key: "webcamVideoPath")
		}
	}

	private func appendCompatibilityAudio(_ sample: CMSampleBuffer, from source: AudioTrackMixer.Source) {
		guard didStartWriting, let owner = compatibilityAudio, CMSampleBufferGetNumSamples(sample) > 0 else { return }
		let clipIndex = currentClipIndex
		do {
			try owner.append(sample, from: source) { [weak self] result, detectedAt in
				guard let self else { return }
				self.sampleQueue.async {
					guard self.compatibilityAudio === owner,
						owner.isCurrent(writer: self.writer, clipIndex: clipIndex, currentClipIndex: self.currentClipIndex) else { return }
					switch result {
					case .success(let completed):
						self.readyAudioTracks = completed.readyTracks
						self.trackTiming(stage: source == .system ? "systemIngest" : "microphoneIngest",
							durationMs: completed.elapsedMs, hostTime: completed.hostTime)
						self.acknowledgeClipReadiness()
					case .failure(let error): self.recordCompatibilityFailure(error, detectedAt: detectedAt)
					}
				}
			}
		} catch { recordCompatibilityFailure(error, detectedAt: owner.failureTime ?? CMClockGetTime(CMClockGetHostTimeClock())) }
	}

	/// Called only on sampleQueue, after checking the owning main writer and clip.
	private func recordCompatibilityFailure(_ error: Error, detectedAt: CMTime) {
		if stateQueue.sync(execute: { isPaused || isStopping }) {
			let message = boundaryWarnings.record(error)
			emit(["event": "warning", "code": "compatibility-audio-failed", "message": message])
			stateQueue.sync { terminationBoundary.recordFailure(at: detectedAt) }
		} else { reportWriterFailure("\(error)", detectedAt: detectedAt) }
	}

	private func appendOriginal(_ sample: CMSampleBuffer, key: String) {
		if diagnosticTiming, startupTiming[key + "FirstInputHostSeconds"] == nil {
			startupTiming[key + "FirstInputHostSeconds"] = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
			startupTiming[key + "FirstInputSamples"] = Double(CMSampleBufferGetNumSamples(sample))
			startupTiming[key + "FirstInputWriterStarted"] = didStartWriting ? 1 : 0
			emitTiming(stage: "first-input-" + key)
		}
		if let owner = originalOwners[key] {
			guard didStartWriting, CMSampleBufferGetNumSamples(sample) > 0 else { return }
			if diagnosticTiming, startupTiming[key + "FirstEnqueueHostSeconds"] == nil {
				startupTiming[key + "FirstEnqueueHostSeconds"] = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()))
				emitTiming(stage: "first-enqueue-" + key)
			}
			let clipIndex = currentClipIndex
			do {
				try owner.append(sample) { [weak self] result, detectedAt in
					guard let self else { return }
					self.sampleQueue.async {
						guard owner.isCurrent(original: self.originals[key], clipIndex: clipIndex, currentClipIndex: self.currentClipIndex) else { return }
						switch result {
						case .success(let completed):
							self.trackTiming(stage: key + "Append", durationMs: completed.elapsedMs, hostTime: completed.hostTime)
							if self.diagnosticTiming && completed.firstAppend {
								self.startupTiming[key + "FirstAppendMs"] = completed.elapsedMs
								self.emitTiming(stage: "first-original-" + key)
							}
							if let metadata = completed.metadata {
								self.readyOriginals.insert(key)
								self.emitOriginalStart(metadata, key: key, clipIndex: clipIndex)
								self.acknowledgeClipReadiness()
							}
						case .failure(let error):
							if self.stateQueue.sync(execute: { self.isPaused || self.isStopping }) {
								let message = self.boundaryWarnings.record(error)
								emit(["event": "warning", "code": "original-track-failed", "message": message])
								self.stateQueue.sync { self.terminationBoundary.recordFailure(at: detectedAt) }
							} else { self.reportWriterFailure("\(error)", detectedAt: detectedAt) }
						}
					}
				}
			} catch { reportWriterFailure("\(error)", detectedAt: owner.failureTime) }
			return
		}
	}
	private func emitOriginalStart(_ metadata: (path: String, offsetMs: Double), key: String, clipIndex: Int) {
		emit(["event": "original-started", "clipIndex": clipIndex, "key": key, "path": metadata.path, "offsetMs": metadata.offsetMs])
	}

	private var startupDeadline: CMTime? {
		startup.epoch.map { $0 + CMTime(seconds: RecordingStartup.sourceDeadlineSeconds, preferredTimescale: 1_000_000) }
	}
	private func beginStartup(at epoch: CMTime, firstFrame: CMSampleBuffer) {
		self.firstScreenFrame = firstFrame
		startup.begin(at: epoch)
		if request.video.quality == "high" { cadence.begin(at: epoch, firstFramePending: true) }
		startCadenceTimer()
		guard let writer else { return }
		let writerID = ObjectIdentifier(writer), clipIndex = currentClipIndex
		startupTimer = RecordingStartupWatchdog(epoch: epoch, queue: sampleQueue) { [weak self] deadline in
			guard let self, self.writer.map(ObjectIdentifier.init) == writerID, self.currentClipIndex == clipIndex,
				!self.startup.isLive, !self.stateQueue.sync(execute: { self.isPaused || self.isStopping || self.hasTerminalFailure }) else { return }
			do {
				try self.startup.checkDeadline(at: deadline, videoAppended: self.clipLastTime != nil,
					readyOriginals: self.readyOriginals, readyAudio: self.readyAudioTracks)
			} catch { self.reportWriterFailure("\(error)", detectedAt: deadline) }
		}
	}

	private func startCadenceTimer() {
		guard cadenceTimer == nil, let writer else { return }
		let writerID = ObjectIdentifier(writer), clipIndex = currentClipIndex
		let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
		timer.schedule(deadline: .now() + 1.0 / Double(max(1, request.video.fps)), repeating: 1.0 / Double(max(1, request.video.fps)), leeway: .milliseconds(1))
		timer.setEventHandler { [weak self] in
			guard let self, self.writer.map(ObjectIdentifier.init) == writerID, self.currentClipIndex == clipIndex else { return }
			self.writeScheduledFrames()
		}
		cadenceTimer = timer
		timer.resume()
	}

	private func writeScheduledFrames() {
		guard !stateQueue.sync(execute: { isPaused || isStopping }), let videoInput else { return }
		if request.video.quality != "high" {
			if clipLastTime == nil, let firstScreenFrame { appendScreenFrame(firstScreenFrame) }
			return
		}
		do {
			for time in try cadence.dueTimes(at: CMClockGetTime(CMClockGetHostTimeClock()), maximumCatchUpFrames: startup.backlogLimit(fps: request.video.fps)) {
				guard videoInput.isReadyForMoreMediaData else { captureTelemetry.recordVideoBackpressure(retried: request.video.quality == "high"); return }
				guard let frame = try frameCache.scheduledFrame(at: time, fps: request.video.fps, firstFrame: firstScreenFrame) else { return }
				let previousTime = clipLastTime
				appendScreenFrame(frame.sample, sourceTime: frame.sourceTime)
				guard clipLastTime != previousTime else { return }
			}
		} catch {
			if diagnosticTiming {
				if let anchor = cadence.anchor { startupTiming["cadenceLagMs"] = CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()) - anchor - CMTime(value: cadence.nextFrame, timescale: CMTimeScale(max(1, request.video.fps)))) * 1_000 }
				startupTiming["screenInputReady"] = videoInput.isReadyForMoreMediaData ? 1 : 0
				emitTiming(stage: "cadence-failure")
			}
			reportWriterFailure("\(error)")
		}
	}

	private func trackTiming(stage: String, since start: UInt64) {
		guard diagnosticTiming else { return }
		trackTiming(stage: stage, durationMs: milliseconds(since: start), hostTime: CMClockGetTime(CMClockGetHostTimeClock()))
	}
	private func trackTiming(stage: String, durationMs duration: Double, hostTime: CMTime) {
		guard diagnosticTiming else { return }
		startupTiming[stage + "MaxMs"] = max(startupTiming[stage + "MaxMs"] ?? 0, duration)
		startupTiming[stage + "LastMs"] = duration
		startupTiming[stage + "LastHostSeconds"] = CMTimeGetSeconds(hostTime)
		if duration >= 10 { emitTiming(stage: "slow-" + stage) }
	}

	private func milliseconds(since start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }
	private func emitTiming(stage: String) {
		emit(["event": "capture-diagnostic", "stage": stage, "clipIndex": currentClipIndex, "timingMs": startupTiming])
	}

	private func addAudioInput(
		to writer: AVAssetWriter,
		bitRate: Int,
		trackTitle: String,
		trackLanguageCode: String
	) throws -> AVAssetWriterInput {
		let settings: [String: Any] = [
			AVFormatIDKey: kAudioFormatMPEG4AAC,
			AVSampleRateKey: 48_000,
			AVNumberOfChannelsKey: 2,
			AVEncoderBitRateKey: bitRate,
		]
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: settings)
		input.expectsMediaDataInRealTime = true
		let metadata = AVMutableMetadataItem()
		metadata.identifier = .commonIdentifierTitle
		metadata.value = trackTitle as NSString
		input.metadata = [metadata]
		// ISO 639-2 reserves qaa–qtz for local use. FFmpeg does not expose the ISO `titl`
		// track metadata above, but it does expose this media-header language tag.
		input.languageCode = trackLanguageCode

		guard writer.canAdd(input) else {
			throw HelperError.writerSetupFailed("Unable to add AAC audio input to AVAssetWriter.")
		}

		writer.add(input)
		return input
	}

}
