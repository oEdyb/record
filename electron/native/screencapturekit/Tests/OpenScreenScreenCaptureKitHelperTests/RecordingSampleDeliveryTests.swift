import Dispatch
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class RecordingSampleDeliveryTests: XCTestCase {
	func testFrameworkReceiveWaitDoesNotBlockWriterTimer() {
		let delivery = RecordingSampleDelivery()
		let receiving = DispatchSemaphore(value: 0)
		let release = DispatchSemaphore(value: 0)
		delivery.queue.async { receiving.signal(); release.wait() }
		XCTAssertEqual(receiving.wait(timeout: .now() + 1), .success)
		defer { release.signal(); delivery.barrier {} }
		let fired = expectation(description: "Writer timer runs while delivery is blocked")
		let timer = DispatchSource.makeTimerSource(queue: delivery.processingQueue)
		timer.schedule(deadline: .now() + .milliseconds(10))
		timer.setEventHandler { fired.fulfill() }
		timer.resume()
		wait(for: [fired], timeout: 1)
		timer.cancel()
	}

	func testSourceBarrierDrainsAcceptedSamplesBeforeReset() {
		let delivery = RecordingSampleDelivery()
		let firstStarted = DispatchSemaphore(value: 0)
		let release = DispatchSemaphore(value: 0)
		let values = Values()
		delivery.queue.async {
			firstStarted.signal()
			release.wait()
			delivery.process { values.events.append("old") }
		}
		XCTAssertEqual(firstStarted.wait(timeout: .now() + 1), .success)
		delivery.queue.async { delivery.process { values.events.append("queued-old") } }
		release.signal()
		delivery.barrier { values.events.append("reset") }
		delivery.queue.async { delivery.process { values.events.append("new") } }
		delivery.barrier { XCTAssertEqual(values.events, ["old", "queued-old", "reset", "new"]) }
	}

	private final class Values { var events: [String] = [] }
}
