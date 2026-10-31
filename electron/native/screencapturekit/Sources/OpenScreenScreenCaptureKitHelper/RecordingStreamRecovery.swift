import Foundation
import ScreenCaptureKit

struct RecordingStreamRecovery {
	enum StopDisposition: Equatable {
		case ignored
		case pausedSourceUnavailable
		case activeFailure
	}
	private var current: ObjectIdentifier?
	private var sourceIsInactive = false
	private(set) var needsReplacement = false
	private(set) var generation: UInt64 = 0

	var isSourceUsable: Bool {
		current != nil && !needsReplacement && !sourceIsInactive
	}

	var canAttemptResume: Bool {
		current != nil && !sourceIsInactive
	}

	mutating func install(_ stream: AnyObject) {
		current = ObjectIdentifier(stream)
		needsReplacement = false
		sourceIsInactive = false
		generation &+= 1
	}

	func acceptsSamples(from stream: AnyObject) -> Bool {
		current == ObjectIdentifier(stream) && isSourceUsable
	}

	func acceptsSamples(from stream: AnyObject, systemAudioStream: AnyObject?, isSystemAudio: Bool) -> Bool {
		if let systemAudioStream {
			if isSystemAudio { return stream === systemAudioStream }
			if stream === systemAudioStream { return false }
		}
		return acceptsSamples(from: stream)
	}

	mutating func becameInactive(_ stream: AnyObject) -> Bool {
		guard current == ObjectIdentifier(stream), !needsReplacement, !sourceIsInactive else { return false }
		sourceIsInactive = true
		generation &+= 1
		return true
	}

	mutating func becameActive(_ stream: AnyObject) -> Bool {
		guard current == ObjectIdentifier(stream), !needsReplacement, sourceIsInactive else { return false }
		sourceIsInactive = false
		return true
	}

	mutating func invalidate() { needsReplacement = true }

	mutating func stopped(_ stream: AnyObject, paused: Bool, stopping: Bool) -> StopDisposition {
		guard current == ObjectIdentifier(stream), !stopping, !needsReplacement else { return .ignored }
		needsReplacement = true
		return paused ? .pausedSourceUnavailable : .activeFailure
	}

	static func canRejectResume(paused: Bool, stopping: Bool, terminalFailure: Bool,
		acknowledgedClipIndex: Int?, previousClipIndex: Int, resumePending: Bool = false) -> Bool {
		(paused || resumePending) && !stopping && !terminalFailure &&
			(acknowledgedClipIndex.map { $0 <= previousClipIndex } ?? true)
	}

	static func rejectedResumePayload(previousClipIndex: Int, message: String) -> [String: Any] {
		["event": "error", "code": "clip-resume-rejected", "clipIndex": previousClipIndex + 1, "message": message]
	}

	/// The stop reasons a user can act on, named in plain words; anything else keeps its
	/// framework description. Codes: SCError.h (-3817 macOS 12.3, -3821 15.0, -3822 27.0).
	static func stopMessage(for error: Error) -> String {
		let nsError = error as NSError
		guard nsError.domain == SCStreamErrorDomain else { return "\(error)" }
		switch nsError.code {
		case -3817: return "Screen sharing was stopped from the menu bar."
		case -3821: return "macOS stopped the screen capture."
		case -3822: return "The disk is full, so macOS stopped the screen capture."
		default: return "\(error)"
		}
	}
}
