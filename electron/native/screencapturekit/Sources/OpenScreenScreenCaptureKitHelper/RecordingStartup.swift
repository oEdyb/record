import CoreMedia
import Foundation

/// Local readiness policy, not an Apple latency guarantee. The media epoch is
/// immutable even if a first encoder append or requested source arrives late.
struct RecordingStartup {
	static let sourceDeadlineSeconds = 2.0
	private(set) var epoch: CMTime?
	private(set) var isLive = false
	private var cancelled = false
	let originals: Set<String>
	let audioTracks: Set<String>

	init(originals: Set<String> = [], audioTracks: Set<String> = []) {
		self.originals = originals; self.audioTracks = audioTracks
	}
	mutating func begin(at time: CMTime) { if epoch == nil { epoch = time } }
	func checkDeadline(at now: CMTime, videoAppended: Bool, readyOriginals: Set<String>, readyAudio: Set<String>) throws {
		guard !cancelled, !isLive, let epoch, now.isNumeric,
			now - epoch >= CMTime(seconds: Self.sourceDeadlineSeconds, preferredTimescale: 1_000_000) else { return }
		var missing = originals.subtracting(readyOriginals).sorted() + audioTracks.subtracting(readyAudio).sorted().map { "\($0) AAC" }
		if !videoAppended { missing.insert("screen video", at: 0) }
		if missing.isEmpty { missing = ["the video timeline to catch up"] }
		throw HelperError.writerSetupFailed("Recording startup exceeded two seconds waiting for \(missing.joined(separator: ", ")).")
	}
	mutating func acknowledge(videoAppended: Bool, readyOriginals: Set<String>, readyAudio: Set<String>, gridCaughtUp: Bool) -> Bool {
		guard !cancelled, !isLive, epoch != nil, videoAppended, originals.isSubset(of: readyOriginals),
			audioTracks.isSubset(of: readyAudio), gridCaughtUp else { return false }
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
