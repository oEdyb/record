import Foundation

/// Capture and finalization own separate leases so a capture failure cannot end
/// the activity while the remaining media is still being saved.
final class RecordingProcessActivity {
	final class Lease {
		private let owner: RecordingProcessActivity
		private let id: UUID

		fileprivate init(owner: RecordingProcessActivity, id: UUID) {
			self.owner = owner
			self.id = id
		}

		func end() { owner.release(id) }
		deinit { end() }
	}

	private let lock = NSLock()
	private var token: NSObjectProtocol?
	private var leases: Set<UUID> = []
	private let beginActivity: () -> NSObjectProtocol
	private let endActivity: (NSObjectProtocol) -> Void

	init(
		begin: @escaping () -> NSObjectProtocol = {
			ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical], reason: "Recording screen and audio")
		},
		end: @escaping (NSObjectProtocol) -> Void = { ProcessInfo.processInfo.endActivity($0) }
	) {
		beginActivity = begin
		endActivity = end
	}

	func acquire() -> Lease {
		lock.lock()
		defer { lock.unlock() }
		if token == nil { token = beginActivity() }
		let id = UUID()
		leases.insert(id)
		return Lease(owner: self, id: id)
	}

	private func release(_ id: UUID) {
		lock.lock()
		guard leases.remove(id) != nil, leases.isEmpty else {
			lock.unlock()
			return
		}
		let previous = token
		token = nil
		lock.unlock()
		if let previous { endActivity(previous) }
	}
}
