import AVFoundation
import CoreMedia
import CoreVideo
import Foundation

/// Admission includes queued, currently encoding and not-yet-appended source buffers.
/// It never allocates the limit; it accounts for the actual retained samples.
final class OriginalSourceAdmission: @unchecked Sendable {
	private let lock = NSLock()
	private var tickets: [(id: Int, bytes: Int)] = []
	private var nextID = 0
	private var accepting = true
	private var bytes = 0
	private var maximumDepth = 0
	private var maximumRetainedBytes = 0
	private var firstFailure: CMTime?
	static let maximumSamples = 32
	static let maximumBytes = 8 * 1024 * 1024
	static let maximumCameraBytes = 512 * 1024 * 1024
	let sampleLimit: Int
	let byteLimit: Int

	init(maximumSamples: Int = maximumSamples, maximumBytes: Int = maximumBytes) {
		sampleLimit = maximumSamples; byteLimit = maximumBytes
	}
	static func cameraSamples(fps: Double) -> Int {
		guard fps.isFinite, fps > 0 else { return 8 }
		return Int(min(128, max(8, ceil(fps) + 8)))
	}

	func reserve(bytes size: Int) throws -> Int {
		lock.lock(); defer { lock.unlock() }
		guard accepting, size > 0, size <= byteLimit,
			tickets.count < sampleLimit, bytes <= byteLimit - size else {
			throw HelperError.writerSetupFailed("The original source encoder exceeded its bounded source queue.")
		}
		nextID += 1
		tickets.append((nextID, size)); bytes += size
		maximumDepth = max(maximumDepth, tickets.count)
		maximumRetainedBytes = max(maximumRetainedBytes, bytes)
		return nextID
	}
	func consume(_ count: Int) {
		lock.lock(); defer { lock.unlock() }
		for _ in 0..<min(count, tickets.count) { bytes -= tickets.removeFirst().bytes }
	}
	func release(_ id: Int) {
		lock.lock(); defer { lock.unlock() }
		if let index = tickets.firstIndex(where: { $0.id == id }) { bytes -= tickets.remove(at: index).bytes }
	}
	func close() { lock.lock(); accepting = false; lock.unlock() }
	func fail(at time: CMTime) { lock.lock(); accepting = false; if firstFailure == nil { firstFailure = time }; lock.unlock() }
	var failureTime: CMTime? { lock.lock(); defer { lock.unlock() }; return firstFailure }
	var maxDepth: Int { lock.lock(); defer { lock.unlock() }; return maximumDepth }
	var maxBytes: Int { lock.lock(); defer { lock.unlock() }; return maximumRetainedBytes }
	var retainedCount: Int { lock.lock(); defer { lock.unlock() }; return tickets.count }
	var retainedBytes: Int { lock.lock(); defer { lock.unlock() }; return bytes }
}

/// Each standalone source has a serial encoder owner independent of screen cadence.
/// Its original PTS and readiness depend on actual append, never queue latency.
final class OriginalSourceWriter: @unchecked Sendable {
	struct Completion {
		let metadata: (path: String, offsetMs: Double)?
		let firstAppend: Bool
		let elapsedMs: Double
		let hostTime: CMTime
	}
	let original: OriginalTrackWriter
	let queue: DispatchQueue
	private let admission: OriginalSourceAdmission
	private var failed = false
	var failureTime: CMTime? { admission.failureTime }
	var maximumQueueDepth: Int { max(admission.maxDepth, queue.sync { original.maximumQueueDepth }) }
	var maximumQueuedBytes: Int { admission.maxBytes }

	init(original: OriginalTrackWriter, queue: DispatchQueue, admission: OriginalSourceAdmission = OriginalSourceAdmission()) {
		self.original = original; self.queue = queue; self.admission = admission
	}
	func prepare() throws { try queue.sync { try original.prepare() } }
	func begin(at epoch: CMTime) { queue.async { self.original.begin(at: epoch) } }

	func append(_ sample: CMSampleBuffer, completion: @escaping (Result<Completion, Error>, CMTime) -> Void) throws {
		let ticket = try admission.reserve(bytes: Self.storageBytes(sample))
		queue.async {
			guard !self.failed else { self.admission.release(ticket); return }
			let started = DispatchTime.now().uptimeNanoseconds
			let previousCount = self.original.appendedSamples
			do {
				let accepted = try self.original.append(sample)
				if !accepted { self.admission.release(ticket) }
				self.admission.consume(self.original.appendedSamples - previousCount)
				let hostTime = CMClockGetTime(CMClockGetHostTimeClock())
				completion(.success(Completion(metadata: self.original.takeStartedMetadata(), firstAppend: previousCount == 0 && self.original.appendedSamples > 0,
					elapsedMs: Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000, hostTime: hostTime)), hostTime)
			} catch {
				let failureTime = CMClockGetTime(CMClockGetHostTimeClock())
				self.failed = true; self.admission.fail(at: failureTime)
				self.admission.consume(self.original.appendedSamples - previousCount)
				self.admission.release(ticket)
				completion(.failure(error), failureTime)
			}
		}
	}

	/// Close producer admission first. Every queued metadata callback is dispatched
	/// before the drain continuation; the recorder then crosses its sample barrier.
	func drain() async {
		admission.close()
		await withCheckedContinuation { continuation in queue.async { continuation.resume() } }
	}
	func finish() async throws -> Bool {
		let before = queue.sync { original.appendedSamples }
		let saved = try await original.finish(on: queue)
		admission.consume(queue.sync { original.appendedSamples - before })
		return saved
	}
	func cancel(remove: Bool) {
		admission.close()
		queue.sync { original.cancel(remove: remove) }
	}
	func isCurrent(original: OriginalTrackWriter?, clipIndex: Int, currentClipIndex: Int) -> Bool {
		original === self.original && clipIndex == currentClipIndex
	}
	static func storageBytes(_ sample: CMSampleBuffer) -> Int {
		if let image = CMSampleBufferGetImageBuffer(sample) {
			// GetDataSize can be zero for noncontiguous planes. Include padded
			// row strides and extended pixels too, conservatively for each plane.
			var left = 0, right = 0, top = 0, bottom = 0
			CVPixelBufferGetExtendedPixels(image, &left, &right, &top, &bottom)
			let planes = CVPixelBufferGetPlaneCount(image)
			var rowsBytes = 0
			for plane in 0..<max(1, planes) {
				let rows = planes == 0 ? CVPixelBufferGetHeight(image) : CVPixelBufferGetHeightOfPlane(image, plane)
				let stride = planes == 0 ? CVPixelBufferGetBytesPerRow(image) : CVPixelBufferGetBytesPerRowOfPlane(image, plane)
				let (extensionRows, extensionOverflow) = top.addingReportingOverflow(bottom)
				let (extendedRows, rowOverflow) = rows.addingReportingOverflow(extensionRows)
				let (size, byteOverflow) = stride.multipliedReportingOverflow(by: extendedRows)
				let (total, sumOverflow) = rowsBytes.addingReportingOverflow(size)
				guard !extensionOverflow, !rowOverflow, !byteOverflow, !sumOverflow else { return Int.max }
				rowsBytes = total
			}
			return max(CVPixelBufferGetDataSize(image), rowsBytes)
		}
		if let data = CMSampleBufferGetDataBuffer(sample) { return CMBlockBufferGetDataLength(data) }
		return CMSampleBufferGetTotalSampleSize(sample)
	}
}
