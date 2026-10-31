import CoreGraphics
import CoreMedia
import CoreVideo
import ScreenCaptureKit
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class CaptureSetupTests: XCTestCase {
	func testWindowSystemAudioUsesAnIndependentFullMix() {
		XCTAssertTrue(CaptureSetupBuilder.usesIndependentSystemAudio(sourceType: "window", enabled: true))
		XCTAssertFalse(CaptureSetupBuilder.usesIndependentSystemAudio(sourceType: "window", enabled: false))
		XCTAssertFalse(CaptureSetupBuilder.usesIndependentSystemAudio(sourceType: "display", enabled: true))
		let configuration = CaptureSetupBuilder.systemAudioConfiguration()
		XCTAssertTrue(configuration.capturesAudio)
		XCTAssertTrue(configuration.excludesCurrentProcessAudio)
		XCTAssertEqual(configuration.sampleRate, 48_000)
		XCTAssertEqual(configuration.channelCount, 2)
		if #available(macOS 15.0, *) { XCTAssertFalse(configuration.captureMicrophone) }
	}

	/// Frames arrive on refreshes: the first refresh at least `interval` after the last frame.
	private func deliveredFps(refreshHz: Double, fps: Int) -> Double {
		let interval = CMTimeGetSeconds(
			CaptureSetupBuilder.minimumFrameInterval(quality: "high", fps: fps, refreshHz: refreshHz)
		)
		let refreshesPerFrame = max(1, (interval * refreshHz - 1e-9).rounded(.up))
		return refreshHz / refreshesPerFrame
	}

	func testHighDeliversAtLeastTheWrittenRateOnEveryRefreshRate() {
		for refreshHz in [59.94, 60, 75, 90, 100, 120, 144, 165, 240] {
			XCTAssertGreaterThanOrEqual(deliveredFps(refreshHz: refreshHz, fps: 60), 59.94, "\(refreshHz) Hz")
		}
		XCTAssertEqual(deliveredFps(refreshHz: 120, fps: 60), 60)
		XCTAssertEqual(deliveredFps(refreshHz: 240, fps: 60), 60)
		XCTAssertEqual(deliveredFps(refreshHz: 144, fps: 60), 72)
		XCTAssertEqual(deliveredFps(refreshHz: 75, fps: 60), 75)
		XCTAssertEqual(deliveredFps(refreshHz: 120, fps: 30), 30)
	}

	func testHighTakesEveryRefreshWhenTheRateIsUnknown() {
		let interval = CaptureSetupBuilder.minimumFrameInterval(quality: "high", fps: 60, refreshHz: 0)
		XCTAssertEqual(CMTimeCompare(interval, .zero), 0)
	}

	func testStandardDeliversTheWrittenRate() {
		let interval = CaptureSetupBuilder.minimumFrameInterval(quality: "standard", fps: 30, refreshHz: 120)
		XCTAssertEqual(CMTimeGetSeconds(interval), 1.0 / 30, accuracy: 0.000_001)
	}

	func testQueueDepthIsTheDocumentedMaximum() {
		XCTAssertEqual(CaptureSetupBuilder.queueDepth, 8)
	}

	func testScreenIsCapturedAsBT709VideoRange420() {
		XCTAssertEqual(CaptureSetupBuilder.pixelFormat, kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange)
		XCTAssertEqual(CaptureSetupBuilder.colorMatrix as String, CGDisplayStream.yCbCrMatrix_ITU_R_709_2 as String)
	}
}
