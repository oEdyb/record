import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class CameraGeometryGateTests: XCTestCase {
	func testForwardsNativeFrames() {
		var gate = CameraGeometryGate()
		XCTAssertEqual(gate.admit(native: true), .forward)
		XCTAssertEqual(gate.admit(native: true), .forward)
	}

	func testDropsFramesAtAnotherSizeAndReportsOnlyTheEdgesOfTheGap() {
		var gate = CameraGeometryGate()
		XCTAssertEqual(gate.admit(native: false), .dropStartingGap)
		XCTAssertEqual(gate.admit(native: false), .drop)
		XCTAssertEqual(gate.admit(native: false), .drop)
		XCTAssertEqual(gate.admit(native: true), .forwardAfterGap(dropped: 3))
		XCTAssertEqual(gate.admit(native: true), .forward)
	}

	func testReportsEveryNewGap() {
		var gate = CameraGeometryGate()
		XCTAssertEqual(gate.admit(native: false), .dropStartingGap)
		XCTAssertEqual(gate.admit(native: true), .forwardAfterGap(dropped: 1))
		XCTAssertEqual(gate.admit(native: false), .dropStartingGap)
	}
}
