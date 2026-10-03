import AVFoundation
import CoreMedia
import Foundation

/// One owner for PCM conversion, mixing and all compatibility AAC inputs. Cold
/// AAC appends must not occupy the screen queue or its 60 Hz cadence timer.
@available(macOS 13.0, *)
final class CompatibilityAudioWriter: @unchecked Sendable {
	struct Completion {
		let elapsedMs: Double
		let hostTime: CMTime
		let readyTracks: Set<String>
	}
	struct Finished {
		let telemetry: AudioTrackMixer.Telemetry
		let failure: AudioTrackMixer.Failure?
	}
	static let maximumSamples = 128
	static let maximumBytes = 8 * 1024 * 1024
	let writer: AVAssetWriter
	let queue: DispatchQueue
	private let mixer: AudioTrackMixer
	private let admission: OriginalSourceAdmission
	private var failed = false
	private var finished: Finished?
	var failureTime: CMTime? { admission.failureTime }
	var maximumQueueDepth: Int { admission.maxDepth }
	var maximumQueuedBytes: Int { admission.maxBytes }
	var retainedCount: Int { admission.retainedCount }
	var retainedBytes: Int { admission.retainedBytes }

	init(writer: AVAssetWriter, mixer: AudioTrackMixer, queue: DispatchQueue,
		admission: OriginalSourceAdmission = OriginalSourceAdmission(maximumSamples: maximumSamples, maximumBytes: maximumBytes)) {
		self.writer = writer; self.mixer = mixer; self.queue = queue; self.admission = admission
	}

	/// The recorder calls this only after main startSession, before admitting audio.
	func begin(at epoch: CMTime) { queue.async { self.mixer.beginTimeline(at: epoch) } }

	func append(_ sample: CMSampleBuffer, from source: AudioTrackMixer.Source,
		completion: @escaping (Result<Completion, Error>, CMTime) -> Void) throws {
		let ticket: Int
		do { ticket = try admission.reserve(bytes: OriginalSourceWriter.storageBytes(sample)) }
		catch {
			admission.fail(at: CMClockGetTime(CMClockGetHostTimeClock()))
			throw HelperError.writerSetupFailed("The compatibility audio encoder exceeded its bounded PCM queue.")
		}
		queue.async {
			defer { self.admission.release(ticket) }
			guard !self.failed else { return }
			let started = DispatchTime.now().uptimeNanoseconds
			self.mixer.ingest(sample, from: source)
			if let failure = self.mixer.failure {
				self.failed = true; self.admission.fail(at: failure.hostTime)
				completion(.failure(failure.error), failure.hostTime)
			} else {
				let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
				completion(.success(Completion(elapsedMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
						hostTime: hostTime, readyTracks: self.mixer.readyTracks)), hostTime)
			}
		}
	}

	/// Admission counts queued AND in-flight capture storage. Close it before
	/// crossing the owner barrier; callbacks never synchronously enter sampleQueue.
	func drain() async {
		admission.close()
		await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
	}

	/// This includes every final AAC append. Main endSession/mark/finish is later.
	func finish() async -> Finished {
		admission.close()
		return await withCheckedContinuation { continuation in
			queue.async {
				if let finished = self.finished { continuation.resume(returning: finished); return }
				let telemetry = self.mixer.finish()
				let failure = self.mixer.failure
				if let failure { self.failed = true; self.admission.fail(at: failure.hostTime) }
				let finished = Finished(telemetry: telemetry, failure: failure)
				self.finished = finished
				continuation.resume(returning: finished)
			}
		}
	}

	/// Wait for admitted appends to return before the recorder cancels main writer.
	func cancel() { admission.close(); queue.sync { self.failed = true } }
	func isCurrent(writer: AVAssetWriter?, clipIndex: Int, currentClipIndex: Int) -> Bool {
		writer === self.writer && clipIndex == currentClipIndex
	}
}
