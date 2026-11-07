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
	private enum State { case allocated, active, draining, completed(Finished), cancelled(Finished) }
	private enum Event { case begin(CMTime), ingest, drain, fail, finish(Finished), cancel }
	private var state: State = .allocated
	private let log: (String, String) -> Void
	var lifecycleName: String {
		switch state { case .allocated: return "allocated"; case .active: return "active"; case .draining: return "draining"; case .completed: return "completed"; case .cancelled: return "cancelled" }
	}
	@discardableResult private func transition(_ event: Event) -> Bool {
		let before = lifecycleName
		let name: String
		var accepted = true
		switch event {
		case .begin(let epoch):
			name = "begin"
			if case .allocated = state, epoch.isValid { state = .active } else { accepted = false }
		case .ingest:
			name = "ingest"
			if case .active = state {} else { accepted = false }
		case .drain:
			name = "drain"
			switch state { case .allocated, .active: state = .draining; default: break }
		case .fail:
			name = "fail"
			switch state { case .active, .draining: state = .draining; default: accepted = false }
		case .finish(let finished):
			name = "finish"
			if case .draining = state { state = .completed(finished) } else { accepted = false }
		case .cancel:
			name = "cancel"
			switch state {
			case .completed: accepted = false
			case .cancelled: break
			default:
				state = .cancelled(Finished(telemetry: mixer.telemetry,
					failure: AudioTrackMixer.Failure(error: HelperError.writerSetupFailed("Compatibility audio was cancelled."), hostTime: CMClockGetTime(CMClockGetHostTimeClock()))))
			}
		}
		if !accepted { log(before, name) }
		return accepted
	}
	var failureTime: CMTime? { admission.failureTime }
	var maximumQueueDepth: Int { admission.maxDepth }
	var maximumQueuedBytes: Int { admission.maxBytes }
	var retainedCount: Int { admission.retainedCount }
	var retainedBytes: Int { admission.retainedBytes }

	init(writer: AVAssetWriter, mixer: AudioTrackMixer, queue: DispatchQueue,
		admission: OriginalSourceAdmission = OriginalSourceAdmission(maximumSamples: maximumSamples, maximumBytes: maximumBytes),
		log: @escaping (String, String) -> Void = { from, event in emit(["event": "warning", "code": "illegal-compatibility-writer-transition", "from": from, "transition": event]) }) {
		self.log = log
		self.writer = writer; self.mixer = mixer; self.queue = queue; self.admission = admission
	}

	/// The recorder calls this only after main startSession, before admitting audio.
	func begin(at epoch: CMTime) { queue.async { if self.transition(.begin(epoch)) { self.mixer.beginTimeline(at: epoch) } } }

	func append(_ sample: CMSampleBuffer, from source: AudioTrackMixer.Source,
		completion: @escaping (Result<Completion, Error>, CMTime) -> Void) throws {
		do {
			try admission.enqueue(bytes: OriginalSourceWriter.storageBytes(sample), on: queue) { ticket in
				defer { self.admission.release(ticket) }
				guard self.transition(.ingest) else { return }
				let started = DispatchTime.now().uptimeNanoseconds
				self.mixer.ingest(sample, from: source)
				if let failure = self.mixer.failure {
					self.transition(.fail); self.admission.fail(at: failure.hostTime)
					completion(.failure(failure.error), failure.hostTime)
				} else {
					let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
					completion(.success(Completion(elapsedMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000,
						hostTime: hostTime, readyTracks: self.mixer.readyTracks)), hostTime)
				}
			}
		} catch {
			admission.fail(at: CMClockGetTime(CMClockGetHostTimeClock()))
			throw HelperError.writerSetupFailed("The compatibility audio encoder exceeded its bounded PCM queue.")
		}
	}

	/// Admission counts queued AND in-flight capture storage. Close it before
	/// crossing the owner barrier; callbacks never synchronously enter sampleQueue.
	func drain() async {
		admission.close()
		await withCheckedContinuation { continuation in queue.async { self.transition(.drain); continuation.resume() } }
	}

	/// This includes every final AAC append. Main endSession/mark/finish is later.
	func finish() async -> Finished {
		admission.close()
		return await withCheckedContinuation { continuation in
			queue.async {
				switch self.state {
				case .completed(let finished), .cancelled(let finished): continuation.resume(returning: finished); return
				default: break
				}
				self.transition(.drain)
				let telemetry = self.mixer.finish()
				let failure = self.mixer.failure
				if let failure { self.transition(.fail); self.admission.fail(at: failure.hostTime) }
				let finished = Finished(telemetry: telemetry, failure: failure)
				self.transition(.finish(finished))
				continuation.resume(returning: finished)
			}
		}
	}

	/// Wait for admitted appends to return before the recorder cancels main writer.
	func cancel() { admission.close(); _ = queue.sync { self.transition(.cancel) } }
	func isCurrent(writer: AVAssetWriter?, clipIndex: Int, currentClipIndex: Int) -> Bool {
		writer === self.writer && clipIndex == currentClipIndex
	}
}
