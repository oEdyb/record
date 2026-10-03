import Foundation
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingBoundaryWarningsTests: XCTestCase {
	func testClosingFailureReachesBothPausedAndStoppedResults() {
		var warnings = RecordingBoundaryWarnings()
		let revision = warnings.revision
		let message = warnings.record(NSError(domain: "recording-test", code: 1))
		XCTAssertEqual(warnings.pauseFailure(since: revision), message)
		XCTAssertEqual(warnings.stoppedWarning(finalClipWarning: nil), [
			"code": "final-screen-frame-failed", "message": message,
		])
	}

	func testRepeatedIdenticalFailureStillWarnsForTheNextClip() {
		var warnings = RecordingBoundaryWarnings()
		_ = warnings.record(NSError(domain: "recording-test", code: 1))
		let revision = warnings.revision
		XCTAssertNil(warnings.pauseFailure(since: revision))
		let nextMessage = warnings.record(NSError(domain: "recording-test", code: 1))
		XCTAssertEqual(warnings.pauseFailure(since: revision), nextMessage)
	}

	func testStopPreservesWriterFinalizationFailureAlongsideTheBoundaryFailure() {
		var warnings = RecordingBoundaryWarnings()
		let boundaryMessage = warnings.record(NSError(domain: "recording-test", code: 1))
		XCTAssertEqual(warnings.stoppedWarning(finalClipWarning: [
			"code": "final-clip-failed", "message": "Writer finalization failed",
		]), [
			"code": "final-clip-failed", "message": "Writer finalization failed \(boundaryMessage)",
		])
	}

	func testHealthyBoundariesRemainSuccessful() {
		let warnings = RecordingBoundaryWarnings()
		XCTAssertNil(warnings.pauseFailure(since: warnings.revision))
		XCTAssertNil(warnings.stoppedWarning(finalClipWarning: nil))
	}
}
