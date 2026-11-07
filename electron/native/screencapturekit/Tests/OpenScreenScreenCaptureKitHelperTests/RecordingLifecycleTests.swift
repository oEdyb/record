import CoreMedia
import Foundation
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingLifecycleTests: XCTestCase {
	private let source = NSObject()
	private func epoch(_ value: Double) -> CMTime { CMTime(seconds: value, preferredTimescale: 600_000) }

	func testIllegalResumeAndWriterReplacementAreRejectedAndLoggedWithoutChangingLiveEpoch() {
		var rejected: [String] = []
		let lifecycle = RecordingLifecycle { from, event in rejected.append("\(from):\(event)") }
		lifecycle.transition(.installSource(ObjectIdentifier(source)))
		let startup = RecordingStartup(lifecycle: lifecycle)
		startup.begin(at: epoch(100))
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true))
		XCTAssertFalse(lifecycle.transition(.beginResume(generation: 1, previousClipIndex: 0)).accepted)
		XCTAssertFalse(lifecycle.transition(.prepareClip(.init(), index: 1)).accepted)
		XCTAssertFalse(lifecycle.transition(.detachWriter).accepted)
		XCTAssertEqual(rejected, ["live:begin-resume", "live:prepare-clip", "live:detach-writer"])
		XCTAssertEqual(lifecycle.name, "live")
		XCTAssertEqual(startup.epoch, epoch(100))
		XCTAssertTrue(lifecycle.capture.clip.hasSession)
	}

	func testStopDuringUnacknowledgedContinueCoalescesAndWaitsForFinalization() async throws {
		var rejected: [String] = []
		let lifecycle = RecordingLifecycle { _, event in rejected.append(event) }
		lifecycle.transition(.installSource(ObjectIdentifier(source)))
		lifecycle.transition(.pause)
		XCTAssertTrue(lifecycle.transition(.beginResume(generation: 1, previousClipIndex: 0)).accepted)
		let first = lifecycle.transition(.stop)
		let second = lifecycle.transition(.stop)
		let owner = try XCTUnwrap(first.stop), joined = try XCTUnwrap(second.stop)
		XCTAssertTrue(owner === joined)
		XCTAssertTrue(first.ownsStop)
		XCTAssertFalse(second.ownsStop)
		XCTAssertTrue(first.accepted && second.accepted)
		XCTAssertEqual(lifecycle.name, "stopping")
		let completed = expectation(description: "Overlapping Stop waits for finalization")
		let waiter = Task { await joined.wait(); completed.fulfill() }
		await Task.yield()
		XCTAssertEqual(lifecycle.name, "stopping")
		lifecycle.transition(.stopped)
		owner.finish()
		await fulfillment(of: [completed], timeout: 1)
		await waiter.value
		let repeated = lifecycle.transition(.stop)
		XCTAssertFalse(repeated.ownsStop)
		await repeated.stop?.wait()
		XCTAssertTrue(rejected.isEmpty)
	}

	func testCompletedLifecycleRejectsAndLogsNewSourceWithoutChangingGeneration() {
		var rejected: [String] = []
		let lifecycle = RecordingLifecycle { from, event in rejected.append("\(from):\(event)") }
		lifecycle.transition(.installSource(ObjectIdentifier(source)))
		let generation = lifecycle.capture.source.generation
		let stop = lifecycle.transition(.stop)
		lifecycle.transition(.stopped)
		stop.stop?.finish()
		XCTAssertFalse(lifecycle.transition(.installSource(ObjectIdentifier(NSObject()))).accepted)
		XCTAssertEqual(lifecycle.capture.source.generation, generation)
		XCTAssertEqual(rejected, ["completed:install-source"])
	}

	func testSourceGenerationAndStartupViewsShareOneAuthority() {
		let lifecycle = RecordingLifecycle(log: { _, _ in })
		let recovery = RecordingStreamRecovery(lifecycle: lifecycle)
		let startup = RecordingStartup(lifecycle: lifecycle)
		recovery.install(source)
		startup.begin(at: epoch(100))
		let generation = recovery.generation
		XCTAssertTrue(recovery.becameInactive(source))
		XCTAssertEqual(lifecycle.name, "source-inactive")
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: true, expectedGeneration: generation))
		XCTAssertTrue(recovery.becameActive(source))
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: true, expectedGeneration: generation))
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true, expectedGeneration: recovery.generation))
		XCTAssertEqual(lifecycle.name, "live")
	}

	func testCancellingReadinessRetainsWriterSessionUntilItIsDetached() {
		let lifecycle = RecordingLifecycle(log: { _, _ in })
		lifecycle.transition(.installSource(ObjectIdentifier(source)))
		let startup = RecordingStartup(lifecycle: lifecycle)
		startup.begin(at: epoch(100))
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true))
		lifecycle.transition(.pause)
		startup.cancel()
		XCTAssertTrue(lifecycle.capture.clip.hasSession, "Pause/Stop still has real footage to finalize")
		XCTAssertEqual(startup.epoch, epoch(100))
		lifecycle.transition(.detachWriter)
		XCTAssertFalse(lifecycle.capture.clip.hasSession)
	}
}
