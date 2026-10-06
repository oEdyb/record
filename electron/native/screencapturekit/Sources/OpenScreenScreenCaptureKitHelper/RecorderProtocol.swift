import Foundation

/// Serializes full async lifecycle operations. A plain actor is reentrant at every
/// `await`, which would still let Stop overtake Pause while AVAssetWriter finishes.
final class RecorderCommandExecutor: @unchecked Sendable {
	private let lock = NSLock()
	private var tail = Task<Void, Never> {}

	func submit(_ operation: @escaping @Sendable () async -> Void) -> Task<Void, Never> {
		lock.lock()
		let previous = tail
		let next = Task {
			await previous.value
			await operation()
		}
		tail = next
		lock.unlock()
		return next
	}
}

struct Rectangle: Decodable {
	let x: Double
	let y: Double
	let width: Double
	let height: Double
}

struct RecordingRequest: Decodable {
	struct Source: Decodable {
		let type: String
		let sourceId: String
		let displayId: UInt32?
		let windowId: UInt32?
		let excludedWindowIds: [UInt32]?
		let excludedProcessIds: [Int32]?
		let bounds: Rectangle?
	}

	struct Video: Decodable {
		let quality: String?
		let fps: Int
		let width: Int
		let height: Int
		let bitrate: Int?
		let hideSystemCursor: Bool
	}

	struct Audio: Decodable {
		struct SystemAudio: Decodable {
			let enabled: Bool
		}

		struct Microphone: Decodable {
			let enabled: Bool
			let deviceId: String?
			let deviceName: String?
			let gain: Double
		}

		let system: SystemAudio
		let microphone: Microphone
	}

	struct Webcam: Decodable, Equatable {
		let enabled: Bool
		let deviceId: String?
		let deviceName: String?
		let width: Int
		let height: Int
		let fps: Int
		/// High only: record exactly width × height at fps instead of the Automatic format.
		let exactFormat: Bool?
	}

	struct Cursor: Decodable {
		let mode: String
	}

	struct Outputs: Decodable {
		let screenPath: String
		let manifestPath: String?
	}

	let schemaVersion: Int?
	let recordingId: Int?
	let source: Source
	let video: Video
	let audio: Audio
	let webcam: Webcam
	let cursor: Cursor
	let outputs: Outputs
}

struct RecorderCommand: Decodable {
	let command: String
	let request: RecordingRequest?
}

enum HelperError: Error, CustomStringConvertible {
	case invalidArguments
	case unsupportedMacOS
	case unsupportedFeature(String)
	case sourceNotFound(String)
	case invalidSourceType(String)
	case permissionDenied(String)
	case writerSetupFailed(String)

	var description: String {
		switch self {
		case .invalidArguments:
			return "Expected one JSON recording request argument."
		case .unsupportedMacOS:
			return "ScreenCaptureKit recording requires macOS 13 or newer."
		case .unsupportedFeature(let message):
			return message
		case .sourceNotFound(let message):
			return message
		case .invalidSourceType(let sourceType):
			return "Unsupported source type: \(sourceType)."
		case .permissionDenied(let message):
			return message
		case .writerSetupFailed(let message):
			return message
		}
	}
}

func emit(_ fields: [String: Any]) {
	if let data = try? JSONSerialization.data(withJSONObject: fields, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func emitError(code: String, message: String) {
	emit([
		"event": "error",
		"code": code,
		"message": message,
	])
}
