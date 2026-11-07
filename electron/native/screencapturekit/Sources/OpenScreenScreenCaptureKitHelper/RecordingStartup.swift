import CoreMedia
import Foundation

/// Local readiness policy, not an Apple latency guarantee. The media epoch is
/// immutable even if a first encoder append or requested source arrives late.
struct RecordingStartup {
	static let sourceDeadlineSeconds = 2.0
	let lifecycle: RecordingLifecycle
	init(originals: Set<String> = [], audioTracks: Set<String> = [], lifecycle: RecordingLifecycle = RecordingLifecycle()) {
		self.lifecycle = lifecycle
		configure(originals: originals, audioTracks: audioTracks)
	}
	var epoch: CMTime? { lifecycle.capture.clip.startup?.epoch }
	var isLive: Bool { lifecycle.capture.clip.isLive }
	var lateSources: [String] { lifecycle.capture.clip.startup?.lateSources ?? [] }
	var originals: Set<String> { lifecycle.capture.clip.inputs.originals }
	var audioTracks: Set<String> { lifecycle.capture.clip.inputs.audioTracks }
	@discardableResult func configure(originals: Set<String>, audioTracks: Set<String>, clipIndex: Int = 0) -> Bool {
		lifecycle.transition(.prepareClip(RecordingLifecycle.Inputs(originals: originals, audioTracks: audioTracks), index: clipIndex)).accepted
	}
	func begin(at time: CMTime) { lifecycle.transition(.beginEpoch(time)) }
	func checkDeadline(at now: CMTime, videoAppended: Bool, readyOriginals: Set<String>, readyAudio: Set<String>) throws -> [String] {
		let result = lifecycle.transition(.checkDeadline(now: now, videoAppended: videoAppended, originals: readyOriginals, audio: readyAudio))
		if let error = result.error { throw error }
		return result.lateSources
	}
	func acknowledge(videoAppended: Bool, gridCaughtUp: Bool, expectedGeneration: UInt64? = nil) -> Bool {
		acknowledgeClip(videoAppended: videoAppended, gridCaughtUp: gridCaughtUp, expectedGeneration: expectedGeneration) != nil
	}
	func acknowledgeClip(videoAppended: Bool, gridCaughtUp: Bool, expectedGeneration: UInt64? = nil) -> Int? {
		lifecycle.transition(.acknowledge(videoAppended: videoAppended, gridCaughtUp: gridCaughtUp, expectedGeneration: expectedGeneration)).acknowledgedIndex
	}
	func backlogLimit(fps: Int) -> Int { isLive ? RecordingCadence.maximumCatchUpFrames : max(1, fps) }
	func cancel() { lifecycle.transition(.cancelReadiness) }
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
