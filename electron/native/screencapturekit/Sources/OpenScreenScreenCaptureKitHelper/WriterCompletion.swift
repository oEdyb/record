import Foundation

final class WriterCompletion {
	private enum State {
		case pending([CheckedContinuation<Bool, Error>])
		case finished(Result<Bool, Error>)
	}
	private enum Event { case wait(CheckedContinuation<Bool, Error>), finish(Result<Bool, Error>) }
	private let lock = NSLock()
	private var state: State = .pending([])
	private func transition(_ event: Event) {
		lock.lock()
		let waiters: [CheckedContinuation<Bool, Error>]
		let result: Result<Bool, Error>?
		switch (state, event) {
		case (.pending(var current), .wait(let waiter)):
			current.append(waiter); state = .pending(current); waiters = []; result = nil
		case (.finished(let value), .wait(let waiter)): waiters = [waiter]; result = value
		case (.pending(let current), .finish(let value)): state = .finished(value); waiters = current; result = value
		case (.finished, .finish): waiters = []; result = nil
		}
		lock.unlock()
		if let result { for waiter in waiters { waiter.resume(with: result) } }
	}
	func wait() async throws -> Bool { try await withCheckedThrowingContinuation { transition(.wait($0)) } }
	func finish(_ result: Result<Bool, Error>) { transition(.finish(result)) }
}
