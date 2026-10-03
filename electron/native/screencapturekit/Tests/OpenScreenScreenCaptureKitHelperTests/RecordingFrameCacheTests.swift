import AVFoundation
import CoreMedia
import CoreVideo
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingFrameCacheTests: XCTestCase {
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
