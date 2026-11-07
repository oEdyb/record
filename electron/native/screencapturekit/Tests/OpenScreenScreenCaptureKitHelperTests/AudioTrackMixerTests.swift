import AVFoundation
import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class AudioTrackMixerTests: XCTestCase {
	func testMixerRejectsAndLogsBeginAndIngestAfterFinalization() throws {
		var rejected: [String] = []
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings)
		let mixer = AudioTrackMixer(mixedInput: input, systemInput: nil, microphoneInput: nil,
			includesSystemAudio: true, includesMicrophone: false, microphoneGain: 1,
			log: { from, event in rejected.append("\(from):\(event)") })
		mixer.beginTimeline(at: CMTime(seconds: 100, preferredTimescale: 600))
		_ = mixer.finish()
		mixer.beginTimeline(at: CMTime(seconds: 200, preferredTimescale: 600))
		mixer.ingest(try audioSample(at: CMTime(seconds: 200, preferredTimescale: 600)), from: .system)
		XCTAssertEqual(rejected, ["completed:begin", "completed:ingest"])
		XCTAssertEqual(mixer.lifecycleName, "completed")
		XCTAssertTrue(mixer.readyTracks.isEmpty)
	}
	func testCompatibilityOwnerPreservesCompletedResultAndLogsLateBegin() async throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings)
		writer.add(input)
		let mixer = AudioTrackMixer(mixedInput: input, systemInput: nil, microphoneInput: nil,
			includesSystemAudio: true, includesMicrophone: false, microphoneGain: 1)
		var rejected: [String] = []
		let queue = DispatchQueue(label: "test.compatibility.lifecycle")
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: queue,
			log: { from, event in rejected.append("\(from):\(event)") })
		owner.begin(at: .zero)
		async let first = owner.finish(); async let second = owner.finish()
		let results = await [first, second]
		XCTAssertTrue(results.allSatisfy { $0.failure == nil })
		owner.begin(at: .zero); queue.sync {}
		XCTAssertEqual(owner.lifecycleName, "completed")
		XCTAssertEqual(rejected, ["completed:begin"])
		writer.cancelWriting()
	}
    func testInvalidEpochIsLoggedWithoutBlockingSubsequentRealAACAppend() async throws {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
        defer { try? FileManager.default.removeItem(at: url) }
        let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
        let input = AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings)
        input.expectsMediaDataInRealTime = true
        writer.add(input)
        XCTAssertTrue(writer.startWriting()); writer.startSession(atSourceTime: .zero)
        let mixer = AudioTrackMixer(mixedInput: input, systemInput: nil, microphoneInput: nil,
            includesSystemAudio: true, includesMicrophone: false, microphoneGain: 1)
        let queue = DispatchQueue(label: "review.invalid-epoch")
        var rejected: [String] = []
        let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: queue,
            log: { from, event in rejected.append("\(from):\(event)") })
        owner.begin(at: .invalid)
        owner.begin(at: .zero)
        let callback = expectation(description: "valid append callback")
        try owner.append(audioSample(at: .zero, amplitude: 1000), from: .system) { result, _ in
            if case .failure(let error) = result { XCTFail("valid sample failed: \(error)") }
            callback.fulfill()
        }
        await owner.drain()
        await fulfillment(of: [callback], timeout: 1)
        let finished = await owner.finish()
        XCTAssertNil(finished.failure)
        XCTAssertEqual(queue.sync { mixer.readyTracks }, ["mixed"], "Invalid begin must not consume the only valid timeline transition")
        XCTAssertEqual(rejected, ["allocated:begin"])
        writer.cancelWriting()
    }
	func testCancelledCompatibilityOwnerReturnsFailureWithoutEscapingTerminalState() async throws {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString + ".mov")
		defer { try? FileManager.default.removeItem(at: url) }
		let writer = try AVAssetWriter(outputURL: url, fileType: .mov)
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings)
		writer.add(input)
		let mixer = AudioTrackMixer(mixedInput: input, systemInput: nil, microphoneInput: nil,
			includesSystemAudio: true, includesMicrophone: false, microphoneGain: 1)
		let owner = CompatibilityAudioWriter(writer: writer, mixer: mixer, queue: DispatchQueue(label: "test.cancelled.compatibility"))
		owner.cancel()
		let finished = await owner.finish()
		XCTAssertNotNil(finished.failure)
		XCTAssertEqual(owner.lifecycleName, "cancelled")
		writer.cancelWriting()
	}
	func testCompletedAudioTrackRejectsAndLogsNewSamples() throws {
		var rejected: [String] = []
		let input = AVAssetWriterInput(mediaType: .audio, outputSettings: OriginalTrackWriter.audioSettings)
		let output = AudioTrackMixer.TrackOutput(input: input, label: "test", writer: nil, append: { $0.append($1) },
			log: { from, event in rejected.append("\(from):\(event)") })
		output.flush(until: Date())
		output.enqueue(try audioSample(at: .zero))
		XCTAssertEqual(rejected, ["completed:enqueue"])
		XCTAssertFalse(output.didAppend)
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
