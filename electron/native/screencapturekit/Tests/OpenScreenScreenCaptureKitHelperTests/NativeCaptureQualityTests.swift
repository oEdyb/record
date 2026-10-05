import AVFoundation
import CoreMedia
import CoreVideo
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class NativeCaptureQualityTests: XCTestCase {
	func testFailedCameraReconfigurationRestoresEverySourceEvenIfAnotherRollbackFails() async {
		var restored: [String] = []
		let failures = await RecordingSetupRollback.run([
			("configuration", { restored.append("configuration"); throw HelperError.writerSetupFailed("failed") }),
			("filter", { restored.append("filter") }),
			("camera", { restored.append("camera") }),
		])
		XCTAssertEqual(restored, ["configuration", "filter", "camera"])
		XCTAssertEqual(failures.count, 1)
		XCTAssertTrue(failures[0].hasPrefix("configuration:"))
	}

	func testProfilesPreserveStandardUIAndLegacyRequestBitrates() {
		XCTAssertEqual(RecordingQualityPolicy.bitrate(quality: "standard", legacyBitrate: 1), 68_000_000)
		XCTAssertEqual(RecordingQualityPolicy.bitrate(quality: "high", legacyBitrate: 1), 136_000_000)
		XCTAssertEqual(RecordingQualityPolicy.bitrate(quality: nil, legacyBitrate: nil), 18_000_000)
		XCTAssertEqual(RecordingQualityPolicy.bitrate(quality: nil, legacyBitrate: 45_000_000), 45_000_000)
		XCTAssertEqual(RecordingQualityPolicy.cameraBitrate(quality: "standard", width: 1920, height: 1080, fps: 30), 18_000_000)
		XCTAssertEqual(RecordingQualityPolicy.cameraBitrate(quality: "high", width: 3840, height: 2160, fps: 30), 90_000_000)
	}

	func testCadenceUsesExactGridDespiteTimerJitterAndReanchorsEachClip() throws {
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100))
		let times = try grid.dueTimes(at: time(100.052))
		XCTAssertEqual(times, (1...3).map { time(100) + CMTime(value: Int64($0), timescale: 60) })
		for _ in times { grid.didAppend() }
		XCTAssertTrue(try grid.dueTimes(at: time(100.052)).isEmpty)
		grid.reset(); grid.begin(at: time(200))
		XCTAssertEqual(try grid.dueTimes(at: time(200.02)), [time(200) + CMTime(value: 1, timescale: 60)])
	}

	func testBackpressureRetriesSameGridAndPersistentLagFailsLoudly() throws {
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100))
		XCTAssertEqual(try grid.dueTimes(at: time(100.02)), try grid.dueTimes(at: time(100.02)))
		XCTAssertThrowsError(try grid.dueTimes(at: time(100.2)))
	}

	func testBriefEncoderBacklogSkipsToTheNewestFrameInsteadOfFailing() throws {
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100))
		for _ in 1...60 { grid.didAppend() }
		let now = time(101.31)
		XCTAssertThrowsError(try grid.dueTimes(at: now))
		XCTAssertFalse(RecordingCadence.writerStalled(lastAppended: time(101), at: now))
		XCTAssertEqual(grid.skipBacklog(at: now), 78 - 61)
		XCTAssertEqual(try grid.dueTimes(at: now), [time(100) + CMTime(value: 78, timescale: 60)])
		XCTAssertEqual(grid.skipBacklog(at: now), 0)
	}

	func testEncoderThatTakesNothingForTwoSecondsStillFailsLoudly() {
		XCTAssertTrue(RecordingCadence.writerStalled(lastAppended: time(100), at: time(102)))
		XCTAssertTrue(RecordingCadence.writerStalled(lastAppended: nil, at: time(102)))
		XCTAssertFalse(RecordingCadence.writerStalled(lastAppended: time(100.5), at: time(102)))
	}

	func testClosingGridFillsOnlyFrozenBoundaryWithOnePartialInterval() throws {
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100))
		for _ in 1...479 { grid.didAppend() }
		let boundary = time(108.653333)
		let frames = try grid.closingFrames(endingAt: boundary)
		XCTAssertEqual(frames.count, 40)
		XCTAssertEqual(frames.first?.time, time(100) + CMTime(value: 480, timescale: 60))
		for (previous, next) in zip(frames, frames.dropFirst()) { XCTAssertEqual(next.time - previous.time, CMTime(value: 1, timescale: 60)) }
		let last = try XCTUnwrap(frames.last)
		XCTAssertEqual(last.time + last.duration, boundary)
		XCTAssertLessThan(last.duration, CMTime(value: 1, timescale: 60))
		XCTAssertThrowsError(try grid.closingFrames(endingAt: time(110)), "Finalization must not generate an unbounded lost interval")
		XCTAssertThrowsError(try grid.dueTimes(at: boundary), "Closing catch-up must not loosen the live lag policy")
	}

	func testExactClosingBoundaryHasNoZeroLengthOrDuplicateFrame() throws {
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100))
		let frames = try grid.closingFrames(endingAt: time(100) + CMTime(value: 3, timescale: 60))
		XCTAssertEqual(frames.count, 2)
		XCTAssertEqual(frames.last?.time, time(100) + CMTime(value: 2, timescale: 60))
		XCTAssertTrue(frames.allSatisfy { $0.duration == CMTime(value: 1, timescale: 60) })
	}

	func testTerminalFailureFreezesFirstHostBoundaryBeforeAutomaticStop() {
		var boundary = RecordingTerminationBoundary()
		XCTAssertEqual(boundary.endingAt(time(100)), time(100))
		boundary.recordFailure(at: .invalid)
		XCTAssertNil(boundary.failureTime)
		boundary.recordFailure(at: time(101.2))
		boundary.recordFailure(at: time(101.8))
		XCTAssertEqual(boundary.endingAt(time(104)), time(101.2), "Recovery and teardown latency must not extend failed content")
		XCTAssertEqual(boundary.endingAt(time(101.1)), time(101.1), "An earlier requested Stop remains earlier")
	}

	func testCameraUsesActualSupportedRangesAndRejectsAmbiguousOpaqueIDs() {
		// MacBook Air camera: the square mode has the most pixels, but Automatic takes 16:9.
		let macBook: [(width: Int, height: Int, fps: Double)] = [(640, 480, 30), (1280, 720, 30), (1760, 1328, 30), (1328, 1760, 30), (1552, 1552, 30), (1920, 1080, 30), (1080, 1920, 30)]
		let macBookPick = macBook.min(by: NativeCameraCapture.automaticFormatPrecedes)
		XCTAssertEqual(macBookPick?.width, 1920); XCTAssertEqual(macBookPick?.height, 1080)
		let phone: [(width: Int, height: Int, fps: Double)] = [(1280, 720, 60), (1920, 1080, 30), (1920, 1080, 60), (1920, 1440, 60)]
		let phonePick = phone.min(by: NativeCameraCapture.automaticFormatPrecedes)
		XCTAssertEqual(phonePick?.width, 1920); XCTAssertEqual(phonePick?.height, 1080); XCTAssertEqual(phonePick?.fps, 60)
		// A camera with no 16:9 mode still gets its largest format.
		let square: [(width: Int, height: Int, fps: Double)] = [(640, 480, 30), (1552, 1552, 30)]
		XCTAssertEqual(square.min(by: NativeCameraCapture.automaticFormatPrecedes)?.width, 1552)
		XCTAssertEqual(NativeCameraCapture.supportedFps(ranges: [(24, 30), (120, 240)], target: 60), 30)
		XCTAssertEqual(NativeCameraCapture.supportedFps(ranges: [(1, 60)], target: 60), 60)
		XCTAssertEqual(NativeCameraCapture.supportedFps(ranges: [(59.94, 59.94)], target: 60), 59.94)
		XCTAssertEqual(NativeCameraCapture.resolveDeviceIndex(ids: ["native-id"], names: ["Camera"], id: "opaque-browser-id", name: "Camera"), 0)
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a", "b"], names: ["Camera", "Camera"], id: "opaque", name: "Camera"))
		XCTAssertEqual(NativeCameraCapture.resolveDeviceIndex(ids: ["a", "b"], names: ["Camera", "Camera"], id: "b", name: "Camera"), 1)
	}

	func testCameraMapsChromiumHardwareSuffixWithoutGuessingAmbiguousDevices() {
		XCTAssertEqual(NativeCameraCapture.resolveDeviceIndex(ids: ["native-built-in"], names: ["MacBook Air Camera"], id: "opaque", name: "MacBook Air Camera (0000:0001)"), 0)
		XCTAssertEqual(NativeCameraCapture.resolveDeviceIndex(ids: ["native-usb"], names: ["Camera (Built-in)"], id: "opaque", name: "Camera (Built-in) (ABcd:1234)"), 0)
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a", "b"], names: ["Camera", "Camera"], id: "opaque", name: "Camera (0000:0001)"))
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a", "b"], names: ["Camera", "Camera (0000:0001)"], id: "opaque", name: "Camera (0000:0001)"))
		XCTAssertEqual(NativeCameraCapture.resolveDeviceIndex(ids: ["a", "b"], names: ["Camera", "Camera"], id: "b", name: "Camera (0000:0001)"), 1)
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a"], names: ["Camera"], id: "opaque", name: "Camera (Built-in)"))
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a"], names: ["Camera"], id: "opaque", name: "Camera (0000:001)"))
		XCTAssertNil(NativeCameraCapture.resolveDeviceIndex(ids: ["a"], names: ["Camera"], id: "opaque", name: "Missing Camera (0000:0001)"))
	}

	func testCameraFrameDurationStaysInsideExactNativeRationalBoundaries() throws {
		let nativeThirty = CMTime(value: 1_000_000, timescale: 30_000_000)
		let nativeFifteen = CMTime(value: 1_000_000, timescale: 15_000_000)
		let roundedThirty = CMTime(seconds: 1 / 30.0, preferredTimescale: 1_000_000_000)
		XCTAssertLessThan(roundedThirty, nativeThirty, "Regression fixture must reproduce the too-fast rounding")
		XCTAssertEqual(try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(nativeThirty, nativeFifteen)], fps: 30)), nativeThirty)
		XCTAssertEqual(try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(nativeThirty, nativeFifteen)], fps: 60)), nativeThirty)
		XCTAssertEqual(try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(nativeThirty, nativeFifteen)], fps: 10)), nativeFifteen)
		let ntsc = CMTime(value: 1001, timescale: 30_000)
		XCTAssertEqual(try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(ntsc, ntsc)], fps: 29.97)), ntsc)
		let sixty = CMTime(value: 1, timescale: 60)
		XCTAssertEqual(try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(ntsc, ntsc), (sixty, sixty)], fps: 60)), sixty)
		let interior = try XCTUnwrap(NativeCameraCapture.frameDuration(ranges: [(nativeThirty, nativeFifteen)], fps: 24))
		XCTAssertGreaterThanOrEqual(interior, nativeThirty)
		XCTAssertLessThanOrEqual(interior, nativeFifteen)
		XCTAssertNil(NativeCameraCapture.frameDuration(ranges: [(.invalid, .invalid)], fps: 30))
		XCTAssertNil(NativeCameraCapture.frameDuration(ranges: [(nativeThirty, nativeFifteen)], fps: .infinity))
	}

	func testCameraRejectsPresetOverrideEvenWhenOutputWasScaledToExpectedDimensions() {
		XCTAssertTrue(NativeCameraCapture.matchesNativeGeometry(expected: (1552, 1552), active: (1552, 1552), delivered: (1552, 1552)))
		XCTAssertFalse(NativeCameraCapture.matchesNativeGeometry(expected: (1552, 1552), active: (1920, 1080), delivered: (1920, 1080)))
		XCTAssertFalse(NativeCameraCapture.matchesNativeGeometry(expected: (1552, 1552), active: (1920, 1080), delivered: (1552, 1552)), "Output resizing must not masquerade as a native source format")
		XCTAssertFalse(NativeCameraCapture.matchesNativeGeometry(expected: (1920, 1080), active: (1920, 1080), delivered: (1080, 1920)))
	}

	func testHighBitrateNativeGeometryEncodesOriginalMOVWithoutResizing() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let output = directory.appendingPathComponent("original.mov")
		let track = try OriginalTrackWriter(path: output.path, mediaType: .video,
			settings: OriginalTrackWriter.videoSettings(width: 2564, height: 1692, fps: 60, bitrate: 136_000_000))
		let queue = DispatchQueue(label: "test.original.mov")
		try track.prepare()
		XCTAssertFalse(track.started)
		XCTAssertNil(track.takeStartedMetadata())
		track.begin(at: time(100))
		for index in 0..<12 {
			let sample = try screenSample(at: time(100) + CMTime(value: Int64(index), timescale: 60))
			_ = try queue.sync { try track.append(sample) }
			try await Task.sleep(nanoseconds: 5_000_000)
		}
		let saved = try await track.finish(on: queue)
		XCTAssertTrue(saved)
		XCTAssertEqual(track.offsetMs, 0)
		let video = try await AVURLAsset(url: output).loadTracks(withMediaType: .video)
		let dimensions = try await XCTUnwrap(video.first).load(.naturalSize)
		XCTAssertEqual(dimensions, CGSize(width: 2564, height: 1692))
		let duration = try await AVURLAsset(url: output).load(.duration)
		XCTAssertEqual(duration.seconds, 0.2, accuracy: 0.025)
	}

	func testOriginalWriterNeverAcknowledgesAnAppendToCancelledWriter() throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let track = try OriginalTrackWriter(path: directory.appendingPathComponent("failed.mov").path, mediaType: .video,
			settings: OriginalTrackWriter.videoSettings(width: 2564, height: 1692, fps: 60, bitrate: 68_000_000))
		track.begin(at: time(100)); track.writer.cancelWriting()
		XCTAssertNil(track.takeStartedMetadata())
		XCTAssertThrowsError(try track.append(screenSample(at: time(100))))
		XCTAssertNil(track.takeStartedMetadata(), "Failed append must not announce a recoverable source")
	}

	func testEndingHighSessionBeforeCompatibilityMixerTailReproduces11862() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let (writer, video, audio, mixer) = try highMixedWriter(at: directory.appendingPathComponent("old-high-stop.mp4"))
		let queue = DispatchQueue(label: "test.old-high-stop")
		let epoch = time(100), boundary = time(100.153333)
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: epoch)
		try await ClosingFrameAppender(sample: screenSample(at: epoch, width: 256, height: 144), input: video, writer: writer, queue: queue).append()
		let system = try audioSample(at: time(100.023)), microphone = try audioSample(at: time(100.025))
		queue.sync {
			mixer.beginTimeline(at: epoch)
			mixer.ingest(system, from: .system); mixer.ingest(microphone, from: .microphone)
			writer.endSession(atSourceTime: boundary) // The real pre-fix ordering.
			_ = mixer.finish() // The 2 ms microphone tail needs one final mix chunk.
			video.markAsFinished(); audio.forEach { $0.markAsFinished() }
		}
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .failed)
		XCTAssertEqual((writer.error as NSError?)?.code, -11862)
	}

	func testHighStopAndResumedPauseFlushAllSourcesBeforeFrozenSessionEnd() async throws {
		for epoch in [100.0, 200.0] { try await verifyHighMixedStop(epoch: epoch) }
	}

	private func verifyHighMixedStop(epoch seconds: Double) async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("clean-high-stop.mp4")
		let (writer, video, audio, mixer) = try highMixedWriter(at: path)
		let queue = DispatchQueue(label: "test.clean-high-stop")
		let compatibility = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.clean-high-stop.audio"))
		let epoch = time(seconds), boundary = time(seconds + 0.153333)
		let image = try screenSample(at: epoch, width: 256, height: 144)
		let cameraImage = try screenSample(at: epoch + time(0.023), width: 1552, height: 1552)
		let system = try audioSample(at: epoch + time(0.023)), microphone = try audioSample(at: epoch + time(0.025))
		let originals = [
			try OriginalTrackWriter(path: directory.appendingPathComponent("webcam.mov").path, mediaType: .video,
				settings: OriginalTrackWriter.videoSettings(width: 1552, height: 1552, fps: 30, bitrate: 36_000_000)),
			try OriginalTrackWriter(path: directory.appendingPathComponent("system.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings),
			try OriginalTrackWriter(path: directory.appendingPathComponent("microphone.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings),
		]
		let owners = originals.enumerated().map { index, original in
			OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.high-stop.original." + String(index)),
				admission: index == 0 ? OriginalSourceAdmission(maximumSamples: 38, maximumBytes: OriginalSourceAdmission.maximumCameraBytes) : OriginalSourceAdmission())
		}
		for owner in owners { try owner.prepare(); owner.begin(at: epoch) }
		let callbacks = expectation(description: "All original first-sample metadata survives the Stop drain")
		callbacks.expectedFulfillmentCount = 3
		for (owner, sample) in zip(owners, [cameraImage, system, microphone]) {
			try owner.append(sample) { result, _ in
				if case .success(let completed) = result { XCTAssertNotNil(completed.metadata) } else { XCTFail("Original failed before Stop: \(result)") }
				callbacks.fulfill()
			}
		}
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: epoch)
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: epoch)
		let frames = try [image] + grid.closingFrames(endingAt: boundary).map { try RecordingFrameCache.retime(image, at: $0.time, fps: 60, duration: $0.duration) }
		try await ClosingFrameAppender(samples: frames, input: video, writer: writer, queue: queue).append()
		compatibility.begin(at: epoch)
		try compatibility.append(system, from: .system) { result, _ in if case .failure(let error) = result { XCTFail("System mix failed: \(error)") } }
		try compatibility.append(microphone, from: .microphone) { result, _ in if case .failure(let error) = result { XCTFail("Microphone mix failed: \(error)") } }
		await compatibility.drain()
		for owner in owners { await owner.drain() }
		await fulfillment(of: [callbacks], timeout: 1)
		var fatalBoundary = RecordingTerminationBoundary()
		fatalBoundary.recordFailure(at: boundary)
		let frozenEnd = fatalBoundary.endingAt(boundary + time(2))
		let finished = await compatibility.finish()
		XCTAssertNil(finished.failure)
		queue.sync { RecordingWriterFinalization.finishInputs(writer: writer, videoInput: video, audioInputs: audio, endingAt: frozenEnd) }
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed, "Clean Stop cannot depend on recovery: \(String(describing: writer.error))")
		XCTAssertNil(writer.error)
		for (owner, offset) in zip(owners, [23.0, 23.0, 25.0]) {
			let saved = try await owner.finish(); XCTAssertTrue(saved)
			XCTAssertEqual(owner.original.offsetMs, offset, accuracy: 0.01)
			let originalAsset = AVURLAsset(url: URL(fileURLWithPath: owner.original.path))
			let sourceDuration = try await originalAsset.load(.duration)
			XCTAssertGreaterThan(sourceDuration.seconds, 0)
		}
		let asset = AVURLAsset(url: path)
		let duration = try await asset.load(.duration)
		XCTAssertEqual(duration.seconds, (boundary - epoch).seconds, accuracy: 0.001)
		let audioTracks = try await asset.loadTracks(withMediaType: .audio)
		XCTAssertEqual(audioTracks.count, 3, "Mixed preview and both compatibility source tracks must be encoded")
		for track in audioTracks {
			let reader = try AVAssetReader(asset: asset)
			let output = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
			reader.add(output); XCTAssertTrue(reader.startReading())
			var decoded = 0
			while let sample = output.copyNextSampleBuffer() { decoded += CMSampleBufferGetNumSamples(sample) }
			XCTAssertEqual(reader.status, .completed)
			XCTAssertGreaterThanOrEqual(decoded, 960, "The mixed compatibility tail must be present")
		}
		let tracks = try await asset.loadTracks(withMediaType: .video)
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
		reader.add(output); XCTAssertTrue(reader.startReading())
		var times: [CMTime] = []
		while let sample = output.copyNextSampleBuffer() { if CMSampleBufferGetImageBuffer(sample) != nil { times.append(CMSampleBufferGetPresentationTimeStamp(sample)) } }
		XCTAssertEqual(reader.status, .completed); XCTAssertEqual(times.count, 10)
		for (previous, next) in zip(times, times.dropFirst()) { XCTAssertEqual((next - previous).seconds, 1 / 60, accuracy: 0.000001) }
	}

	private func highMixedWriter(at path: URL, append: @escaping AudioTrackMixer.Append = { $0.append($1) }) throws -> (AVAssetWriter, AVAssetWriterInput, [AVAssetWriterInput], AudioTrackMixer) {
		let writer = try AVAssetWriter(outputURL: path, fileType: .mp4)
		let video = AVAssetWriterInput(mediaType: .video, outputSettings: OriginalTrackWriter.videoSettings(width: 256, height: 144, fps: 60, bitrate: 1_000_000))
		video.expectsMediaDataInRealTime = true
		XCTAssertTrue(writer.canAdd(video)); writer.add(video)
		let audio = (0..<3).map { _ in AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings) }
		for input in audio { input.expectsMediaDataInRealTime = true; XCTAssertTrue(writer.canAdd(input)); writer.add(input) }
		let mixer = AudioTrackMixer(mixedInput: audio[0], systemInput: audio[1], microphoneInput: audio[2], includesSystemAudio: true, includesMicrophone: true, microphoneGain: 1.4, writer: writer, append: append)
		return (writer, video, audio, mixer)
	}

	func testOriginalAudioStartsAtZeroAndKeepsActualHostOffsetSeparately() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let output = directory.appendingPathComponent("microphone.mov")
		let track = try OriginalTrackWriter(path: output.path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let queue = DispatchQueue(label: "test.original.audio")
		try track.prepare()
		try track.prepare() // A repeated preparation must not start another writing session.
		XCTAssertTrue(track.prepared)
		XCTAssertEqual(track.writer.status, .writing)
		XCTAssertFalse(track.started, "Preparing encoders is not a captured source or a readiness acknowledgment")
		XCTAssertEqual(track.appendedSamples, 0)
		XCTAssertNil(track.takeStartedMetadata())
		track.begin(at: time(200))
		XCTAssertNil(track.takeStartedMetadata(), "The screen epoch alone cannot acknowledge missing audio")
		for index in 0..<10 { _ = try queue.sync { try track.append(audioSample(at: time(200.023 + Double(index) * 0.01))) } }
		let saved = try await track.finish(on: queue)
		XCTAssertTrue(saved)
		XCTAssertEqual(track.offsetMs, 23, accuracy: 0.01)
		let metadata = try XCTUnwrap(track.takeStartedMetadata())
		XCTAssertEqual(metadata.path, output.path)
		XCTAssertEqual(metadata.offsetMs, 23, accuracy: 0.01)
		XCTAssertNil(track.takeStartedMetadata(), "Replayed callbacks must not publish a second source start")
		let asset = AVURLAsset(url: output)
		let audio = try await asset.loadTracks(withMediaType: .audio)
		let range = try await XCTUnwrap(audio.first).load(.timeRange)
		XCTAssertEqual(range.start.seconds, 0, accuracy: 0.001)
		XCTAssertEqual(range.duration.seconds, 0.1, accuracy: 0.025)
	}

	func testColdCompatibilityAACDoesNotBlockEncodedVideoGridAndPreservesThreeTracks() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("cold-compatibility.mp4")
		let entered = DispatchSemaphore(value: 0)
		let release = DispatchSemaphore(value: 0), returned = DispatchSemaphore(value: 0)
		var first = true // Accessed exclusively on the compatibility owner.
		var initialAudioPTS: [CMTime] = [] // Same owner; inspected only after its drain.
		let (writer, video, audio, mixer) = try highMixedWriter(at: path, append: { input, sample in
			if first { first = false; entered.signal(); release.wait(); returned.signal() }
			if initialAudioPTS.count < 3 { initialAudioPTS.append(CMSampleBufferGetPresentationTimeStamp(sample)) }
			return input.append(sample)
		})
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.cold-compatibility"))
		let videoQueue = DispatchQueue(label: "test.actual-video-cadence")
		let epoch = time(100), boundary = time(100.253333)
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: epoch)
		let image = try screenSample(at: epoch, width: 256, height: 144)
		try await ClosingFrameAppender(sample: image, input: video, writer: writer, queue: videoQueue).append()
		owner.begin(at: epoch)
		let callbacks = expectation(description: "Every admitted compatibility sample drains before Stop")
		callbacks.expectedFulfillmentCount = 24
		for index in 0..<12 {
			for (source, offset, amplitude) in [(AudioTrackMixer.Source.system, 0.023, Int16(2000)), (.microphone, 0.025, Int16(1000))] {
				try owner.append(audioSample(at: epoch + time(offset + Double(index) * 0.01), amplitude: amplitude), from: source) { result, _ in
					if case .failure(let error) = result { XCTFail("Compatibility audio failed: \(error)") }
					callbacks.fulfill()
				}
			}
		}
		XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
		XCTAssertGreaterThan(owner.retainedCount, 0, "In-flight cold AAC buffers remain producer-admitted")
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: epoch)
		let frames = try grid.closingFrames(endingAt: boundary).map { try RecordingFrameCache.retime(image, at: $0.time, fps: 60, duration: $0.duration) }
		try await ClosingFrameAppender(samples: frames, input: video, writer: writer, queue: videoQueue).append()
		XCTAssertEqual(returned.wait(timeout: .now()), .timedOut, "Actual video appends complete while cold compatibility AAC is still in flight")
		try await Task.sleep(nanoseconds: 185_000_000)
		release.signal()
		await owner.drain()
		await fulfillment(of: [callbacks], timeout: 1)
		let finished = await owner.finish()
		XCTAssertNil(finished.failure)
		XCTAssertEqual(owner.retainedCount, 0)
		XCTAssertEqual(initialAudioPTS, [CMTime](repeating: epoch + time(0.023), count: 3), "All three real AAC inputs retain source PTS despite the cold append delay")
		videoQueue.sync { RecordingWriterFinalization.finishInputs(writer: writer, videoInput: video, audioInputs: audio, endingAt: boundary) }
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed, "Cold AAC must not require screen recovery: \(String(describing: writer.error))")
		let asset = AVURLAsset(url: path)
		let duration = try await asset.load(.duration)
		XCTAssertEqual(duration.seconds, (boundary - epoch).seconds, accuracy: 0.001)
		let videoTracks = try await asset.loadTracks(withMediaType: .video)
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(videoTracks.first), outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
		reader.add(output); XCTAssertTrue(reader.startReading())
		var times: [CMTime] = []
		while let sample = output.copyNextSampleBuffer() { times.append(CMSampleBufferGetPresentationTimeStamp(sample)) }
		XCTAssertEqual(reader.status, .completed); XCTAssertEqual(times.count, 16)
		for (previous, next) in zip(times, times.dropFirst()) { XCTAssertEqual((next - previous).seconds, 1 / 60, accuracy: 0.000001) }
		let tracks = try await asset.loadTracks(withMediaType: .audio)
		XCTAssertEqual(tracks.count, 3)
		for (index, track) in tracks.enumerated() {
			let audioReader = try AVAssetReader(asset: asset)
			let audioOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM,
				AVLinearPCMBitDepthKey: 16, AVLinearPCMIsFloatKey: false, AVLinearPCMIsNonInterleaved: false])
			audioReader.add(audioOutput); XCTAssertTrue(audioReader.startReading())
			var firstTime: CMTime?, maximum: Int = 0, frames = 0
			while let sample = audioOutput.copyNextSampleBuffer() {
				if firstTime == nil { firstTime = CMSampleBufferGetPresentationTimeStamp(sample) }
				frames += CMSampleBufferGetNumSamples(sample)
				if let data = CMSampleBufferGetDataBuffer(sample) {
					var bytes = [Int16](repeating: 0, count: CMBlockBufferGetDataLength(data) / 2)
					bytes.withUnsafeMutableBytes { raw in _ = CMBlockBufferCopyDataBytes(data, atOffset: 0, dataLength: raw.count, destination: raw.baseAddress!) }
					maximum = max(maximum, bytes.map { abs(Int($0)) }.max() ?? 0)
				}
			}
			XCTAssertEqual(audioReader.status, .completed)
			XCTAssertGreaterThan(frames, 480)
			XCTAssertEqual(try XCTUnwrap(firstTime).seconds, 0, accuracy: 0.001, "AVAssetReader includes the AAC timeline's leading silence/priming")
			XCTAssertGreaterThan(maximum, index == 2 ? 1200 : 1800, "Actual source and gain-applied microphone signal must survive AAC")
		}
	}

	func testCompatibilityAdmissionIncludesInFlightAndRejectsCountAndByteOverflow() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let (writer, _, _, mixer) = try highMixedWriter(at: directory.appendingPathComponent("bounded.mp4"))
		let gate = DispatchSemaphore(value: 0), entered = DispatchSemaphore(value: 0)
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.bounded-compatibility"),
			admission: OriginalSourceAdmission(maximumSamples: 2, maximumBytes: 4000))
		owner.queue.async { entered.signal(); gate.wait() }
		XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
		let sample = try audioSample(at: time(100.023))
		try owner.append(sample, from: .system) { _, _ in }
		try owner.append(sample, from: .microphone) { _, _ in }
		XCTAssertEqual(owner.retainedCount, 2); XCTAssertEqual(owner.retainedBytes, 3840)
		XCTAssertThrowsError(try owner.append(sample, from: .system) { _, _ in })
		XCTAssertNotNil(owner.failureTime)
		gate.signal(); await owner.drain()
		XCTAssertEqual(owner.retainedCount, 0)
		XCTAssertThrowsError(try owner.append(sample, from: .system) { _, _ in })
		let byteOwner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.byte-compatibility"),
			admission: OriginalSourceAdmission(maximumSamples: 128, maximumBytes: 1000))
		XCTAssertThrowsError(try byteOwner.append(sample, from: .system) { _, _ in })
		XCTAssertEqual(byteOwner.retainedBytes, 0, "Reject raw storage before PCM conversion or retention")
		XCTAssertEqual(CompatibilityAudioWriter.maximumSamples, 128)
		XCTAssertEqual(CompatibilityAudioWriter.maximumBytes, 8 * 1024 * 1024)
		owner.cancel(); byteOwner.cancel(); writer.cancelWriting()
	}

	func testEncodedStartupPreservesFirstPixelsAndEpochAcrossColdAACAndVideoBackpressure() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("startup-grid.mp4")
		let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
		defer { release.signal() }
		var firstAAC = true
		let (writer, video, audio, mixer) = try highMixedWriter(at: path, append: { input, sample in
			if firstAAC { firstAAC = false; entered.signal(); release.wait() }
			return input.append(sample)
		})
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.startup-cold-aac"))
		let videoQueue = DispatchQueue(label: "test.startup-video")
		let epoch = time(100), readyTime = time(100.2), end = time(100.203333)
		let first = try screenSample(at: epoch, width: 256, height: 144)
		let future = try screenSample(at: time(100.3), width: 256, height: 144)
		for (sample, value) in [(first, UInt8(16)), (future, UInt8(240))] {
			let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample))
			CVPixelBufferLockBaseAddress(pixels, [])
			try XCTUnwrap(CVPixelBufferGetBaseAddress(pixels)).initializeMemory(as: UInt8.self, repeating: value, count: CVPixelBufferGetBytesPerRow(pixels) * CVPixelBufferGetHeight(pixels))
			CVPixelBufferUnlockBaseAddress(pixels, [])
		}
		var cache = RecordingFrameCache(); cache.observe(first)
		var startup = RecordingStartup(audioTracks: ["mixed", "system", "microphone"])
		startup.begin(at: epoch)
		var grid = RecordingCadence(fps: 60); grid.begin(at: epoch, firstFramePending: true)
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: epoch)
		owner.begin(at: epoch)
		var readyAAC = Set<String>() // Written on owner, inspected after its drain.
		for index in 0..<8 {
			for source in [AudioTrackMixer.Source.system, .microphone] {
				try owner.append(audioSample(at: epoch + time(0.023 + Double(index) * 0.01), amplitude: 1000), from: source) { result, _ in
					if case .success(let completed) = result { readyAAC = completed.readyTracks }
					else { XCTFail("Startup AAC append failed: \(result)") }
				}
			}
		}
		XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
		XCTAssertFalse(startup.acknowledge(videoAppended: false, gridCaughtUp: false))
		// Model the observed temporarily-not-ready video input. New captured pixels
		// arrive, but the first sample remains retained until an actual append.
		cache.observe(future)
		try await Task.sleep(nanoseconds: 185_000_000)
		release.signal(); await owner.drain()
		XCTAssertEqual(readyAAC, ["mixed", "system", "microphone"])
		let due = try grid.dueTimes(at: readyTime, maximumCatchUpFrames: startup.backlogLimit(fps: 60))
		XCTAssertEqual(due.count, 13)
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: due.isEmpty))
		for point in due {
			let frame = try XCTUnwrap(cache.scheduledFrame(at: point, fps: 60, firstFrame: first))
			XCTAssertEqual(frame.sourceTime, epoch)
			XCTAssertTrue(CMSampleBufferGetImageBuffer(frame.sample) === CMSampleBufferGetImageBuffer(first))
			let sample = try RecordingFrameCache.retime(frame.sample, at: point, fps: 60, duration: min(CMTime(value: 1, timescale: 60), end - point))
			try await ClosingFrameAppender(sample: sample, input: video, writer: writer, queue: videoQueue).append()
			cache.didAppend(sample, sourceTime: frame.sourceTime); grid.didAppend()
		}
		XCTAssertTrue(startup.acknowledge(videoAppended: true,
			gridCaughtUp: try grid.dueTimes(at: readyTime, maximumCatchUpFrames: startup.backlogLimit(fps: 60)).isEmpty))
		XCTAssertThrowsError(try grid.dueTimes(at: time(100.4), maximumCatchUpFrames: startup.backlogLimit(fps: 60)))
		XCTAssertEqual(startup.epoch, epoch)
		let finished = await owner.finish(); XCTAssertNil(finished.failure)
		videoQueue.sync { RecordingWriterFinalization.finishInputs(writer: writer, videoInput: video, audioInputs: audio, endingAt: end) }
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed, "Startup cannot depend on recovery: \(String(describing: writer.error))")
		let asset = AVURLAsset(url: path)
		let duration = try await asset.load(.duration)
		XCTAssertEqual(duration.seconds, (end - epoch).seconds, accuracy: 0.001)
		let tracks = try await asset.loadTracks(withMediaType: .video)
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
		reader.add(output); XCTAssertTrue(reader.startReading())
		var timestamps: [CMTime] = []
		while let sample = output.copyNextSampleBuffer() {
			timestamps.append(CMSampleBufferGetPresentationTimeStamp(sample))
			let pixels = try XCTUnwrap(CMSampleBufferGetImageBuffer(sample)); CVPixelBufferLockBaseAddress(pixels, .readOnly)
			let red = try XCTUnwrap(CVPixelBufferGetBaseAddress(pixels)).load(fromByteOffset: 2, as: UInt8.self)
			CVPixelBufferUnlockBaseAddress(pixels, .readOnly)
			XCTAssertLessThan(red, 40, "A later bright source image must not move backwards into the dark startup grid")
		}
		XCTAssertEqual(reader.status, .completed); XCTAssertEqual(timestamps.count, 13)
		XCTAssertEqual(timestamps.first, .zero)
		for (previous, next) in zip(timestamps, timestamps.dropFirst()) { XCTAssertEqual((next - previous).seconds, 1 / 60, accuracy: 0.000001) }
		let audioTracks = try await asset.loadTracks(withMediaType: .audio)
		XCTAssertEqual(audioTracks.count, 3)
		for track in audioTracks {
			let audioReader = try AVAssetReader(asset: asset)
			let audioOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [AVFormatIDKey: kAudioFormatLinearPCM])
			audioReader.add(audioOutput); XCTAssertTrue(audioReader.startReading())
			var samples = 0
			while let buffer = audioOutput.copyNextSampleBuffer() { samples += CMSampleBufferGetNumSamples(buffer) }
			XCTAssertEqual(audioReader.status, .completed); XCTAssertGreaterThan(samples, 480)
		}
	}

	func testCompatibilityRejectedAppendPreservesDetectedFailureThroughDelayedCallbackAndFinish() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let (writer, _, _, mixer) = try highMixedWriter(at: directory.appendingPathComponent("rejected.mp4"), append: { _, _ in false })
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: time(100))
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.rejected-compatibility"))
		owner.begin(at: time(100))
		let callbackQueue = DispatchQueue(label: "test.delayed-compatibility-failure")
		let gate = DispatchSemaphore(value: 0)
		callbackQueue.async { gate.wait() }
		let detected = expectation(description: "False append fails even while AVAssetWriter remains writing")
		let delivered = expectation(description: "Delayed callback retains earliest actual failure time")
		try owner.append(audioSample(at: time(100.023)), from: .system) { result, failureTime in
			if case .failure(let error) = result { XCTAssertTrue("\(error)".contains("rejected")); detected.fulfill() }
			else { XCTFail("False append was incorrectly acknowledged") }
			callbackQueue.async {
				var boundary = RecordingTerminationBoundary()
				let laterFailure = CMClockGetTime(CMClockGetHostTimeClock())
				boundary.recordFailure(at: laterFailure); boundary.recordFailure(at: failureTime)
				XCTAssertEqual(boundary.endingAt(laterFailure), failureTime)
				XCTAssertEqual(owner.failureTime, failureTime)
				delivered.fulfill()
			}
		}
		await fulfillment(of: [detected], timeout: 1)
		XCTAssertEqual(writer.status, .writing)
		await owner.drain()
		let finished = await owner.finish()
		XCTAssertEqual(finished.failure?.hostTime, owner.failureTime)
		XCTAssertNotNil(finished.failure, "Finalization cannot silently discard an append rejection")
		try await Task.sleep(nanoseconds: 50_000_000)
		gate.signal(); await fulfillment(of: [delivered], timeout: 1)
		XCTAssertThrowsError(try owner.append(audioSample(at: time(100.1)), from: .microphone) { _, _ in })
		owner.cancel(); writer.cancelWriting()
	}

	func testCompatibilityImmediatePauseDrainsAndRejectsDelayedReplacementCallbacks() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let (writer, video, audio, mixer) = try highMixedWriter(at: directory.appendingPathComponent("pause-compatibility.mp4"))
		let (replacement, _, _, replacementMixer) = try highMixedWriter(at: directory.appendingPathComponent("continue-compatibility.mp4"))
		let replacementOwner = CompatibilityAudioWriter(writer: replacement, mixer: replacementMixer, queue: DispatchQueue(label: "test.continue-compatibility"))
		XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: time(100))
		let videoQueue = DispatchQueue(label: "test.immediate-pause.video")
		try await ClosingFrameAppender(sample: screenSample(at: time(100), width: 256, height: 144), input: video, writer: writer, queue: videoQueue).append()
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.immediate-pause.audio"))
		owner.begin(at: time(100))
		let callbacks = DispatchQueue(label: "test.delayed-pause-callback"), gate = DispatchSemaphore(value: 0)
		callbacks.async { gate.wait() }
		let delivered = expectation(description: "Old callback cannot reach a continued clip")
		try owner.append(audioSample(at: time(100.023), amplitude: 1000), from: .system) { result, _ in
			callbacks.async {
				if case .failure(let error) = result { XCTFail("Immediate Pause lost admitted audio: \(error)") }
				XCTAssertFalse(owner.isCurrent(writer: replacementOwner.writer, clipIndex: 0, currentClipIndex: 1))
				XCTAssertFalse(owner.isCurrent(writer: owner.writer, clipIndex: 0, currentClipIndex: 1))
				XCTAssertTrue(owner.isCurrent(writer: owner.writer, clipIndex: 0, currentClipIndex: 0))
				delivered.fulfill()
			}
		}
		await owner.drain()
		let finished = await owner.finish()
		XCTAssertNil(finished.failure)
		videoQueue.sync { RecordingWriterFinalization.finishInputs(writer: writer, videoInput: video, audioInputs: audio, endingAt: time(100.05)) }
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed)
		XCTAssertThrowsError(try owner.append(audioSample(at: time(100.1)), from: .system) { _, _ in })
		gate.signal(); await fulfillment(of: [delivered], timeout: 1)
		owner.cancel(); replacement.cancelWriting()
	}

	func testColdAudioOwnerCannotBlockVideoGridOrChangeOriginalOffset() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("queued-audio.mov")
		let original = try OriginalTrackWriter(path: path.path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let owner = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.cold-aac-owner"))
		try owner.prepare(); owner.begin(at: time(100))
		let gate = DispatchSemaphore(value: 0)
		let entered = DispatchSemaphore(value: 0)
		owner.queue.async { entered.signal(); gate.wait() }
		XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
		let videoQueue = DispatchQueue(label: "test.independent-video-cadence")
		let videoDone = expectation(description: "Video grid keeps its owner while AAC is blocked")
		let metadataDone = expectation(description: "Actual audio append publishes its original offset")
		for index in 0..<10 {
			try owner.append(audioSample(at: time(100.023 + Double(index) * 0.01))) { result, _ in
				videoQueue.async {
					if case .success(let completed) = result, let metadata = completed.metadata {
						XCTAssertEqual(metadata.offsetMs, 23, accuracy: 0.01)
						metadataDone.fulfill()
					}
				}
			}
		}
		let videoEpoch = time(200)
		videoQueue.async {
			var grid = RecordingCadence(fps: 60)
			grid.begin(at: videoEpoch)
			for index in 1...12 {
				do { let due = try grid.dueTimes(at: videoEpoch + CMTime(value: Int64(index), timescale: 60)); XCTAssertEqual(due.count, 1); grid.didAppend() }
				catch { XCTFail("The independent video grid failed: \(error)") }
			}
			videoDone.fulfill()
		}
		await fulfillment(of: [videoDone], timeout: 1)
		XCTAssertEqual(original.appendedSamples, 0, "Cold owner remains blocked while all video ticks run")
		try await Task.sleep(nanoseconds: 185_000_000)
		gate.signal()
		await owner.drain()
		videoQueue.sync {} // Metadata callbacks precede finalization.
		let saved = try await owner.finish()
		XCTAssertTrue(saved)
		await fulfillment(of: [metadataDone], timeout: 1)
		XCTAssertEqual(owner.maximumQueueDepth, 10)
		XCTAssertEqual(original.offsetMs, 23, accuracy: 0.01)
		let tracks = try await AVURLAsset(url: path).loadTracks(withMediaType: .audio)
		let range = try await XCTUnwrap(tracks.first).load(.timeRange)
		XCTAssertEqual(range.start.seconds, 0, accuracy: 0.001)
		XCTAssertEqual(range.duration.seconds, 0.1, accuracy: 0.025)
		XCTAssertThrowsError(try owner.append(audioSample(at: time(100.5)), completion: { _, _ in }), "A drained owner closes admission")
	}

	func testColdNativeCameraOwnerDoesNotBlockVideoOrAcknowledgeBeforeActualAppend() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("queued-camera.mov")
		let original = try OriginalTrackWriter(path: path.path, mediaType: .video,
			settings: OriginalTrackWriter.videoSettings(width: 1552, height: 1552, fps: 30, bitrate: 36_000_000))
		let admission = OriginalSourceAdmission(maximumSamples: OriginalSourceAdmission.cameraSamples(fps: 30), maximumBytes: OriginalSourceAdmission.maximumCameraBytes)
		let owner = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.cold-camera-owner"), admission: admission)
		try owner.prepare(); owner.begin(at: time(100))
		let gate = DispatchSemaphore(value: 0), entered = DispatchSemaphore(value: 0)
		owner.queue.async { entered.signal(); gate.wait() }
		XCTAssertEqual(entered.wait(timeout: .now() + 1), .success)
		let videoQueue = DispatchQueue(label: "test.video-with-cold-camera")
		var readiness = RecordingStartBarrier()
		readiness.prepare(clipIndex: 0)
		let cameraReady = expectation(description: "Camera readiness follows its successful append")
		let videoDone = expectation(description: "64 live video ticks run during the observed 1.06-second camera stall")
		let seed = try screenSample(at: time(100.023), width: 1552, height: 1552)
		for index in 0..<33 {
			let frame = try RecordingFrameCache.retime(seed, at: time(100.023) + CMTime(value: Int64(index), timescale: 30), fps: 30)
			try owner.append(frame) { result, _ in
				videoQueue.async {
					if case .success(let completed) = result, let metadata = completed.metadata {
						XCTAssertEqual(metadata.offsetMs, 23, accuracy: 0.01)
						XCTAssertEqual(readiness.acknowledgeAppend(succeeded: true, requiredSourcesReady: true), 0)
						cameraReady.fulfill()
					}
				}
			}
		}
		let videoEpoch = time(200)
		videoQueue.async {
			var grid = RecordingCadence(fps: 60)
			grid.begin(at: videoEpoch)
			for index in 1...64 {
				do { let due = try grid.dueTimes(at: videoEpoch + CMTime(value: Int64(index), timescale: 60)); XCTAssertEqual(due.count, 1); grid.didAppend() }
				catch { XCTFail("Cold camera blocked the independent video grid: \(error)") }
			}
			XCTAssertNil(readiness.acknowledgeAppend(succeeded: true, requiredSourcesReady: false), "Queued camera frames are not writer readiness")
			videoDone.fulfill()
		}
		await fulfillment(of: [videoDone], timeout: 1)
		XCTAssertEqual(admission.retainedCount, 33, "Queued and in-flight frames remain admitted before any input append")
		try await Task.sleep(nanoseconds: 1_060_000_000)
		gate.signal(); await owner.drain()
		videoQueue.sync {}
		let saved = try await owner.finish()
		XCTAssertTrue(saved)
		await fulfillment(of: [cameraReady], timeout: 1)
		XCTAssertEqual(owner.maximumQueueDepth, 33)
		XCTAssertEqual(owner.maximumQueuedBytes, 33 * OriginalSourceWriter.storageBytes(seed))
		XCTAssertEqual(admission.retainedCount, 0)
		XCTAssertEqual(original.offsetMs, 23, accuracy: 0.01)
		let tracks = try await AVURLAsset(url: path).loadTracks(withMediaType: .video)
		let range = try await XCTUnwrap(tracks.first).load(.timeRange)
		XCTAssertEqual(range.start.seconds, 0, accuracy: 0.001)
		XCTAssertEqual(range.duration.seconds, 1.1, accuracy: 0.025)
	}

	func testCameraAdmissionUsesActualPaddedPlaneBytesAndNativeRateBudget() throws {
		let camera = try screenSample(at: time(100), width: 1552, height: 1552)
		let frameBytes = OriginalSourceWriter.storageBytes(camera)
		XCTAssertGreaterThanOrEqual(frameBytes, 1552 * 1552 * 4)
		XCTAssertEqual(OriginalSourceAdmission.cameraSamples(fps: 30), 38)
		XCTAssertEqual(OriginalSourceAdmission.cameraSamples(fps: 29.97), 38)
		XCTAssertEqual(OriginalSourceAdmission.cameraSamples(fps: 60), 68)
		XCTAssertEqual(OriginalSourceAdmission.cameraSamples(fps: 240), 128)
		let countBound = OriginalSourceAdmission(maximumSamples: 38, maximumBytes: OriginalSourceAdmission.maximumCameraBytes)
		for _ in 0..<38 { _ = try countBound.reserve(bytes: frameBytes) }
		XCTAssertEqual(countBound.retainedCount, 38)
		XCTAssertEqual(countBound.retainedBytes, 38 * frameBytes)
		XCTAssertEqual(countBound.maxBytes, 38 * frameBytes)
		XCTAssertLessThanOrEqual(countBound.retainedBytes, 512 * 1024 * 1024)
		XCTAssertThrowsError(try countBound.reserve(bytes: frameBytes), "Native30+8 source frames is a strict count cap")
		let bytesBound = OriginalSourceAdmission(maximumSamples: 128, maximumBytes: OriginalSourceAdmission.maximumCameraBytes)
		let fullFrames = OriginalSourceAdmission.maximumCameraBytes / frameBytes
		for _ in 0..<fullFrames { _ = try bytesBound.reserve(bytes: frameBytes) }
		XCTAssertThrowsError(try bytesBound.reserve(bytes: frameBytes), "Camera bytes stay bounded independently of source count")
		let padded = try screenSample(at: time(100), width: 1553, height: 1551)
		let paddedImage = try XCTUnwrap(CMSampleBufferGetImageBuffer(padded))
		XCTAssertGreaterThanOrEqual(OriginalSourceWriter.storageBytes(padded), CVPixelBufferGetBytesPerRow(paddedImage) * CVPixelBufferGetHeight(paddedImage))
		let planar = try screenSample(at: time(100), width: 1552, height: 1552, format: kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
		let planarImage = try XCTUnwrap(CMSampleBufferGetImageBuffer(planar))
		let planesBytes = (0..<CVPixelBufferGetPlaneCount(planarImage)).reduce(0) { $0 + CVPixelBufferGetBytesPerRowOfPlane(planarImage, $1) * CVPixelBufferGetHeightOfPlane(planarImage, $1) }
		XCTAssertGreaterThanOrEqual(OriginalSourceWriter.storageBytes(planar), planesBytes)
		XCTAssertGreaterThanOrEqual(OriginalSourceWriter.storageBytes(planar), CVPixelBufferGetDataSize(planarImage))
	}

	func testImmediateCameraStopDrainsMetadataAndRejectsLateReplacementCallbacks() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let settings = OriginalTrackWriter.videoSettings(width: 1552, height: 1552, fps: 30, bitrate: 36_000_000)
		let original = try OriginalTrackWriter(path: directory.appendingPathComponent("pause-camera.mov").path, mediaType: .video, settings: settings)
		let replacement = try OriginalTrackWriter(path: directory.appendingPathComponent("continue-camera.mov").path, mediaType: .video, settings: settings)
		let replacementOwner = OriginalSourceWriter(original: replacement, queue: DispatchQueue(label: "test.replacement-owner"))
		let owner = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.stop-camera-owner"),
			admission: OriginalSourceAdmission(maximumSamples: 38, maximumBytes: OriginalSourceAdmission.maximumCameraBytes))
		try owner.prepare(); owner.begin(at: time(100))
		let gate = DispatchSemaphore(value: 0)
		owner.queue.async { gate.wait() }
		let callbacks = DispatchQueue(label: "test.camera-stop-callbacks")
		let callbackGate = DispatchSemaphore(value: 0)
		callbacks.async { callbackGate.wait() }
		let completed = expectation(description: "Old camera completion is identity-guarded after Continue")
		try owner.append(screenSample(at: time(100.023), width: 1552, height: 1552)) { result, _ in
			callbacks.async {
				if case .success(let result) = result { XCTAssertNotNil(result.metadata) } else { XCTFail("Queued camera failed to drain") }
				XCTAssertFalse(owner.isCurrent(original: replacementOwner.original, clipIndex: 0, currentClipIndex: 1))
				completed.fulfill()
			}
		}
		gate.signal(); await owner.drain()
		XCTAssertThrowsError(try owner.append(screenSample(at: time(100.05), width: 1552, height: 1552), completion: { _, _ in }), "Pause/Stop closes producer admission")
		let saved = try await owner.finish()
		XCTAssertTrue(saved)
		callbackGate.signal()
		await fulfillment(of: [completed], timeout: 1)
		XCTAssertEqual(original.offsetMs, 23, accuracy: 0.01)
		replacementOwner.cancel(remove: true)
	}

	func testRejectedResumeDrainsCancelledOriginalBeforeReturningCorrelatedError() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let path = directory.appendingPathComponent("attempted-webcam.mov").path
		let original = try OriginalTrackWriter(path: path, mediaType: .video,
			settings: OriginalTrackWriter.videoSettings(width: 256, height: 144, fps: 30, bitrate: 2_000_000))
		let admission = OriginalSourceAdmission()
		let owner = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.rejected-camera"), admission: admission)
		try owner.prepare(); owner.begin(at: time(100))
		let callbacks = DispatchQueue(label: "test.rejected-camera-callbacks")
		let gate = DispatchSemaphore(value: 0)
		callbacks.async { gate.wait() }
		let firstAppend = expectation(description: "Attempted original actually appended before rollback")
		let callbackReturned = expectation(description: "Already queued original metadata is rejected after rollback")
		try owner.append(screenSample(at: time(100.023), width: 256, height: 144)) { result, _ in
			if case .success(let completed) = result { XCTAssertNotNil(completed.metadata) }
			else { XCTFail("The attempted source must append before cancellation") }
			firstAppend.fulfill()
			callbacks.async {
				XCTAssertFalse(owner.isCurrent(original: nil, clipIndex: 1, currentClipIndex: 0),
					"Production clears the attempted original and restores the previous index before rejection")
				callbackReturned.fulfill()
			}
		}
		await fulfillment(of: [firstAppend], timeout: 1)
		owner.cancel(remove: true)
		XCTAssertEqual(admission.retainedCount, 0)
		XCTAssertFalse(FileManager.default.fileExists(atPath: path))
		let rejection = RecordingStreamRecovery.rejectedResumePayload(previousClipIndex: 0, message: "Selected source closed")
		XCTAssertEqual(rejection["code"] as? String, "clip-resume-rejected")
		XCTAssertEqual(rejection["clipIndex"] as? Int, 1)
		XCTAssertEqual(rejection["message"] as? String, "Selected source closed")
		gate.signal()
		await fulfillment(of: [callbackReturned], timeout: 1)
		XCTAssertThrowsError(try owner.append(screenSample(at: time(100.05), width: 256, height: 144), completion: { _, _ in }))
	}

	func testDetachedAudioCallbackCannotPublishIntoReplacementClip() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = try OriginalTrackWriter(path: directory.appendingPathComponent("old-source.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let replacement = try OriginalTrackWriter(path: directory.appendingPathComponent("replacement.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let replacementOwner = OriginalSourceWriter(original: replacement, queue: DispatchQueue(label: "test.replacement-owner"))
		let owner = OriginalSourceWriter(original: old, queue: DispatchQueue(label: "test.old-source-owner"))
		try owner.prepare(); owner.begin(at: time(100))
		let gate = DispatchSemaphore(value: 0)
		owner.queue.async { gate.wait() }
		let callbackQueue = DispatchQueue(label: "test.clip-callbacks")
		let returned = expectation(description: "Queued old completion returns after clip replacement")
		try owner.append(audioSample(at: time(100.023))) { result, _ in
			callbackQueue.async {
				XCTAssertFalse(owner.isCurrent(original: replacementOwner.original, clipIndex: 0, currentClipIndex: 1))
				if owner.isCurrent(original: replacementOwner.original, clipIndex: 0, currentClipIndex: 1) {
					XCTFail("Detached source metadata or failure reached the replacement clip: \(result)")
				}
				returned.fulfill()
			}
		}
		gate.signal(); await owner.drain()
		await fulfillment(of: [returned], timeout: 1)
		_ = try await owner.finish()
		replacementOwner.cancel(remove: true)
	}

	func testOwnerFailureTimeSurvivesDelayedCallbackAndDrain() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let original = try OriginalTrackWriter(path: directory.appendingPathComponent("failed-source.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let owner = OriginalSourceWriter(original: original, queue: DispatchQueue(label: "test.failed-source-owner"))
		try owner.prepare(); owner.begin(at: time(100))
		owner.queue.sync { original.writer.cancelWriting() }
		let callbacks = DispatchQueue(label: "test.delayed-failure-callback")
		let gate = DispatchSemaphore(value: 0)
		callbacks.async { gate.wait() }
		let failed = expectation(description: "Failed owner detects before callback delivery")
		let delivered = expectation(description: "Delayed failure still uses original host timestamp")
		try owner.append(audioSample(at: time(100.023))) { result, detectedAt in
			if case .failure = result { failed.fulfill() } else { XCTFail("Cancelled original unexpectedly appended") }
			callbacks.async {
				var boundary = RecordingTerminationBoundary()
				let laterStop = CMClockGetTime(CMClockGetHostTimeClock())
				boundary.recordFailure(at: laterStop) // Another owner reports a later failure first.
				boundary.recordFailure(at: detectedAt)
				XCTAssertEqual(boundary.endingAt(laterStop), detectedAt)
				XCTAssertEqual(owner.failureTime, detectedAt)
				delivered.fulfill()
			}
		}
		await fulfillment(of: [failed], timeout: 1)
		try await Task.sleep(nanoseconds: 50_000_000)
		gate.signal(); await owner.drain()
		await fulfillment(of: [delivered], timeout: 1)
		XCTAssertThrowsError(try owner.append(audioSample(at: time(100.1)), completion: { _, _ in }))
		owner.cancel(remove: true)
	}

	func testAudioAdmissionBoundsAllRetainedSamplesAndBytes() throws {
		let admission = OriginalSourceAdmission()
		for _ in 0..<32 { _ = try admission.reserve(bytes: 1024) }
		XCTAssertEqual(admission.retainedCount, 32)
		XCTAssertThrowsError(try admission.reserve(bytes: 1))
		admission.consume(10)
		XCTAssertEqual(admission.retainedCount, 22)
		let ticket = try admission.reserve(bytes: 1024)
		admission.release(ticket)
		XCTAssertEqual(admission.retainedCount, 22)
		let bytes = OriginalSourceAdmission()
		_ = try bytes.reserve(bytes: OriginalSourceAdmission.maximumBytes)
		XCTAssertThrowsError(try bytes.reserve(bytes: 1), "One large buffer must obey the PCM byte limit too")
		bytes.close()
		XCTAssertThrowsError(try bytes.reserve(bytes: 1))
	}

	func testDelayedAudioFailureKeepsOwnerTimeAndRejectsReplacedWriterCallbacks() throws {
		let admission = OriginalSourceAdmission()
		admission.fail(at: time(101.2)); admission.fail(at: time(101.8))
		XCTAssertEqual(admission.failureTime, time(101.2))
		XCTAssertThrowsError(try admission.reserve(bytes: 128))
		var boundary = RecordingTerminationBoundary()
		boundary.recordFailure(at: time(101.25)) // Camera/other owner callback arrives first.
		let stopBeforeCallback = boundary.endingAt(time(103))
		boundary.recordFailure(at: try XCTUnwrap(admission.failureTime))
		XCTAssertEqual(boundary.endingAt(stopBeforeCallback), time(101.2), "Late callback must reconcile an already frozen Stop")
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let old = try OriginalTrackWriter(path: directory.appendingPathComponent("old.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let replacement = try OriginalTrackWriter(path: directory.appendingPathComponent("new.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let owner = OriginalSourceWriter(original: old, queue: DispatchQueue(label: "test.stale-audio"))
		XCTAssertTrue(owner.isCurrent(original: old, clipIndex: 0, currentClipIndex: 0))
		XCTAssertFalse(owner.isCurrent(original: replacement, clipIndex: 0, currentClipIndex: 0))
		XCTAssertFalse(owner.isCurrent(original: old, clipIndex: 0, currentClipIndex: 1))
		XCTAssertFalse(owner.isCurrent(original: nil, clipIndex: 0, currentClipIndex: 0))
		owner.cancel(remove: true); replacement.cancel(remove: true)
	}

	func testOriginalAudioFragmentsRemainReadableWithoutFinalization() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let output = directory.appendingPathComponent("fragmented-audio.mov")
		let track = try OriginalTrackWriter(path: output.path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let queue = DispatchQueue(label: "test.fragmented.audio")
		track.begin(at: time(100))
		for index in 0..<350 {
			_ = try queue.sync { try track.append(audioSample(at: time(100.023 + Double(index) * 0.01))) }
			try await Task.sleep(nanoseconds: 1_000_000)
		}
		// No finishWriting or cancelWriting: read the actual interrupted-write shape.
		let asset = AVURLAsset(url: output, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
		let audio = try await asset.loadTracks(withMediaType: .audio)
		XCTAssertEqual(audio.count, 1)
		let duration = try await asset.load(.duration)
		XCTAssertGreaterThan(duration.seconds, 1)
		let reader = try AVAssetReader(asset: asset)
		let input = AVAssetReaderTrackOutput(track: try XCTUnwrap(audio.first), outputSettings: nil)
		reader.add(input)
		XCTAssertTrue(reader.startReading())
		XCTAssertNotNil(input.copyNextSampleBuffer())
		reader.cancelReading()
		_ = try await track.finish(on: queue)
	}

	func testMissingEnabledOriginalFailsInsteadOfSavingSilenceAsSuccess() async throws {
		let directory = try temporaryDirectory()
		defer { try? FileManager.default.removeItem(at: directory) }
		let track = try OriginalTrackWriter(path: directory.appendingPathComponent("empty.mov").path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		try track.prepare()
		XCTAssertNil(track.takeStartedMetadata())
		do { _ = try await track.finish(on: DispatchQueue(label: "test.empty")); XCTFail("Missing original must surface a warning") }
		catch { XCTAssertFalse(FileManager.default.fileExists(atPath: track.path)) }
	}

	func testSourceTimingReportsDeliveryDelayAndExcludesPauseFromFrameIntervals() throws {
		let telemetry = CaptureTelemetry(requestedVideoFps: 60)
		telemetry.beginClip()
		XCTAssertTrue(telemetry.recordScreenSample(try screenSample(at: time(10), width: 16, height: 16), receivedAt: time(10.2)))
		XCTAssertTrue(telemetry.recordScreenSample(try screenSample(at: time(10.05), width: 16, height: 16), receivedAt: time(10.06)))
		telemetry.beginClip()
		XCTAssertTrue(telemetry.recordScreenSample(try screenSample(at: time(20), width: 16, height: 16), receivedAt: time(20.01)))
		let payload = telemetry.payload()
		let age = try XCTUnwrap(payload["screenDeliveryAgeMs"] as? [String: Any])
		let interval = try XCTUnwrap(payload["completeScreenIntervalMs"] as? [String: Any])
		XCTAssertEqual(try XCTUnwrap(age["max"] as? Double), 200, accuracy: 0.001)
		XCTAssertEqual(try XCTUnwrap(interval["max"] as? Double), 50, accuracy: 0.001)
		XCTAssertEqual(interval["count"] as? Int, 1)
	}

	private func temporaryDirectory() throws -> URL {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		return directory
	}
	private func time(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600_000) }
	private func screenSample(at timestamp: CMTime, width: Int = 2564, height: Int = 1692, format: OSType = kCVPixelFormatType_32BGRA) throws -> CMSampleBuffer {
		var pixels: CVPixelBuffer?
		XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, width, height, format,
			[kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels), kCVReturnSuccess)
		let image = try XCTUnwrap(pixels)
		var format: CMVideoFormatDescription?
		XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format), noErr)
		var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 60), presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
			formatDescription: try XCTUnwrap(format), sampleTiming: &timing, sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}
	private func audioSample(at timestamp: CMTime, amplitude: Int16 = 0) throws -> CMSampleBuffer {
		var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
			mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
		var format: CMAudioFormatDescription?
		XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
			magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format), noErr)
		var buffer: CMBlockBuffer?
		XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
			blockLength: 480 * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
			dataLength: 480 * 4, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &buffer), noErr)
		let data = try XCTUnwrap(buffer)
		XCTAssertEqual(CMBlockBufferFillDataBytes(with: 0, blockBuffer: data, offsetIntoDestination: 0, dataLength: 480 * 4), noErr)
		if amplitude != 0 {
			let pcm = [Int16](repeating: amplitude, count: 480 * 2)
			pcm.withUnsafeBytes { bytes in XCTAssertEqual(CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: bytes.count), noErr) }
		}
		var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
		var size = 4
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: data, formatDescription: try XCTUnwrap(format),
			sampleCount: 480, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1,
			sampleSizeArray: &size, sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}
}
