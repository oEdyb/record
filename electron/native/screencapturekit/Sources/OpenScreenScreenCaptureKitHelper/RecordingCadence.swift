import CoreMedia

/// Host-clock grid; repeated pixels are counted separately from captured frames.
struct RecordingCadence {
	private(set) var anchor: CMTime?
	private(set) var nextFrame: Int64 = 1
	let fps: Int
	static let maximumCatchUpFrames = 8
	mutating func begin(at time: CMTime, firstFramePending: Bool = false) { anchor = time; nextFrame = firstFramePending ? 0 : 1 }
	mutating func reset() { anchor = nil; nextFrame = 1 }
	func dueTimes(at now: CMTime, maximumCatchUpFrames: Int = maximumCatchUpFrames) throws -> [CMTime] {
		guard let anchor, now.isNumeric, now >= anchor else { return [] }
		let elapsed = CMTimeConvertScale(now - anchor, timescale: CMTimeScale(max(1, fps)), method: .roundTowardZero).value
		guard elapsed >= nextFrame else { return [] }
		guard elapsed - nextFrame < maximumCatchUpFrames else {
			throw HelperError.writerSetupFailed(maximumCatchUpFrames == Self.maximumCatchUpFrames
				? "The screen encoder stopped accepting frames for two seconds."
				: "Recording startup exceeded its one-second video backlog.")
		}
		return (nextFrame...elapsed).map { anchor + CMTime(value: $0, timescale: CMTimeScale(max(1, fps))) }
	}
	/// Close only through the already frozen Pause/Stop host timestamp. Teardown
	/// time must never become extra content. Each interior sample stays on-grid;
	/// only the last sample can have a shorter duration.
	func closingFrames(endingAt endTime: CMTime) throws -> [(time: CMTime, duration: CMTime)] {
		guard let anchor, endTime.isNumeric, endTime > anchor else { return [] }
		let rate = CMTimeScale(max(1, fps))
		let elapsed = CMTimeConvertScale(endTime - anchor, timescale: rate, method: .roundTowardZero).value
		guard elapsed >= nextFrame else { return [] }
		// Finalization retries have one total second; bound retained boundary samples
		// independently of the live scheduler's stricter lag limit.
		guard elapsed - nextFrame < Int64(max(1, fps)) else {
			throw HelperError.writerSetupFailed("The recording boundary is more than one second behind the last written frame.")
		}
		let interval = CMTime(value: 1, timescale: rate)
		return (nextFrame...elapsed).compactMap { index in
			let time = anchor + CMTime(value: index, timescale: rate)
			let duration = min(interval, endTime - time)
			return duration > .zero ? (time, duration) : nil
		}
	}
	mutating func didAppend() { nextFrame += 1 }
	/// How long the encoder may refuse every frame before the take stops loudly.
	static let maximumWriterStallSeconds = 2.0
	/// Drops the grid frames a busy encoder could not take and keeps the newest
	/// one due. The previous picture stays up a little longer; nothing is retimed.
	mutating func skipBacklog(at now: CMTime) -> Int {
		guard let anchor, now.isNumeric, now >= anchor else { return 0 }
		let elapsed = CMTimeConvertScale(now - anchor, timescale: CMTimeScale(max(1, fps)), method: .roundTowardZero).value
		guard elapsed > nextFrame else { return 0 }
		let dropped = Int(elapsed - nextFrame)
		nextFrame = elapsed
		return dropped
	}
	/// A brief encoder backlog is skipped; one that lasts is a failed writer.
	static func writerStalled(lastAppended: CMTime?, at now: CMTime) -> Bool {
		guard let lastAppended, lastAppended.isNumeric, now.isNumeric else { return true }
		return now - lastAppended >= CMTime(seconds: maximumWriterStallSeconds, preferredTimescale: 1_000_000)
	}
}

enum RecordingQualityPolicy {
	static func bitrate(quality: String?, legacyBitrate: Int?) -> Int {
		switch quality {
		case "high": return 136_000_000
		case "standard": return 68_000_000
		default: return legacyBitrate ?? 18_000_000
		}
	}
}


extension RecordingQualityPolicy {
	static func cameraBitrate(quality: String?, width: Int, height: Int, fps: Int) -> Int {
		let pixels = width * height
		let base = pixels >= 3840 * 2160 ? 45_000_000 : pixels >= 2560 * 1440 ? 28_000_000 : 18_000_000
		let standard = Int((Double(base) * (fps >= 60 ? 1.7 : 1)).rounded())
		return quality == "high" ? standard * 2 : standard
	}
}


/// Attempt every rollback phase; one failure must not prevent restoring another source.
enum RecordingSetupRollback {
	static func run(_ phases: [(String, () async throws -> Void)]) async -> [String] {
		var failures: [String] = []
		for (label, restore) in phases {
			do { try await restore() } catch { failures.append("\(label): \(error)") }
		}
		return failures
	}
}

/// Terminal capture failure freezes content even if recovery Stop arrives later.
/// Used under stateQueue, with the same monotonic host clock as capture samples.
struct RecordingTerminationBoundary {
	private(set) var failureTime: CMTime?
	mutating func recordFailure(at time: CMTime) {
		guard time.isNumeric else { return }
		// Independent source owners can deliver callbacks out of detection order.
		// The first actual failure is the earliest host time, not callback arrival.
		failureTime = failureTime.map { min($0, time) } ?? time
	}
	func endingAt(_ requestedTime: CMTime) -> CMTime {
		guard let failureTime else { return requestedTime }
		return min(requestedTime, failureTime)
	}
}
