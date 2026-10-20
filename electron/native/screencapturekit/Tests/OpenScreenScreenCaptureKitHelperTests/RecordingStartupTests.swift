import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingStartupTests: XCTestCase {
	private func time(_ seconds: Double) -> CMTime { CMTime(seconds: seconds, preferredTimescale: 600_000) }

	func testScreenVideoAndCaughtUpGridMakeTheTakeLiveWhileOtherSourcesJoinLater() throws {
		let originals: Set<String> = ["webcamVideoPath", "systemAudioPath", "microphoneAudioPath"]
		let tracks: Set<String> = ["mixed", "system", "microphone"]
		var startup = RecordingStartup(originals: originals, audioTracks: tracks)
		startup.begin(at: time(100)); startup.begin(at: time(101))
		XCTAssertEqual(startup.epoch, time(100), "Late successful append cannot move the source epoch")
		XCTAssertFalse(startup.acknowledge(videoAppended: false, gridCaughtUp: true))
		var grid = RecordingCadence(fps: 60)
		grid.begin(at: time(100), firstFramePending: true)
		let due = try grid.dueTimes(at: time(100.159), maximumCatchUpFrames: startup.backlogLimit(fps: 60))
		XCTAssertEqual(due.count, 10)
		XCTAssertEqual(due.first, time(100))
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: due.isEmpty), "159 ms debt cannot ACK and then immediately fail LIVE")
		for _ in due { grid.didAppend() }
		XCTAssertTrue(startup.acknowledge(videoAppended: true,
			gridCaughtUp: try grid.dueTimes(at: time(100.159), maximumCatchUpFrames: startup.backlogLimit(fps: 60)).isEmpty),
			"Camera and audio have not arrived yet, but the screen is recording")
		XCTAssertTrue(startup.isLive)
		XCTAssertEqual(startup.backlogLimit(fps: 60), 8)
		XCTAssertThrowsError(try grid.dueTimes(at: time(100.35), maximumCatchUpFrames: startup.backlogLimit(fps: 60)), "Post-ACK policy is the original133ms guard")

		XCTAssertEqual(try startup.checkDeadline(at: time(101.9), videoAppended: true, readyOriginals: [], readyAudio: []), [])
		XCTAssertEqual(try startup.checkDeadline(at: time(102), videoAppended: true,
			readyOriginals: originals.subtracting(["webcamVideoPath"]), readyAudio: tracks), ["webcamVideoPath"],
			"A live take keeps recording and names the late camera once")
		XCTAssertEqual(try startup.checkDeadline(at: time(102.5), videoAppended: true,
			readyOriginals: originals.subtracting(["webcamVideoPath"]), readyAudio: tracks), [], "The same late camera is not reported twice")
		XCTAssertEqual(try startup.checkDeadline(at: time(102), videoAppended: true, readyOriginals: originals, readyAudio: tracks), [])
	}

	func testOneSecondVideoBacklogIsBoundedSeparatelyFromTwoSecondSourceDeadline() throws {
		var startup = RecordingStartup(originals: ["webcamVideoPath"])
		startup.begin(at: time(100))
		var grid = RecordingCadence(fps: 60); grid.begin(at: time(100), firstFramePending: true)
		XCTAssertEqual(try grid.dueTimes(at: time(100.99), maximumCatchUpFrames: startup.backlogLimit(fps: 60)).count, 60)
		XCTAssertThrowsError(try grid.dueTimes(at: time(101), maximumCatchUpFrames: startup.backlogLimit(fps: 60)))
		XCTAssertEqual(try startup.checkDeadline(at: time(101.06), videoAppended: true, readyOriginals: [], readyAudio: []), [])
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true), "The previously observed1.06sec camera initialization remains valid when video is current")
		var next = RecordingStartup(originals: ["webcamVideoPath"]); next.begin(at: time(200))
		XCTAssertFalse(next.isLive); XCTAssertEqual(next.backlogLimit(fps: 60), 60)
		XCTAssertThrowsError(try next.checkDeadline(at: time(202), videoAppended: true, readyOriginals: [], readyAudio: []),
			"A take that is still not live two seconds after its first frame fails") { error in
			XCTAssertTrue("\(error)".contains("catch up"))
		}
		XCTAssertThrowsError(try next.checkDeadline(at: time(202), videoAppended: false, readyOriginals: [], readyAudio: [])) { error in
			XCTAssertTrue("\(error)".contains("screen video"))
		}
	}

	func testLateMicrophoneIsReportedWithoutAnotherMediaEventAndCancelledWatchdogCannotAck() async throws {
		let queue = DispatchQueue(label: "test.startup-no-media-events")
		let epoch = CMClockGetTime(CMClockGetHostTimeClock())
		let timeout = expectation(description: "Independent monotonic watchdog names the late microphone")
		var startup = RecordingStartup(originals: ["microphoneAudioPath"], audioTracks: ["microphone"])
		startup.begin(at: epoch)
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true))
		let live = startup
		let watchdog = RecordingStartupWatchdog(epoch: epoch, queue: queue) { deadline in
			var probe = live
			XCTAssertEqual(try? probe.checkDeadline(at: deadline, videoAppended: true, readyOriginals: [], readyAudio: []),
				["microphoneAudioPath", "microphone AAC"], "A late microphone is named, not fatal")
			XCTAssertEqual((deadline - epoch).seconds, 2, accuracy: 0.000001)
			timeout.fulfill()
		}
		let cancelled = RecordingStartupWatchdog(epoch: epoch, queue: queue) { _ in XCTFail("Paused/stopped old watchdog fired") }
		cancelled.cancel()
		await fulfillment(of: [timeout], timeout: 3)
		watchdog.cancel()
		startup.cancel()
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: true), "Late source success after Pause/Stop cannot ACK")
		XCTAssertEqual(try startup.checkDeadline(at: epoch + time(3), videoAppended: false, readyOriginals: [], readyAudio: []), [],
			"A cancelled startup never fails a paused or stopped take")
	}

	func testOnlyAClipShorterThanTheSourceAllowanceExcusesAnEmptyOriginal() {
		let start = CMTime(seconds: 10, preferredTimescale: 600)
		let after = { (seconds: Double) in start + CMTime(seconds: seconds, preferredTimescale: 600) }
		// A source that has not delivered on this stream gets the startup allowance.
		XCTAssertTrue(ScreenCaptureRecorder.originalMayBeEmpty(sourceAlreadyDelivered: false, start: start, end: after(1.5)))
		XCTAssertFalse(ScreenCaptureRecorder.originalMayBeEmpty(sourceAlreadyDelivered: false, start: start, end: after(2.5)))
		// One that already delivered is only excused for a few buffers after Continue.
		XCTAssertTrue(ScreenCaptureRecorder.originalMayBeEmpty(sourceAlreadyDelivered: true, start: start, end: after(0.3)))
		XCTAssertFalse(ScreenCaptureRecorder.originalMayBeEmpty(sourceAlreadyDelivered: true, start: start, end: after(1.5)))
	}
}
