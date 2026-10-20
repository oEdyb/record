import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class CaptureSetupTests: XCTestCase {
	func testHighCapsDeliveryJustAboveTheWrittenRate() {
		let interval = CaptureSetupBuilder.minimumFrameInterval(quality: "high", fps: 60)
		XCTAssertEqual(CMTimeGetSeconds(interval), 0.015, accuracy: 0.000_001)
		XCTAssertGreaterThan(CMTimeGetSeconds(interval), 1.0 / 120)
	}

	func testStandardDeliversTheWrittenRate() {
		let interval = CaptureSetupBuilder.minimumFrameInterval(quality: "standard", fps: 30)
		XCTAssertEqual(CMTimeGetSeconds(interval), 1.0 / 30, accuracy: 0.000_001)
	}

	func testQueueDepthIsTheDocumentedMaximum() {
		XCTAssertEqual(CaptureSetupBuilder.queueDepth, 8)
	}
}
