import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class CameraDropReportTests: XCTestCase {
	func testReportsOnceASecond() {
		var report = CameraDropReport()
		XCTAssertTrue(report.shouldReport(at: 10))
		XCTAssertFalse(report.shouldReport(at: 10.5))
		XCTAssertFalse(report.shouldReport(at: 10.99))
		XCTAssertTrue(report.shouldReport(at: 11))
		XCTAssertFalse(report.shouldReport(at: 11.2))
	}

	func testNamesAppleDropReasons() {
		XCTAssertEqual(CameraDropReport.describe(kCMSampleBufferDroppedFrameReason_FrameWasLate), "frame was late: the camera delivery queue was busy")
		XCTAssertEqual(CameraDropReport.describe(kCMSampleBufferDroppedFrameReason_OutOfBuffers), "out of buffers: frames are waiting on the recorder queue")
		XCTAssertEqual(CameraDropReport.describe(kCMSampleBufferDroppedFrameReason_Discontinuity), "discontinuity")
		XCTAssertEqual(CameraDropReport.describe("SomethingNew" as CFString), "SomethingNew")
		XCTAssertEqual(CameraDropReport.describe(nil), "unknown reason")
	}
}
