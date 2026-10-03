import CoreMedia
import CoreVideo

struct RecordingStartBarrier {
	private var pendingClipIndex: Int?

	mutating func prepare(clipIndex: Int) {
		pendingClipIndex = clipIndex
	}

	mutating func acknowledgeAppend(succeeded: Bool) -> Int? {
		guard succeeded, let clipIndex = pendingClipIndex else { return nil }
		pendingClipIndex = nil
		return clipIndex
	}
}

struct RecordingFrameCache {
	private var capturedFrame: CMSampleBuffer?
	private var writtenFrame: CMSampleBuffer?

	mutating func observe(_ sample: CMSampleBuffer) {
		guard CMSampleBufferDataIsReady(sample), CMSampleBufferGetImageBuffer(sample) != nil else { return }
		capturedFrame = sample
	}

	mutating func invalidateCapturedFrame() {
		capturedFrame = nil
	}

	mutating func beginClip() {
		writtenFrame = nil
	}

	mutating func didAppend(_ sample: CMSampleBuffer) {
		writtenFrame = sample
	}

	func resumedFrame(at time: CMTime, fps: Int) throws -> CMSampleBuffer? {
		guard let capturedFrame else { return nil }
		return try Self.retime(capturedFrame, at: time, fps: fps)
	}

	func closingFrame(at endTime: CMTime, fps: Int) throws -> CMSampleBuffer? {
		guard let writtenFrame else { return nil }
		let frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, fps)))
		let lastTime = CMSampleBufferGetPresentationTimeStamp(writtenFrame)
		let finalTime = CMTimeSubtract(endTime, frameDuration)
		guard finalTime.isValid, finalTime.isNumeric, finalTime > lastTime else { return nil }
		return try Self.retime(writtenFrame, at: finalTime, fps: fps)
	}

	static func retime(_ sample: CMSampleBuffer, at time: CMTime, fps: Int) throws -> CMSampleBuffer {
		guard time.isValid, time.isNumeric, CMSampleBufferGetImageBuffer(sample) != nil else {
			throw HelperError.writerSetupFailed("A complete screen frame and valid recording time are required.")
		}
		var timing = CMSampleTimingInfo(
			duration: CMTime(value: 1, timescale: CMTimeScale(max(1, fps))),
			presentationTimeStamp: time,
			decodeTimeStamp: .invalid
		)
		var copied: CMSampleBuffer?
		let result = CMSampleBufferCreateCopyWithNewTiming(
			allocator: kCFAllocatorDefault,
			sampleBuffer: sample,
			sampleTimingEntryCount: 1,
			sampleTimingArray: &timing,
			sampleBufferOut: &copied
		)
		guard result == noErr, let copied else {
			throw HelperError.writerSetupFailed("Unable to preserve the screen frame at the recording boundary (\(result)).")
		}
		return copied
	}
}
