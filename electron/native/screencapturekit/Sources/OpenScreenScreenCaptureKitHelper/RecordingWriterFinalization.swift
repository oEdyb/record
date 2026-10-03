import AVFoundation
import CoreMedia

/// Runs on the screen sample queue after every audio/source owner finishes.
/// Every compatibility audio append must return before ending the screen session.
@available(macOS 13.0, *)
enum RecordingWriterFinalization {
	static func finishInputs(writer: AVAssetWriter, videoInput: AVAssetWriterInput?, audioInputs: [AVAssetWriterInput],
		endingAt: CMTime?) {
		if let endingAt, writer.status == .writing {
			writer.endSession(atSourceTime: endingAt)
		}
		videoInput?.markAsFinished()
		audioInputs.forEach { $0.markAsFinished() }
	}
}
