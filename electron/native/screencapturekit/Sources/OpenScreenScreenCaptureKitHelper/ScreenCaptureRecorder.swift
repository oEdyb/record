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

		var payload: [String: Any] {
			[
				"index": index,
				"screenVideoPath": path,
				"durationMs": durationMs,
			]
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
	}

	private var request: RecordingRequest
	private let captureSetupBuilder = CaptureSetupBuilder()
	private let sampleQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples")
	private let stateQueue = DispatchQueue(label: "app.openscreen.sck-helper.state")
	private var stream: SCStream?
	private var activeFilter: SCContentFilter?
	private var activeConfiguration: SCStreamConfiguration?
	private var writer: AVAssetWriter?
	private var videoInput: AVAssetWriterInput?
	// The mixed track stays first for HTML5 preview. Tagged source tracks give export clean
	// microphone/system stems without changing the one-file-per-clip project model.
	private var audioInputs: [AVAssetWriterInput] = []
	private var audioMixer: AudioTrackMixer?
	private var didStartWriting = false
	private var didEmitRecordingStarted = false
	private var didReportWriterFailure = false
	private var isStopping = false
	private var isPaused = false
	private var hasTerminalFailure = false
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
		let stream = SCStream(
			filter: setup.filter,
			configuration: setup.configuration,
			delegate: self
		)

		try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
		// Apple supports live configuration updates on one SCStream. Keep all
		// available destinations attached for the full session; the configuration
		// decides which sample types flow into each new clip.
		try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: sampleQueue)
		if #available(macOS 15.0, *),
			let microphoneOutputType = SCStreamOutputType(
				rawValue: screenCaptureKitMicrophoneOutputTypeRawValue
			)
		{
			try stream.addStreamOutput(
				self,
				type: microphoneOutputType,
				sampleHandlerQueue: sampleQueue
			)
		}
		try setupWriter(for: currentClipIndex)

		self.stream = stream
		activeFilter = setup.filter
		activeConfiguration = setup.configuration
		emit([
			"event": "ready",
			"schemaVersion": 1,
		])
		try await stream.startCapture()
	}

	func reconfigure(with nextRequest: RecordingRequest) async {
		let canReconfigure = stateQueue.sync { !isStopping && isPaused && !hasTerminalFailure }
		guard canReconfigure else {
			emitError(code: "reconfigure-not-paused", message: "Capture setup can change only while paused.")
			return
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
				try await stream.updateConfiguration(setup.configuration)
				try await stream.updateContentFilter(setup.filter)
			} catch {
				var rollbackErrors: [String] = []
				do {
					try await stream.updateConfiguration(previousConfiguration)
				} catch let rollbackError {
					rollbackErrors.append("configuration: \(rollbackError)")
				}
				do {
					try await stream.updateContentFilter(previousFilter)
				} catch let rollbackError {
					rollbackErrors.append("filter: \(rollbackError)")
				}
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
		let shouldStop = stateQueue.sync {
			if isStopping {
				return false
			}
			isStopping = true
			return true
		}
		if !shouldStop {
			return
		}

		do {
			try await stream?.stopCapture()
		} catch {
			emit([
				"event": "warning",
				"code": "stop-capture-failed",
				"message": "\(error)",
			])
		}

		var finalClipWarning: [String: String]?
		do {
			let finalizeStartedAt = Date()
			if let clip = try await finishCurrentClip() {
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
		let didPause = stateQueue.sync {
			if isStopping || isPaused {
				return false
			}

			isPaused = true
			return true
		}

		guard didPause else { return }
		emit(["event": "clip-finalizing"])
		do {
			let finalizeStartedAt = Date()
			if let clip = try await finishCurrentClip() {
				captureTelemetry.recordFinalizedClip(
					durationMs: clip.durationMs,
					finalizeMs: Date().timeIntervalSince(finalizeStartedAt) * 1_000
				)
				finalizedClips.append(clip)
				emit(["event": "clip-finalized", "clip": clip.payload])
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

		do {
			let nextClipIndex = currentClipIndex + 1
			try sampleQueue.sync {
				do {
					try setupWriter(for: nextClipIndex)
				} catch {
					discardCurrentWriterOnSampleQueue()
					throw error
				}
			}
			currentClipIndex = nextClipIndex
			stateQueue.sync { isPaused = false }
			emit([
				"event": "recording-resumed",
				"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
				"clipIndex": currentClipIndex,
			])
		} catch {
			emitError(code: "clip-start-failed", message: "\(error)")
		}
	}

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		unexpectedStopHandler(self, error)
	}

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard CMSampleBufferDataIsReady(sampleBuffer) else {
			return
		}
		if stateQueue.sync(execute: { isPaused }) {
			return
		}

		if type == .audio {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: false)
			audioMixer?.ingest(sampleBuffer, from: .system)
			return
		}

		if type.rawValue == screenCaptureKitMicrophoneOutputTypeRawValue {
			captureTelemetry.recordAudioSample(sampleBuffer, microphone: true)
			audioMixer?.ingest(sampleBuffer, from: .microphone)
			return
		}

		guard type == .screen else {
			return
		}
		guard captureTelemetry.recordScreenSample(sampleBuffer) else {
			return
		}
		guard let videoInput, let writer else {
			return
		}
		let presentationTime = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
		if !didStartWriting {
			writer.startWriting()
			writer.startSession(atSourceTime: presentationTime)
			didStartWriting = true
			clipStartTime = presentationTime
			audioMixer?.beginTimeline(at: presentationTime)
		}

		if videoInput.isReadyForMoreMediaData {
			let appended = videoInput.append(sampleBuffer)
			if appended {
				captureTelemetry.recordVideoAppend(at: presentationTime)
				clipLastTime = presentationTime
				let duration = CMSampleBufferGetDuration(sampleBuffer)
				clipLastFrameDuration = duration.isValid && duration > .zero
					? duration
					: CMTime(value: 1, timescale: CMTimeScale(max(1, request.video.fps)))
			}
			if appended, !didEmitRecordingStarted {
				didEmitRecordingStarted = true
				emit([
					"event": "recording-started",
					"timestampMs": Int(Date().timeIntervalSince1970 * 1000),
					"width": outputWidth,
					"height": outputHeight,
					"captureBounds": captureBoundsPayload(),
				])
			} else if !appended {
				captureTelemetry.recordVideoAppendFailure()
				reportWriterFailure("video append")
			}
		} else {
			captureTelemetry.recordVideoBackpressure()
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
	private func reportWriterFailure(_ stage: String) {
		guard !didReportWriterFailure, let writer else {
			return
		}
		didReportWriterFailure = true
		stateQueue.sync {
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
				AVVideoAverageBitRateKey: request.video.bitrate ?? 18_000_000,
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
		audioMixer = nil

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
			audioMixer = AudioTrackMixer(
				mixedInput: mixedInput,
				systemInput: systemInput,
				microphoneInput: microphoneInput,
				includesSystemAudio: request.audio.system.enabled,
				includesMicrophone: nativeMicrophoneEnabled,
				microphoneGain: request.audio.microphone.gain
			)
		}
		captureTelemetry.beginClip()
	}

	private func detachCurrentWriter() -> DetachedWriter? {
		sampleQueue.sync {
			guard let writer, let currentClipPath else { return nil }
			if let audioTelemetry = audioMixer?.finish() {
				captureTelemetry.recordAudioWriter(
					maxQueueBytes: audioTelemetry.maxPendingBytes,
					maxQueueDepth: audioTelemetry.maxPendingChunks,
					blockedMs: audioTelemetry.blockedMs
				)
			}
			videoInput?.markAsFinished()
			audioInputs.forEach { $0.markAsFinished() }

			let detached = DetachedWriter(
				writer: writer,
				path: currentClipPath,
				index: currentClipIndex,
				started: didStartWriting,
				startTime: clipStartTime,
				lastTime: clipLastTime,
				lastFrameDuration: clipLastFrameDuration
			)
			self.writer = nil
			self.videoInput = nil
			self.audioInputs = []
			self.audioMixer = nil
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
		writer?.cancelWriting()
		if let currentClipPath {
			try? FileManager.default.removeItem(atPath: currentClipPath)
		}
		writer = nil
		videoInput = nil
		audioInputs = []
		audioMixer = nil
		currentClipPath = nil
		didStartWriting = false
		clipStartTime = nil
		clipLastTime = nil
		clipLastFrameDuration = .zero
	}

	private func finishCurrentClip() async throws -> FinalizedClip? {
		guard let detached = detachCurrentWriter() else { return nil }
		guard detached.started else {
			detached.writer.cancelWriting()
			try? FileManager.default.removeItem(atPath: detached.path)
			return nil
		}

		await withCheckedContinuation { continuation in
			detached.writer.finishWriting {
				continuation.resume()
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
		return FinalizedClip(index: detached.index, path: detached.path, durationMs: durationMs)
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
