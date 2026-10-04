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

		XCTAssertNoThrow(try startup.checkDeadline(at: time(101.9), videoAppended: true, readyOriginals: [], readyAudio: []))
		XCTAssertThrowsError(try startup.checkDeadline(at: time(102), videoAppended: true,
			readyOriginals: originals.subtracting(["webcamVideoPath"]), readyAudio: tracks), "A live take still fails loudly when the camera never arrives") { error in
			XCTAssertTrue("\(error)".contains("webcamVideoPath"))
		}
		XCTAssertNoThrow(try startup.checkDeadline(at: time(102), videoAppended: true, readyOriginals: originals, readyAudio: tracks))
	}

	func testOneSecondVideoBacklogIsBoundedSeparatelyFromTwoSecondSourceDeadline() throws {
		var startup = RecordingStartup(originals: ["webcamVideoPath"])
		startup.begin(at: time(100))
		var grid = RecordingCadence(fps: 60); grid.begin(at: time(100), firstFramePending: true)
		XCTAssertEqual(try grid.dueTimes(at: time(100.99), maximumCatchUpFrames: startup.backlogLimit(fps: 60)).count, 60)
		XCTAssertThrowsError(try grid.dueTimes(at: time(101), maximumCatchUpFrames: startup.backlogLimit(fps: 60)))
		XCTAssertNoThrow(try startup.checkDeadline(at: time(101.06), videoAppended: true, readyOriginals: [], readyAudio: []))
		XCTAssertTrue(startup.acknowledge(videoAppended: true, gridCaughtUp: true), "The previously observed1.06sec camera initialization remains valid when video is current")
		var next = RecordingStartup(originals: ["webcamVideoPath"]); next.begin(at: time(200))
		XCTAssertFalse(next.isLive); XCTAssertEqual(next.backlogLimit(fps: 60), 60)
		XCTAssertThrowsError(try next.checkDeadline(at: time(202), videoAppended: true, readyOriginals: [], readyAudio: []))
	}

	func testMissingMicrophoneTimesOutWithoutAnotherMediaEventAndCancelledWatchdogCannotAck() async throws {
		let queue = DispatchQueue(label: "test.startup-no-media-events")
		let epoch = CMClockGetTime(CMClockGetHostTimeClock())
		let timeout = expectation(description: "Independent monotonic watchdog diagnoses missing microphone")
		var startup = RecordingStartup(originals: ["microphoneAudioPath"], audioTracks: ["microphone"])
		startup.begin(at: epoch)
		let waiting = startup
		let watchdog = RecordingStartupWatchdog(epoch: epoch, queue: queue) { deadline in
			do { try waiting.checkDeadline(at: deadline, videoAppended: true, readyOriginals: [], readyAudio: []); XCTFail("Missing source was silently acknowledged") }
			catch { XCTAssertTrue("\(error)".contains("microphone")); XCTAssertTrue("\(error)".contains("two seconds")) }
			XCTAssertEqual((deadline - epoch).seconds, 2, accuracy: 0.000001)
			timeout.fulfill()
		}
		let cancelled = RecordingStartupWatchdog(epoch: epoch, queue: queue) { _ in XCTFail("Paused/stopped old watchdog fired") }
		cancelled.cancel()
		await fulfillment(of: [timeout], timeout: 3)
		watchdog.cancel()
		startup.cancel()
		XCTAssertFalse(startup.acknowledge(videoAppended: true, gridCaughtUp: true), "Late source success after Pause/Stop cannot ACK")
		XCTAssertNoThrow(try startup.checkDeadline(at: epoch + time(3), videoAppended: false, readyOriginals: [], readyAudio: []))
	}
}
