import AVFoundation
import CoreGraphics
import CoreMedia
import ScreenCaptureKit

@available(macOS 13.0, *)
struct CaptureSetup {
	let filter: SCContentFilter
	let systemAudioFilter: SCContentFilter?
	let configuration: SCStreamConfiguration
	let width: Int
	let height: Int
	let captureFrame: CGRect
	let microphoneEnabled: Bool
	/// True when the filter hides the app by process (or records one window), so the
	/// request's list of windows to exclude has no effect on what is captured.
	let ignoresExcludedWindows: Bool
}

@available(macOS 13.0, *)
final class CaptureSetupBuilder {
	private struct CaptureTarget {
		let filter: SCContentFilter
		let width: Int
		let height: Int
		let captureFrame: CGRect
		let ignoresExcludedWindows: Bool
		let displayID: CGDirectDisplayID?
	}

	func make(from content: SCShareableContent, request: RecordingRequest) throws -> CaptureSetup {
		let target = try makeCaptureTarget(from: content, request: request)
		let streamSettings = makeStreamConfiguration(
			for: request,
			width: target.width,
			height: target.height,
			displayID: target.displayID
		)
		let systemAudioFilter: SCContentFilter?
		if Self.usesIndependentSystemAudio(sourceType: request.source.type, enabled: request.audio.system.enabled) {
			guard let display = content.displays.first else {
				throw HelperError.sourceNotFound("System audio requires an available display.")
			}
			systemAudioFilter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
		} else {
			systemAudioFilter = nil
		}
		return CaptureSetup(
			filter: target.filter,
			systemAudioFilter: systemAudioFilter,
			configuration: streamSettings.configuration,
			width: target.width,
			height: target.height,
			captureFrame: target.captureFrame,
			microphoneEnabled: streamSettings.microphoneEnabled,
			ignoresExcludedWindows: target.ignoresExcludedWindows
		)
	}

	static func usesIndependentSystemAudio(sourceType: String, enabled: Bool) -> Bool {
		enabled && sourceType == "window"
	}

	static func systemAudioConfiguration() -> SCStreamConfiguration {
		let configuration = SCStreamConfiguration()
		configuration.width = 2
		configuration.height = 2
		configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
		configuration.queueDepth = 3
		configuration.capturesAudio = true
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		return configuration
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
				captureFrame: display.frame,
				ignoresExcludedWindows: !excludedApplications.isEmpty,
				displayID: display.displayID
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
				captureFrame: window.frame,
				ignoresExcludedWindows: true,
				displayID: candidateDisplay?.displayID
			)
		default:
			throw HelperError.invalidSourceType(request.source.type)
		}
	}

	private func makeStreamConfiguration(
		for request: RecordingRequest,
		width: Int,
		height: Int,
		displayID: CGDirectDisplayID?
	) -> (configuration: SCStreamConfiguration, microphoneEnabled: Bool) {
		let configuration = SCStreamConfiguration()
		configuration.width = width
		configuration.height = height
		if #available(macOS 14.0, *) {
			configuration.preservesAspectRatio = true
			configuration.captureResolution = .best
		}
		configuration.minimumFrameInterval = Self.minimumFrameInterval(
			quality: request.video.quality,
			fps: request.video.fps,
			refreshHz: displayID.flatMap { CGDisplayCopyDisplayMode($0)?.refreshRate } ?? 0
		)
		configuration.queueDepth = Self.queueDepth
		configuration.showsCursor = !request.video.hideSystemCursor
		configuration.pixelFormat = Self.pixelFormat
		configuration.colorMatrix = Self.colorMatrix
		configuration.sampleRate = 48_000
		configuration.channelCount = 2
		configuration.excludesCurrentProcessAudio = true
		configuration.capturesAudio = request.audio.system.enabled && request.source.type != "window"

		guard request.audio.microphone.enabled else {
			return (configuration, false)
		}
		guard #available(macOS 15.0, *) else {
			emit([
				"event": "warning",
				"code": "microphone-unavailable",
				"message": "Native microphone capture requires ScreenCaptureKit microphone support on this macOS version.",
			])
			return (configuration, false)
		}

		configuration.captureMicrophone = true
		let selectedDeviceID = resolveMicrophoneCaptureDeviceID(for: request)
		if let deviceId = selectedDeviceID {
			configuration.microphoneCaptureDeviceID = deviceId
		}
		if let message = microphoneFallbackWarning(
			deviceID: request.audio.microphone.deviceId,
			deviceName: request.audio.microphone.deviceName, resolvedID: selectedDeviceID
		) {
			emit(["event": "warning", "code": "microphone-defaulted", "message": message])
		}
		if ProcessInfo.processInfo.environment["OPENSCREEN_CAPTURE_DIAGNOSTICS"] == "1" {
			let systemDefault = AVCaptureDevice.default(for: .audio)
			emit(["event": "capture-diagnostic", "stage": "microphone-device",
				"configuredDeviceID": selectedDeviceID ?? "system-default",
				"defaultDeviceID": systemDefault?.uniqueID ?? "unavailable",
				"defaultDeviceName": systemDefault?.localizedName ?? "unavailable"])
		}
		return (configuration, true)
	}

	/// Standard appends every delivered frame, so delivery is the written rate. High writes a
	/// fixed grid from the newest frame, and frames arrive only on display refreshes, so it
	/// skips whole refreshes: as many as still deliver at least `fps` (60 of a 120 Hz panel's
	/// 120, 72 of 144, every refresh of a 75 or 100 Hz one). An unknown rate keeps zero, which
	/// means every refresh.
	static func minimumFrameInterval(quality: String?, fps: Int, refreshHz: Double) -> CMTime {
		let rate = Int32(max(1, fps))
		guard quality == "high" else { return CMTime(value: 1, timescale: rate) }
		guard refreshHz > 0 else { return .zero }
		let refreshesPerFrame = max(1, (refreshHz / Double(rate) + 0.01).rounded(.down))
		return CMTime(seconds: 0.9 * refreshesPerFrame / refreshHz, preferredTimescale: 600_000)
	}

	/// The encoder takes 4:2:0, so capture it directly: 12 instead of 32 bits a pixel through the
	/// surface pool, and no BGRA conversion inside VideoToolbox. BT.709 video range is what the
	/// encoder produced from BGRA and what the compositor decodes (`shaders.metal`).
	static let pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
	static let colorMatrix = CGDisplayStream.yCbCrMatrix_ITU_R_709_2

	/// The documented maximum. The frame cache keeps up to three pool surfaces between
	/// frames, and the pool stalls when the app holds too many of them.
	static let queueDepth = 8

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

		return resolveMicrophoneDeviceID(
			deviceID: request.audio.microphone.deviceId,
			deviceName: request.audio.microphone.deviceName,
			devices: devices.map { (id: $0.uniqueID, name: $0.localizedName) }
		)
	}
}
