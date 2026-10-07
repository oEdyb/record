import CoreMedia
import Foundation

/// A freshly replaced stream delivers its first frame tens of milliseconds after it starts,
/// while an `SCScreenshotManager` capture costs about 600 ms. Continue waits briefly for that
/// frame and only falls back to the screenshot when the stream stays silent.
enum ResumeSeedWait {
	static let budget: TimeInterval = 0.3
	static let pollInterval: TimeInterval = 0.02

	struct Result {
		let frame: CMSampleBuffer?
		let waitedMs: Int
	}

	static func firstFrame(
		budget: TimeInterval = budget,
		now: () -> Date = Date.init,
		sleep: (TimeInterval) async throws -> Void = { try await Task.sleep(nanoseconds: UInt64($0 * 1_000_000_000)) },
		frame: () throws -> CMSampleBuffer?
	) async throws -> Result {
		let startedAt = now()
		while true {
			if let frame = try frame() {
				return Result(frame: frame, waitedMs: Int((now().timeIntervalSince(startedAt) * 1000).rounded()))
			}
			let elapsed = now().timeIntervalSince(startedAt)
			guard elapsed < budget else {
				return Result(frame: nil, waitedMs: Int((elapsed * 1000).rounded()))
			}
			try await sleep(min(pollInterval, budget - elapsed))
		}
	}
}
