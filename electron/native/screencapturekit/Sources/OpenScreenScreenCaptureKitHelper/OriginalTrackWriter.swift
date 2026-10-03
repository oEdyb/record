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
	private(set) var started = false
	private(set) var prepared = false
	private var announcedStart = false
	private var epoch: CMTime?
	private var lastTime: CMTime?
	private var pending: [CMSampleBuffer] = []
	private static let maximumPendingSamples = 32

	init(path: String, mediaType: AVMediaType, settings: [String: Any]) throws {
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
		if prepared {
			guard writer.status == .writing else { throw failure("prepared writer stopped") }
			return
		}
		guard writer.status == .unknown, writer.startWriting() else { throw failure("prepare") }
		prepared = true
	}

	func begin(at epoch: CMTime) { self.epoch = epoch }

	/// Publish timing only after a real encoded-input append, exactly once per clip.
	func takeStartedMetadata() -> (path: String, offsetMs: Double)? {
		guard appendedSamples > 0, !announcedStart else { return nil }
		announcedStart = true
		return (path, offsetMs)
	}

	@discardableResult func append(_ sample: CMSampleBuffer) throws -> Bool {
		guard let epoch else { return false }
		let time = CMSampleBufferGetPresentationTimeStamp(sample)
		guard time.isNumeric, time >= epoch, lastTime == nil || time > lastTime! else { return false }
		if !started {
			try prepare()
			writer.startSession(atSourceTime: time)
			offsetMs = max(0, CMTimeGetSeconds(time - epoch) * 1_000)
			started = true
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
		}
	}

	/// Retry a short bounded tail on the source owner queue. Never block delivery or silently drop it.
	func finish(on queue: DispatchQueue) async throws -> Bool {
		if !started {
			writer.cancelWriting()
			try? FileManager.default.removeItem(atPath: path)
			throw failure("received no source samples")
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
		return true
	}

	func cancel(remove: Bool) {
		writer.cancelWriting()
		if remove { try? FileManager.default.removeItem(atPath: path) }
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
