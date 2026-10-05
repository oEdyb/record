import AVFoundation
import CoreGraphics
import Foundation
import ScreenCaptureKit

/// Standby work that makes the next start() cheaper without capturing anything:
/// no stream starts, no camera session runs, so no capture indicator appears.
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

	/// Waits for the start request on stdin. EOF or the idle limit ends the standby helper.
	static func awaitRequest() -> Data? {
		let idle = DispatchWorkItem { exit(0) }
		DispatchQueue.global().asyncAfter(deadline: .now() + .seconds(idleSeconds), execute: idle)
		defer { idle.cancel() }
		return readLine().map { Data($0.utf8) }
	}
}
