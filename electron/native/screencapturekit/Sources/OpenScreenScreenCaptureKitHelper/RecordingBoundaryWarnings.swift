import Foundation

struct RecordingBoundaryWarnings {
	private(set) var revision = 0
	private var latestMessage: String?

	mutating func record(_ error: Error) -> String {
		revision += 1
		let message = "The final screen frame could not be saved: \(error). Existing clip frames were kept."
		latestMessage = message
		return message
	}

	func pauseFailure(since previousRevision: Int) -> String? {
		revision > previousRevision ? latestMessage : nil
	}

	func stoppedWarning(finalClipWarning: [String: String]?) -> [String: String]? {
		let messages = [finalClipWarning?["message"], latestMessage].compactMap { $0 }
		guard !messages.isEmpty else { return nil }
		return [
			"code": finalClipWarning?["code"] ?? "final-screen-frame-failed",
			"message": messages.joined(separator: " "),
		]
	}
}
