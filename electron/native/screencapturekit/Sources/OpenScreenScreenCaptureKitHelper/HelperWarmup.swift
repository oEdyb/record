import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Standby work that makes the next start() cheaper. No stream starts. The camera runs only
/// while the app asks for it, which it does only while its recorder already shows that camera.
@available(macOS 13.0, *)
enum HelperWarmup {
	static let standbyArgument = "--standby"
	static let idleSeconds = 600

	static func run() async {
		_ = CGPreflightScreenCaptureAccess()
		_ = AVCaptureDevice.authorizationStatus(for: .video)
		_ = AVCaptureDevice.authorizationStatus(for: .audio)
		_ = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .externalUnknown], mediaType: .video, position: .unspecified).devices
		if let content = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true),
			let display = content.displays.first {
			let configuration = SCStreamConfiguration()
			configuration.width = display.width
			configuration.height = display.height
			_ = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: configuration, delegate: nil)
		}
		warmEncoder()
	}

	private static func warmEncoder() {
		let url = FileManager.default.temporaryDirectory.appendingPathComponent("klippt-warmup-\(getpid()).mp4")
		defer { try? FileManager.default.removeItem(at: url) }
		guard let writer = try? AVAssetWriter(outputURL: url, fileType: .mp4) else { return }
		let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
			AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 1920, AVVideoHeightKey: 1080,
		])
		input.expectsMediaDataInRealTime = true
		guard writer.canAdd(input) else { return }
		writer.add(input)
		if writer.startWriting() { writer.cancelWriting() }
	}

	/// Sent by the app while its own recorder is already showing this camera, and cleared
	/// when it stops showing it, so standby never holds a camera the user cannot see.
	struct WarmCameraCommand: Decodable {
		struct Camera: Decodable {
			let webcam: RecordingRequest.Webcam
			let quality: String?
		}
		let warmCamera: Camera?
	}

	private struct WarmCamera {
		let capture: NativeCameraCapture
		let webcam: RecordingRequest.Webcam
		let quality: String?
	}
	nonisolated(unsafe) private static var warmCamera: WarmCamera?
	private static let warmCameraQueue = DispatchQueue(label: "app.openscreen.sck-helper.camera-warm")

	static func isWarmCameraLine(_ data: Data) -> Bool {
		((try? JSONSerialization.jsonObject(with: data)) as? [String: Any])?.keys.contains("warmCamera") ?? false
	}

	static func warmCameraMatches(webcam: RecordingRequest.Webcam, quality: String?, request: RecordingRequest) -> Bool {
		request.webcam.enabled && webcam == request.webcam && quality == request.video.quality
	}

	private static func setWarmCamera(_ next: WarmCameraCommand.Camera?) async {
		if let current = warmCamera {
			if let next, current.webcam == next.webcam, current.quality == next.quality, current.capture.isRunning { return }
			warmCamera = nil
			await current.capture.stop()
		}
		guard let next, next.webcam.enabled, AVCaptureDevice.authorizationStatus(for: .video) == .authorized,
			let capture = try? NativeCameraCapture(webcam: next.webcam, quality: next.quality, sampleQueue: warmCameraQueue,
				onFailure: { _ in }, onDrop: {}, onSample: { _ in })
		else { return }
		do {
			try await capture.start(announce: false)
			warmCamera = WarmCamera(capture: capture, webcam: next.webcam, quality: next.quality)
		} catch {
			await capture.stop()
		}
	}

	/// The warm camera for this request, or nil after stopping one that does not fit it.
	static func takeWarmCamera(for request: RecordingRequest) async -> NativeCameraCapture? {
		guard let current = warmCamera else { return nil }
		warmCamera = nil
		if current.capture.isRunning, warmCameraMatches(webcam: current.webcam, quality: current.quality, request: request) {
			return current.capture
		}
		await current.capture.stop()
		return nil
	}

	/// Waits for the start request on stdin, serving camera warm-up lines until it arrives.
	/// EOF or the idle limit ends the standby helper.
	static func awaitRequest() async -> Data? {
		let idle = DispatchWorkItem { exit(0) }
		DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(idleSeconds), execute: idle)
		defer { idle.cancel() }
		while let line = readLine() {
			let data = Data(line.utf8)
			guard isWarmCameraLine(data) else { return data }
			await setWarmCamera((try? JSONDecoder().decode(WarmCameraCommand.self, from: data))?.warmCamera)
		}
		return nil
	}
}
