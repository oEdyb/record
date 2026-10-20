import CoreGraphics
import Foundation
import ScreenCaptureKit

/// What a start or rebuild needs from a window-list snapshot, as plain values so the
/// freshness rule can be tested without ScreenCaptureKit objects.
struct ContentSnapshotNeeds: Equatable {
	enum Target: Equatable {
		case display(CGDirectDisplayID)
		case window(CGWindowID)
	}
	let target: Target
	let excludedWindowIDs: Set<CGWindowID>
	let excludedProcessIDs: Set<pid_t>

	init(target: Target, excludedWindowIDs: Set<CGWindowID> = [], excludedProcessIDs: Set<pid_t> = []) {
		self.target = target
		self.excludedWindowIDs = excludedWindowIDs
		self.excludedProcessIDs = excludedProcessIDs
	}

	init?(request: RecordingRequest) {
		switch request.source.type {
		case "display":
			guard let id = request.source.displayId else { return nil }
			target = .display(id)
		case "window":
			guard let id = request.source.windowId else { return nil }
			target = .window(id)
		default:
			return nil
		}
		excludedProcessIDs = Set(request.source.excludedProcessIds ?? [])
		// A filter that hides the app by process never reads the window list.
		excludedWindowIDs = excludedProcessIDs.isEmpty ? Set(request.source.excludedWindowIds ?? []) : []
	}
}

struct ContentSnapshotSummary {
	var displays: [CGDirectDisplayID: CGRect]
	var windows: [CGWindowID: CGRect]
	var processIDs: Set<pid_t>
	var fetchedAt: TimeInterval
}

enum ContentSnapshotRule {
	static let maxAgeSeconds: TimeInterval = 10
	/// Each refresh costs replayd and the helper a window-server listing, and the standby
	/// helper lives as long as the app does. Refresh just often enough to stay inside
	/// `maxAgeSeconds`, with room for a slow listing.
	static let refreshSeconds: TimeInterval = 8

	/// A snapshot serves a request only when it holds every object the filter needs and the
	/// capture target's live bounds still equal the snapshot's. Anything else fetches again,
	/// so a window resized or a display switched since the snapshot never sets the output size.
	/// Returns nil when the snapshot covers the request, otherwise why it does not.
	static func rejection(
		_ summary: ContentSnapshotSummary, needs: ContentSnapshotNeeds, now: TimeInterval,
		liveDisplayBounds: (CGDirectDisplayID) -> CGRect?, liveWindowBounds: (CGWindowID) -> CGRect?
	) -> String? {
		guard now - summary.fetchedAt <= maxAgeSeconds else { return "snapshot-too-old" }
		switch needs.target {
		case .display(let id):
			guard let frame = summary.displays[id] else { return "display-missing" }
			guard liveDisplayBounds(id) == frame else { return "display-bounds-changed" }
		case .window(let id):
			guard let frame = summary.windows[id] else { return "window-missing" }
			guard let live = liveWindowBounds(id) else { return "window-gone" }
			guard live == frame else { return "window-bounds-changed" }
		}
		guard needs.excludedProcessIDs.isSubset(of: summary.processIDs) else { return "excluded-app-missing" }
		guard needs.excludedWindowIDs.isSubset(of: Set(summary.windows.keys)) else { return "excluded-window-missing" }
		return nil
	}

	static func covers(
		_ summary: ContentSnapshotSummary, needs: ContentSnapshotNeeds, now: TimeInterval,
		liveDisplayBounds: (CGDirectDisplayID) -> CGRect?, liveWindowBounds: (CGWindowID) -> CGRect?
	) -> Bool {
		rejection(summary, needs: needs, now: now, liveDisplayBounds: liveDisplayBounds, liveWindowBounds: liveWindowBounds) == nil
	}
}

/// SCShareableContent answers in about 25 ms on a quiet window server and in over a second
/// whenever any app is slow to list its windows. Standby and Pause keep a young snapshot so a
/// start or rebuild usually skips that wait; the rule above decides when it may be reused.
@available(macOS 13.0, *)
actor ShareableContentCache {
	static let shared = ShareableContentCache()
	private var content: SCShareableContent?
	private var summary: ContentSnapshotSummary?
	private var refresher: Task<Void, Never>?

	static func fetch() async throws -> SCShareableContent {
		try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
	}

	func refresh() async {
		guard let fresh = try? await Self.fetch() else { return }
		store(fresh)
	}

	func current() -> SCShareableContent? { content }

	/// The cached snapshot when it still describes the request exactly, otherwise a fresh one
	/// and the reason the snapshot could not serve.
	func content(for request: RecordingRequest) async throws -> (content: SCShareableContent, rejection: String?) {
		var rejection = "no-snapshot"
		if let content, let summary {
			guard let needs = ContentSnapshotNeeds(request: request) else { return (content, nil) }
			rejection = ContentSnapshotRule.rejection(
				summary, needs: needs, now: Date().timeIntervalSince1970,
				liveDisplayBounds: { CGDisplayBounds($0) }, liveWindowBounds: Self.liveWindowBounds) ?? ""
			if rejection.isEmpty { return (content, nil) }
		}
		let fresh = try await Self.fetch()
		store(fresh)
		return (fresh, rejection)
	}

	/// Refetches on an interval while nothing is being captured, so the next start or rebuild
	/// finds a snapshot it can use.
	func keepFresh(every seconds: TimeInterval) {
		refresher?.cancel()
		refresher = Task { [weak self] in
			while !Task.isCancelled {
				await self?.refresh()
				try? await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
			}
		}
	}

	func stopKeepingFresh() {
		refresher?.cancel()
		refresher = nil
	}

	private func store(_ fresh: SCShareableContent) {
		content = fresh
		summary = ContentSnapshotSummary(
			displays: Dictionary(fresh.displays.map { ($0.displayID, $0.frame) }, uniquingKeysWith: { first, _ in first }),
			windows: Dictionary(fresh.windows.map { ($0.windowID, $0.frame) }, uniquingKeysWith: { first, _ in first }),
			processIDs: Set(fresh.applications.map(\.processID)),
			fetchedAt: Date().timeIntervalSince1970)
	}

	static func liveWindowBounds(_ id: CGWindowID) -> CGRect? {
		guard let info = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
			let bounds = info.first?[kCGWindowBounds as String] as? NSDictionary,
			let rect = CGRect(dictionaryRepresentation: bounds)
		else { return nil }
		return rect
	}
}
