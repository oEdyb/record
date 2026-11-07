import AVFoundation
import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class OriginalTrackWriterTests: XCTestCase {
	private func time(_ value: Double) -> CMTime { CMTime(seconds: value, preferredTimescale: 600_000) }
	private func directory() throws -> URL {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
		try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
		addTeardownBlock { try? FileManager.default.removeItem(at: url) }
		return url
	}
	func testIllegalEpochReplacementAndPostFinishAppendAreRejectedAndLogged() async throws {
		var rejected: [String] = []
		let url = try directory().appendingPathComponent("original.mov")
		let track = try OriginalTrackWriter(path: url.path, mediaType: .audio, settings: OriginalTrackWriter.audioSettings,
			log: { from, event in rejected.append("\(from):\(event)") })
		let queue = DispatchQueue(label: "test.explicit.original")
		try queue.sync { try track.prepare() }
		XCTAssertEqual(track.lifecycleName, "encoder-prepared")
		XCTAssertNil(track.takeStartedMetadata())
		queue.sync { track.begin(at: time(100)); track.begin(at: time(101)) }
		XCTAssertEqual(rejected, ["epoch-set:epoch"])
		for index in 0..<20 {
			_ = try queue.sync { try track.append(audioSample(at: time(100.023 + Double(index) * 0.01))) }
		}
		let metadata = queue.sync { track.takeStartedMetadata() }
		XCTAssertEqual(try XCTUnwrap(metadata).offsetMs, 23, accuracy: 0.01)
		XCTAssertNil(queue.sync { track.takeStartedMetadata() })
		async let first = track.finish(on: queue)
		async let second = track.finish(on: queue)
		let values = try await [first, second]
		XCTAssertEqual(values, [true, true])
		let third = try await track.finish(on: queue)
		XCTAssertTrue(third)
		let savedData = try Data(contentsOf: url)
		queue.sync { track.cancel(remove: false); track.cancel(remove: true) }
		let afterCancel = try await track.finish(on: queue)
		XCTAssertTrue(afterCancel)
		XCTAssertEqual(try Data(contentsOf: url), savedData)
		XCTAssertEqual(track.lifecycleName, "completed")
		XCTAssertFalse(try queue.sync { try track.append(audioSample(at: time(102))) })
		XCTAssertThrowsError(try queue.sync { try track.prepare() })
		XCTAssertEqual(Array(rejected.suffix(2)), ["completed:append", "completed:prepare"])
		let asset = AVURLAsset(url: url)
		let tracks = try await asset.loadTracks(withMediaType: .audio)
		XCTAssertEqual(tracks.count, 1)
		let reader = try AVAssetReader(asset: asset)
		let output = AVAssetReaderTrackOutput(track: try XCTUnwrap(tracks.first), outputSettings: nil)
		reader.add(output); XCTAssertTrue(reader.startReading())
		var count = 0
		while output.copyNextSampleBuffer() != nil { count += 1 }
		XCTAssertGreaterThan(count, 0)
		XCTAssertEqual(reader.status, .completed)
	}
	func testInvalidEpochDoesNotConsumeTheFirstValidSourceSession() async throws {
		var rejected: [String] = []
		let track = try OriginalTrackWriter(path: try directory().appendingPathComponent("epoch.mov").path,
			mediaType: .audio, settings: OriginalTrackWriter.audioSettings,
			log: { from, event in rejected.append("\(from):\(event)") })
		let queue = DispatchQueue(label: "test.original.invalid-epoch")
		try queue.sync {
			try track.prepare()
			track.begin(at: .invalid)
			track.begin(at: time(100))
			XCTAssertTrue(try track.append(audioSample(at: time(100.023))))
		}
		let saved = try await track.finish(on: queue)
		XCTAssertTrue(saved)
		XCTAssertEqual(track.appendedSamples, 1)
		XCTAssertEqual(rejected, ["encoder-prepared:epoch"])
	}
	func testConcurrentEmptyFinalizationReturnsTheSameNoSamplesFailure() async throws {
		let track = try OriginalTrackWriter(path: try directory().appendingPathComponent("empty.mov").path,
			mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let queue = DispatchQueue(label: "test.explicit.empty")
		try queue.sync { try track.prepare() }
		@Sendable func finish() async -> Bool {
			do { _ = try await track.finish(on: queue); return false }
			catch { return error is OriginalTrackWriter.NoSamples }
		}
		async let first = finish(); async let second = finish()
		let results = await [first, second]
		XCTAssertEqual(results, [true, true])
		XCTAssertEqual(track.lifecycleName, "no-samples")
		XCTAssertFalse(FileManager.default.fileExists(atPath: track.path))
	}
	func testCancelledWriterKeepsItsTerminalResultWhenFinishIsRequested() async throws {
		let track = try OriginalTrackWriter(path: try directory().appendingPathComponent("cancelled.mov").path,
			mediaType: .audio, settings: OriginalTrackWriter.audioSettings)
		let queue = DispatchQueue(label: "test.cancelled.finish")
		queue.sync { track.cancel(remove: true) }
		for _ in 0..<2 {
			do { _ = try await track.finish(on: queue); XCTFail("Cancelled media cannot be reported as saved") } catch {}
			XCTAssertEqual(track.lifecycleName, "cancelled")
		}
	}
	func testClosingAdmissionWaitsBehindEveryReservedSubmission() throws {
		let admission = OriginalSourceAdmission(maximumSamples: 512)
		let queue = DispatchQueue(label: "test.atomic.admission")
		let producers = DispatchQueue(label: "test.atomic.producers", attributes: .concurrent)
		let group = DispatchGroup(), ready = DispatchSemaphore(value: 0), first = DispatchSemaphore(value: 0)
		let counts = AdmissionCounts()
		for _ in 0..<16 {
			group.enter()
			producers.async {
				ready.wait()
				for _ in 0..<16 {
					do {
						try admission.enqueue(bytes: 1, on: queue) { ticket in
							counts.process(); admission.release(ticket)
						}
						counts.accept(); first.signal()
					} catch {}
				}
				group.leave()
			}
		}
		group.enter()
		producers.async { first.wait(); admission.close(); group.leave() }
		for _ in 0..<16 { ready.signal() }
		XCTAssertEqual(group.wait(timeout: .now() + 2), .success)
		queue.sync {}
		XCTAssertGreaterThan(counts.snapshot.accepted, 0)
		XCTAssertEqual(counts.snapshot.processed, counts.snapshot.accepted)
		XCTAssertEqual(admission.retainedCount, 0)
		XCTAssertThrowsError(try admission.reserve(bytes: 1))
	}
	private func audioSample(at timestamp: CMTime, amplitude: Int16 = 0) throws -> CMSampleBuffer {
		var asbd = AudioStreamBasicDescription(mSampleRate: 48_000, mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked, mBytesPerPacket: 4,
			mFramesPerPacket: 1, mBytesPerFrame: 4, mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
		var format: CMAudioFormatDescription?
		XCTAssertEqual(CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
			magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &format), noErr)
		var buffer: CMBlockBuffer?
		XCTAssertEqual(CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
			blockLength: 480 * 4, blockAllocator: kCFAllocatorDefault, customBlockSource: nil, offsetToData: 0,
			dataLength: 480 * 4, flags: kCMBlockBufferAssureMemoryNowFlag, blockBufferOut: &buffer), noErr)
		let data = try XCTUnwrap(buffer)
		XCTAssertEqual(CMBlockBufferFillDataBytes(with: 0, blockBuffer: data, offsetIntoDestination: 0, dataLength: 480 * 4), noErr)
		if amplitude != 0 {
			let pcm = [Int16](repeating: amplitude, count: 480 * 2)
			pcm.withUnsafeBytes { bytes in XCTAssertEqual(CMBlockBufferReplaceDataBytes(with: bytes.baseAddress!, blockBuffer: data, offsetIntoDestination: 0, dataLength: bytes.count), noErr) }
		}
		var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000), presentationTimeStamp: timestamp, decodeTimeStamp: .invalid)
		var size = 4
		var sample: CMSampleBuffer?
		XCTAssertEqual(CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: data, formatDescription: try XCTUnwrap(format),
			sampleCount: 480, sampleTimingEntryCount: 1, sampleTimingArray: &timing, sampleSizeEntryCount: 1,
			sampleSizeArray: &size, sampleBufferOut: &sample), noErr)
		return try XCTUnwrap(sample)
	}
}

private final class AdmissionCounts: @unchecked Sendable {
	private let lock = NSLock()
	private var accepted = 0
	private var processed = 0
	func accept() { lock.lock(); accepted += 1; lock.unlock() }
	func process() { lock.lock(); processed += 1; lock.unlock() }
	var snapshot: (accepted: Int, processed: Int) { lock.lock(); defer { lock.unlock() }; return (accepted, processed) }
}
