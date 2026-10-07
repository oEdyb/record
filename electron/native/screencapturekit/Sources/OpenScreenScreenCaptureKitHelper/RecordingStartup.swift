import CoreMedia
import Foundation

/// Local readiness policy, not an Apple latency guarantee. The media epoch is
/// immutable even if a first encoder append or requested source arrives late.
struct RecordingStartup {
	static let sourceDeadlineSeconds = 2.0
	private(set) var epoch: CMTime?
	private(set) var isLive = false
	private(set) var lateSources: [String] = []
	private var cancelled = false
	let originals: Set<String>
	let audioTracks: Set<String>

	init(originals: Set<String> = [], audioTracks: Set<String> = []) {
		self.originals = originals; self.audioTracks = audioTracks
	}
	mutating func begin(at time: CMTime) { if epoch == nil { epoch = time } }
	/// Screen readiness makes the take live. Camera and audio join later on the same
	/// epoch: the ones still missing at the deadline are returned once so the caller can
	/// warn while the take keeps recording. A source that never arrives is reported again
	/// when its original finishes with no samples. Only the screen itself fails the take.
	mutating func checkDeadline(at now: CMTime, videoAppended: Bool, readyOriginals: Set<String>, readyAudio: Set<String>) throws -> [String] {
		guard !cancelled, let epoch, now.isNumeric,
			now - epoch >= CMTime(seconds: Self.sourceDeadlineSeconds, preferredTimescale: 1_000_000) else { return [] }
		guard videoAppended else {
			throw HelperError.writerSetupFailed("Recording startup exceeded two seconds waiting for screen video.")
		}
		guard isLive else {
			throw HelperError.writerSetupFailed("Recording startup exceeded two seconds waiting for the video timeline to catch up.")
		}
		let missing = originals.subtracting(readyOriginals).sorted() + audioTracks.subtracting(readyAudio).sorted().map { "\($0) AAC" }
		let newlyLate = missing.filter { !lateSources.contains($0) }
		lateSources += newlyLate
		return newlyLate
	}
	mutating func acknowledge(videoAppended: Bool, gridCaughtUp: Bool) -> Bool {
		guard !cancelled, !isLive, epoch != nil, videoAppended, gridCaughtUp else { return false }
		isLive = true
		return true
	}
	func backlogLimit(fps: Int) -> Int { isLive ? RecordingCadence.maximumCatchUpFrames : max(1, fps) }
	mutating func cancel() { cancelled = true }
}

/// Independent of media delivery: missing sources or permanently not-ready
/// inputs cannot leave Start waiting forever when no later samples arrive.
final class RecordingStartupWatchdog {
	private let timer: DispatchSourceTimer
	init(epoch: CMTime, queue: DispatchQueue, onDeadline: @escaping (CMTime) -> Void) {
		let deadline = epoch + CMTime(seconds: RecordingStartup.sourceDeadlineSeconds, preferredTimescale: 1_000_000)
		let remaining = max(0, CMTimeGetSeconds(deadline - CMClockGetTime(CMClockGetHostTimeClock())))
		timer = DispatchSource.makeTimerSource(queue: queue)
		timer.schedule(deadline: .now() + remaining, leeway: .milliseconds(1))
		timer.setEventHandler { onDeadline(deadline) }
		timer.resume()
	}
	func cancel() { timer.cancel() }
	deinit { timer.cancel() }
}
