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
	private let sampleDelivery = RecordingSampleDelivery()
	private var sampleQueue: DispatchQueue { sampleDelivery.processingQueue }
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private let processActivity = RecordingProcessActivity()
	private var recordingActivity: RecordingProcessActivity.Lease?
	private var stream: SCStream?
	private var systemAudioStream: SCStream?
	private var activeSystemAudioFilter: SCContentFilter?
	private let lifecycle: RecordingLifecycle
	private let streamRecovery: RecordingStreamRecovery
	private var activeFilter: SCContentFilter?
	private var activeConfiguration: SCStreamConfiguration?
	/// The live frame interval while a paused stream runs throttled. Command lane only.
	private var pausedFullFrameInterval: CMTime? { if case .throttled(let interval) = lifecycle.capture.sourceRate { return interval }; return nil }
	/// Runs work on the helper's serialized command lane, so a delayed throttle can never
	/// overlap Continue, Stop or a reconfiguration.
	var submitCommand: ((@escaping @Sendable () async -> Void) -> Void)?
	private var pauseGeneration = 0
	private var writer: AVAssetWriter?
	private var cameraCapture: NativeCameraCapture?
	private var activeFilterIgnoresExcludedWindows = false
	/// A camera the standby helper already started for this exact setup; used by the first start only.
	var warmCamera: NativeCameraCapture?
	private var cameraSample: CMSampleBuffer?
	private var originals: [String: OriginalTrackWriter] = [:]
	private var originalOwners: [String: OriginalSourceWriter] = [:]
	private var readyOriginals: Set<String> = []
	/// Sources that have delivered since the current stream started; owned by `sampleQueue`.
	private var originalsStartedOnStream: Set<String> = []
	private var droppedOriginalSamples: [String: Int] = [:]
	private var readyAudioTracks: Set<String> = []
	private let startup: RecordingStartup
	/// Pending Continue state; every access is owned by `sampleQueue`.
	var pendingResume: (generation: UInt64, previousClipIndex: Int, commandInFlight: Bool)? {
		guard !lifecycle.isStopping, let resume = lifecycle.capture.resume else { return nil }
		return (resume.generation, resume.previousClipIndex, resume.commandInFlight)
	}
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
	private var didStartWriting: Bool { lifecycle.capture.clip.hasSession }
	private var frameCache = RecordingFrameCache()
	private var boundaryWarnings = RecordingBoundaryWarnings()
	private var acceptsCachedFrames: Bool { if case .stable = lifecycle.capture.sourceCache { return true }; return false }
	private var isStopping: Bool { lifecycle.isStopping }
	private var isPaused: Bool { lifecycle.isPaused }
	private var hasTerminalFailure: Bool { lifecycle.hasTerminalFailure }
	private var terminationBoundary = RecordingTerminationBoundary()
	var currentClipIndex: Int { lifecycle.capture.clipIndex }
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
	var eventObserver: (([String: Any]) -> Void)?
	var videoAppendObserver: ((CMTime) -> Void)?
	private let eventObserverLock = NSLock()
	private let sampleQueueKey = DispatchSpecificKey<Bool>()

	init(
		request: RecordingRequest,
		unexpectedStopHandler: @escaping (ScreenCaptureRecorder, Error) -> Void
	) {
		let lifecycle = RecordingLifecycle()
		self.lifecycle = lifecycle
		streamRecovery = RecordingStreamRecovery(lifecycle: lifecycle)
		startup = RecordingStartup(lifecycle: lifecycle)
		self.request = request
		cadence = RecordingCadence(fps: request.video.fps)
		captureTelemetry = CaptureTelemetry(requestedVideoFps: request.video.fps)
		self.unexpectedStopHandler = unexpectedStopHandler
		super.init()
		sampleQueue.setSpecific(key: sampleQueueKey, value: true)
	}

	@discardableResult
	func syncOnSampleQueue<T>(_ work: () throws -> T) rethrows -> T {
		if DispatchQueue.getSpecific(key: sampleQueueKey) == true { return try work() }
		return try sampleQueue.sync(execute: work)
	}

	func preparePausedResumeFixture(source: AnyObject, seed: CMSampleBuffer? = nil) {
		stateQueue.sync {
			streamRecovery.install(source)
			lifecycle.transition(.pause)
		}
		if let seed { syncOnSampleQueue { frameCache.observe(seed) } }
	}

	private func emitObservedEvent(_ fields: [String: Any]) {
		guard let eventObserver else {
			emit(fields)
			return
		}
		eventObserverLock.lock()
		defer { eventObserverLock.unlock() }
		emit(fields)
		eventObserver(fields)
	}

	func start() async throws {
		guard lifecycle.transition(.start).accepted else { throw HelperError.writerSetupFailed("The recorder cannot start from its current state.") }
		var stepStarted = DispatchTime.now().uptimeNanoseconds
		var startSteps: [String: Double] = ["startEnteredEpochMs": Date().timeIntervalSince1970 * 1_000]
		let markStep = { [self] (name: String) in
			startSteps["start\(name)Ms"] = milliseconds(since: stepStarted)
			stepStarted = DispatchTime.now().uptimeNanoseconds
		}
		if request.webcam.enabled, AVCaptureDevice.authorizationStatus(for: .video) != .authorized {
			throw HelperError.permissionDenied("Camera permission is required for native camera capture.")
		}
		async let cameraReady: Void = configureCamera(for: request)
		try ensureRequestedPermissions(for: request)
		markStep("Permissions")

		let (content, contentRejection) = try await ShareableContentCache.shared.content(for: request)
		emit(["event": "start-stage", "key": contentRejection.map { "shareable-content:\($0)" } ?? "shareable-content-cached"])
		markStep("ShareableContent")
		stateQueue.sync { recordingActivity = processActivity.acquire() }
		var started = false
		defer { if !started { endRecordingActivity() } }
		let setup = try captureSetupBuilder.make(from: content, request: request)
		outputWidth = setup.width
		outputHeight = setup.height
		captureFrame = setup.captureFrame
		nativeMicrophoneEnabled = setup.microphoneEnabled
		let stream = try configuredStream(filter: setup.filter, configuration: setup.configuration)
		markStep("StreamSetup")
		try await cameraReady
		markStep("Camera")
		try sampleQueue.sync { try setupWriter(for: currentClipIndex) }
		markStep("Writers")
		if diagnosticTiming { startupTiming.merge(startSteps) { _, step in step } }

		self.stream = stream
		stateQueue.sync { streamRecovery.install(stream) }
		activeFilter = setup.filter
		activeConfiguration = setup.configuration
		activeFilterIgnoresExcludedWindows = setup.ignoresExcludedWindows
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		do {
			try await startSystemAudioIfNeeded(filter: setup.systemAudioFilter)
			try await stream.startCapture()
		} catch {
			await stopSystemAudio()
			try? await stream.stopCapture()
			throw error
		}
		activeSystemAudioFilter = setup.systemAudioFilter
		started = true
	}

	/// The camera session and the screen stream shut down independently.
	private func stopSourcesForFinalization() async {
		// Camera frames are already refused once `isStopping` is set, and the helper exits after
		// Stop. Shutting the session down takes hundreds of ms, or seconds when the device is
		// busy, so it must not hold up the final clip.
		if let cameraCapture { Task.detached { await cameraCapture.stop() } }
		do {
			if !stateQueue.sync(execute: { streamRecovery.needsReplacement }) { try await stream?.stopCapture() }
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}
		await stopSystemAudio()
	}

	private func startSystemAudioIfNeeded(filter: SCContentFilter?) async throws {
		guard let filter, stateQueue.sync(execute: { systemAudioStream == nil }) else { return }
		let candidate = SCStream(filter: filter, configuration: CaptureSetupBuilder.systemAudioConfiguration(), delegate: self)
		try candidate.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleDelivery.queue)
		stateQueue.sync { systemAudioStream = candidate }
		do {
			try await candidate.startCapture()
			guard stateQueue.sync(execute: { systemAudioStream === candidate }) else {
				throw HelperError.writerSetupFailed("System audio stopped while capture was starting.")
			}
		} catch {
			stateQueue.sync { systemAudioStream = nil }
			try? await candidate.stopCapture()
			throw error
		}
	}

	private func stopSystemAudio() async {
		let previous = stateQueue.sync {
			let previous = systemAudioStream
			systemAudioStream = nil
			return previous
		}
		do { try await previous?.stopCapture() } catch {
			emit(["event": "warning", "code": "stop-audio-capture-failed", "message": "\(error)"])
		}
	}

	private func endRecordingActivity() {
		let activity = stateQueue.sync {
			let previous = recordingActivity
			recordingActivity = nil
			return previous
		}
		activity?.end()
	}

	private func configuredStream(filter: SCContentFilter, configuration: SCStreamConfiguration) throws -> SCStream {
		let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleDelivery.queue)
		try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleDelivery.queue)
		if #available(macOS 15.0, *) {
			try stream.addStreamOutput(self, type: .microphone, sampleHandlerQueue: sampleDelivery.queue)
		}
		return stream
	}

	/// Starts a stream for the new setup and only then retires the previous one. With
	/// `keepingPrevious` the previous stream is still healthy, so a failed start leaves it in
	/// charge; without it the previous stream has already stopped and nothing is lost.
	private func replaceCaptureStream(filter: SCContentFilter, configuration: SCStreamConfiguration, keepingPrevious: Bool = false) async throws {
		let replacement = try configuredStream(filter: filter, configuration: configuration)
		emit(["event": "reconfigure-stage", "key": "replacement-created"])
		let previous = stream
		stream = replacement
		stateQueue.sync { streamRecovery.install(replacement) }
		sampleQueue.sync {
			frameCache.invalidateCapturedFrame()
			originalsStartedOnStream = []
		}
		if !keepingPrevious {
			try? await previous?.stopCapture()
			emit(["event": "reconfigure-stage", "key": "previous-stopped"])
		}
		do {
			try await replacement.startCapture()
			emit(["event": "reconfigure-stage", "key": "replacement-started"])
			guard stateQueue.sync(execute: { streamRecovery.isSourceUsable }) else {
				throw HelperError.sourceNotFound("The selected capture source stopped before recording could continue. Select an available source and try again.")
			}
		} catch {
			try? await replacement.stopCapture()
			if keepingPrevious, let previous {
				stream = previous
				stateQueue.sync {
					streamRecovery.install(previous)
					streamRecovery.invalidate()
				}
			} else {
				stateQueue.sync { streamRecovery.invalidate() }
			}
			throw error
		}
		if keepingPrevious, let previous {
			Task.detached { try? await previous.stopCapture() }
		}
	}

	func reconfigure(with nextRequest: RecordingRequest) async {
		let canReconfigure = stateQueue.sync { !isStopping && isPaused && !hasTerminalFailure }
		guard canReconfigure else {
			emitError(code: "reconfigure-not-paused", message: "Capture setup can change only while paused.")
			return
		}
		// The app opens and closes its own windows while recording. When the filter already
		// hides the app by process, a new list of those windows changes nothing that is
		// captured: keep the running stream, its cached frame and the camera as they are.
		if activeFilterIgnoresExcludedWindows, Self.sameCaptureExceptExcludedWindows(request, nextRequest) {
			request = nextRequest
			emit([
				"event": "recording-reconfigured",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
				"width": outputWidth,
				"height": outputHeight,
				"captureBounds": captureBoundsPayload(),
			])
			return
		}
		// Samples arriving during filter/configuration changes cannot be assigned
		// reliably to either source. A resumed clip must never seed an old source.
		sampleQueue.sync {
			lifecycle.transition(.beginSourceChange)
			frameCache.invalidateCapturedFrame()
		}
		defer {
			sampleDelivery.barrier {
				frameCache.invalidateCapturedFrame()
				lifecycle.transition(.endSourceChange)
			}
		}

		do {
			try ensureRequestedPermissions(for: nextRequest)
			emit(["event": "reconfigure-stage", "key": "permissions"])
			let (content, contentRejection) = try await ShareableContentCache.shared.content(for: nextRequest)
			emit(["event": "reconfigure-stage", "key": contentRejection.map { "shareable-content:\($0)" } ?? "shareable-content-cached"])
			let setup = try captureSetupBuilder.make(from: content, request: nextRequest)
			guard let stream else {
				throw HelperError.writerSetupFailed("ScreenCaptureKit stream is not running.")
			}
			guard let previousFilter = activeFilter,
				let previousConfiguration = activeConfiguration
			else {
				throw HelperError.writerSetupFailed("The active ScreenCaptureKit setup is missing.")
			}

			let hadSystemAudio = stateQueue.sync { systemAudioStream != nil }
			// Await both operations before changing the writer settings. Continue stays
			// disabled in the renderer until this acknowledgement arrives.
			do {
				try await startSystemAudioIfNeeded(filter: setup.systemAudioFilter)
				if Self.cameraNeedsRestart(from: request, to: nextRequest, running: cameraCapture?.isRunning ?? false) {
					try await configureCamera(for: nextRequest)
					emit(["event": "reconfigure-stage", "key": "camera"])
				}
				// Resizing a live stream costs one to two seconds in ScreenCaptureKit; starting a
				// second stream at the new size takes a few hundred ms, so a new size gets a new
				// stream while the old one keeps running until the new one delivers.
				let sizeChanges = setup.width != outputWidth || setup.height != outputHeight
				let previousHealthy = stateQueue.sync(execute: { streamRecovery.isSourceUsable })
				if previousHealthy && !sizeChanges {
					try await stream.updateConfiguration(setup.configuration)
					emit(["event": "reconfigure-stage", "key": "configuration"])
					try await stream.updateContentFilter(setup.filter)
					emit(["event": "reconfigure-stage", "key": "filter"])
				} else {
					try await replaceCaptureStream(filter: setup.filter, configuration: setup.configuration, keepingPrevious: previousHealthy)
					emit(["event": "reconfigure-stage", "key": "replaced-stream"])
				}
			} catch {
				if !hadSystemAudio { await stopSystemAudio() }
				var rollback: [(String, () async throws -> Void)] = []
				if stateQueue.sync(execute: { streamRecovery.isSourceUsable }) {
					rollback.append(("configuration", { try await stream.updateConfiguration(previousConfiguration) }))
					rollback.append(("filter", { try await stream.updateContentFilter(previousFilter) }))
				}
				rollback.append(("camera", { try await self.configureCamera(for: self.request) }))
				let rollbackErrors = await RecordingSetupRollback.run(rollback)
				if !rollbackErrors.isEmpty {
					_ = stateQueue.sync { lifecycle.transition(.fail) }
					emitError(
						code: "writer-failed-during-capture",
						message: "Capture reconfiguration and rollback failed: \(error). Rollback: \(rollbackErrors.joined(separator: "; "))"
					)
					await stop()
					return
				}
				throw error
			}
			if setup.systemAudioFilter == nil { await stopSystemAudio() }
			activeSystemAudioFilter = setup.systemAudioFilter
			request = nextRequest
			cadence = RecordingCadence(fps: nextRequest.video.fps)
			activeFilter = setup.filter
			activeConfiguration = setup.configuration
			// The new configuration runs at the full rate already.
			lifecycle.transition(.restoreSourceRate)
			activeFilterIgnoresExcludedWindows = setup.ignoresExcludedWindows
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
		await ShareableContentCache.shared.stopKeepingFresh()
		let requestedEndTime = CMClockGetTime(CMClockGetHostTimeClock())
		let stop = stateQueue.sync { lifecycle.transition(.stop) }
		guard let completion = stop.stop else { return }
		if !stop.ownsStop { await completion.wait(); return }
		let endTime = stateQueue.sync {
			pauseGeneration += 1
			return terminationBoundary.endingAt(requestedEndTime)
		}
		defer { lifecycle.transition(.stopped); completion.finish() }

		let finalizationActivity = processActivity.acquire()
		endRecordingActivity()
		defer { finalizationActivity.end() }

		await stopSourcesForFinalization()
		emitStopStage("sources-stopped")
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
		emitObservedEvent(stoppedPayload)
	}

	func pause() async {
		let endTime = CMClockGetTime(CMClockGetHostTimeClock())
		let didPause = stateQueue.sync {
			if isStopping || isPaused {
				return false
			}

			return lifecycle.transition(.pause).changed
		}

		guard didPause else { return }
		let finalizationActivity = processActivity.acquire()
		endRecordingActivity()
		defer { finalizationActivity.end() }
		emitObservedEvent(["event": "clip-finalizing"])
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
			schedulePausedThrottle()
			await ShareableContentCache.shared.keepFresh(every: ContentSnapshotRule.refreshSeconds)
		} catch {
			emitError(code: "clip-finalize-failed", message: "\(error)")
		}
	}

	func resume() async {
		await ShareableContentCache.shared.stopKeepingFresh()
		stateQueue.sync { pauseGeneration += 1 }
		let previousClipIndex = currentClipIndex
		var resumeGeneration = stateQueue.sync { streamRecovery.generation }
		guard lifecycle.transition(.beginResume(generation: resumeGeneration, previousClipIndex: previousClipIndex)).accepted else {
			guard isPaused, !isStopping, pendingResume == nil else { return }
			if hasTerminalFailure {
				emitError(code: "clip-start-failed", message: "The current writer failed. Stop now to keep earlier completed clips.")
			} else {
				emitObservedEvent(RecordingStreamRecovery.rejectedResumePayload(previousClipIndex: previousClipIndex,
					message: "The selected capture source is unavailable or the recorder is not paused. Select an available source and try again."))
			}
			return
		}

		stateQueue.sync { recordingActivity = processActivity.acquire() }
		var resumed = false
		defer { if !resumed { endRecordingActivity() } }
		do {
			try await restorePausedStreamRate()
			try await startSystemAudioIfNeeded(filter: activeSystemAudioFilter)
			if stateQueue.sync(execute: { streamRecovery.needsReplacement }), let activeFilter, let activeConfiguration {
				try await replaceCaptureStream(filter: activeFilter, configuration: activeConfiguration)
				resumeGeneration = stateQueue.sync { streamRecovery.generation }
			}
			let nextClipIndex = previousClipIndex + 1
			var seed = try syncOnSampleQueue {
				lifecycle.transition(.resumeSeed(generation: resumeGeneration, previousClipIndex: previousClipIndex))
				return try frameCache.resumedFrame(
					at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps
				)
			}
			if seed == nil {
				let waited = try await ResumeSeedWait.firstFrame {
					try sampleQueue.sync {
						try frameCache.resumedFrame(at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps)
					}
				}
				seed = waited.frame
				if seed != nil { emit(["event": "resume-stage", "key": "first-frame", "waitedMs": waited.waitedMs]) }
			}
			if seed == nil, #available(macOS 14.0, *),
				let activeFilter, let activeConfiguration
			{
				// A static screen may produce no new complete frame after a filter
				// change. Capture that filtered source once while still paused.
				let screenshot = try await SCScreenshotManager.captureSampleBuffer(
					contentFilter: activeFilter, configuration: activeConfiguration
				)
				emit(["event": "resume-stage", "key": "screenshot-seed"])
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
				if let sourceSeed = seed {
					try stateQueue.sync {
						guard streamRecovery.isSourceUsable, streamRecovery.generation == resumeGeneration,
							!isStopping, !hasTerminalFailure else {
							throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
						}
					}
					// Writer preparation can take hundreds of ms. A resumed clip's
					// host epoch begins after that work, at the first seeded append.
					let seed = try RecordingFrameCache.retime(sourceSeed, at: CMClockGetTime(CMClockGetHostTimeClock()), fps: request.video.fps)
					frameCache.observe(seed)
					guard let videoInput, let writer, writer.status == .writing else {
						throw HelperError.writerSetupFailed("Unable to start the resumed clip writer.")
					}
					let startTime = CMSampleBufferGetPresentationTimeStamp(seed)
					writer.startSession(atSourceTime: startTime)

					clipStartTime = startTime
					beginStartup(at: startTime, firstFrame: seed)
					compatibilityAudio?.begin(at: startTime)
					beginOriginals(at: startTime)
					return (seed, videoInput, writer)
				}
				try stateQueue.sync {
					guard streamRecovery.isSourceUsable, !isStopping, !hasTerminalFailure else {
						throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
					}
					lifecycle.transition(.acceptResumeFrames)
				}
				return nil
			}
			if let (seed, input, writer) = seededWriter {
				// Retry encoder backpressure without waiting for the static screen
				// to change. The same bounded append keeps readiness truthful.
				try await ClosingFrameAppender(sample: seed, input: input, writer: writer, queue: sampleQueue).append()
				try sampleQueue.sync {
					try stateQueue.sync {
						guard streamRecovery.isSourceUsable, !isStopping, !hasTerminalFailure else {
							throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
						}
						lifecycle.transition(.acceptResumeFrames)
					}
					recordSuccessfulVideoAppend(seed, sourceGeneration: resumeGeneration, acknowledgeReadiness: false)
					if acknowledgeClipReadiness(expectedSourceGeneration: resumeGeneration) { return }
					if !startup.isLive {
						try stateQueue.sync {
							guard streamRecovery.isSourceUsable, streamRecovery.generation == resumeGeneration,
								!isStopping, !hasTerminalFailure else {
								throw HelperError.sourceNotFound("The selected capture source is unavailable. Select an available source and try again.")
							}
						}
					}
				}
			}
			let rejected = syncOnSampleQueue { () -> Bool in
				lifecycle.transition(.awaitResumeAcknowledgement)
				return rejectPendingResumeIfSourceChanged()
			}
			if rejected { return }
			resumed = true
		} catch {
			let rejected = syncOnSampleQueue { () -> Bool in
				let rejected = stateQueue.sync {
					RecordingStreamRecovery.canRejectResume(paused: isPaused, stopping: isStopping,
						terminalFailure: hasTerminalFailure, acknowledgedClipIndex: startup.isLive ? currentClipIndex : nil,
						previousClipIndex: previousClipIndex, resumePending: true)
				}
				guard rejected else { return false }
				discardCurrentWriterOnSampleQueue()
				frameCache.invalidateCapturedFrame()
				_ = stateQueue.sync { lifecycle.transition(.rejectResume) }
				return true
			}
			if rejected { emitObservedEvent(RecordingStreamRecovery.rejectedResumePayload(previousClipIndex: previousClipIndex, message: "\(error)")) }
			else { emitError(code: "clip-start-failed", message: "\(error)") }
		}
	}

	/// A paused take keeps its stream so Continue starts at once, but nothing is written:
	/// a few frames a second keep the resume seed fresh without full-rate composition.
	static let pausedFrameInterval = CMTime(value: 1, timescale: 5)
	/// Restoring the rate costs Continue about 70-130 ms (measured October 20), so only a
	/// pause long enough to matter for power is throttled.
	static let pausedThrottleDelayNanoseconds: UInt64 = 10_000_000_000

	private func schedulePausedThrottle() {
		guard let submitCommand else { return }
		let generation = stateQueue.sync { pauseGeneration }
		Task.detached { [weak self] in
			try? await Task.sleep(nanoseconds: Self.pausedThrottleDelayNanoseconds)
			submitCommand { [weak self] in
				guard let self, self.stateQueue.sync(execute: { self.pauseGeneration == generation && self.isPaused }) else { return }
				await self.throttlePausedStream()
			}
		}
	}

	private func throttlePausedStream() async {
		guard pausedFullFrameInterval == nil, let stream, let activeConfiguration,
			!stateQueue.sync(execute: { !streamRecovery.isSourceUsable || isStopping })
		else { return }
		let fullInterval = activeConfiguration.minimumFrameInterval
		activeConfiguration.minimumFrameInterval = Self.pausedFrameInterval
		do {
			try await stream.updateConfiguration(activeConfiguration)
			lifecycle.transition(.throttleSource(fullInterval))
		} catch {
			activeConfiguration.minimumFrameInterval = fullInterval
			emit(["event": "warning", "code": "paused-throttle-failed", "message": "\(error)"])
		}
	}

	private func restorePausedStreamRate() async throws {
		guard let fullInterval = pausedFullFrameInterval, let activeConfiguration else { return }
		activeConfiguration.minimumFrameInterval = fullInterval
		// A stream due for replacement restarts from this configuration at the full rate.
		if stateQueue.sync(execute: { streamRecovery.needsReplacement }) {
			lifecycle.transition(.restoreSourceRate)
			return
		}
		if let stream, stateQueue.sync(execute: { streamRecovery.isSourceUsable }) {
			do { try await stream.updateConfiguration(activeConfiguration) } catch {
				activeConfiguration.minimumFrameInterval = Self.pausedFrameInterval
				throw error
			}
			emit(["event": "resume-stage", "key": "full-rate"])
			lifecycle.transition(.restoreSourceRate)
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		handleStreamStop(stream, error: error)
	}

	func handleSystemAudioStop(_ error: Error) {
		let disposition = stateQueue.sync {
			let outcome = lifecycle.transition(.systemAudioStopped)
			if outcome.sourceStop == .activeFailure { terminationBoundary.recordFailure(at: CMClockGetTime(CMClockGetHostTimeClock())) }
			return outcome.sourceStop
		}
		switch disposition {
		case .ignored: return
		case .pausedSourceUnavailable:
			emit(["event": "warning", "code": "system-audio-unavailable", "message": "System audio stopped: \(error). Continue will retry."])
		case .activeFailure:
			endRecordingActivity()
			unexpectedStopHandler(self, error)
		}
	}

	func handleStreamStop(_ stream: AnyObject, error: Error) {
		let audioFailure = stateQueue.sync { () -> Bool in
			guard stream === systemAudioStream else { return false }
			systemAudioStream = nil
			return !isStopping
		}
		if audioFailure { handleSystemAudioStop(error); return }
		let disposition = syncOnSampleQueue {
			return stateQueue.sync { () -> RecordingStreamRecovery.StopDisposition in
				let disposition = streamRecovery.stopped(stream)
				if disposition == .activeFailure {
					terminationBoundary.recordFailure(at: CMClockGetTime(CMClockGetHostTimeClock()))
					lifecycle.transition(.pause)
					lifecycle.transition(.fail)
				}
				return disposition
			}
		}
		switch disposition {
		case .ignored: return
		case .pausedSourceUnavailable:
			sampleQueue.async {
				self.frameCache.invalidateCapturedFrame()
				_ = self.rejectPendingResumeIfSourceChanged()
			}
			emit(["event": "warning", "code": "paused-source-unavailable", "message": "\(error)"])
		case .activeFailure:
			endRecordingActivity()
			unexpectedStopHandler(self, error)
		}
	}

	/// Everything the stream shared has closed (macOS 15.2+). On High the cadence grid would
	/// keep writing the last picture, so the app is told and pauses the take.
	@available(macOS 15.2, *)
	func streamDidBecomeInactive(_ stream: SCStream) {
		emitSourceActivity(stream, code: "source-inactive")
	}

	@available(macOS 15.2, *)
	func streamDidBecomeActive(_ stream: SCStream) {
		emitSourceActivity(stream, code: "source-active")
	}

	func emitSourceActivity(_ stream: AnyObject, code: String) {
		let transitioned = stateQueue.sync { () -> Bool in
			guard !isStopping else { return false }
			if code == "source-inactive" { return streamRecovery.becameInactive(stream) }
			return streamRecovery.becameActive(stream)
		}
		guard transitioned else { return }
		if code == "source-inactive" {
			sampleQueue.async {
				self.frameCache.invalidateCapturedFrame()
				_ = self.rejectPendingResumeIfSourceChanged()
			}
		}
		emit(["event": "warning", "code": code, "clipIndex": currentClipIndex,
			"timestampMs": Int(Date().timeIntervalSince1970 * 1_000), "message": "The captured content \(code == "source-inactive" ? "closed" : "is back")."])
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		sampleDelivery.process { processStreamSample(stream, sampleBuffer: sampleBuffer, type: type) }
	}

	private func processStreamSample(_ stream: SCStream, sampleBuffer: CMSampleBuffer, type: SCStreamOutputType) {
		let callbackStart = diagnosticTiming ? DispatchTime.now().uptimeNanoseconds : 0
		let callbackStage = type == .screen ? "screenCallback" : type == .audio ? "systemCallback" : "microphoneCallback"
		defer { if diagnosticTiming { trackTiming(stage: callbackStage, since: callbackStart) } }
		if diagnosticTiming, type == .screen {
			let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
			if time.isNumeric { trackTiming(stage: "screenSourceAge", durationMs: CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock()) - time) * 1000, hostTime: CMClockGetTime(CMClockGetHostTimeClock())) }
		}
		guard measureCaptureStage("streamStateWait", { stateQueue.sync(execute: {
			streamRecovery.acceptsSamples(from: stream, systemAudioStream: systemAudioStream, isSystemAudio: type == .audio)
		}) }), CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		let inactive = measureCaptureStage("streamPausedStateWait", { stateQueue.sync(execute: { isPaused || isStopping }) })
		if type == .screen, acceptsCachedFrames {
			let status = CaptureTelemetry.frameStatus(sampleBuffer)
			if status == nil || status == .complete { measureCaptureStage("frameCacheObserve") { frameCache.observe(sampleBuffer, retainingPrevious: !inactive) } }
		}
		if inactive { return }

		if type == .audio {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: false)
			appendOriginal(sampleBuffer, key: "systemAudioPath")
			appendCompatibilityAudio(sampleBuffer, from: .system)
			return
		}

		if #available(macOS 15.0, *), type == .microphone {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: true)
			appendOriginal(sampleBuffer, key: "microphoneAudioPath")
			appendCompatibilityAudio(sampleBuffer, from: .microphone)
			return
		}

		guard type == .screen else {
			return
		}
		guard measureCaptureStage("screenTelemetry", { captureTelemetry.recordScreenSample(sampleBuffer) }) else {
			return
		}
		if request.video.quality != "high" || cadence.anchor == nil { appendScreenFrame(sampleBuffer) }
	}

	/// Runs on sampleQueue. Readiness for each clip means an actual appended frame.
	func appendScreenFrame(_ incoming: CMSampleBuffer, sourceTime: CMTime? = nil) {
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

	private func recordSuccessfulVideoAppend(
		_ sample: CMSampleBuffer,
		sourceTime: CMTime? = nil,
		sourceGeneration: UInt64? = nil,
		acknowledgeReadiness: Bool = true
	) {
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
		videoAppendObserver?(presentationTime)
		if acknowledgeReadiness {
			acknowledgeClipReadiness(expectedSourceGeneration: sourceGeneration)
		}
	}

	private func rejectPendingResumeIfSourceChanged() -> Bool {
		guard let pending = pendingResume else { return false }
		let sourceChanged = stateQueue.sync {
			!streamRecovery.isSourceUsable || streamRecovery.generation != pending.generation
		}
		guard sourceChanged, !pending.commandInFlight else { return false }
		let rejected = stateQueue.sync {
			RecordingStreamRecovery.canRejectResume(paused: isPaused, stopping: isStopping,
				terminalFailure: hasTerminalFailure, acknowledgedClipIndex: startup.isLive ? currentClipIndex : nil,
				previousClipIndex: pending.previousClipIndex, resumePending: true)
		}
		guard rejected else { return false }
		discardCurrentWriterOnSampleQueue()
		frameCache.invalidateCapturedFrame()
		_ = stateQueue.sync { lifecycle.transition(.rejectResume) }
		endRecordingActivity()
		emitObservedEvent(RecordingStreamRecovery.rejectedResumePayload(
			previousClipIndex: pending.previousClipIndex,
			message: "The selected capture source changed before recording could continue. Try again."
		))
		return true
	}

	@discardableResult
	private func acknowledgeClipReadiness(expectedSourceGeneration: UInt64? = nil) -> Bool {
		if rejectPendingResumeIfSourceChanged() { return true }
		guard clipLastTime != nil else { return false }
		guard !stateQueue.sync(execute: { isPaused || isStopping || hasTerminalFailure || startup.isLive }) else { return false }
		let expectedGeneration = expectedSourceGeneration ?? pendingResume?.generation
		let now = CMClockGetTime(CMClockGetHostTimeClock())
		do {
			reportLateSources(try startup.checkDeadline(at: now, videoAppended: true, readyOriginals: readyOriginals, readyAudio: readyAudioTracks))
			var caughtUp = true
			if request.video.quality == "high" { caughtUp = try cadence.dueTimes(at: now, maximumCatchUpFrames: startup.backlogLimit(fps: request.video.fps)).isEmpty }
			let clipIndex = stateQueue.sync { () -> Int? in
				guard streamRecovery.isSourceUsable,
					(expectedGeneration.map { streamRecovery.generation == $0 } ?? true),
					let clipIndex = startup.acknowledgeClip(videoAppended: true, gridCaughtUp: caughtUp, expectedGeneration: expectedGeneration)
				else { return nil }
				emitObservedEvent([
					"event": clipIndex == 0 ? "recording-started" : "recording-resumed",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"epochMs": startup.epoch.map { Int((Date().timeIntervalSince1970 - CMTimeGetSeconds(now - $0)) * 1_000) } ?? 0,
					"clipIndex": clipIndex,
					"width": outputWidth,
					"height": outputHeight,
					"captureBounds": captureBoundsPayload(),
				])
				return clipIndex
			}
			if clipIndex != nil, diagnosticTiming { emitTiming(stage: "startup-ready") }
		} catch { reportWriterFailure("\(error)", detectedAt: startupDeadline.map { min($0, now) } ?? now) }
		return false
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
		guard let writer, lifecycle.transition(.announceFailure).changed else {
			return
		}
		let failureTime = detectedAt ?? CMClockGetTime(CMClockGetHostTimeClock())
		stateQueue.sync {
			terminationBoundary.recordFailure(at: failureTime)
			lifecycle.transition(.pause)
			lifecycle.transition(.fail)
		}
		endRecordingActivity()
		emitObservedEvent([
			"event": "error",
			"code": "writer-failed-during-capture",
			"message": "\(stage): "
				+ (writer.error.map { "\($0)" }
					?? "AVAssetWriter status \(writer.status.rawValue)"),
		])
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
		lifecycle.transition(.detachWriter)

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
		originalOwners = [:]; readyOriginals = []; droppedOriginalSamples = [:]
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
		guard startup.configure(originals: Set(originals.keys), audioTracks: audioTracks, clipIndex: index) else {
			throw HelperError.writerSetupFailed("The recorder cannot prepare a writer from its current state.")
		}
		readyAudioTracks = []; firstScreenFrame = nil
		startupTimer?.cancel(); startupTimer = nil
		cadenceTimer?.cancel(); cadenceTimer = nil; cadence.reset(); lastScheduledSourceTime = nil
		captureTelemetry.beginClip()
		frameCache.beginClip()
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
			lifecycle.transition(.detachWriter)
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
		lifecycle.transition(.detachWriter)
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
		emitStopStage("drained")

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
		emitStopStage("closing-frames-written")
		if let audioOwner {
			let finished = await audioOwner.finish()
			emitStopStage("audio-finished")
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

		emitStopStage("writer-detached")
		await withCheckedContinuation { continuation in
			detached.writer.finishWriting {
				continuation.resume()
			}
		}
		emitStopStage("main-written")
		var originalPayload: [String: Any] = [:]
		let startedOnStream = sampleQueue.sync { originalsStartedOnStream }
		let clipEnd = effectiveEndTime.isNumeric ? effectiveEndTime : detached.lastTime
		for (key, original) in detached.originals {
			defer {
				let owner = detached.sourceOwners[key]
				captureTelemetry.recordOriginalWriter(cameraFrames: key == "webcamVideoPath" ? original.appendedSamples : 0, backpressureEvents: original.backpressureEvents, queueDepth: owner?.maximumQueueDepth ?? original.maximumQueueDepth)
				if diagnosticTiming, let owner {
					emit(["event": "capture-timing", "stage": "original-source-queue", "key": key,
						"maximumQueueDepth": owner.maximumQueueDepth, "maximumQueuedBytes": owner.maximumQueuedBytes,
						"droppedSamples": droppedOriginalSamples[key] ?? 0])
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
			} catch let empty as OriginalTrackWriter.NoSamples where Self.originalMayBeEmpty(
				sourceAlreadyDelivered: startedOnStream.contains(key), start: detached.startTime, end: clipEnd
			) {
				// A clip can close before a microphone or camera delivers: within the startup
				// allowance of a new stream, or within a few buffers of Continue. That clip simply
				// has no such original; a longer silent source still fails loudly.
				emit(["event": "warning", "code": "original-empty", "key": key, "clipIndex": detached.index, "message": "\(empty)"])
			} catch {
				let message = boundaryWarnings.record(error)
				emit(["event": "warning", "code": "original-track-failed", "message": message])
			}
		}

		emitStopStage("originals-written")
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

	static let resumedSourceAllowanceSeconds = 0.5

	static func originalMayBeEmpty(sourceAlreadyDelivered: Bool, start: CMTime?, end: CMTime?) -> Bool {
		guard let start, let end, start.isNumeric, end.isNumeric else { return true }
		let allowance = sourceAlreadyDelivered ? resumedSourceAllowanceSeconds : RecordingStartup.sourceDeadlineSeconds
		return CMTimeGetSeconds(end - start) < allowance
	}

	static func sameCaptureExceptExcludedWindows(_ current: RecordingRequest, _ next: RecordingRequest) -> Bool {
		current.source.type == next.source.type && current.source.sourceId == next.source.sourceId
			&& current.source.displayId == next.source.displayId && current.source.windowId == next.source.windowId
			&& current.source.excludedProcessIds == next.source.excludedProcessIds && current.source.bounds == next.source.bounds
			&& current.video == next.video && current.audio == next.audio && current.webcam == next.webcam
			&& current.cursor == next.cursor && current.outputs == next.outputs
	}

	/// A running camera whose setup did not change keeps its session across Continue. A
	/// source or window change must not cost a camera restart and a gap in its picture.
	static func cameraNeedsRestart(from current: RecordingRequest, to next: RecordingRequest, running: Bool) -> Bool {
		if !next.webcam.enabled { return current.webcam.enabled || running }
		return !running || next.webcam != current.webcam || next.video.quality != current.video.quality
	}

	private func configureCamera(for nextRequest: RecordingRequest) async throws {
		await cameraCapture?.stop()
		sampleQueue.sync { cameraCapture = nil; cameraSample = nil }
		let warm = warmCamera
		warmCamera = nil
		guard nextRequest.webcam.enabled else { await warm?.stop(); return }
		let onFailure: (Error) -> Void = { [weak self] error in self?.reportWriterFailure("\(error)") }
		let onDrop: () -> Void = { [weak self] in
			guard let self, !self.stateQueue.sync(execute: { self.isPaused || self.isStopping }) else { return }
			self.captureTelemetry.recordCameraSample(dropped: true)
		}
		let onSample: (CMSampleBuffer) -> Void = { [weak self] sample in
			guard let self else { return }
			let callbackStart = self.diagnosticTiming ? DispatchTime.now().uptimeNanoseconds : 0
			defer { if self.diagnosticTiming { self.trackTiming(stage: "cameraCallback", since: callbackStart) } }
			self.cameraSample = sample
			guard !self.stateQueue.sync(execute: { self.isPaused || self.isStopping }) else { return }
			if self.didStartWriting { self.captureTelemetry.recordCameraSample() }
			self.appendOriginal(sample, key: "webcamVideoPath")
		}
		let onInterruption: (String) -> Void = { [weak self] message in self?.recordCameraInterruption(message) }
		if let warm, warm.isRunning {
			warm.adopt(sampleQueue: sampleQueue, onFailure: onFailure, onDrop: onDrop, onSample: onSample)
			warm.onInterruption = onInterruption
			sampleQueue.sync { cameraCapture = warm }
			warm.announceFormat()
			return
		}
		await warm?.stop()
		let camera = try NativeCameraCapture(webcam: nextRequest.webcam, quality: nextRequest.video.quality, sampleQueue: sampleQueue, onFailure: onFailure, onDrop: onDrop, onSample: onSample)
		camera.onInterruption = onInterruption
		sampleQueue.sync { cameraCapture = camera }
		try await camera.start()
	}

	/// The camera stopped feeding the take. Loud but not fatal: the device usually comes
	/// back, and the warning carries the moment so the gap in the file can be explained.
	private func recordCameraInterruption(_ message: String) {
		sampleQueue.async { [weak self] in
			guard let self else { return }
			let now = CMClockGetTime(CMClockGetHostTimeClock())
			let sinceEpochMs = self.startup.epoch.map { Int(CMTimeGetSeconds(now - $0) * 1_000) } ?? -1
			emit([
				"event": "warning", "code": "camera-interrupted", "clipIndex": self.currentClipIndex,
				"timestampMs": Int(Date().timeIntervalSince1970 * 1_000), "sinceEpochMs": sinceEpochMs, "message": message,
			])
		}
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
		let admissionStart = diagnosticTiming ? DispatchTime.now().uptimeNanoseconds : 0
		defer { if diagnosticTiming { trackTiming(stage: "compatibilityAdmission", since: admissionStart) } }
		guard didStartWriting, let owner = compatibilityAudio, CMSampleBufferGetNumSamples(sample) > 0 else { return }
		let clipIndex = currentClipIndex
		do {
			try owner.append(sample, from: source) { [weak self] result, detectedAt in
				guard let self else { return }
				let queuedAt = DispatchTime.now().uptimeNanoseconds
				self.sampleQueue.async {
					guard self.compatibilityAudio === owner,
						owner.isCurrent(writer: self.writer, clipIndex: clipIndex, currentClipIndex: self.currentClipIndex) else { return }
					self.trackTiming(stage: "compatibilityCompletionQueueDelay", since: queuedAt)
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
		let admissionStart = diagnosticTiming ? DispatchTime.now().uptimeNanoseconds : 0
		defer { if diagnosticTiming { trackTiming(stage: key + "Admission", since: admissionStart) } }
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
					let queuedAt = DispatchTime.now().uptimeNanoseconds
					self.sampleQueue.async {
						guard owner.isCurrent(original: self.originals[key], clipIndex: clipIndex, currentClipIndex: self.currentClipIndex) else { return }
						self.trackTiming(stage: key + "CompletionQueueDelay", since: queuedAt)
						switch result {
						case .success(let completed):
							self.trackTiming(stage: key + "Append", durationMs: completed.elapsedMs, hostTime: completed.hostTime)
							if self.diagnosticTiming && completed.firstAppend {
								self.startupTiming[key + "FirstAppendMs"] = completed.elapsedMs
								self.emitTiming(stage: "first-original-" + key)
							}
							if let metadata = completed.metadata {
								self.readyOriginals.insert(key)
								self.originalsStartedOnStream.insert(key)
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
			} catch let overflow as OriginalAdmissionOverflow {
				recordOriginalOverflow(key, overflow)
			} catch { reportWriterFailure("\(key): \(error)", detectedAt: owner.failureTime) }
			return
		}
	}

	/// A side track whose encoder falls behind sheds its own samples, like a late camera
	/// frame. Only the screen writer decides whether the recording lives.
	private func recordOriginalOverflow(_ key: String, _ overflow: OriginalAdmissionOverflow) {
		let dropped = (droppedOriginalSamples[key] ?? 0) + 1
		droppedOriginalSamples[key] = dropped
		if key == "webcamVideoPath" { captureTelemetry.recordCameraSample(dropped: true) }
		guard dropped == 1 else { return }
		emit(["event": "warning", "code": "original-sample-dropped", "key": key, "clipIndex": currentClipIndex, "message": "\(key): \(overflow)"])
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
				!self.stateQueue.sync(execute: { self.isPaused || self.isStopping || self.hasTerminalFailure }) else { return }
			do {
				self.reportLateSources(try self.startup.checkDeadline(at: deadline, videoAppended: self.clipLastTime != nil,
					readyOriginals: self.readyOriginals, readyAudio: self.readyAudioTracks))
			} catch { self.reportWriterFailure("\(error)", detectedAt: deadline) }
		}
	}

	private func reportLateSources(_ sources: [String]) {
		guard !sources.isEmpty else { return }
		emit([
			"event": "warning", "code": "source-late", "clipIndex": currentClipIndex,
			"message": "Recording continues without \(sources.joined(separator: ", ")) two seconds after the first screen frame; each source joins when its first sample arrives.",
		])
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
		let callbackStart = diagnosticTiming ? DispatchTime.now().uptimeNanoseconds : 0
		defer { if diagnosticTiming { trackTiming(stage: "cadenceTimerCallback", since: callbackStart) } }
		if diagnosticTiming {
			let now = CMClockGetTime(CMClockGetHostTimeClock())
			let seconds = CMTimeGetSeconds(now)
			if let previous = startupTiming["cadenceTimerEntryHostSeconds"] { trackTiming(stage: "cadenceTimerInterval", durationMs: (seconds - previous) * 1000, hostTime: now) }
			startupTiming["cadenceTimerEntryHostSeconds"] = seconds
		}
		guard !measureCaptureStage("timerStateWait", { stateQueue.sync(execute: { isPaused || isStopping }) }), let videoInput else { return }
		if request.video.quality != "high" {
			if clipLastTime == nil, let firstScreenFrame { appendScreenFrame(firstScreenFrame) }
			return
		}
		do {
			let now = CMClockGetTime(CMClockGetHostTimeClock())
			let limit = startup.backlogLimit(fps: request.video.fps)
			let due: [CMTime]
			do {
				due = try cadence.dueTimes(at: now, maximumCatchUpFrames: limit)
			} catch where startup.isLive && !RecordingCadence.writerStalled(lastAppended: clipLastTime, at: now) {
				// A briefly full encoder (camera plus a 60 fps High screen) skips
				// frames rather than ending the take.
				captureTelemetry.recordSkippedVideoFrames(cadence.skipBacklog(at: now))
				due = try cadence.dueTimes(at: now, maximumCatchUpFrames: limit)
			}
			for time in due {
				guard videoInput.isReadyForMoreMediaData else { captureTelemetry.recordVideoBackpressure(retried: request.video.quality == "high"); return }
				guard let frame = try measureCaptureStage("frameRetime", { try frameCache.scheduledFrame(at: time, fps: request.video.fps, firstFrame: firstScreenFrame) }) else { return }
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

	// sampleQueue only. Keep a fixed set of aggregate metrics in memory; do not
	// synchronously serialize/flush on the hot path being measured.
	private func measureCaptureStage<T>(_ stage: String, _ work: () throws -> T) rethrows -> T {
		guard diagnosticTiming else { return try work() }
		let started = DispatchTime.now().uptimeNanoseconds
		defer { trackTiming(stage: stage, since: started) }
		return try work()
	}

	private func trackTiming(stage: String, since start: UInt64) {
		guard diagnosticTiming else { return }
		trackTiming(stage: stage, durationMs: milliseconds(since: start), hostTime: CMClockGetTime(CMClockGetHostTimeClock()))
	}
	private func trackTiming(stage: String, durationMs duration: Double, hostTime: CMTime) {
		guard diagnosticTiming else { return }
		if duration > (startupTiming[stage + "MaxMs"] ?? 0) { startupTiming[stage + "MaxHostSeconds"] = CMTimeGetSeconds(hostTime) }
		startupTiming[stage + "MaxMs"] = max(startupTiming[stage + "MaxMs"] ?? 0, duration)
		startupTiming[stage + "LastMs"] = duration
		startupTiming[stage + "LastHostSeconds"] = CMTimeGetSeconds(hostTime)
	}

	private func milliseconds(since start: UInt64) -> Double { Double(DispatchTime.now().uptimeNanoseconds - start) / 1_000_000 }
	private func emitStopStage(_ stage: String) {
		// Pause finalizes a clip through the same steps, so it reports them too.
		guard stateQueue.sync(execute: { isStopping || isPaused }) else { return }
		emit(["event": "stop-stage", "key": stage])
	}

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
