import AVFoundation
import CoreMedia
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class AudioTrackMixerPCMTests: XCTestCase {
	func testIntegerMicrophoneDecodesToStereoAtTheRightGainAndPolarity() throws {
		for (bits, bytes, high, signed) in [
			(8, 1, false, true), (8, 1, false, false),
			(24, 3, false, true), (24, 3, false, false),
			(24, 4, false, true), (24, 4, true, true),
			(24, 4, false, false), (24, 4, true, false),
			(16, 2, false, true), (32, 4, false, true)
		] {
			let buffer = makeIntegerMonoBuffer(alternating: 0.5, frames: 480, at: .zero,
				bits: bits, bytes: bytes, alignedHigh: high, signed: signed)
			let pcm = try XCTUnwrap(AudioTrackMixer.decodeInterleavedStereo(buffer, gain: 0.5))
			XCTAssertEqual(pcm.count, 960)
			for frame in 0..<480 {
				for channel in 0..<2 {
					XCTAssertEqual(pcm[frame * 2 + channel], frame % 2 == 0 ? 0.25 : -0.25,
						accuracy: 0.00001, "bits=\(bits), bytes=\(bytes), high=\(high), signed=\(signed)")
				}
			}
		}
	}
	private func makeIntegerMonoBuffer(
		alternating amplitude: Float,
		frames frameCount: Int,
		at presentationTime: CMTime,
		bits: Int,
		bytes: Int,
		alignedHigh: Bool,
		signed: Bool = true
	) -> CMSampleBuffer {
		var asbd = AudioStreamBasicDescription(
			mSampleRate: Float64(48_000),
			mFormatID: kAudioFormatLinearPCM,
			mFormatFlags: (signed ? kAudioFormatFlagIsSignedInteger : 0)
				| (bits == bytes * 8 ? kAudioFormatFlagIsPacked : 0)
				| (alignedHigh ? kAudioFormatFlagIsAlignedHigh : 0),
			mBytesPerPacket: UInt32(bytes),
			mFramesPerPacket: 1,
			mBytesPerFrame: UInt32(bytes),
			mChannelsPerFrame: 1,
			mBitsPerChannel: UInt32(bits),
			mReserved: 0
		)
		var formatDescription: CMAudioFormatDescription?
		XCTAssertEqual(
			CMAudioFormatDescriptionCreate(
				allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
				magicCookieSize: 0, magicCookie: nil, extensions: nil,
				formatDescriptionOut: &formatDescription
			),
			noErr
		)
		var sampleBuffer: CMSampleBuffer?
		XCTAssertEqual(
			CMAudioSampleBufferCreateWithPacketDescriptions(
				allocator: kCFAllocatorDefault, dataBuffer: nil, dataReady: false,
				makeDataReadyCallback: nil, refcon: nil, formatDescription: formatDescription!,
				sampleCount: frameCount, presentationTimeStamp: presentationTime,
				packetDescriptions: nil, sampleBufferOut: &sampleBuffer
			),
			noErr
		)

		let byteCount = frameCount * bytes
		let memory = UnsafeMutableRawPointer.allocate(byteCount: byteCount, alignment: 16)
		defer { memory.deallocate() }
		let fullScale = Double(Int64(1) << (bits - 1))
		for frame in 0..<frameCount {
			let sample = Double(frame % 2 == 0 ? amplitude : -amplitude)
			var value = Int64((sample * fullScale).rounded())
			value = min(max(value, -Int64(fullScale)), Int64(fullScale) - 1)
			if !signed {
				// Offset binary: the midpoint is silence.
				value += Int64(fullScale)
			}
			// High-aligned puts the padding below the value; low-aligned sign-extends above it.
			let word = UInt32(truncatingIfNeeded: alignedHigh ? value << Int64(bytes * 8 - bits) : value)
			for byte in 0..<bytes {
				memory.storeBytes(of: UInt8(truncatingIfNeeded: word >> UInt32(8 * byte)),
					toByteOffset: frame * bytes + byte, as: UInt8.self)
			}
		}
		let bufferList = AudioBufferList.allocate(maximumBuffers: 1)
		defer { free(bufferList.unsafeMutablePointer) }
		bufferList[0] = AudioBuffer(mNumberChannels: 1, mDataByteSize: UInt32(byteCount), mData: memory)
		XCTAssertEqual(
			CMSampleBufferSetDataBufferFromAudioBufferList(
				sampleBuffer!, blockBufferAllocator: kCFAllocatorDefault,
				blockBufferMemoryAllocator: kCFAllocatorDefault, flags: 0,
				bufferList: bufferList.unsafePointer
			),
			noErr
		)
		XCTAssertEqual(CMSampleBufferSetDataReady(sampleBuffer!), noErr)
		return sampleBuffer!
	}
}
