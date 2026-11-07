import AVFoundation
import CoreMedia
import Foundation

/// Captures an original source once. All mutable access belongs to its source owner queue.
/// Audio starts at its first captured sample, with its screen offset stored separately.
final class OriginalTrackWriter {
	let path: String
	let writer: AVAssetWriter
	let input: AVAssetWriterInput
	private(set) var offsetMs: Double = 0
	private(set) var backpressureEvents = 0
	private(set) var maximumQueueDepth = 0
	private(set) var appendedSamples = 0
	private enum Preparation { case allocated, prepared }
	private enum Publication { case waiting, announced }
	private struct Session {
		let epoch: CMTime
		var publication: Publication = .waiting
	}
	private enum State {
		case allocated, encoderPrepared, epochSet(CMTime, Preparation)
		case sourceSessionStarted(Session), pendingBackpressure(Session), firstAppendAnnounced(Session)
		case draining(Session?, WriterCompletion), noSamples(WriterCompletion)
		case completed(Session?, WriterCompletion), cancelled(WriterCompletion)
		var session: Session? {
			switch self {
			case .sourceSessionStarted(let value), .pendingBackpressure(let value), .firstAppendAnnounced(let value): return value
			case .draining(let value, _), .completed(let value, _): return value
			default: return nil
			}
		}
		var epoch: CMTime? {
			if case .epochSet(let time, _) = self { return time }; return session?.epoch
		}
		var canPrepare: Bool {
			switch self { case .allocated, .encoderPrepared, .epochSet, .sourceSessionStarted, .pendingBackpressure, .firstAppendAnnounced: return true; default: return false }
		}
		var acceptsSamples: Bool {
			switch self { case .epochSet, .sourceSessionStarted, .pendingBackpressure, .firstAppendAnnounced: return true; default: return false }
		}
		var name: String {
			switch self {
			case .allocated: return "allocated"; case .encoderPrepared: return "encoder-prepared"; case .epochSet: return "epoch-set"
			case .sourceSessionStarted: return "source-session-started"; case .pendingBackpressure: return "pending-backpressure"
			case .firstAppendAnnounced: return "first-append-announced"; case .draining: return "draining"
			case .noSamples: return "no-samples"; case .completed: return "completed"; case .cancelled: return "cancelled"
			}
		}
	}
	private enum Event {
		case prepare, epoch(CMTime), startSession, append, backlog, announce, drain, complete, cancel
		var name: String {
			switch self { case .prepare: return "prepare"; case .epoch: return "epoch"; case .startSession: return "start-session"
			case .append: return "append"; case .backlog: return "backlog"; case .announce: return "announce"
			case .drain: return "drain"; case .complete: return "complete"; case .cancel: return "cancel" }
		}
	}
	private struct Outcome { var accepted = true; var changed = false; var completion: WriterCompletion?; var ownsDrain = false }
	private var state: State = .allocated
	private let log: (String, String) -> Void
	var started: Bool { state.session != nil }
	var prepared: Bool {
		switch state { case .allocated, .epochSet(_, .allocated): return false; case .cancelled, .noSamples: return false; default: return true }
	}
	var lifecycleName: String { state.name }
	@discardableResult private func transition(_ event: Event) -> Outcome {
		let before = state.name
		var result = Outcome()
		switch event {
		case .prepare:
			switch state {
			case .allocated: state = .encoderPrepared; result.changed = true
			case .epochSet(let epoch, .allocated): state = .epochSet(epoch, .prepared); result.changed = true
			case .encoderPrepared, .epochSet(_, .prepared), .sourceSessionStarted, .pendingBackpressure, .firstAppendAnnounced: break
			default: result.accepted = false
			}
		case .epoch(let epoch):
			guard epoch.isNumeric else { result.accepted = false; break }
			switch state {
			case .allocated: state = .epochSet(epoch, .allocated); result.changed = true
			case .encoderPrepared: state = .epochSet(epoch, .prepared); result.changed = true
			case .epochSet(let existing, _) where existing == epoch: break
			default: result.accepted = false
			}
		case .startSession:
			if case .epochSet(let epoch, .prepared) = state { state = .sourceSessionStarted(Session(epoch: epoch)); result.changed = true }
			else { result.accepted = false }
		case .append, .backlog:
			if let session = state.session {
				switch state {
				case .sourceSessionStarted, .pendingBackpressure, .firstAppendAnnounced:
					if case .backlog = event { state = .pendingBackpressure(session) }
					else { switch session.publication { case .waiting: state = .sourceSessionStarted(session); case .announced: state = .firstAppendAnnounced(session) } }
					result.changed = true
				case .draining: break
				default: result.accepted = false
				}
			} else { result.accepted = false }
		case .announce:
			if var session = state.session, case .waiting = session.publication, appendedSamples > 0 {
				session.publication = .announced
				switch state {
				case .pendingBackpressure: state = .pendingBackpressure(session)
				case .draining(_, let completion): state = .draining(session, completion)
				case .completed(_, let completion): state = .completed(session, completion)
				default: state = .firstAppendAnnounced(session)
				}
				result.changed = true
			}
		case .drain:
			switch state {
			case .draining(_, let completion), .noSamples(let completion), .completed(_, let completion), .cancelled(let completion): result.completion = completion
			default:
				let completion = WriterCompletion(); result.completion = completion; result.ownsDrain = true
				if let session = state.session { state = .draining(session, completion) } else { state = .noSamples(completion) }
				result.changed = true
			}
		case .complete:
			switch state {
			case .draining(let session, let completion): state = .completed(session, completion); result.changed = true
			case .noSamples: break
			default: result.accepted = false
			}
		case .cancel:
			switch state {
			case .draining, .completed, .noSamples: result.accepted = false
			case .cancelled: break
			default:
				let completion = WriterCompletion()
				completion.finish(.failure(HelperError.writerSetupFailed("The original source was cancelled.")))
				state = .cancelled(completion); result.changed = true
			}
		}
		if !result.accepted { log(before, event.name) }
		return result
	}
	private var lastTime: CMTime?
	private var pending: [CMSampleBuffer] = []
	private static let maximumPendingSamples = 32

	init(path: String, mediaType: AVMediaType, settings: [String: Any],
		log: @escaping (String, String) -> Void = { from, event in emit(["event": "warning", "code": "illegal-original-writer-transition", "from": from, "transition": event]) }) throws {
		self.log = log
		self.path = path
		let url = URL(fileURLWithPath: path)
		try? FileManager.default.removeItem(at: url)
		// QuickTime fragments remain readable without finishWriting after a crash.
		// M4A does not have the same documented fragmentation guarantee.
		writer = try AVAssetWriter(outputURL: url, fileType: .mov)
		writer.movieFragmentInterval = CMTime(seconds: 1, preferredTimescale: 600)
		input = AVAssetWriterInput(mediaType: mediaType, outputSettings: settings)
		input.expectsMediaDataInRealTime = true
		guard writer.canAdd(input) else { throw HelperError.writerSetupFailed("Cannot create original track \(path).") }
		writer.add(input)
	}

	/// Encoder setup has no source epoch and never announces writer readiness.
	/// Prepare before live capture starts; preserve first sample PTS below.
	func prepare() throws {
		guard state.canPrepare else { _ = transition(.prepare); throw failure("prepare after closure") }
		if prepared {
			guard writer.status == .writing else { throw failure("prepared writer stopped") }
			return
		}
		guard writer.status == .unknown, writer.startWriting() else { throw failure("prepare") }
		_ = transition(.prepare)
	}

	func begin(at epoch: CMTime) { _ = transition(.epoch(epoch)) }

	/// Publish timing only after a real encoded-input append, exactly once per clip.
	func takeStartedMetadata() -> (path: String, offsetMs: Double)? {
		guard transition(.announce).changed else { return nil }
		return (path, offsetMs)
	}

	@discardableResult func append(_ sample: CMSampleBuffer) throws -> Bool {
		guard state.acceptsSamples, let epoch = state.epoch else { _ = transition(.append); return false }
		let time = CMSampleBufferGetPresentationTimeStamp(sample)
		guard time.isNumeric, time >= epoch, lastTime == nil || time > lastTime! else { return false }
		if !started {
			try prepare()
			writer.startSession(atSourceTime: time)
			offsetMs = max(0, CMTimeGetSeconds(time - epoch) * 1_000)
			_ = transition(.startSession)
		}
		pending.append(sample)
		maximumQueueDepth = max(maximumQueueDepth, pending.count)
		lastTime = time
		try flush()
		guard pending.count <= Self.maximumPendingSamples else { throw failure("backpressure exceeded 32 source samples") }
		return true
	}

	func flush() throws {
		guard started else { return }
		guard writer.status == .writing else { throw failure("writer stopped") }
		if !pending.isEmpty && !input.isReadyForMoreMediaData { backpressureEvents += 1 }
		while !pending.isEmpty && input.isReadyForMoreMediaData {
			guard input.append(pending[0]) else { throw failure("append") }
			appendedSamples += 1
			pending.removeFirst()
			_ = transition(.append)
		}
		if !pending.isEmpty { _ = transition(.backlog) }
	}

	/// Retry a short bounded tail on the source owner queue. Never block delivery or silently drop it.
	func finish(on queue: DispatchQueue) async throws -> Bool {
		let drain = queue.sync { transition(.drain) }
		guard let completion = drain.completion else { throw failure("missing finalization") }
		if !drain.ownsDrain { return try await completion.wait() }
		let result: Result<Bool, Error>
		do {
			guard queue.sync(execute: { started }) else {
				queue.sync { writer.cancelWriting(); try? FileManager.default.removeItem(atPath: path) }
				throw NoSamples(path: path)
			}
			let deadline = DispatchTime.now().uptimeNanoseconds + 500_000_000
			while true {
				let drained = try queue.sync { () -> Bool in try flush(); return pending.isEmpty }
				if drained { break }
				guard DispatchTime.now().uptimeNanoseconds < deadline else { throw failure("tail did not drain") }
				try await Task.sleep(nanoseconds: 5_000_000)
			}
			queue.sync { input.markAsFinished() }
			await withCheckedContinuation { continuation in writer.finishWriting { continuation.resume() } }
			guard writer.status == .completed else { throw failure("finish") }
			result = .success(true)
		} catch { result = .failure(error) }
		queue.sync { _ = transition(.complete) }
		completion.finish(result)
		return try result.get()
	}

	func cancel(remove: Bool) {
		let cancelled = transition(.cancel)
		guard cancelled.accepted else { return }
		if cancelled.changed { writer.cancelWriting() }
		if remove { try? FileManager.default.removeItem(atPath: path) }
	}

	/// The source delivered nothing before the clip closed.
	struct NoSamples: Error, CustomStringConvertible {
		let path: String
		var description: String { "Original track \(URL(fileURLWithPath: path).lastPathComponent) received no source samples." }
	}

	private func failure(_ stage: String) -> Error {
		HelperError.writerSetupFailed("Original track \(URL(fileURLWithPath: path).lastPathComponent) \(stage): \(writer.error.map { "\($0)" } ?? "status \(writer.status.rawValue)").")
	}

	static var audioSettings: [String: Any] { [
		AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
		AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 256_000,
	] }

	static func videoSettings(width: Int, height: Int, fps: Int, bitrate: Int) -> [String: Any] { [
		AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: width, AVVideoHeightKey: height,
		AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
			AVVideoExpectedSourceFrameRateKey: fps, AVVideoAllowFrameReorderingKey: false],
	] }
}
