import Foundation
import ScreenCaptureKit
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingStreamRecoveryTests: XCTestCase {
	func testIndependentAudioAcceptsOnlyFullMixAndRejectsRetiredStreams() {
		let screen = NSObject()
		let audio = NSObject()
		let retired = NSObject()
		let recovery = RecordingStreamRecovery()
		recovery.install(screen)
		XCTAssertTrue(recovery.acceptsSamples(from: audio, systemAudioStream: audio, isSystemAudio: true))
		XCTAssertFalse(recovery.acceptsSamples(from: screen, systemAudioStream: audio, isSystemAudio: true))
		XCTAssertFalse(recovery.acceptsSamples(from: audio, systemAudioStream: audio, isSystemAudio: false))
		XCTAssertFalse(recovery.acceptsSamples(from: retired, systemAudioStream: audio, isSystemAudio: true))
		XCTAssertTrue(recovery.acceptsSamples(from: screen, systemAudioStream: audio, isSystemAudio: false))
		XCTAssertTrue(recovery.acceptsSamples(from: screen, systemAudioStream: nil, isSystemAudio: true))
		XCTAssertFalse(recovery.acceptsSamples(from: audio, systemAudioStream: nil, isSystemAudio: true))
	}

	func testClosedPausedSourceCanBeReplacedWithoutEndingTheLogicalSession() {
		let closedSource = NSObject(), selectedSource = NSObject()
		let recovery = RecordingStreamRecovery()
		recovery.install(closedSource)
		recovery.lifecycle.transition(.pause)
		XCTAssertTrue(recovery.acceptsSamples(from: closedSource))
		XCTAssertEqual(recovery.stopped(closedSource), .pausedSourceUnavailable)
		XCTAssertTrue(recovery.needsReplacement)
		XCTAssertTrue(recovery.canAttemptResume, "A stopped stream may be replaced on Continue")
		XCTAssertFalse(recovery.acceptsSamples(from: closedSource))
		XCTAssertTrue(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: false, acknowledgedClipIndex: 0, previousClipIndex: 0),
			"The previous committed clip was acknowledged; a screenshot failure before a new writer is still recoverable")
		recovery.install(selectedSource)
		XCTAssertFalse(recovery.needsReplacement)
		XCTAssertTrue(recovery.acceptsSamples(from: selectedSource))
		XCTAssertFalse(recovery.acceptsSamples(from: closedSource))
		XCTAssertEqual(recovery.stopped(closedSource), .ignored,
			"A late failed-source callback cannot stop the replacement recording")
		XCTAssertFalse(recovery.needsReplacement)
	}

	func testActiveCaptureFailureIsTerminalAndStopCallbacksCannotBecomeNewFailures() {
		let activeSource = NSObject()
		let recovery = RecordingStreamRecovery()
		recovery.install(activeSource)
		XCTAssertEqual(recovery.stopped(activeSource), .activeFailure)
		XCTAssertTrue(recovery.needsReplacement)
		XCTAssertEqual(recovery.stopped(activeSource), .ignored)
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: true, acknowledgedClipIndex: nil, previousClipIndex: 0))
		recovery.install(activeSource)
		recovery.lifecycle.transition(.stop)
		XCTAssertEqual(recovery.stopped(activeSource), .ignored)
		XCTAssertFalse(recovery.needsReplacement)
	}

	func testOnlyUnacknowledgedPausedRollbackCanRejectContinueRecoverably() {
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: false, stopping: false, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0))
		XCTAssertTrue(RecordingStreamRecovery.canRejectResume(paused: false, stopping: false, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0, resumePending: true),
			"An unacknowledged Continue remains retryable after the renderer-visible pause flag flips")
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: true, terminalFailure: false, acknowledgedClipIndex: nil, previousClipIndex: 0))
		XCTAssertFalse(RecordingStreamRecovery.canRejectResume(paused: true, stopping: false, terminalFailure: false, acknowledgedClipIndex: 1, previousClipIndex: 0))
		let recovery = RecordingStreamRecovery()
		let attemptedSource = NSObject()
		recovery.install(attemptedSource)
		recovery.invalidate()
		XCTAssertFalse(recovery.acceptsSamples(from: attemptedSource))
		XCTAssertEqual(recovery.stopped(attemptedSource), .ignored,
			"The failed start attempt was already classified while paused")
		XCTAssertTrue(recovery.needsReplacement)
	}

	func testInactiveSourceCannotResumeUntilItBecomesActiveAgain() {
		let source = NSObject(), unrelated = NSObject()
		let recovery = RecordingStreamRecovery()
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
		let recovery = RecordingStreamRecovery()
		recovery.install(source)
		XCTAssertTrue(recovery.becameInactive(source))
		recovery.lifecycle.transition(.pause)
		XCTAssertEqual(recovery.stopped(source), .pausedSourceUnavailable)
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
