import AVFoundation
import CoreMedia
import CoreVideo
import ObjectiveC
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class ScreenCaptureRecorderResumeTests: XCTestCase {
	func testSystemAudioLossDuringResumePreparationIsRecoverable() async throws {
		let fixture = try makeFixture(); registerTeardown(fixture)
		let lifecycle = try XCTUnwrap(Mirror(reflecting: fixture.recorder).children.first { $0.label == "lifecycle" }?.value as? RecordingLifecycle)
		XCTAssertTrue(lifecycle.transition(.beginResume(generation: lifecycle.capture.source.generation, previousClipIndex: 0)).accepted)
		fixture.recorder.handleSystemAudioStop(TestError.sourceStopped)
		XCTAssertEqual(fixture.failures.count, 0)
		XCTAssertFalse(lifecycle.hasTerminalFailure)
		XCTAssertTrue(lifecycle.transition(.rejectResume).accepted)
		await fixture.recorder.resume(); try fixture.appendScreenFrame()
		await fixture.recorder.stop()
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1)
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
		let tracks = try await AVURLAsset(url: fixture.attemptedClip).loadTracks(withMediaType: .video)
		XCTAssertEqual(tracks.count, 1)
	}
	func testInactiveSourceRejectsUnacknowledgedResumeOnceAndAllowsCleanRetry() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)

		await fixture.recorder.resume()
		let pending = try XCTUnwrap(fixture.pendingResume())
		XCTAssertFalse(pending.commandInFlight)
		XCTAssertEqual(pending.previousClipIndex, 0)
		XCTAssertEqual(fixture.currentClipIndex(), 1)
		XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.attemptedClip.path))
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)

		fixture.recorder.emitSourceActivity(fixture.source, code: "source-inactive")
		fixture.drainSampleQueue()
		guard fixture.events(code: "clip-resume-rejected").count == 1 else {
			XCTFail("Source loss after resume() returned must reject the unacknowledged Continue")
			return
		}
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").first?["clipIndex"] as? Int, 1)
		XCTAssertNil(fixture.pendingResume())
		XCTAssertEqual(fixture.currentClipIndex(), 0, "Rollback restores the previous committed clip index")
		XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.attemptedClip.path))
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)
		XCTAssertEqual(fixture.failures.count, 0)

		try fixture.appendScreenFrame()
		fixture.recorder.emitSourceActivity(fixture.source, code: "source-inactive")
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 1, "Repeated source loss cannot reject twice")
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0, "A late append cannot acknowledge after source loss")

		fixture.recorder.emitSourceActivity(fixture.source, code: "source-active")
		await fixture.recorder.resume()
		try fixture.appendScreenFrame()
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1, "The rolled-back pause accepts a real retry")
		XCTAssertEqual(fixture.events(named: "recording-resumed").first?["clipIndex"] as? Int, 1)
		XCTAssertEqual(fixture.currentClipIndex(), 1)
		XCTAssertNil(fixture.pendingResume(), "Readiness clears pending Continue state")
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 1)
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
	}

	func testStoppedSourceRejectsPendingResumeWithoutActiveFailureOrDuplicate() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		XCTAssertNotNil(fixture.pendingResume())

		fixture.recorder.handleStreamStop(fixture.source, error: TestError.sourceStopped)
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 1)
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)
		XCTAssertEqual(fixture.failures.count, 0, "A pending Continue is recoverable, not an active-capture failure")
		XCTAssertNil(fixture.pendingResume())
		XCTAssertEqual(fixture.currentClipIndex(), 0)
		XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.attemptedClip.path))
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)

		fixture.recorder.handleStreamStop(fixture.source, error: TestError.sourceStopped)
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 1)
		XCTAssertEqual(fixture.failures.count, 0)
	}

	func testStopClearsPendingResumeWithoutResumeEvents() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		XCTAssertNotNil(fixture.pendingResume())

		await fixture.recorder.stop()
		XCTAssertNil(fixture.pendingResume())
		XCTAssertEqual(fixture.events(named: "recording-stopped").count, 1)
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)
		XCTAssertEqual(fixture.failures.count, 0)
		XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.attemptedClip.path))
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)

		fixture.recorder.handleStreamStop(fixture.source, error: TestError.sourceStopped)
		try fixture.appendScreenFrame()
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)
		XCTAssertEqual(fixture.failures.count, 0)
	}

	func testAcknowledgedResumeClearsPendingStateBeforeLaterStreamStop() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		try fixture.appendScreenFrame()
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1)
		XCTAssertNil(fixture.pendingResume())

		fixture.recorder.handleStreamStop(fixture.source, error: TestError.sourceStopped)
		fixture.drainSampleQueue()
		XCTAssertEqual(fixture.failures.count, 1, "Once acknowledged, source loss is an active-capture failure")
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1)
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
	}

	func testSourceLossRacingStopCannotAcknowledgeOrRejectAfterStop() async throws {
		for _ in 0..<6 {
			let fixture = try makeFixture()
			registerTeardown(fixture)
			await fixture.recorder.resume()
			await withTaskGroup(of: Void.self) { group in
				group.addTask { await fixture.recorder.stop() }
				group.addTask { fixture.recorder.emitSourceActivity(fixture.source, code: "source-inactive") }
				await group.waitForAll()
			}
			fixture.drainSampleQueue()
			let events = fixture.events()
			let stopped = events.firstIndex { $0["event"] as? String == "recording-stopped" }
			let rejected = events.firstIndex { $0["code"] as? String == "clip-resume-rejected" }
			XCTAssertNotNil(stopped)
			XCTAssertEqual(fixture.events(named: "recording-stopped").count, 1)
			XCTAssertEqual(fixture.events(named: "recording-resumed").count, 0)
			XCTAssertLessThanOrEqual(fixture.events(code: "clip-resume-rejected").count, 1)
			if let stopped, let rejected { XCTAssertLessThan(rejected, stopped, "Stop must win before any late rejection") }
			XCTAssertNil(fixture.pendingResume())
			XCTAssertEqual(fixture.failures.count, 0)
			XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.attemptedClip.path))
			XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
		}
	}

	func testSourceLossRacingReadinessHasExactlyOneOrderedOutcome() async throws {
		for _ in 0..<6 {
			let fixture = try makeFixture()
			registerTeardown(fixture)
			await fixture.recorder.resume()
			await withTaskGroup(of: Void.self) { group in
				group.addTask {
					do { try fixture.appendScreenFrame() }
					catch { XCTFail("The synthetic readiness append failed: \(error)") }
				}
				group.addTask { fixture.recorder.emitSourceActivity(fixture.source, code: "source-inactive") }
				await group.waitForAll()
			}
			fixture.drainSampleQueue()
			let acknowledged = fixture.events(named: "recording-resumed").count
			let rejected = fixture.events(code: "clip-resume-rejected").count
			XCTAssertEqual(acknowledged + rejected, 1, "Source loss and readiness cannot both complete for one Continue")
			XCTAssertNil(fixture.pendingResume())
			XCTAssertEqual(fixture.currentClipIndex(), acknowledged == 1 ? 1 : 0)
			XCTAssertEqual(fixture.failures.count, 0)
			XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
			if rejected == 1 { XCTAssertFalse(FileManager.default.fileExists(atPath: fixture.attemptedClip.path)) }
			await fixture.recorder.stop()
		}
	}

	func testHighQualityLatePauseClosingFramesDoNotFailWriter() async throws {
		let fixture = try makeFixture(quality: "high", fps: 60,
			seed: ScreenCaptureRecorderResumeTests.screenSample(at: CMClockGetTime(CMClockGetHostTimeClock())))
		registerTeardown(fixture)
		let finalizing = expectation(description: "Pause has started finalizing its clip")
		fixture.recorder.eventObserver = {
			fixture.events.append($0)
			if $0["event"] as? String == "clip-finalizing" { finalizing.fulfill() }
		}
		let onGrid = DispatchSemaphore(value: 0)
		let appends = EventLog()
		var observedLiveAppend = false
		fixture.recorder.videoAppendObserver = { presentationTime in
			appends.append([
				"presentationTime": CMTimeGetSeconds(presentationTime),
				"appendedAt": CMTimeGetSeconds(CMClockGetTime(CMClockGetHostTimeClock())),
			])
			let samples = appends.matching(name: nil, code: nil)
			if !observedLiveAppend, let first = samples.first?["presentationTime"] as? Double,
				CMTimeGetSeconds(presentationTime) - first >= 1.0 / 60 {
				observedLiveAppend = true
				onGrid.signal()
			}
		}
		await fixture.recorder.resume()
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1)

		let gate = DispatchSemaphore(value: 0)
		defer { gate.signal() }
		let blocked = XCTestExpectation(description: "Sample queue is blocked after the on-grid append")
		let blockingTask = Task {
			guard onGrid.wait(timeout: .now() + 1) == .success else { return }
			fixture.recorder.syncOnSampleQueue {
				blocked.fulfill()
				gate.wait()
			}
		}
		await fulfillment(of: [blocked], timeout: 1)
		try await Task.sleep(nanoseconds: 50_000_000)
		let pause = Task { await fixture.recorder.pause() }
		await fulfillment(of: [finalizing], timeout: 1)
		try await Task.sleep(nanoseconds: 200_000_000)
		gate.signal()
		await pause.value
		await blockingTask.value

		let asset = AVURLAsset(url: fixture.attemptedClip)
		let tracks = try await asset.loadTracks(withMediaType: .video)
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: nil)
		reader.add(output)
		XCTAssertTrue(reader.startReading(), "\(String(describing: reader.error))")
		var presentationTimes: [CMTime] = []
		while let sample = output.copyNextSampleBuffer() {
			presentationTimes.append(CMSampleBufferGetPresentationTimeStamp(sample))
		}
		XCTAssertEqual(reader.status, .completed, "\(String(describing: reader.error))")
		XCTAssertGreaterThan(presentationTimes.count, 1)
		let appendedSamples = appends.matching(name: nil, code: nil)
		XCTAssertGreaterThanOrEqual(appendedSamples.count, 3, "Pause must actually append a closing frame")
		let closingAppend = try XCTUnwrap(appendedSamples.last)
		let presentationTime = try XCTUnwrap(closingAppend["presentationTime"] as? Double)
		let appendedAt = try XCTUnwrap(closingAppend["appendedAt"] as? Double)
		XCTAssertGreaterThan(appendedAt - presentationTime, 0.150,
			"The real closing append must arrive more than 150 ms after its grid timestamp")
		XCTAssertEqual(fixture.events(code: "writer-failed-during-capture").count, 0,
			"A late Pause closing frame must not emit writer-failed")
		XCTAssertEqual(fixture.failures.count, 0, "A late Pause closing frame is not a writer failure")
	}

	func testOverlappingStopsJoinOneFinalizationAndPreserveBothExistingAndNewFootage() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		try fixture.appendScreenFrame()
		try await Task.sleep(nanoseconds: 50_000_000)
		try fixture.appendScreenFrame()
		async let first: Void = fixture.recorder.stop()
		async let second: Void = fixture.recorder.stop()
		_ = await (first, second)
		await fixture.recorder.stop()
		XCTAssertEqual(fixture.events(named: "recording-stopped").count, 1)
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
		let asset = AVURLAsset(url: fixture.attemptedClip)
		let tracks = try await asset.loadTracks(withMediaType: .video)
		let duration = try await asset.load(.duration)
		XCTAssertEqual(tracks.count, 1)
		XCTAssertGreaterThan(duration.seconds, 0.02)
	}

	func testAdversaryLateContinueAfterStopMustRemainSilent() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.stop()
		let before = fixture.events().count
		await fixture.recorder.resume()
		XCTAssertEqual(fixture.events().count, before, "A late Continue after Stop was previously a no-op")
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
	}
	func testAdversaryDuplicateContinueAfterAckMustRemainSilentAndKeepFootage() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		try fixture.appendScreenFrame()
		XCTAssertEqual(fixture.events(named: "recording-resumed").count, 1)
		let before = fixture.events().count
		await fixture.recorder.resume()
		XCTAssertEqual(fixture.events().count, before, "Duplicate Continue while recording was previously a no-op")
		XCTAssertEqual(fixture.events(code: "clip-resume-rejected").count, 0)
		try fixture.appendScreenFrame()
		await fixture.recorder.stop()
		let tracks = try await AVURLAsset(url: fixture.attemptedClip).loadTracks(withMediaType: .video)
		XCTAssertEqual(tracks.count, 1)
	}

	func testReviewStopBetweenNativeSessionAndLifecycleEpochKeepsAppendedMedia() async throws {
		let fixture = try makeFixture()
		registerTeardown(fixture)
		await fixture.recorder.resume()
		let lifecycle = try XCTUnwrap(Mirror(reflecting: fixture.recorder).children.first { $0.label == "lifecycle" }?.value as? RecordingLifecycle)
		let nativeMethod = try XCTUnwrap(class_getInstanceMethod(AVAssetWriter.self, #selector(AVAssetWriter.startSession(atSourceTime:))))
		let gateMethod = try XCTUnwrap(class_getInstanceMethod(AVAssetWriter.self, #selector(AVAssetWriter.row4_startSession(atSourceTime:))))
		method_exchangeImplementations(nativeMethod, gateMethod)
		defer { method_exchangeImplementations(nativeMethod, gateMethod) }
		let append = Task.detached { try fixture.appendScreenFrame() }
		XCTAssertEqual(Row4NativeSessionGate.entered.wait(timeout: .now() + 2), .success)
		let stop = Task.detached { await fixture.recorder.stop() }
		for _ in 0..<1000 {
			if lifecycle.isStopping { break }
			try await Task.sleep(nanoseconds: 1_000_000)
		}
		XCTAssertTrue(lifecycle.isStopping, "Stop must own its transition before native startSession returns")
		Row4NativeSessionGate.proceed.signal()
		_ = try await append.value
		await stop.value
		let stopped = try XCTUnwrap(fixture.events(named: "recording-stopped").first)
		let clips = try XCTUnwrap(stopped["clips"] as? [[String: Any]])
		XCTAssertEqual(clips.count, 1, "A real successfully appended frame must survive Stop")
		XCTAssertTrue(FileManager.default.fileExists(atPath: fixture.attemptedClip.path), "Stop deleted actually appended media")
		let tracks = try await AVURLAsset(url: fixture.attemptedClip).loadTracks(withMediaType: .video)
		XCTAssertEqual(tracks.count, 1)
		XCTAssertEqual(try Data(contentsOf: fixture.previousClip), fixture.previousClipData)
	}

	private func makeFixture(
		quality: String = "standard",
		fps: Int = 30,
		seed: CMSampleBuffer? = nil
	) throws -> Fixture {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		let previousClip = directory.appendingPathComponent("take-clip-0001.mp4")
		let previousClipData = Data([0, 1, 2, 3, 4])
		try previousClipData.write(to: previousClip)
		let json = """
		{"source":{"type":"display","sourceId":"screen:1"},
		"video":{"quality":"\(quality)","fps":\(fps),"width":1920,"height":1080,"hideSystemCursor":false},
		"audio":{"system":{"enabled":false},"microphone":{"enabled":false,"gain":1}},
		"webcam":{"enabled":false,"width":1920,"height":1080,"fps":30,"exactFormat":false},
		"cursor":{"mode":"system"},"outputs":{"screenPath":"\(previousClip.path)"}}
		"""
		let request = try JSONDecoder().decode(RecordingRequest.self, from: Data(json.utf8))
		let events = EventLog()
		let failures = FailureLog()
		let recorder = ScreenCaptureRecorder(request: request) { _, error in failures.append(error) }
		recorder.eventObserver = { events.append($0) }
		let source = NSObject()
		recorder.preparePausedResumeFixture(source: source, seed: seed)
		return Fixture(
			recorder: recorder,
			source: source,
			directory: directory,
			previousClip: previousClip,
			attemptedClip: directory.appendingPathComponent("take-clip-0002.mp4"),
			previousClipData: previousClipData,
			events: events,
			failures: failures
		)
	}

	private func registerTeardown(_ fixture: Fixture) {
		addTeardownBlock {
			await fixture.recorder.stop()
			try? FileManager.default.removeItem(at: fixture.directory)
		}
	}

	private struct Fixture {
		let recorder: ScreenCaptureRecorder
		let source: NSObject
		let directory: URL
		let previousClip: URL
		let attemptedClip: URL
		let previousClipData: Data
		let events: EventLog
		let failures: FailureLog

		func pendingResume() -> (generation: UInt64, previousClipIndex: Int, commandInFlight: Bool)? {
			recorder.syncOnSampleQueue { recorder.pendingResume }
		}

		func currentClipIndex() -> Int {
			recorder.syncOnSampleQueue { recorder.currentClipIndex }
		}

		func drainSampleQueue() {
			recorder.syncOnSampleQueue {}
		}

		@discardableResult
		func appendScreenFrame() throws -> CMTime {
			let timestamp = CMClockGetTime(CMClockGetHostTimeClock())
			let sample = try ScreenCaptureRecorderResumeTests.screenSample(at: timestamp)
			recorder.syncOnSampleQueue { recorder.appendScreenFrame(sample) }
			return timestamp
		}

		func events(named name: String? = nil, code: String? = nil) -> [[String: Any]] {
			events.matching(name: name, code: code)
		}
	}

	private final class EventLog {
		private let lock = NSLock()
		private var storage: [[String: Any]] = []

		func append(_ event: [String: Any]) {
			lock.lock()
			storage.append(event)
			lock.unlock()
		}

		func matching(name: String?, code: String?) -> [[String: Any]] {
			lock.lock()
			defer { lock.unlock() }
			return storage.filter { event in
				(name == nil || event["event"] as? String == name) &&
					(code == nil || event["code"] as? String == code)
			}
		}
	}

	private final class FailureLog {
		private let lock = NSLock()
		private var errors: [Error] = []
		var count: Int {
			lock.lock()
			defer { lock.unlock() }
			return errors.count
		}
		func append(_ error: Error) {
			lock.lock()
			errors.append(error)
			lock.unlock()
		}
	}

	private enum TestError: Error {
		case sourceStopped
	}

	private static func screenSample(at timestamp: CMTime) throws -> CMSampleBuffer {
		var pixels: CVPixelBuffer?
		XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 1920, 1080, kCVPixelFormatType_32BGRA,
			[kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels), kCVReturnSuccess)
		let image = try XCTUnwrap(pixels)
		var format: CMVideoFormatDescription?
		XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image, formatDescriptionOut: &format), noErr)
		var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 30), presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault, imageBuffer: image,
			formatDescription: try XCTUnwrap(format), sampleTiming: &timing, sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}
}

private enum Row4NativeSessionGate {
	static let entered = DispatchSemaphore(value: 0)
	static let proceed = DispatchSemaphore(value: 0)
}

private extension AVAssetWriter {
	@objc func row4_startSession(atSourceTime startTime: CMTime) {
		Row4NativeSessionGate.entered.signal()
		_ = Row4NativeSessionGate.proceed.wait(timeout: .now() + 5)
		self.row4_startSession(atSourceTime: startTime)
	}
}
