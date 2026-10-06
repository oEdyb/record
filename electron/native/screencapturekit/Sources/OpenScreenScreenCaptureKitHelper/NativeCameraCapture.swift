import AVFoundation
import CoreMedia
import Foundation

/// AVFoundation owns the camera source format; no browser resizing or handoff remux.
final class NativeCameraCapture: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
	private let session = AVCaptureSession()
	private let device: AVCaptureDevice
	private let nativeFormat: AVCaptureDevice.Format
	private let nativeFrameDuration: CMTime
	private let lifecycleQueue = DispatchQueue(label: "app.openscreen.sck-helper.camera")
	private let output = AVCaptureVideoDataOutput()
	private var sampleQueue: DispatchQueue
	private var runtimeObserver: NSObjectProtocol?
	private var onDrop: () -> Void
	private var onFailure: (Error) -> Void
	private var onSample: (CMSampleBuffer) -> Void
	let width: Int
	let height: Int
	let fps: Double

	init(webcam: RecordingRequest.Webcam, quality: String?, sampleQueue: DispatchQueue, onFailure: @escaping (Error) -> Void, onDrop: @escaping () -> Void, onSample: @escaping (CMSampleBuffer) -> Void) throws {
		self.sampleQueue = sampleQueue
		self.onDrop = onDrop
		self.onFailure = onFailure
		self.onSample = onSample
		let cameras = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .externalUnknown], mediaType: .video, position: .unspecified).devices
		guard let device = Self.resolveDevice(cameras, id: webcam.deviceId, name: webcam.deviceName) else {
			throw HelperError.writerSetupFailed("The selected camera is unavailable.")
		}
		self.device = device
		let high = quality == "high"
		// A format picked in Setup is recorded as chosen. If this camera cannot deliver
		// it (it was unplugged and swapped), fall back to the Automatic format.
		let chosen = high && webcam.exactFormat == true
			? Self.exactFormat(device.formats, width: webcam.width, height: webcam.height, fps: webcam.fps)
			: nil
		let candidates = device.formats.filter { $0.videoSupportedFrameRateRanges.contains { $0.minFrameRate <= (high ? 60 : Double(max(1, webcam.fps))) } }
		guard let format = chosen ?? candidates.min(by: { left, right in
			let a = CMVideoFormatDescriptionGetDimensions(left.formatDescription)
			let b = CMVideoFormatDescriptionGetDimensions(right.formatDescription)
			if high {
				return Self.automaticFormatPrecedes(
					(Int(a.width), Int(a.height), Self.supportedFps(ranges: left.videoSupportedFrameRateRanges.map { ($0.minFrameRate, $0.maxFrameRate) }, target: 60)),
					(Int(b.width), Int(b.height), Self.supportedFps(ranges: right.videoSupportedFrameRateRanges.map { ($0.minFrameRate, $0.maxFrameRate) }, target: 60)))
			}
			return abs(Int(a.width) - webcam.width) + abs(Int(a.height) - webcam.height)
				< abs(Int(b.width) - webcam.width) + abs(Int(b.height) - webcam.height)
		}) else { throw HelperError.writerSetupFailed("No native camera format is available.") }
		let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
		nativeFormat = format
		width = Int(dimensions.width); height = Int(dimensions.height)
		let target = chosen != nil || !high ? Double(max(1, webcam.fps)) : 60
		let supportedRate = Self.supportedFps(ranges: format.videoSupportedFrameRateRanges.map { ($0.minFrameRate, $0.maxFrameRate) }, target: target)
		guard let frameDuration = Self.frameDuration(ranges: format.videoSupportedFrameRateRanges.map { ($0.minFrameDuration, $0.maxFrameDuration) }, fps: supportedRate) else {
			throw HelperError.writerSetupFailed("No supported native camera frame duration is available.")
		}
		fps = 1 / CMTimeGetSeconds(frameDuration)
		nativeFrameDuration = frameDuration
		super.init()
		session.beginConfiguration()
		defer { session.commitConfiguration() }
		// macOS supports explicit activeFormat configuration without the iOS-only inputPriority preset.
		let input = try AVCaptureDeviceInput(device: device)
		guard session.canAddInput(input) else { throw HelperError.writerSetupFailed("Cannot open the selected camera.") }
		session.addInput(input)
		// On macOS, preset-only output configuration overrides explicit activeFormat.
		// Request the exact advertised native dimensions; never accept a scaled source.
		output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
			kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height]
		output.alwaysDiscardsLateVideoFrames = true
		output.setSampleBufferDelegate(self, queue: sampleQueue)
		guard session.canAddOutput(output) else { throw HelperError.writerSetupFailed("Cannot read native camera frames.") }
		session.addOutput(output)
		runtimeObserver = NotificationCenter.default.addObserver(forName: AVCaptureSession.runtimeErrorNotification, object: session, queue: nil) { [weak self] notification in
			guard let self else { return }
			let message = String(describing: notification.userInfo?[AVCaptureSessionErrorKey])
			self.sampleQueue.async { self.onFailure(HelperError.writerSetupFailed("Native camera failed: \(message)")) }
		}
	}

	static func supportedFps(ranges: [(Double, Double)], target: Double) -> Double {
		let supported = ranges.compactMap { minimum, maximum -> Double? in
			let rate = min(target, maximum)
			return rate >= minimum ? rate : nil
		}.max() ?? ranges.map { $0.0 }.min() ?? 30
		return max(1, supported)
	}

	/// AVFoundation rejects even a rounded interval just outside its rational range.
	/// Clamp against the actual format durations, not their rounded Double FPS labels.
	static func frameDuration(ranges: [(CMTime, CMTime)], fps: Double) -> CMTime? {
		guard fps.isFinite, fps > 0 else { return nil }
		let requested = CMTime(seconds: 1 / fps, preferredTimescale: 1_000_000_000)
		return ranges.compactMap { minimum, maximum -> CMTime? in
			guard minimum.isNumeric, maximum.isNumeric, minimum > .zero, maximum >= minimum else { return nil }
			return min(max(requested, minimum), maximum)
		}.min { abs(CMTimeGetSeconds($0 - requested)) < abs(CMTimeGetSeconds($1 - requested)) }
	}

	static func resolveDeviceIndex(ids: [String], names: [String], id: String?, name: String?) -> Int? {
		if let id, let index = ids.firstIndex(of: id) { return index }
		if let name, !name.isEmpty {
			// Chromium GetNameAndModel appends UvcControl's four-digit VID:PID.
			// Remove only that hardware suffix, retaining real parenthetical names.
			// Exact and normalized names together must still identify one camera.
			let nativeName = name.replacingOccurrences(of: #" \([0-9a-fA-F]{4}:[0-9a-fA-F]{4}\)$"#, with: "", options: .regularExpression)
			let matches = names.indices.filter { names[$0] == name || names[$0] == nativeName }
			return matches.count == 1 ? matches[0] : nil
		}
		return id == nil && !ids.isEmpty ? 0 : nil
	}

	static func resolveDevice(_ devices: [AVCaptureDevice], id: String?, name: String?) -> AVCaptureDevice? {
		guard let index = resolveDeviceIndex(ids: devices.map(\.uniqueID), names: devices.map(\.localizedName), id: id, name: name) else { return nil }
		return devices[index]
	}

	deinit { if let runtimeObserver { NotificationCenter.default.removeObserver(runtimeObserver) } }

	/// Hands a camera that standby already started to the recording: its frames now go to the
	/// recorder's queue and handlers. Never call this from the queue it is leaving.
	func adopt(sampleQueue: DispatchQueue, onFailure: @escaping (Error) -> Void, onDrop: @escaping () -> Void, onSample: @escaping (CMSampleBuffer) -> Void) {
		output.setSampleBufferDelegate(nil, queue: nil)
		self.sampleQueue.sync {}
		self.sampleQueue = sampleQueue
		self.onFailure = onFailure
		self.onDrop = onDrop
		self.onSample = onSample
		output.setSampleBufferDelegate(self, queue: sampleQueue)
	}

	func announceFormat() {
		emit(["event": "camera-format", "width": width, "height": height, "fps": fps, "container": "mov", "codec": "h264"])
	}

	func start(announce: Bool = true) async throws {
		try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
			lifecycleQueue.async {
				do {
					// Configure after all input/output negotiation, in a separate transaction.
					self.session.beginConfiguration()
					do {
						try self.device.lockForConfiguration()
						self.device.activeFormat = self.nativeFormat
						self.device.activeVideoMinFrameDuration = self.nativeFrameDuration
						self.device.activeVideoMaxFrameDuration = self.nativeFrameDuration
						self.device.unlockForConfiguration()
						self.session.commitConfiguration()
					} catch { self.session.commitConfiguration(); throw error }
					self.session.startRunning()
					guard self.session.isRunning else { throw HelperError.writerSetupFailed("The native camera did not start.") }
					let actual = CMVideoFormatDescriptionGetDimensions(self.device.activeFormat.formatDescription)
					guard actual.width == self.width, actual.height == self.height else {
						throw HelperError.writerSetupFailed("The camera preset replaced the selected native format: requested \(self.width)x\(self.height), active \(actual.width)x\(actual.height).")
					}
					continuation.resume()
				} catch { continuation.resume(throwing: error) }
			}
		}
		if announce { announceFormat() }
	}
	/// Automatic takes a 16:9 format when the camera has one, then the most pixels, then the
	/// highest rate. Pixel count alone picks a square or 4:3 sensor mode on Apple cameras.
	static func automaticFormatPrecedes(_ left: (width: Int, height: Int, fps: Double), _ right: (width: Int, height: Int, fps: Double)) -> Bool {
		let leftWide = left.width * 9 == left.height * 16, rightWide = right.width * 9 == right.height * 16
		if leftWide != rightWide { return leftWide }
		let leftArea = left.width * left.height, rightArea = right.width * right.height
		if leftArea != rightArea { return leftArea > rightArea }
		return left.fps > right.fps
	}

	static func exactFormat(_ formats: [AVCaptureDevice.Format], width: Int, height: Int, fps: Int) -> AVCaptureDevice.Format? {
		formats.first { format in
			let dimensions = CMVideoFormatDescriptionGetDimensions(format.formatDescription)
			// Drivers advertise 60 FPS modes as 59.94, so allow one frame of slack.
			return Int(dimensions.width) == width && Int(dimensions.height) == height
				&& format.videoSupportedFrameRateRanges.contains { $0.maxFrameRate >= Double(fps) - 1 && $0.minFrameRate <= Double(fps) }
		}
	}

	var isRunning: Bool { session.isRunning }

	func stop() async {
		await withCheckedContinuation { continuation in lifecycleQueue.async { self.session.stopRunning(); continuation.resume() } }
	}
	func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
		guard let clock = session.synchronizationClock else { onFailure(HelperError.writerSetupFailed("The native camera clock is unavailable.")); return }
		guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { onFailure(HelperError.writerSetupFailed("The native camera delivered no image.")); return }
		let active = CMVideoFormatDescriptionGetDimensions(device.activeFormat.formatDescription)
		guard Self.matchesNativeGeometry(expected: (width, height), active: (Int(active.width), Int(active.height)), delivered: (CVPixelBufferGetWidth(image), CVPixelBufferGetHeight(image))) else {
			let settings = (output as? AVCaptureVideoDataOutput)?.videoSettings ?? [:]
			onFailure(HelperError.writerSetupFailed("The camera changed its native resolution during capture: configured \(width)x\(height), delivered \(CVPixelBufferGetWidth(image))x\(CVPixelBufferGetHeight(image)), active format \(active.width)x\(active.height), preset \(session.sessionPreset.rawValue), output settings \(settings).")); return
		}
		let hostTime = CMSyncConvertTime(CMSampleBufferGetPresentationTimeStamp(sampleBuffer), from: clock, to: CMClockGetHostTimeClock())
		if let sample = try? RecordingFrameCache.retime(sampleBuffer, at: hostTime, fps: max(1, Int(fps.rounded()))) { onSample(sample) }
	}
	static func matchesNativeGeometry(expected: (Int, Int), active: (Int, Int), delivered: (Int, Int)) -> Bool {
		expected.0 == active.0 && expected.1 == active.1 && expected.0 == delivered.0 && expected.1 == delivered.1
	}
	func captureOutput(_ output: AVCaptureOutput, didDrop sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) { onDrop() }
}
