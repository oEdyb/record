import Foundation
import ScreenCaptureKit
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingStreamRecoveryTests: XCTestCase {
	func testClosedPausedSourceCanBeReplacedWithoutEndingTheLogicalSession() {
		let closedSource = NSObject(), selectedSource = NSObject()
		var recovery = RecordingStreamRecovery()
		recovery.install(closedSource)
		XCTAssertTrue(recovery.acceptsSamples(from: closedSource))
		XCTAssertEqual(recovery.stopped(closedSource, paused: true, stopping: false), .pausedSourceUnavailable)
		XCTAssertTrue(recovery.needsReplacement)
		XCTAssertTrue(recovery.canAttemptResume, "A stopped stream may be replaced on Continue")
		XCTAssertFalse(recovery.acceptsSamples(from: closedSource))
		XCTAssertTrue(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: false, acknowledgedClipIndex: 0, previousClipIndex: 0),
			"The previous committed clip was acknowledged; a screenshot failure before a new writer is still recoverable")
		recovery.install(selectedSource)
		XCTAssertFalse(recovery.needsReplacement)
		XCTAssertTrue(recovery.acceptsSamples(from: selectedSource))
		XCTAssertFalse(recovery.acceptsSamples(from: closedSource))
		XCTAssertEqual(recovery.stopped(closedSource, paused: false, stopping: false), .ignored,
			"A late failed-source callback cannot stop the replacement recording")
		XCTAssertFalse(recovery.needsReplacement)
	}

	func testActiveCaptureFailureIsTerminalAndStopCallbacksCannotBecomeNewFailures() {
		let activeSource = NSObject()
		var recovery = RecordingStreamRecovery()
		recovery.install(activeSource)
		XCTAssertEqual(recovery.stopped(activeSource, paused: false, stopping: false), .activeFailure)
		XCTAssertTrue(recovery.needsReplacement)
		XCTAssertEqual(recovery.stopped(activeSource, paused: true, stopping: false), .ignored)
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: true, acknowledgedClipIndex: nil, previousClipIndex: 0))
		recovery.install(activeSource)
		XCTAssertEqual(recovery.stopped(activeSource, paused: false, stopping: true), .ignored)
		XCTAssertFalse(recovery.needsReplacement)
	}

	func testOnlyUnacknowledgedPausedRollbackCanRejectContinueRecoverably() {
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: false, stopping: false, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0))
		XCTAssertTrue(RecordingStreamRecovery.canRejectResume(paused: false, stopping: false, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0, resumePending: true),
			"An unacknowledged Continue remains retryable after the renderer-visible pause flag flips")
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: true, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0))
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: false, acknowledgedClipIndex: 1, previousClipIndex: 0))
		var recovery = RecordingStreamRecovery()
		let attemptedSource = NSObject()
		recovery.install(attemptedSource)
		recovery.invalidate()
		XCTAssertFalse(recovery.acceptsSamples(from: attemptedSource))
		XCTAssertEqual(recovery.stopped(attemptedSource, paused: false, stopping: false), .ignored,
			"The failed start attempt was already classified while paused")
		XCTAssertTrue(recovery.needsReplacement)
	}

	func testInactiveSourceCannotResumeUntilItBecomesActiveAgain() {
		let source = NSObject(), unrelated = NSObject()
		var recovery = RecordingStreamRecovery()
		recovery.install(source)
		let activeGeneration = recovery.generation
		XCTAssertTrue(recovery.isSourceUsable)
		XCTAssertTrue(recovery.becameInactive(source))
		XCTAssertGreaterThan(recovery.generation, activeGeneration)
		XCTAssertFalse(recovery.canAttemptResume)
		XCTAssertFalse(recovery.isSourceUsable)
		XCTAssertFalse(recovery.acceptsSamples(from: source))
		XCTAssertFalse(recovery.becameInactive(source), "Repeated inactivity must not emit another transition")
		XCTAssertFalse(recovery.becameActive(unrelated))
		XCTAssertFalse(recovery.isSourceUsable)
		XCTAssertTrue(recovery.becameActive(source))
		XCTAssertTrue(recovery.isSourceUsable)
		XCTAssertTrue(recovery.acceptsSamples(from: source))
	}

	func testStoppedSourceCannotBeRevivedByActivityCallbacks() {
		let source = NSObject(), replacement = NSObject()
		var recovery = RecordingStreamRecovery()
		recovery.install(source)
		XCTAssertTrue(recovery.becameInactive(source))
		XCTAssertEqual(recovery.stopped(source, paused: true, stopping: false), .pausedSourceUnavailable)
		XCTAssertTrue(recovery.needsReplacement)
		XCTAssertFalse(recovery.becameActive(source))
		XCTAssertFalse(recovery.isSourceUsable)
		recovery.install(replacement)
		XCTAssertTrue(recovery.isSourceUsable)
		XCTAssertFalse(recovery.becameInactive(source))
		XCTAssertTrue(recovery.isSourceUsable)
	}

	func testNamesTheStopReasonsAUserCanActOn() {
		let stopped = NSError(domain: SCStreamErrorDomain, code: -3821)
		XCTAssertEqual(RecordingStreamRecovery.stopMessage(for: stopped), "macOS stopped the screen capture.")
		let full = NSError(domain: SCStreamErrorDomain, code: -3822)
		XCTAssertTrue(RecordingStreamRecovery.stopMessage(for: full).contains("disk is full"))
		let other = NSError(domain: NSCocoaErrorDomain, code: 4)
		XCTAssertEqual(RecordingStreamRecovery.stopMessage(for: other), "\(other)")
	}
}
