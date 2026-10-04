import Dispatch

final class RecordingSampleDelivery {
	let queue = DispatchQueue(label: "app.openscreen.sck-helper.delivery", qos: .userInitiated)
	let processingQueue = DispatchQueue(label: "app.openscreen.sck-helper.samples", qos: .userInitiated)

	func process(_ work: () -> Void) {
		processingQueue.sync(execute: work)
	}

	// Command lane only: drain earlier framework callbacks before changing source acceptance.
	func barrier(_ work: () -> Void) {
		queue.sync { processingQueue.sync(execute: work) }
	}
}
