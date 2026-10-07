import CoreGraphics
import XCTest
@testable import OpenScreenScreenCaptureKitHelper

final class ContentSnapshotRuleTests: XCTestCase {
	private let display = CGRect(x: 0, y: 0, width: 1728, height: 1117)
	private let window = CGRect(x: 100, y: 80, width: 1200, height: 800)

	private func summary(fetchedAt: TimeInterval = 100) -> ContentSnapshotSummary {
		ContentSnapshotSummary(displays: [1: display], windows: [40: window, 41: CGRect(x: 0, y: 0, width: 10, height: 10)],
			processIDs: [500, 501], fetchedAt: fetchedAt)
	}

	private func covers(_ needs: ContentSnapshotNeeds, now: TimeInterval = 105, summary: ContentSnapshotSummary? = nil,
		liveDisplay: CGRect? = nil, liveWindow: CGRect? = nil, windowGone: Bool = false) -> Bool {
		ContentSnapshotRule.covers(summary ?? self.summary(), needs: needs, now: now,
			liveDisplayBounds: { _ in liveDisplay ?? self.display },
			liveWindowBounds: { _ in windowGone ? nil : (liveWindow ?? self.window) })
	}

	func testYoungSnapshotWithUnchangedTargetServesTheRequest() {
		XCTAssertTrue(covers(ContentSnapshotNeeds(target: .display(1), excludedProcessIDs: [500])))
		XCTAssertTrue(covers(ContentSnapshotNeeds(target: .window(40))))
		XCTAssertTrue(covers(ContentSnapshotNeeds(target: .display(1), excludedWindowIDs: [40, 41])))
	}

	func testOldSnapshotIsFetchedAgain() {
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .display(1)), now: 100 + ContentSnapshotRule.maxAgeSeconds + 0.1))
	}

	func testTargetThatMovedOrResizedSinceTheSnapshotIsFetchedAgain() {
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .display(1)), liveDisplay: CGRect(x: 0, y: 0, width: 1512, height: 982)),
			"A display switched to another resolution must not keep the old output size")
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .window(40)), liveWindow: CGRect(x: 100, y: 80, width: 900, height: 800)))
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .window(40)), windowGone: true), "A closed window is gone")
	}

	func testMissingFilterObjectsAreFetchedAgain() {
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .window(99))), "A window opened after the snapshot")
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .display(2))))
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .display(1), excludedWindowIDs: [40, 77])),
			"An app window created since the snapshot would otherwise be recorded")
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .display(1), excludedProcessIDs: [600])))
	}

	func testRejectionNamesTheReason() {
		let now: TimeInterval = 105
		func reason(_ needs: ContentSnapshotNeeds, liveWindow: CGRect?, now: TimeInterval = 105) -> String? {
			ContentSnapshotRule.rejection(summary(), needs: needs, now: now,
				liveDisplayBounds: { _ in self.display }, liveWindowBounds: { _ in liveWindow })
		}
		XCTAssertNil(reason(ContentSnapshotNeeds(target: .window(40)), liveWindow: window))
		XCTAssertEqual(reason(ContentSnapshotNeeds(target: .window(40)), liveWindow: nil), "window-gone")
		XCTAssertEqual(reason(ContentSnapshotNeeds(target: .window(40)), liveWindow: window.offsetBy(dx: 1, dy: 0)), "window-bounds-changed")
		XCTAssertEqual(reason(ContentSnapshotNeeds(target: .window(99)), liveWindow: window), "window-missing")
		XCTAssertEqual(reason(ContentSnapshotNeeds(target: .display(1)), liveWindow: window, now: now + 20), "snapshot-too-old")
		XCTAssertEqual(reason(ContentSnapshotNeeds(target: .display(1), excludedWindowIDs: [7]), liveWindow: window), "excluded-window-missing")
	}

	func testWindowCoverageIsLiveWhenNoWindowBoundsAreKnown() {
		var stale = summary()
		stale.windows = [:]
		XCTAssertFalse(covers(ContentSnapshotNeeds(target: .window(40)), summary: stale))
	}
}
