import CoreMedia
import CoreVideo
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class ResumeSeedWaitTests: XCTestCase {
	func testReturnsTheFrameAsSoonAsThePollSeesIt() async throws {
		let frame = try makeScreenSample(at: 100)
		var clock = 0.0
		var polls = 0
		let result = try await ResumeSeedWait.firstFrame(
			now: { Date(timeIntervalSince1970: clock) },
			sleep: { clock += $0 },
			frame: { polls += 1; return polls == 3 ? frame : nil }
		)
		XCTAssertTrue(CMSampleBufferGetImageBuffer(try XCTUnwrap(result.frame)) === CMSampleBufferGetImageBuffer(frame))
		XCTAssertEqual(result.waitedMs, 40)
		XCTAssertEqual(polls, 3)
	}

	func testGivesUpAtTheBudgetWhenTheStreamStaysSilent() async throws {
		var clock = 0.0
		var sleeps: [TimeInterval] = []
		let result = try await ResumeSeedWait.firstFrame(
			budget: 0.05,
			now: { Date(timeIntervalSince1970: clock) },
			sleep: { sleeps.append($0); clock += $0 },
			frame: { nil }
		)
		XCTAssertNil(result.frame)
		XCTAssertEqual(result.waitedMs, 50)
		XCTAssertEqual(sleeps.count, 3)
		for (slept, expected) in zip(sleeps, [0.02, 0.02, 0.01]) {
			XCTAssertEqual(slept, expected, accuracy: 0.0001, "Polls never sleep past the budget")
		}
	}

	func testDoesNotSleepWhenAFrameIsAlreadyCached() async throws {
		let frame = try makeScreenSample(at: 100)
		var slept = false
		let result = try await ResumeSeedWait.firstFrame(sleep: { _ in slept = true }, frame: { frame })
		XCTAssertNotNil(result.frame)
		XCTAssertFalse(slept)
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
			presentationTimeStamp: CMTime(seconds: seconds, preferredTimescale: 600_000), decodeTimeStamp: .invalid)
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReadyWithImageBuffer(allocator: kCFAllocatorDefault,
			imageBuffer: image, formatDescription: try XCTUnwrap(format), sampleTiming: &timing,
			sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}
}
