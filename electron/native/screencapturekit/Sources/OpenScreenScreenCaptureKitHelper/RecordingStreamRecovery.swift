import Foundation
import ScreenCaptureKit

struct RecordingStreamRecovery {
	enum StopDisposition: Equatable {
		case ignored
		case pausedSourceUnavailable
		case activeFailure
	}
	let lifecycle: RecordingLifecycle
	init(lifecycle: RecordingLifecycle = RecordingLifecycle()) { self.lifecycle = lifecycle }
	var generation: UInt64 { lifecycle.capture.source.generation }
	var needsReplacement: Bool { lifecycle.capture.source.needsReplacement }
	var isSourceUsable: Bool { lifecycle.capture.source.usable }
	var canAttemptResume: Bool { lifecycle.capture.source.canAttemptResume }
	func install(_ stream: AnyObject) { lifecycle.transition(.installSource(ObjectIdentifier(stream))) }
	func acceptsSamples(from stream: AnyObject) -> Bool {
		let source = lifecycle.capture.source
		return source.identity == ObjectIdentifier(stream) && source.usable
	}
	func acceptsSamples(from stream: AnyObject, systemAudioStream: AnyObject?, isSystemAudio: Bool) -> Bool {
		if let systemAudioStream {
			if isSystemAudio { return stream === systemAudioStream }
			if stream === systemAudioStream { return false }
		}
		return acceptsSamples(from: stream)
	}
	func becameInactive(_ stream: AnyObject) -> Bool { lifecycle.transition(.sourceInactive(ObjectIdentifier(stream))).changed }
	func becameActive(_ stream: AnyObject) -> Bool { lifecycle.transition(.sourceActive(ObjectIdentifier(stream))).changed }
	func invalidate() { lifecycle.transition(.invalidateSource) }
	func stopped(_ stream: AnyObject) -> StopDisposition { lifecycle.transition(.sourceStopped(ObjectIdentifier(stream))).sourceStop }

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
