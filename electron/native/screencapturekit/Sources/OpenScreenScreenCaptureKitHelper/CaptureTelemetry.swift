import CoreMedia
import Foundation
import ScreenCaptureKit

@available(macOS 13.0, *)
final class CaptureTelemetry {
	private final class BoundedSeries {
		private static let capacity = 65_536
		private var values: [Double] = []
		private var nextIndex = 0

		func append(_ value: Double) {
			guard value.isFinite else { return }
			if values.count < Self.capacity {
				values.append(value)
				return
			}
			values[nextIndex] = value
			nextIndex = (nextIndex + 1) % Self.capacity
		}

		func summary() -> [String: Any]? {
			guard !values.isEmpty else { return nil }
			let sorted = values.sorted()
			let total = sorted.reduce(0, +)
			return [
				"count": sorted.count,
				"min": sorted[0],
				"max": sorted[sorted.count - 1],
				"mean": total / Double(sorted.count),
				"p50": percentile(sorted, 0.50),
				"p95": percentile(sorted, 0.95),
				"p99": percentile(sorted, 0.99),
			]
		}

		private func percentile(_ sorted: [Double], _ quantile: Double) -> Double {
			guard sorted.count > 1 else { return sorted[0] }
			let position = Double(sorted.count - 1) * quantile
			let lower = Int(floor(position))
			let upper = Int(ceil(position))
			let weight = position - Double(lower)
			return sorted[lower] * (1 - weight) + sorted[upper] * weight
		}
	}

	private let lock = NSLock()
	private let requestedVideoFps: Int
	private var screenSamples = 0
	private var completeScreenSamples = 0
	private var idleScreenSamples = 0
	private var blankScreenSamples = 0
	private var suspendedScreenSamples = 0
	private var startedScreenSamples = 0
	private var stoppedScreenSamples = 0
	private var otherScreenSamples = 0
	private var repeatedVideoFrames = 0
	private var skippedVideoFrames = 0
	private var appendedVideoFrames = 0
	private var writerBackpressureEvents = 0
	private var appendedCameraFrames = 0
	private var originalBackpressureEvents = 0
	private var originalMaxQueueDepth = 0
	private var cameraSamples = 0
	private var cameraDroppedFrames = 0
	private var pendingVideoFrames = 0
	private var appendFailures = 0
	private var systemAudioSamples = 0
	private var microphoneAudioSamples = 0
	private var latestScreenTimestampSeconds: Double?
	private var lastSystemDriftSampleSeconds: Double?
	private var lastMicrophoneDriftSampleSeconds: Double?
	private var mediaDurationMs = 0
	private let systemAudioDriftMs = BoundedSeries()
	private let microphoneDriftMs = BoundedSeries()
	private let fragmentFinalizeMs = BoundedSeries()
	private let audioBlockMs = BoundedSeries()
	private var audioMaxQueueBytes = 0
	private var writerMaxQueueDepth = 0
	private var currentClipFirstScreenTimestampSeconds: Double?
	private var currentClipAppendedFrames = 0
	private let screenTimestampDriftMs = BoundedSeries()
	private let screenDeliveryAgeMs = BoundedSeries()
	private let completeScreenIntervalMs = BoundedSeries()
	private var previousCompleteScreenTime: Double?

	init(requestedVideoFps: Int) {
		self.requestedVideoFps = requestedVideoFps
	}

	func beginClip() {
		lock.lock()
		defer { lock.unlock() }
		currentClipFirstScreenTimestampSeconds = nil
		currentClipAppendedFrames = 0
		previousCompleteScreenTime = nil
	}

	@discardableResult
	func recordScreenSample(_ sampleBuffer: CMSampleBuffer, receivedAt: CMTime = CMClockGetTime(CMClockGetHostTimeClock())) -> Bool {
		lock.lock()
		defer { lock.unlock() }
		screenSamples += 1
		let sourceTime = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
		let receivedTime = CMTimeGetSeconds(receivedAt)
		if sourceTime.isFinite && receivedTime.isFinite { screenDeliveryAgeMs.append((receivedTime - sourceTime) * 1_000) }
		guard let status = Self.frameStatus(sampleBuffer) else {
			recordCompleteScreen(at: sourceTime)
			return true
		}
		switch status {
		case .complete:
			recordCompleteScreen(at: sourceTime)
			return true
		case .idle:
			idleScreenSamples += 1
		case .blank:
			blankScreenSamples += 1
		case .suspended:
			suspendedScreenSamples += 1
		case .started:
			startedScreenSamples += 1
		case .stopped:
			stoppedScreenSamples += 1
		@unknown default:
			otherScreenSamples += 1
		}
		return false
	}

	private func recordCompleteScreen(at sourceTime: Double) {
		completeScreenSamples += 1
		guard sourceTime.isFinite else { return }
		if let previousCompleteScreenTime, sourceTime >= previousCompleteScreenTime {
			completeScreenIntervalMs.append((sourceTime - previousCompleteScreenTime) * 1_000)
		}
		previousCompleteScreenTime = sourceTime
	}

	func recordVideoAppend(at presentationTime: CMTime) {
		lock.lock()
		defer { lock.unlock() }
		appendedVideoFrames += 1
		let seconds = CMTimeGetSeconds(presentationTime)
		guard seconds.isFinite else { return }
		latestScreenTimestampSeconds = seconds
		if let first = currentClipFirstScreenTimestampSeconds, requestedVideoFps > 0 {
			let expectedSeconds = Double(currentClipAppendedFrames) / Double(requestedVideoFps)
			screenTimestampDriftMs.append((seconds - first - expectedSeconds) * 1_000)
		} else {
			currentClipFirstScreenTimestampSeconds = seconds
		}
		currentClipAppendedFrames += 1
	}

	func recordOriginalWriter(cameraFrames: Int, backpressureEvents: Int, queueDepth: Int) {
		lock.withLock { appendedCameraFrames += cameraFrames; originalBackpressureEvents += backpressureEvents; originalMaxQueueDepth = max(originalMaxQueueDepth, queueDepth) }
	}

	func recordCameraSample(dropped: Bool = false) { lock.withLock { if dropped { cameraDroppedFrames += 1 } else { cameraSamples += 1 } } }

	func recordRepeatedVideoFrame() { lock.withLock { repeatedVideoFrames += 1 } }
	func recordSkippedVideoFrames(_ count: Int) { guard count > 0 else { return }; lock.withLock { skippedVideoFrames += count } }

	func recordVideoBackpressure(retried: Bool = false) {
		lock.withLock { writerBackpressureEvents += 1; if !retried { pendingVideoFrames += 1 } }
	}

	func recordVideoAppendFailure() {
		lock.withLock { appendFailures += 1 }
	}

	func recordAudioSample(_ sampleBuffer: CMSampleBuffer, microphone: Bool) {
		lock.lock()
		defer { lock.unlock() }
		if microphone {
			microphoneAudioSamples += 1
		} else {
			systemAudioSamples += 1
		}
		guard let screenSeconds = latestScreenTimestampSeconds else { return }
		let seconds = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sampleBuffer))
		guard seconds.isFinite else { return }
		let previous = microphone ? lastMicrophoneDriftSampleSeconds : lastSystemDriftSampleSeconds
		guard previous == nil || abs(seconds - (previous ?? seconds)) >= 0.1 else { return }
		let driftMs = (seconds - screenSeconds) * 1_000
		if microphone {
			microphoneDriftMs.append(driftMs)
			lastMicrophoneDriftSampleSeconds = seconds
		} else {
			systemAudioDriftMs.append(driftMs)
			lastSystemDriftSampleSeconds = seconds
		}
	}

	func recordFinalizedClip(durationMs: Int, finalizeMs: Double) {
		lock.lock()
		defer { lock.unlock() }
		mediaDurationMs += max(0, durationMs)
		fragmentFinalizeMs.append(finalizeMs)
	}

	func recordAudioWriter(maxQueueBytes: Int, maxQueueDepth: Int, blockedMs: Double) {
		lock.lock()
		defer { lock.unlock() }
		audioMaxQueueBytes = max(audioMaxQueueBytes, max(0, maxQueueBytes))
		writerMaxQueueDepth = max(writerMaxQueueDepth, max(0, maxQueueDepth))
		audioBlockMs.append(blockedMs)
	}

	func payload() -> [String: Any] {
		lock.lock()
		defer { lock.unlock() }
		let incompleteFrames = idleScreenSamples + blankScreenSamples + suspendedScreenSamples
			+ startedScreenSamples + stoppedScreenSamples + otherScreenSamples
		// Incomplete samples (idle, blank, suspended, ...) mean ScreenCaptureKit had no new
		// pixels to deliver, which is normal when the screen or the game renders below
		// the requested rate. They are not lost frames. Dropped frames are only the samples
		// the writer refused (not ready) or failed to append; counting idle samples here
		// produced a false 2.5% drop rate on a healthy 88-minute capture (2026-09-11).
		let droppedFrames = pendingVideoFrames + appendFailures
		let deliveredFps = mediaDurationMs > 0
			? Double(appendedVideoFrames) * 1_000 / Double(mediaDurationMs)
			: 0
		var value: [String: Any] = [
			"requestedVideoFps": requestedVideoFps,
			"deliveredVideoFps": deliveredFps,
			"screenSamples": screenSamples,
			"completeScreenSamples": completeScreenSamples,
			"idleScreenSamples": idleScreenSamples,
			"blankScreenSamples": blankScreenSamples,
			"suspendedScreenSamples": suspendedScreenSamples,
			"startedScreenSamples": startedScreenSamples,
			"stoppedScreenSamples": stoppedScreenSamples,
			"otherScreenSamples": otherScreenSamples,
			"incompleteScreenSamples": incompleteFrames,
			"appendedVideoFrames": appendedVideoFrames,
			"repeatedVideoFrames": repeatedVideoFrames,
			"skippedVideoFrames": skippedVideoFrames,
			"completeSourceVideoFps": mediaDurationMs > 0 ? Double(completeScreenSamples) * 1_000 / Double(mediaDurationMs) : 0,
			"pendingVideoFrames": pendingVideoFrames,
			"writerBackpressureEvents": writerBackpressureEvents,
			"cameraSamples": cameraSamples,
			"cameraDroppedFrames": cameraDroppedFrames,
			"appendedCameraFrames": appendedCameraFrames,
			"originalBackpressureEvents": originalBackpressureEvents,
			"originalMaxQueueDepth": originalMaxQueueDepth,
			"completeSourceCameraFps": mediaDurationMs > 0 ? Double(cameraSamples) * 1_000 / Double(mediaDurationMs) : 0,
			"deliveredCameraFps": mediaDurationMs > 0 ? Double(appendedCameraFrames) * 1_000 / Double(mediaDurationMs) : 0,
			"appendFailures": appendFailures,
			"droppedVideoFrames": droppedFrames,
			"systemAudioSamples": systemAudioSamples,
			"microphoneAudioSamples": microphoneAudioSamples,
			"audioMaxQueueBytes": audioMaxQueueBytes,
			"writerMaxQueueDepth": writerMaxQueueDepth,
			"lowPowerMode": ProcessInfo.processInfo.isLowPowerModeEnabled,
			"thermalState": thermalStateName(ProcessInfo.processInfo.thermalState),
		]
		if let summary = systemAudioDriftMs.summary() {
			value["systemAudioDriftMs"] = summary
		}
		if let summary = screenTimestampDriftMs.summary() {
			value["screenTimestampDriftMs"] = summary
		}
		if let summary = microphoneDriftMs.summary() {
			value["microphoneDriftMs"] = summary
		}
		if let summary = fragmentFinalizeMs.summary() {
			value["fragmentFinalizeMs"] = summary
		}
		if let summary = audioBlockMs.summary() {
			value["audioBlockMs"] = summary
		}
		if let summary = screenDeliveryAgeMs.summary() { value["screenDeliveryAgeMs"] = summary }
		if let summary = completeScreenIntervalMs.summary() { value["completeScreenIntervalMs"] = summary }
		return value
	}

	static func frameStatus(_ sampleBuffer: CMSampleBuffer) -> SCFrameStatus? {
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
			sampleBuffer,
			createIfNecessary: false
		) as? [[SCStreamFrameInfo: Any]],
			let attachment = attachments.first,
			let statusRawValue = attachment[SCStreamFrameInfo.status] as? Int
		else {
			return nil
		}
		return SCFrameStatus(rawValue: statusRawValue)
	}

	private func thermalStateName(_ state: ProcessInfo.ThermalState) -> String {
		switch state {
		case .nominal: return "nominal"
		case .fair: return "fair"
		case .serious: return "serious"
		case .critical: return "critical"
		@unknown default: return "unknown"
		}
	}
}

private extension NSLock {
	func withLock(_ action: () -> Void) {
		lock()
		defer { unlock() }
		action()
	}
}
