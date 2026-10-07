import CoreMedia
import Foundation

/// AVFoundation drops a camera frame when the delegate queue is late or its buffer pool
/// is empty. One warning per second names the reason instead of flooding the take.
struct CameraDropReport {
	static let minimumIntervalSeconds = 1.0
	private var lastReportedAt: Double?

	mutating func shouldReport(at seconds: Double) -> Bool {
		if let last = lastReportedAt, seconds - last < Self.minimumIntervalSeconds { return false }
		lastReportedAt = seconds
		return true
	}

	static func describe(_ reason: CFTypeRef?) -> String {
		guard let value = reason as? String else { return "unknown reason" }
		if value == kCMSampleBufferDroppedFrameReason_FrameWasLate as String { return "frame was late: the camera delivery queue was busy" }
		if value == kCMSampleBufferDroppedFrameReason_OutOfBuffers as String { return "out of buffers: frames are waiting on the recorder queue" }
		if value == kCMSampleBufferDroppedFrameReason_Discontinuity as String { return "discontinuity" }
		return value
	}
}
