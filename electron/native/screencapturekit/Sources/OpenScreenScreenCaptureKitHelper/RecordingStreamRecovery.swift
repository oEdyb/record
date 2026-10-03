import Foundation

struct RecordingStreamRecovery {
	enum StopDisposition: Equatable {
		case ignored
		case pausedSourceUnavailable
		case activeFailure
	}
	private var current: ObjectIdentifier?
	private(set) var needsReplacement = false

	mutating func install(_ stream: AnyObject) {
		current = ObjectIdentifier(stream)
		needsReplacement = false
	}

	func acceptsSamples(from stream: AnyObject) -> Bool {
		current == ObjectIdentifier(stream) && !needsReplacement
	}

	mutating func invalidate() { needsReplacement = true }

	mutating func stopped(_ stream: AnyObject, paused: Bool, stopping: Bool) -> StopDisposition {
		guard current == ObjectIdentifier(stream), !stopping, !needsReplacement else { return .ignored }
		needsReplacement = true
		return paused ? .pausedSourceUnavailable : .activeFailure
	}

	static func canRejectResume(paused: Bool, stopping: Bool, terminalFailure: Bool,
		acknowledgedClipIndex: Int?, previousClipIndex: Int) -> Bool {
		paused && !stopping && !terminalFailure && (acknowledgedClipIndex.map { $0 <= previousClipIndex } ?? true)
	}

	static func rejectedResumePayload(previousClipIndex: Int, message: String) -> [String: Any] {
		["event": "error", "code": "clip-resume-rejected", "clipIndex": previousClipIndex + 1, "message": message]
	}
}
