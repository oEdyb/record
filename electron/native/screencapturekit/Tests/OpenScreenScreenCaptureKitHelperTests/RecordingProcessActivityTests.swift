import Foundation
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingProcessActivityTests: XCTestCase {
	func testCaptureFailureKeepsFinalizationActive() {
		var starts = 0
		var ends = 0
		let activity = RecordingProcessActivity(begin: { starts += 1; return NSObject() }, end: { _ in ends += 1 })
		let capture = activity.acquire()
		let finalization = activity.acquire()
		capture.end()
		capture.end()
		XCTAssertEqual(starts, 1)
		XCTAssertEqual(ends, 0)
		finalization.end()
		finalization.end()
		XCTAssertEqual(ends, 1)
	}

	func testContinueAfterPauseBeginsNewActivity() {
		var starts = 0
		var ends = 0
		let activity = RecordingProcessActivity(begin: { starts += 1; return NSObject() }, end: { _ in ends += 1 })
		let first = activity.acquire()
		first.end()
		let second = activity.acquire()
		first.end()
		XCTAssertEqual(starts, 2)
		XCTAssertEqual(ends, 1)
		second.end()
		XCTAssertEqual(ends, 2)
	}

	func testAbandonedLeaseEndsActivity() {
		var ends = 0
		let activity = RecordingProcessActivity(begin: { NSObject() }, end: { _ in ends += 1 })
		var lease: RecordingProcessActivity.Lease? = activity.acquire()
		XCTAssertNotNil(lease)
		lease = nil
		XCTAssertEqual(ends, 1)
	}
}
