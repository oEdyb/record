import AVFoundation
import CoreMedia
import Foundation

// All mutable state and AVAssetWriter access are confined to the supplied
// sample queue. The retained screen sample is immutable across the retry.
final class ClosingFrameAppender: @unchecked Sendable {
	private let sample: CMSampleBuffer
	private let input: AVAssetWriterInput
	private let writer: AVAssetWriter
	private let queue: DispatchQueue
	private var continuation: CheckedContinuation<Void, Error>?
	private var retryTimer: DispatchSourceTimer?
	private var deadline: DispatchTime?
	private var finished = false

	init(sample: CMSampleBuffer, input: AVAssetWriterInput, writer: AVAssetWriter, queue: DispatchQueue) {
		self.sample = sample
		self.input = input
		self.writer = writer
		self.queue = queue
	}

	func append() async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			queue.async {
				guard self.continuation == nil, !self.finished else {
					continuation.resume(throwing: HelperError.writerSetupFailed("The recording boundary frame was already requested."))
					return
				}
				self.continuation = continuation
				self.deadline = .now() + 1
				self.tryAppend()
				guard self.continuation != nil else { return }
				let timer = DispatchSource.makeTimerSource(queue: self.queue)
				self.retryTimer = timer
				timer.schedule(deadline: .now() + .milliseconds(5), repeating: .milliseconds(5))
				timer.setEventHandler { self.tryAppend() }
				timer.resume()
			}
		}
	}

	private func tryAppend() {
		guard continuation != nil else { return }
		guard writer.status == .writing else {
			finish(.failure(writer.error ?? HelperError.writerSetupFailed("The video writer stopped before its final frame.")))
			return
		}
		if let deadline, DispatchTime.now().uptimeNanoseconds >= deadline.uptimeNanoseconds {
			finish(.failure(HelperError.writerSetupFailed("Timed out writing the recording boundary frame.")))
			return
		}
		guard input.isReadyForMoreMediaData else { return }
		if input.append(sample) {
			finish(.success(()))
		} else {
			finish(.failure(writer.error ?? HelperError.writerSetupFailed("Unable to write the final screen frame.")))
		}
	}

	private func finish(_ result: Result<Void, Error>) {
		guard let continuation else { return }
		self.continuation = nil
		finished = true
		retryTimer?.setEventHandler {}
		retryTimer?.cancel()
		retryTimer = nil
		continuation.resume(with: result)
	}
}
