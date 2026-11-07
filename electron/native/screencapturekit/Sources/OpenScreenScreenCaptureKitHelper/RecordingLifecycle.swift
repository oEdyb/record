import CoreMedia
import Foundation

final class RecordingStopCompletion {
	private enum State { case pending([CheckedContinuation<Void, Never>]), finished }
	private enum Event { case wait(CheckedContinuation<Void, Never>), finish }
	private let lock = NSLock()
	private var state: State = .pending([])
	private func transition(_ event: Event) {
		lock.lock()
		let ready: [CheckedContinuation<Void, Never>]
		switch (state, event) {
		case (.pending(var waiters), .wait(let waiter)):
			waiters.append(waiter); state = .pending(waiters); ready = []
		case (.finished, .wait(let waiter)): ready = [waiter]
		case (.pending(let waiters), .finish): state = .finished; ready = waiters
		case (.finished, .finish): ready = []
		}
		lock.unlock()
		for waiter in ready { waiter.resume() }
	}
	func wait() async { await withCheckedContinuation { transition(.wait($0)) } }
	func finish() { transition(.finish) }
}

/// One authority shared by capture commands, stream recovery and first-append readiness.
/// The nested regions are one composite value; only transition changes that value.
final class RecordingLifecycle {
	struct Inputs {
		var originals: Set<String> = []
		var audioTracks: Set<String> = []
	}
	struct Startup {
		let epoch: CMTime
		let inputs: Inputs
		var lateSources: [String] = []
	}
	enum Clip {
		case prepared(Inputs), starting(Startup), live(Startup), cancelled(Startup), cancelledWithoutSession(Inputs), detached(Startup?)
		var startup: Startup? {
			switch self {
			case .prepared, .cancelledWithoutSession: return nil
			case .starting(let value), .live(let value), .cancelled(let value): return value
			case .detached(let value): return value
			}
		}
		var hasSession: Bool {
			switch self { case .starting, .live, .cancelled: return true; default: return false }
		}
		var isLive: Bool { if case .live = self { return true }; return false }
		var readinessActive: Bool { switch self { case .starting, .live: return true; default: return false } }
		var inputs: Inputs {
			switch self { case .prepared(let inputs), .cancelledWithoutSession(let inputs): return inputs; default: return startup?.inputs ?? Inputs() }
		}
	}
	struct Resume {
		enum Stage { case commandSuspended, commandAccepting, awaitingAcknowledgement }
		var generation: UInt64
		let previousClipIndex: Int
		var stage: Stage
		var commandInFlight: Bool {
			switch stage { case .commandSuspended, .commandAccepting: return true; case .awaitingAcknowledgement: return false }
		}
	}
	enum Transport { case prepared, active, paused, resuming(Resume) }
	enum Source {
		case uninstalled(UInt64), active(ObjectIdentifier, UInt64), inactive(ObjectIdentifier, UInt64), replacementRequired(ObjectIdentifier, UInt64)
		var generation: UInt64 {
			switch self { case .uninstalled(let value), .active(_, let value), .inactive(_, let value), .replacementRequired(_, let value): return value }
		}
		var identity: ObjectIdentifier? {
			switch self { case .uninstalled: return nil; case .active(let id, _), .inactive(let id, _), .replacementRequired(let id, _): return id }
		}
		var usable: Bool { if case .active = self { return true }; return false }
		var needsReplacement: Bool { if case .replacementRequired = self { return true }; return false }
		var canAttemptResume: Bool {
			switch self { case .active, .replacementRequired: return true; case .inactive, .uninstalled: return false }
		}
	}
	enum SourceCache { case stable, changing }
	enum SourceRate { case full, throttled(CMTime) }
	struct Capture {
		var transport: Transport = .prepared
		var source: Source = .uninstalled(0)
		var clip: Clip = .prepared(Inputs())
		var clipIndex = 0
		var sourceCache: SourceCache = .stable
		var sourceRate: SourceRate = .full
		var resume: Resume? { if case .resuming(let value) = transport { return value }; return nil }
		var paused: Bool {
			switch transport {
			case .prepared, .active: return false
			case .paused: return true
			case .resuming(let value): if case .commandSuspended = value.stage { return true }; return false
			}
		}
	}
	private enum FailurePublication { case detected, announced }
	private enum Origin { case normal, failed(FailurePublication) }
	private enum State {
		case running(Capture), terminalFailure(Capture, FailurePublication), stopping(Capture, Origin, RecordingStopCompletion), completed(Capture, Origin, RecordingStopCompletion)
		var capture: Capture {
			switch self { case .running(let value), .terminalFailure(let value, _), .stopping(let value, _, _), .completed(let value, _, _): return value }
		}
	}
	enum Event {
		case start, pause, beginResume(generation: UInt64, previousClipIndex: Int), resumeSeed(generation: UInt64, previousClipIndex: Int), acceptResumeFrames, awaitResumeAcknowledgement, rejectResume, fail, announceFailure, stop, stopped
		case prepareClip(Inputs, index: Int), beginEpoch(CMTime), acknowledge(videoAppended: Bool, gridCaughtUp: Bool, expectedGeneration: UInt64?), cancelReadiness, detachWriter
		case checkDeadline(now: CMTime, videoAppended: Bool, originals: Set<String>, audio: Set<String>)
		case beginSourceChange, endSourceChange, throttleSource(CMTime), restoreSourceRate
		case installSource(ObjectIdentifier), invalidateSource, sourceInactive(ObjectIdentifier), sourceActive(ObjectIdentifier), sourceStopped(ObjectIdentifier)
		var name: String {
			switch self {
			case .beginSourceChange: return "begin-source-change"; case .endSourceChange: return "end-source-change"; case .throttleSource: return "throttle-source"; case .restoreSourceRate: return "restore-source-rate"; case .start: return "start"; case .pause: return "pause"; case .beginResume: return "begin-resume"; case .resumeSeed: return "resume-seed"; case .acceptResumeFrames: return "accept-resume-frames"; case .awaitResumeAcknowledgement: return "await-resume-acknowledgement"; case .rejectResume: return "reject-resume"; case .fail: return "failure"; case .announceFailure: return "announce-failure"; case .stop: return "stop"; case .stopped: return "stopped"; case .prepareClip: return "prepare-clip"; case .beginEpoch: return "begin-epoch"; case .acknowledge: return "acknowledge"; case .cancelReadiness: return "cancel-readiness"; case .detachWriter: return "detach-writer"; case .checkDeadline: return "check-deadline"; case .installSource: return "install-source"; case .invalidateSource: return "invalidate-source"; case .sourceInactive: return "source-inactive"; case .sourceActive: return "source-active"; case .sourceStopped: return "source-stopped"
			}
		}
	}
	struct Outcome {
		var accepted = true
		var changed = false
		var acknowledgedIndex: Int?
		var acknowledged: Bool { acknowledgedIndex != nil }
		var lateSources: [String] = []
		var error: Error?
		var stop: RecordingStopCompletion?
		var ownsStop = false
		var sourceStop: RecordingStreamRecovery.StopDisposition = .ignored
	}
	private let lock = NSRecursiveLock()
	private var state: State = .running(Capture())
	private let log: (String, String) -> Void
	init(log: @escaping (String, String) -> Void = { from, event in emit(["event": "warning", "code": "illegal-recording-transition", "from": from, "transition": event]) }) { self.log = log }
	private func read<T>(_ body: (State) -> T) -> T { lock.lock(); defer { lock.unlock() }; return body(state) }
	var capture: Capture { read { $0.capture } }
	private var isCompleted: Bool { if case .completed = state { return true }; return false }
	var isStopping: Bool { read { if case .stopping = $0 { return true }; if case .completed = $0 { return true }; return false } }
	var hasTerminalFailure: Bool { read { switch $0 { case .terminalFailure, .stopping(_, .failed(_), _), .completed(_, .failed(_), _): return true; default: return false } } }
	var isPaused: Bool { read { if case .terminalFailure = $0 { return true }; return $0.capture.paused } }
	var name: String { read(Self.name) }
	private static func name(_ state: State) -> String {
		switch state {
		case .stopping: return "stopping"; case .completed: return "completed"; case .terminalFailure: return "terminal-failure"
		case .running(let capture):
			switch capture.source { case .inactive: return "source-inactive"; case .replacementRequired: return "replacement-required"; default: break }
			switch capture.transport {
			case .prepared: return "prepared"; case .paused: return "paused"
			case .resuming(let resume): return resume.commandInFlight ? "resume-command-in-flight" : "awaiting-resume-seed"
			case .active: return capture.clip.isLive ? "live" : "first-screen-startup"
			}
		}
	}
	@discardableResult func transition(_ event: Event) -> Outcome {
		lock.lock()
		let before = Self.name(state)
		var context = state.capture
		var result = Outcome()
		func reject() { result.accepted = false }
		func running() -> Bool { if case .running = state { return true }; return false }
		func saveCapture() {
			switch state {
			case .running: state = .running(context)
			case .terminalFailure(_, let publication): state = .terminalFailure(context, publication)
			case .stopping(_, let origin, let stop): state = .stopping(context, origin, stop)
			case .completed(_, let origin, let stop): state = .completed(context, origin, stop)
			}
		}
		switch event {
		case .start:
			if running(), case .prepared = context.transport { context.transport = .active; saveCapture(); result.changed = true } else { reject() }
		case .pause:
			if running(), !context.paused { context.transport = .paused; saveCapture(); result.changed = true }
		case .beginResume(let generation, let index):
			if running(), case .paused = context.transport, context.source.canAttemptResume {
				context.transport = .resuming(Resume(generation: generation, previousClipIndex: index, stage: .commandSuspended)); saveCapture(); result.changed = true
			} else { reject() }
		case .resumeSeed(let generation, let index):
			if running(), let resume = context.resume, resume.previousClipIndex == index {
				context.transport = .resuming(Resume(generation: generation, previousClipIndex: index, stage: .commandSuspended)); saveCapture(); result.changed = true
			} else { reject() }
		case .acceptResumeFrames:
			if running(), var resume = context.resume { resume.stage = .commandAccepting; context.transport = .resuming(resume); saveCapture(); result.changed = true } else { reject() }
		case .awaitResumeAcknowledgement:
			if running(), var resume = context.resume { resume.stage = .awaitingAcknowledgement; context.transport = .resuming(resume); saveCapture(); result.changed = true }
		case .rejectResume:
			if running(), context.resume != nil, !context.clip.hasSession { context.transport = .paused; saveCapture(); result.changed = true } else { reject() }
		case .fail:
			if running() { context.transport = .paused; state = .terminalFailure(context, .detected); result.changed = true }
		case .announceFailure:
			switch state {
			case .running: context.transport = .paused; state = .terminalFailure(context, .announced); result.changed = true
			case .terminalFailure(_, .detected): state = .terminalFailure(context, .announced); result.changed = true
			case .stopping(_, .failed(.detected), let stop): state = .stopping(context, .failed(.announced), stop); result.changed = true
			case .stopping(_, .normal, let stop): state = .stopping(context, .failed(.announced), stop); result.changed = true
			default: break
			}
		case .stop:
			switch state {
			case .stopping(_, _, let stop), .completed(_, _, let stop): result.stop = stop
			case .running, .terminalFailure:
				let origin: Origin
				if case .terminalFailure(_, let publication) = state { origin = .failed(publication) } else { origin = .normal }
				let stop = RecordingStopCompletion(); state = .stopping(context, origin, stop); result.stop = stop; result.ownsStop = true; result.changed = true
			}
		case .stopped:
			if case .stopping(_, let origin, let stop) = state { state = .completed(context, origin, stop); result.changed = true } else { reject() }
		case .prepareClip(let inputs, let index):
			if running(), !context.clip.hasSession { context.clip = .prepared(inputs); context.clipIndex = index; saveCapture(); result.changed = true } else { reject() }
		case .beginEpoch(let epoch):
			// An admitted native startSession may return after Stop takes ownership.
			if !isCompleted, case .prepared(let inputs) = context.clip {
				context.clip = .starting(Startup(epoch: epoch, inputs: inputs)); if case .prepared = context.transport { context.transport = .active }; saveCapture(); result.changed = true
			} else { reject() }
		case .acknowledge(let video, let caughtUp, let expectedGeneration):
			if running(), !context.paused, video, caughtUp, case .starting(let startup) = context.clip,
				context.source.usable, expectedGeneration.map({ $0 == context.source.generation }) ?? true {
				context.clip = .live(startup); context.transport = .active; saveCapture(); result.acknowledgedIndex = context.clipIndex; result.changed = true
			}
		case .cancelReadiness:
			switch context.clip {
			case .prepared(let inputs), .cancelledWithoutSession(let inputs): context.clip = .cancelledWithoutSession(inputs)
			case .starting(let startup), .live(let startup), .cancelled(let startup): context.clip = .cancelled(startup)
			case .detached: break
			}
			if running(), case .active = context.transport { context.transport = .paused }; saveCapture(); result.changed = true
		case .detachWriter:
			if !context.clip.hasSession || context.paused || context.resume != nil || !running() {
				context.clip = .detached(context.clip.startup); saveCapture(); result.changed = true
			} else { reject() }
		case .checkDeadline(let now, let video, let originals, let audio):
			if running(), !context.paused, context.clip.readinessActive, let startup = context.clip.startup, now.isNumeric,
				now - startup.epoch >= CMTime(seconds: RecordingStartup.sourceDeadlineSeconds, preferredTimescale: 1_000_000) {
				if !video { result.error = HelperError.writerSetupFailed("Recording startup exceeded two seconds waiting for screen video.") }
				else if !context.clip.isLive { result.error = HelperError.writerSetupFailed("Recording startup exceeded two seconds waiting for the video timeline to catch up.") }
				else {
					var next = startup
					let missing = startup.inputs.originals.subtracting(originals).sorted() + startup.inputs.audioTracks.subtracting(audio).sorted().map { "\($0) AAC" }
					result.lateSources = missing.filter { !startup.lateSources.contains($0) }; next.lateSources += result.lateSources
					context.clip = .live(next); saveCapture()
				}
			}
		case .beginSourceChange:
			if running(), context.paused, case .stable = context.sourceCache { context.sourceCache = .changing; saveCapture(); result.changed = true } else { reject() }
		case .endSourceChange:
			context.sourceCache = .stable; saveCapture(); result.changed = true
		case .throttleSource(let interval):
			context.sourceRate = .throttled(interval); saveCapture(); result.changed = true
		case .restoreSourceRate:
			context.sourceRate = .full; saveCapture(); result.changed = true
		case .installSource(let id):
			if !isCompleted { context.source = .active(id, context.source.generation &+ 1); saveCapture(); result.changed = true } else { reject() }
		case .invalidateSource:
			if let id = context.source.identity { context.source = .replacementRequired(id, context.source.generation); saveCapture(); result.changed = true }
		case .sourceInactive(let id):
			if running(), case .active(let current, let generation) = context.source, current == id { context.source = .inactive(id, generation &+ 1); saveCapture(); result.changed = true }
		case .sourceActive(let id):
			if running(), case .inactive(let current, let generation) = context.source, current == id { context.source = .active(id, generation); saveCapture(); result.changed = true }
		case .sourceStopped(let id):
			if running(), context.source.identity == id, !context.source.needsReplacement {
				context.source = .replacementRequired(id, context.source.generation)
				if context.paused || context.resume != nil { result.sourceStop = .pausedSourceUnavailable; saveCapture() }
				else { result.sourceStop = .activeFailure; context.transport = .paused; state = .terminalFailure(context, .detected) }
				result.changed = true
			}
		}
		lock.unlock()
		if !result.accepted { log(before, event.name) }
		return result
	}
}
