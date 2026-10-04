import AVFoundation
import CoreMedia
import CoreVideo
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingFrameCacheTests: XCTestCase {
	func testHistoricalGridNeverUsesFuturePixelsAndRetainsFirstImageWhileInputIsNotReady() throws {
		let first = try makeScreenSample(at: 100), future = try makeScreenSample(at: 100.5)
		var cache = RecordingFrameCache()
		cache.observe(first); cache.observe(future)
		let retained = try XCTUnwrap(cache.scheduledFrame(at: time(100), fps: 60, firstFrame: first))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(retained.sample) === CMSampleBufferGetImageBuffer(first))
		XCTAssertEqual(retained.sourceTime, time(100))
		cache.didAppend(try RecordingFrameCache.retime(first, at: time(100.1), fps: 60), sourceTime: time(100))
		let historical = try XCTUnwrap(cache.scheduledFrame(at: time(100.2), fps: 60, firstFrame: nil))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(historical.sample) === CMSampleBufferGetImageBuffer(first))
		XCTAssertEqual(historical.sourceTime, time(100), "Repeated pixels retain capture identity rather than their retimed grid PTS")
		let current = try XCTUnwrap(cache.scheduledFrame(at: time(100.5), fps: 60, firstFrame: nil))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(current.sample) === CMSampleBufferGetImageBuffer(future))
		XCTAssertEqual(current.sourceTime, time(100.5))
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(future), time(100.5))
	}
	func testFutureArrivalDoesNotDiscardTheFrameForTheCurrentGridSlot() throws {
		let first = try makeScreenSample(at: 100)
		let eligible = try makeScreenSample(at: 100.015)
		let future = try makeScreenSample(at: 100.031)
		var cache = RecordingFrameCache()
		cache.observe(first); cache.didAppend(first)
		cache.observe(eligible); cache.observe(future)
		let scheduled = try XCTUnwrap(cache.scheduledFrame(at: time(100) + CMTime(value: 1, timescale: 60), fps: 60, firstFrame: first))
		XCTAssertEqual(scheduled.sourceTime, time(100.015))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(scheduled.sample) === CMSampleBufferGetImageBuffer(eligible))
	}

	func testHistoryIsBoundedAndPauseRetainsOnlyLatestSource() throws {
		var cache = RecordingFrameCache()
		cache.observe(try makeScreenSample(at: 100))
		cache.observe(try makeScreenSample(at: 101))
		cache.observe(try makeScreenSample(at: 102))
		XCTAssertNil(try cache.scheduledFrame(at: time(100), fps: 60, firstFrame: nil))
		XCTAssertEqual(try cache.scheduledFrame(at: time(101), fps: 60, firstFrame: nil)?.sourceTime, time(101))
		cache.observe(try makeScreenSample(at: 103), retainingPrevious: false)
		XCTAssertNil(try cache.scheduledFrame(at: time(102), fps: 60, firstFrame: nil))
		cache.invalidateCapturedFrame()
		XCTAssertNil(try cache.scheduledFrame(at: time(104), fps: 60, firstFrame: nil))
	}

	func testOutOfOrderSourceCannotRegressWrittenPixels() throws {
		var cache = RecordingFrameCache()
		let current = try makeScreenSample(at: 101)
		cache.observe(current); cache.didAppend(current)
		cache.observe(try makeScreenSample(at: 100))
		XCTAssertEqual(try cache.scheduledFrame(at: time(102), fps: 60, firstFrame: nil)?.sourceTime, time(101))
	}

	func testEveryClipAcknowledgesOnlyItsFirstSuccessfulAppend() {
		var barrier = RecordingStartBarrier()
		barrier.prepare(clipIndex: 0)
		XCTAssertNil(barrier.acknowledgeAppend(succeeded: false))
		XCTAssertEqual(barrier.acknowledgeAppend(succeeded: true), 0)
		XCTAssertNil(barrier.acknowledgeAppend(succeeded: true))
		barrier.prepare(clipIndex: 1)
		XCTAssertNil(barrier.acknowledgeAppend(succeeded: false))
		XCTAssertEqual(barrier.acknowledgeAppend(succeeded: true), 1)
	}

	func testResumeRetimesTheLatestCompleteFrameWithoutChangingTheOriginal() throws {
		let original = try makeScreenSample(at: 100)
		var cache = RecordingFrameCache()
		cache.observe(original)
		let resumed = try XCTUnwrap(cache.resumedFrame(at: time(200), fps: 60))
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(resumed), time(200))
		XCTAssertEqual(CMSampleBufferGetDuration(resumed), CMTime(value: 1, timescale: 60))
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(original), time(100))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(original) === CMSampleBufferGetImageBuffer(resumed))
	}

	func testClosingFrameKeepsWrittenImageAndExtendsOnlyChronologically() throws {
		let written = try makeScreenSample(at: 100)
		let observedWhilePaused = try makeScreenSample(at: 101)
		var cache = RecordingFrameCache()
		cache.observe(written)
		cache.didAppend(written)
		cache.observe(observedWhilePaused)
		XCTAssertNil(try cache.closingFrame(at: time(100), fps: 60))
		let closing = try XCTUnwrap(cache.closingFrame(at: time(102), fps: 60))
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(closing), time(102) - CMTime(value: 1, timescale: 60))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(closing) === CMSampleBufferGetImageBuffer(written))
		cache.beginClip()
		XCTAssertNil(try cache.closingFrame(at: time(103), fps: 60))
	}

	func testResumeEpochFollowsEncoderPreparationInsteadOfItsStaleSeedClock() throws {
		var cache = RecordingFrameCache()
		let source = try makeScreenSample(at: 100)
		cache.observe(source)
		let prePreparationSeed = try XCTUnwrap(cache.resumedFrame(at: time(200), fps: 60))
		let preparationCompleted = time(200.35) // Measured cold encoder preparation exceeded 243 ms.
		let preparedSeed = try RecordingFrameCache.retime(prePreparationSeed, at: preparationCompleted, fps: 60)
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(preparedSeed), preparationCompleted)
		XCTAssertTrue(CMSampleBufferGetImageBuffer(preparedSeed) === CMSampleBufferGetImageBuffer(source))
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: CMSampleBufferGetPresentationTimeStamp(preparedSeed))
		XCTAssertEqual(try grid.dueTimes(at: time(200.37)).count, 1)
		grid.begin(at: CMSampleBufferGetPresentationTimeStamp(prePreparationSeed))
		XCTAssertThrowsError(try grid.dueTimes(at: time(200.37)), "A pre-preparation seed falsely spends the live lag budget")
		XCTAssertEqual(CMSampleBufferGetPresentationTimeStamp(source), time(100), "Preparing the resume seed cannot mutate captured source timing")
	}

	func testSourceChangesInvalidateOldResumeFrame() throws {
		var cache = RecordingFrameCache()
		cache.observe(try makeScreenSample(at: 100))
		cache.invalidateCapturedFrame()
		XCTAssertNil(try cache.resumedFrame(at: time(200), fps: 60))
		let newSource = try makeScreenSample(at: 201)
		cache.observe(newSource)
		let resumed = try XCTUnwrap(cache.resumedFrame(at: time(202), fps: 60))
		XCTAssertTrue(CMSampleBufferGetImageBuffer(resumed) === CMSampleBufferGetImageBuffer(newSource))
	}

	func testStaticSilentClipKeepsItsHostIntervalInRealEncodedFile() async throws {
		try await verifyStaticClip(firstTime: 100, endTime: 102, expectedDuration: 2)
	}

	func testSubsecondStaticSilentClipKeepsItsDuration() async throws {
		try await verifyStaticClip(firstTime: 100, endTime: 100.2, expectedDuration: 0.2)
	}

	func testStaticResumedSilentClipKeepsItsOwnInterval() async throws {
		var cache = RecordingFrameCache()
		cache.observe(try makeScreenSample(at: 100))
		let resumed = try XCTUnwrap(cache.resumedFrame(at: time(200), fps: 60))
		try await verifyStaticClip(firstTime: 200, endTime: 201, expectedDuration: 1, firstSample: resumed)
	}

	func testEncodedHighClosingGridHasNoGapAndExcludesDelayedTeardown() async throws {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(atPath: directory.path) }
		let output = directory.appendingPathComponent("high-boundary.mp4")
		let (writer, input) = try makeWriter(at: output)
		let queue = DispatchQueue(label: "test.high-boundary")
		let anchor = time(100)
		var termination = RecordingTerminationBoundary()
		termination.recordFailure(at: time(101.153333))
		let frozenBoundary = termination.endingAt(time(103.153333))
		let first = try makeScreenSample(at: 100)
		XCTAssertTrue(writer.startWriting())
		writer.startSession(atSourceTime: anchor)
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: anchor)
		var cache = RecordingFrameCache()
		let regular = try (0...30).map { try RecordingFrameCache.retime(first, at: anchor + CMTime(value: Int64($0), timescale: 60), fps: 60) }
		try await ClosingFrameAppender(samples: regular, input: input, writer: writer, queue: queue).append()
		cache.didAppend(try XCTUnwrap(regular.last))
		for _ in 1...30 { grid.didAppend() }
		// Reproduce the missing 653 ms before Stop. Later source/teardown time is
		// never passed back into the frozen boundary's grid or asset session.
		let closing = try grid.closingFrames(endingAt: frozenBoundary).compactMap { frame in
			try cache.boundaryFrame(at: frame.time, duration: frame.duration, fps: 60)
		}
		XCTAssertEqual(closing.count, 39)
		try await Task.sleep(nanoseconds: 100_000_000)
		try await ClosingFrameAppender(samples: closing, input: input, writer: writer, queue: queue).append()
		writer.endSession(atSourceTime: frozenBoundary)
		input.markAsFinished()
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
		let asset = AVURLAsset(url: output)
		let duration = try await asset.load(.duration)
		XCTAssertEqual(CMTimeGetSeconds(duration), CMTimeGetSeconds(frozenBoundary - anchor), accuracy: 0.001)
		let tracks = try await asset.loadTracks(withMediaType: .video)
		let track = try XCTUnwrap(tracks.first)
		let reader = try AVAssetReader(asset: asset)
		let readerOutput = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
		reader.add(readerOutput)
		XCTAssertTrue(reader.startReading())
		var times: [CMTime] = []
		while let sample = readerOutput.copyNextSampleBuffer() {
			if CMSampleBufferGetImageBuffer(sample) != nil { times.append(CMSampleBufferGetPresentationTimeStamp(sample)) }
		}
		XCTAssertEqual(reader.status, .completed)
		XCTAssertEqual(times.count, 70)
		for (previous, next) in zip(times, times.dropFirst()) { XCTAssertEqual(CMTimeGetSeconds(next - previous), 1 / 60, accuracy: 0.000001) }
		XCTAssertLessThan(CMTimeGetSeconds(duration), 1.2, "Teardown delay must not extend the saved recording")
	}

	func testClosingFrameRejectsStoppedWriterWithoutHanging() async throws {
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: directory) }
		let (writer, input) = try makeWriter(at: directory.appendingPathComponent("cancelled.mp4"))
		writer.cancelWriting()
		do {
			try await ClosingFrameAppender(sample: makeScreenSample(at: 100), input: input, writer: writer,
				queue: DispatchQueue(label: "test.cancelled-writer")).append()
			XCTFail("A cancelled writer cannot append a closing frame")
		} catch {
			XCTAssertEqual(writer.status, .cancelled)
		}
	}

	private func verifyStaticClip(firstTime: Double, endTime: Double, expectedDuration: Double,
		firstSample: CMSampleBuffer? = nil) async throws
	{
		let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
		defer { try? FileManager.default.removeItem(at: directory) }
		let output = directory.appendingPathComponent("static.mp4")
		let (writer, input) = try makeWriter(at: output)
		let queue = DispatchQueue(label: "test.static-writer")
		let first = try firstSample ?? makeScreenSample(at: firstTime)
		XCTAssertTrue(writer.startWriting())
		writer.startSession(atSourceTime: time(firstTime))
		try await ClosingFrameAppender(sample: first, input: input, writer: writer, queue: queue).append()
		var cache = RecordingFrameCache()
		cache.didAppend(first)
		let closing = try XCTUnwrap(cache.closingFrame(at: time(endTime), fps: 60))
		try await ClosingFrameAppender(sample: closing, input: input, writer: writer, queue: queue).append()
		input.markAsFinished()
		await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
		XCTAssertEqual(writer.status, .completed, "\(String(describing: writer.error))")
		let duration = try await AVURLAsset(url: output).load(.duration)
		XCTAssertEqual(CMTimeGetSeconds(duration), expectedDuration, accuracy: 0.04)
		let tracks = try await AVURLAsset(url: output).loadTracks(withMediaType: .audio)
		XCTAssertTrue(tracks.isEmpty)
	}

	private func makeWriter(at output: URL) throws -> (AVAssetWriter, AVAssetWriterInput) {
		let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264,
			AVVideoWidthKey: 320,
			AVVideoHeightKey: 180,
			AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false],
		])
		input.expectsMediaDataInRealTime = true
		XCTAssertTrue(writer.canAdd(input))
		writer.add(input)
		return (writer, input)
	}

	private func makeScreenSample(at seconds: Double) throws -> CMSampleBuffer {
		var pixels: CVPixelBuffer?
		XCTAssertEqual(CVPixelBufferCreate(kCFAllocatorDefault, 320, 180, kCVPixelFormatType_32BGRA,
			[kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pixels), kCVReturnSuccess)
		let image = try XCTUnwrap(pixels)
		var format: CMVideoFormatDescription?
		XCTAssertEqual(CMVideoFormatDescriptionCreateForImageBuffer(allocator: kCFAllocatorDefault,
			imageBuffer: image, formatDescriptionOut: &format), noErr)
		var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 60),
			presentationTimeStamp: time(seconds), decodeTimeStamp: .invalid)
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault,
			imageBuffer: image, formatDescription: try XCTUnwrap(format), sampleTiming: &timing,
			sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}

	private func time(_ seconds: Double) -> CMTime {
		CMTime(seconds: seconds, preferredTimescale: 600_000)
	}
}
