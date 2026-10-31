import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class MicrophoneDeviceSelectionTests: XCTestCase {
	let devices = [(id: "usb", name: "Shure MV7"), (id: "builtin", name: "MacBook Air Microphone")]

	func testChromiumSuffixesResolveWithoutGuessingSubstrings() {
		for suffix in ["14ed:1012", "Built-in", "Virtual", "Aggregate", "Bluetooth"] {
			XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: "hash", deviceName: " Shure MV7 (\(suffix)) ", devices: devices), "usb")
		}
		for name in ["Shure", "Shure MV7 (Unknown)", "Shure MV7 (Virtual) extra", "Default - Shure MV7 (Virtual)"] {
			XCTAssertNil(resolveMicrophoneDeviceID(deviceID: "hash", deviceName: name, devices: devices))
		}
	}

	func testNativeIDWinsAndExactDecoratedNamesArePreserved() {
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: " usb ", deviceName: "MacBook Air Microphone", devices: devices), "usb")
		XCTAssertEqual(resolveMicrophoneDeviceID(deviceID: nil, deviceName: "Shure MV7 (Virtual)", devices: devices + [(id: "literal", name: "Shure MV7 (Virtual)")]), "literal")
	}

	func testAmbiguityFallsBackWithWarning() {
		let duplicate = devices + [(id: "other", name: "Shure MV7")]
		for name in ["Shure MV7", "Shure MV7 (Virtual)"] {
			let resolved = resolveMicrophoneDeviceID(deviceID: "hash", deviceName: name, devices: duplicate)
			XCTAssertNil(resolved)
			XCTAssertNotNil(microphoneFallbackWarning(deviceID: "hash", deviceName: name, resolvedID: resolved))
		}
	}

	func testDefaultAndResolvedSelectionsDoNotWarn() {
		XCTAssertNil(microphoneFallbackWarning(deviceID: nil, deviceName: nil, resolvedID: nil))
		XCTAssertNil(microphoneFallbackWarning(deviceID: " default ", deviceName: "Default - Shure MV7 (Virtual)", resolvedID: nil))
		XCTAssertNil(microphoneFallbackWarning(deviceID: "hash", deviceName: "Shure MV7", resolvedID: "usb"))
		XCTAssertNotNil(microphoneFallbackWarning(deviceID: nil, deviceName: "Disconnected", resolvedID: nil))
	}
}
