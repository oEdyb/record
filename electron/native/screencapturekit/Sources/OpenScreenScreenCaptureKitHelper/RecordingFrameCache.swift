import CoreMedia
import CoreVideo

struct RecordingFrameCache {
	private var capturedFrame: CMSampleBuffer?
	private var previousCapturedFrame: CMSampleBuffer?
	private var writtenFrame: CMSampleBuffer?
	private(set) var writtenSourcePresentationTime: CMTime?

	var capturedPresentationTime: CMTime? { capturedFrame.map { CMSampleBufferGetPresentationTimeStamp($0) } }

	mutating func observe(_ sample: CMSampleBuffer, retainingPrevious: Bool = true) {
		guard CMSampleBufferDataIsReady(sample), CMSampleBufferGetImageBuffer(sample) != nil else { return }
		let incomingTime = CMSampleBufferGetPresentationTimeStamp(sample)
		guard incomingTime.isNumeric else { return }
		if let capturedFrame, incomingTime < CMSampleBufferGetPresentationTimeStamp(capturedFrame) { return }
		if !retainingPrevious {
			previousCapturedFrame = nil
		} else if capturedFrame.map({ CMSampleBufferGetPresentationTimeStamp($0) != incomingTime }) ?? false {
			previousCapturedFrame = capturedFrame
		}
		capturedFrame = sample
	}

	mutating func invalidateCapturedFrame() {
		capturedFrame = nil
		previousCapturedFrame = nil
	}

	mutating func beginClip() {
		previousCapturedFrame = nil
		writtenFrame = nil
		writtenSourcePresentationTime = nil
	}

	mutating func didAppend(_ sample: CMSampleBuffer, sourceTime: CMTime? = nil) {
		writtenFrame = sample
		writtenSourcePresentationTime = sourceTime ?? CMSampleBufferGetPresentationTimeStamp(sample)
	}

	/// A newly captured image cannot be moved backwards into a historical grid
	/// slot. Reuse the previous written pixels (or the retained first image) there.
	func scheduledFrame(at time: CMTime, fps: Int, firstFrame: CMSampleBuffer?) throws -> (sample: CMSampleBuffer, sourceTime: CMTime)? {
		let source: CMSampleBuffer
		let sourceTime: CMTime
		if let capturedFrame = eligibleCapturedFrame(capturedFrame, at: time) ?? eligibleCapturedFrame(previousCapturedFrame, at: time) {
			source = capturedFrame; sourceTime = CMSampleBufferGetPresentationTimeStamp(capturedFrame)
		} else if let writtenFrame, let writtenSourcePresentationTime {
			source = writtenFrame; sourceTime = writtenSourcePresentationTime
		} else if let firstFrame, CMSampleBufferGetPresentationTimeStamp(firstFrame) <= time {
			source = firstFrame; sourceTime = CMSampleBufferGetPresentationTimeStamp(firstFrame)
		} else { return nil }
		return (try Self.retime(source, at: time, fps: fps), sourceTime)
	}

	private func eligibleCapturedFrame(_ frame: CMSampleBuffer?, at time: CMTime) -> CMSampleBuffer? {
		guard let frame else { return nil }
		let sourceTime = CMSampleBufferGetPresentationTimeStamp(frame)
		guard sourceTime <= time, writtenSourcePresentationTime.map({ sourceTime >= $0 }) ?? true else { return nil }
		return frame
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

	func boundaryFrame(at time: CMTime, duration: CMTime, fps: Int) throws -> CMSampleBuffer? {
		guard let writtenFrame else { return nil }
		return try Self.retime(writtenFrame, at: time, fps: fps, duration: duration)
	}

	static func retime(_ sample: CMSampleBuffer, at time: CMTime, fps: Int, duration: CMTime? = nil) throws -> CMSampleBuffer {
		guard time.isValid, time.isNumeric, CMSampleBufferGetImageBuffer(sample) != nil else {
			throw HelperError.writerSetupFailed("A complete screen frame and valid recording time are required.")
		}
		var timing = CMSampleTimingInfo(
			duration: duration ?? CMTime(value: 1, timescale: CMTimeScale(max(1, fps))),
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
