import AVFoundation
import CoreGraphics
import CoreMedia
import ScreenCaptureKit

let screenCaptureKitMicrophoneOutputTypeRawValue = 2

@available(macOS 13.0, *)
struct CaptureSetup {
	let filter: SCContentFilter
	let configuration: SCStreamConfiguration
	let width: Int
	let height: Int
	let captureFrame: CGRect
	let microphoneEnabled: Bool
}

@available(macOS 13.0, *)
final class CaptureSetupBuilder {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		let captureFrame: CGRect
	}

	func make(from content: SCShareableContent, request: RecordingRequest) throws -> CaptureSetup {
		let target = try makeCaptureTarget(from: content, request: request)
		let streamSettings = makeStreamConfiguration(
			for: request,
			width: target.width,
			height: target.height
		)
		return CaptureSetup(
			filter: target.filter,
			configuration: streamSettings.configuration,
			width: target.width,
			height: target.height,
			captureFrame: target.captureFrame,
			microphoneEnabled: streamSettings.microphoneEnabled
		)
	}

	private func makeCaptureTarget(
		from content: SCShareableContent,
		request: RecordingRequest
	) throws -> CaptureTarget {
		switch request.source.type {
		case "display":
			guard let displayId = request.source.displayId else {
				throw HelperError.sourceNotFound("Display capture requires source.displayId.")
			}
			guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit display found for id \(displayId).")
			}
			let excludedWindowIds = Set(request.source.excludedWindowIds ?? [])
			let excludedWindows = content.windows.filter { excludedWindowIds.contains($0.windowID) }
			let excludedProcessIds = Set(request.source.excludedProcessIds ?? [])
			let excludedApplications = content.applications.filter {
				excludedProcessIds.contains($0.processID)
			}
			let filter = excludedApplications.isEmpty
				? SCContentFilter(display: display, excludingWindows: excludedWindows)
				: SCContentFilter(
					display: display,
					excludingApplications: excludedApplications,
					exceptingWindows: []
				)
			let fallbackScale = Self.scaleFactor(for: display.displayID)
			let dimensions = captureDimensions(
				for: filter,
				fallbackWidth: Int(display.frame.width) * fallbackScale,
				fallbackHeight: Int(display.frame.height) * fallbackScale,
				request: request
			)
			return CaptureTarget(
				filter: filter,
				width: dimensions.width,
				height: dimensions.height,
				captureFrame: display.frame
			)
		case "window":
			guard let windowId = request.source.windowId else {
				throw HelperError.sourceNotFound("Window capture requires source.windowId.")
			}
			guard let window = content.windows.first(where: { $0.windowID == windowId }) else {
				throw HelperError.sourceNotFound("No ScreenCaptureKit window found for id \(windowId).")
			}
			let candidateDisplay = content.displays.first {
				$0.frame.intersects(window.frame) ||
					$0.frame.contains(CGPoint(x: window.frame.midX, y: window.frame.midY))
			}
			let scaleFactor = Self.scaleFactor(for: candidateDisplay?.displayID ?? CGMainDisplayID())
			let filter = SCContentFilter(desktopIndependentWindow: window)
			let dimensions = captureDimensions(
				for: filter,
				fallbackWidth: Int(window.frame.width) * scaleFactor,
				fallbackHeight: Int(window.frame.height) * scaleFactor,
				request: request
			)
			return CaptureTarget(
				filter: filter,
				width: dimensions.width,
				height: dimensions.height,
				captureFrame: window.frame
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration(
		for request: RecordingRequest,
		width: Int,
		height: Int
	) -> (configuration: SCStreamConfiguration, microphoneEnabled: Bool) {
		let configuration = SCStreamConfiguration()
		configuration.width = width
		configuration.height = height
		if #available(macOS 14.0, *) {
			configuration.preservesAspectRatio = true
			configuration.captureResolution = .best
		}
		configuration.minimumFrameInterval = CMTime(
			value: 1,
			timescale: CMTimeScale(max(1, request.video.fps))
		)
		configuration.queueDepth = 6
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = kCVPixelFormatType_32BGRA
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio = request.audio.system.enabled

		guard request.audio.microphone.enabled else {
			return (configuration, false)
		}
		guard supportsNativeMicrophoneCapture(configuration) else {
			emit([
				"event": "warning",
				"code": "microphone-unavailable",
				"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
			])
			return (configuration, false)
		}

		configuration.setValue(true, forKey: "captureMicrophone")
		if let deviceId = resolveMicrophoneCaptureDeviceID(for: request) {
			configuration.setValue(deviceId, forKey: "microphoneCaptureDeviceID")
		}
		return (configuration, true)
	}

	private func captureDimensions(
		for filter: SCContentFilter,
		fallbackWidth: Int,
		fallbackHeight: Int,
		request: RecordingRequest
	) -> (width: Int, height: Int) {
		if #available(macOS 14.0, *) {
			let scale = CGFloat(max(1, filter.pointPixelScale))
			let width = Int(ceil(filter.contentRect.width * scale))
			let height = Int(ceil(filter.contentRect.height * scale))
			if width > 0, height > 0 {
				return (Self.evenPixelDimension(width), Self.evenPixelDimension(height))
			}
		}

		let width = fallbackWidth > 0 ? fallbackWidth : request.video.width
		let height = fallbackHeight > 0 ? fallbackHeight : request.video.height
		return (Self.evenPixelDimension(width), Self.evenPixelDimension(height))
	}

	private static func evenPixelDimension(_ value: Int) -> Int {
		let positive = max(2, value)
		return positive + (positive % 2)
	}

	private static func scaleFactor(for displayId: CGDirectDisplayID) -> Int {
		guard let mode = CGDisplayCopyDisplayMode(displayId) else {
			return 1
		}
		return max(1, mode.pixelWidth / max(1, mode.width))
	}

	private func supportsNativeMicrophoneCapture(_ configuration: SCStreamConfiguration) -> Bool {
		guard #available(macOS 15.0, *) else {
			return false
		}
		return configuration.responds(to: Selector(("setCaptureMicrophone:"))) &&
			configuration.responds(to: Selector(("setMicrophoneCaptureDeviceID:")))
	}

	private func resolveMicrophoneCaptureDeviceID(for request: RecordingRequest) -> String? {
		let microphoneDeviceType: AVCaptureDevice.DeviceType
		if #available(macOS 14.0, *) {
			microphoneDeviceType = .microphone
		} else {
			microphoneDeviceType = AVCaptureDevice.DeviceType(
				rawValue: "AVCaptureDeviceTypeBuiltInMicrophone"
			)
		}
		let devices = AVCaptureDevice.DiscoverySession(
			deviceTypes: [microphoneDeviceType],
			mediaType: .audio,
			position: .unspecified
		).devices

		if let deviceName = request.audio.microphone.deviceName?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceName.isEmpty,
			let device = devices.first(where: { $0.localizedName == deviceName })
		{
			return device.uniqueID
		}

		if let deviceId = request.audio.microphone.deviceId?.trimmingCharacters(in: .whitespacesAndNewlines),
			!deviceId.isEmpty,
			devices.contains(where: { $0.uniqueID == deviceId })
		{
			return deviceId
		}
		return nil
	}
}
