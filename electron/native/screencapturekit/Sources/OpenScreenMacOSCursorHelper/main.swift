import AppKit
import ApplicationServices
import CryptoKit
import Foundation

struct CursorHelperRequest: Decodable {
	let sampleIntervalMs: Int?
}

struct CapturedCursorAsset {
	let id: String
	let imageDataUrl: String
	let width: Int
	let height: Int
	let hotspotX: Double
	let hotspotY: Double
	let scaleFactor: Double
}

final class MouseButtonTracker {
	private let lock = NSLock()
	private var transitions: [Transition] = []
	private var isLeftButtonDown = false
	private var eventTap: CFMachPort?
	private var runLoopSource: CFRunLoopSource?

	struct Transition {
		let kind: String
		let timestampMs: Int
		let point: CGPoint
	}

	struct Batch {
		let transitions: [Transition]
		let isLeftButtonDown: Bool
	}

	func start() -> Bool {
		let mask =
			(1 << CGEventType.leftMouseDown.rawValue) |
			(1 << CGEventType.leftMouseUp.rawValue)
		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .listenOnly,
			eventsOfInterest: CGEventMask(mask),
			callback: { _, type, event, userInfo in
				if let userInfo {
					let tracker = Unmanaged<MouseButtonTracker>.fromOpaque(userInfo).takeUnretainedValue()
					tracker.record(type, event: event)
				}
				return Unmanaged.passUnretained(event)
			},
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			return false
		}

		guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
			return false
		}

		eventTap = tap
		runLoopSource = source
		CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
		CGEvent.tapEnable(tap: tap, enable: true)
		return true
	}

	func pump() {
		CFRunLoopRunInMode(.defaultMode, 0.001, false)
	}

	func consume() -> Batch {
		lock.lock()
		defer { lock.unlock() }
		let events = transitions
		transitions.removeAll(keepingCapacity: true)
		return Batch(transitions: events, isLeftButtonDown: isLeftButtonDown)
	}

	private func record(_ type: CGEventType, event: CGEvent) {
		lock.lock()
		defer { lock.unlock() }
		if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
			reenableTap()
			return
		}
		if type == .leftMouseDown {
			isLeftButtonDown = true
			transitions.append(Transition(kind: "down", timestampMs: timestampMs(), point: event.location))
		} else if type == .leftMouseUp {
			isLeftButtonDown = false
			transitions.append(Transition(kind: "up", timestampMs: timestampMs(), point: event.location))
		}
	}

	private func reenableTap() {
		if let eventTap {
			CGEvent.tapEnable(tap: eventTap, enable: true)
		}
	}
}

final class KeyboardActivityTracker {
	private let lock = NSLock()
	private var activities: [Activity] = []
	private var lastTargetLookupMs = 0
	private var targetLookupInFlight = false
	private var eventTap: CFMachPort?
	private var runLoopSource: CFRunLoopSource?
	private static let targetLookupIntervalMs = 100
	private let targetQueue = DispatchQueue(
		label: "co.openscreen.cursor-helper.typing-target",
		qos: .utility
	)

	struct Activity {
		let timestampMs: Int
		let target: TypingTarget
	}

	func start() -> Bool {
		let mask = 1 << CGEventType.keyDown.rawValue
		guard let tap = CGEvent.tapCreate(
			tap: .cgSessionEventTap,
			place: .headInsertEventTap,
			options: .listenOnly,
			eventsOfInterest: CGEventMask(mask),
			callback: { _, type, event, userInfo in
				if let userInfo {
					let tracker = Unmanaged<KeyboardActivityTracker>.fromOpaque(userInfo)
						.takeUnretainedValue()
					tracker.record(type, event: event)
				}
				return Unmanaged.passUnretained(event)
			},
			userInfo: UnsafeMutableRawPointer(Unmanaged.passUnretained(self).toOpaque())
		) else {
			return false
		}

		guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0) else {
			return false
		}

		eventTap = tap
		runLoopSource = source
		CFRunLoopAddSource(CFRunLoopGetCurrent(), source, .commonModes)
		CGEvent.tapEnable(tap: tap, enable: true)
		return true
	}

	func consume() -> [Activity] {
		lock.lock()
		defer { lock.unlock() }
		let consumed = activities
		activities.removeAll(keepingCapacity: true)
		return consumed
	}

	private func record(_ type: CGEventType, event _: CGEvent) {
		if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
			lock.lock()
			if let eventTap {
				CGEvent.tapEnable(tap: eventTap, enable: true)
			}
			lock.unlock()
			return
		}
		guard type == .keyDown else {
			return
		}

		// Look up at most ten targets per second. Each accepted event is tied to
		// the target that was focused when that event arrived. If Accessibility
		// cannot prove that target is a non-secure editable element, drop it.
		let nowMs = timestampMs()
		lock.lock()
		guard nowMs - lastTargetLookupMs >= Self.targetLookupIntervalMs,
			!targetLookupInFlight,
			let focused = focusedElement()
		else {
			lock.unlock()
			return
		}
		lastTargetLookupMs = nowMs
		targetLookupInFlight = true
		lock.unlock()

		targetQueue.async { [weak self] in
			guard let self else {
				return
			}
			let target = typingTarget(startingAt: focused)
			self.lock.lock()
			if let target {
				self.activities.append(Activity(timestampMs: nowMs, target: target))
			}
			self.targetLookupInFlight = false
			self.lock.unlock()
		}
	}
}

struct TypingTarget {
	let focus: CGPoint
	let bounds: CGRect
	let focusSource: String
	let processId: pid_t
	let contextId: String
	let targetId: String
}

final class OpaqueElementRegistry {
	private struct Entry {
		let prefix: String
		let processId: pid_t
		let element: CFTypeRef
		let id: String
	}

	private let lock = NSLock()
	private let seed = UUID().uuidString
	private var nextId = 0
	private var entries: [Entry] = []
	private var processContexts: [pid_t: String] = [:]

	private func makeId(prefix: String) -> String {
		defer { nextId += 1 }
		let data = Data("\(seed):\(prefix):\(nextId)".utf8)
		let digest = SHA256.hash(data: data).prefix(12).map { String(format: "%02x", $0) }.joined()
		return "\(prefix)-\(digest)"
	}

	func identity(prefix: String, processId: pid_t, element: CFTypeRef) -> String {
		lock.lock()
		defer { lock.unlock() }
		if let entry = entries.first(where: {
			$0.prefix == prefix && $0.processId == processId && CFEqual($0.element, element)
		}) {
			return entry.id
		}
		let id = makeId(prefix: prefix)
		entries.append(Entry(prefix: prefix, processId: processId, element: element, id: id))
		return id
	}

	func processContext(processId: pid_t) -> String {
		lock.lock()
		defer { lock.unlock() }
		if let id = processContexts[processId] {
			return id
		}
		let id = makeId(prefix: "context")
		processContexts[processId] = id
		return id
	}
}

let opaqueElementRegistry = OpaqueElementRegistry()

func contextIdentity(for element: AXUIElement, processId: pid_t) -> String {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXWindowAttribute as CFString, &value)
	if result == .success, let window = value, CFGetTypeID(window) == AXUIElementGetTypeID() {
		return opaqueElementRegistry.identity(
			prefix: "context",
			processId: processId,
			element: window
		)
	}
	return opaqueElementRegistry.processContext(processId: processId)
}

func emit(_ fields: [String: Any?]) {
	let compacted = fields.compactMapValues { $0 }
	if let data = try? JSONSerialization.data(withJSONObject: compacted, options: []),
		let line = String(data: data, encoding: .utf8)
	{
		print(line)
		fflush(stdout)
	}
}

func stringAttribute(_ element: AXUIElement, _ attribute: String) -> String? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	return value as? String
}

func booleanAttribute(_ element: AXUIElement, _ attribute: String) -> Bool? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	guard result == .success else {
		return nil
	}
	return value as? Bool
}

func pointAttribute(_ element: AXUIElement, _ attribute: String) -> CGPoint? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	guard result == .success, let value, CFGetTypeID(value) == AXValueGetTypeID() else {
		return nil
	}
	let axValue = value as! AXValue
	guard AXValueGetType(axValue) == .cgPoint else {
		return nil
	}
	var point = CGPoint.zero
	return AXValueGetValue(axValue, .cgPoint, &point) ? point : nil
}

func sizeAttribute(_ element: AXUIElement, _ attribute: String) -> CGSize? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	guard result == .success, let value, CFGetTypeID(value) == AXValueGetTypeID() else {
		return nil
	}
	let axValue = value as! AXValue
	guard AXValueGetType(axValue) == .cgSize else {
		return nil
	}
	var size = CGSize.zero
	return AXValueGetValue(axValue, .cgSize, &size) ? size : nil
}

func elementBounds(_ element: AXUIElement) -> CGRect? {
	guard let position = pointAttribute(element, kAXPositionAttribute),
		let size = sizeAttribute(element, kAXSizeAttribute),
		size.width >= 0,
		size.height >= 0
	else {
		return nil
	}
	return CGRect(origin: position, size: size)
}

func selectedTextBounds(_ element: AXUIElement) -> CGRect? {
	var rangeValue: CFTypeRef?
	guard AXUIElementCopyAttributeValue(
		element,
		kAXSelectedTextRangeAttribute as CFString,
		&rangeValue
	) == .success, let rangeValue else {
		return nil
	}

	var boundsValue: CFTypeRef?
	guard AXUIElementCopyParameterizedAttributeValue(
		element,
		kAXBoundsForRangeParameterizedAttribute as CFString,
		rangeValue,
		&boundsValue
	) == .success,
		let boundsValue,
		CFGetTypeID(boundsValue) == AXValueGetTypeID()
	else {
		return nil
	}
	let axValue = boundsValue as! AXValue
	guard AXValueGetType(axValue) == .cgRect else {
		return nil
	}
	var bounds = CGRect.zero
	return AXValueGetValue(axValue, .cgRect, &bounds) ? bounds : nil
}

func focusedElement() -> AXUIElement? {
	let systemWide = AXUIElementCreateSystemWide()
	guard AXUIElementSetMessagingTimeout(systemWide, 0.01) == .success else {
		return nil
	}
	var value: CFTypeRef?
	guard AXUIElementCopyAttributeValue(
		systemWide,
		kAXFocusedUIElementAttribute as CFString,
		&value
	) == .success,
		let value,
		CFGetTypeID(value) == AXUIElementGetTypeID()
	else {
		return nil
	}
	return (value as! AXUIElement)
}

enum SafeAXLookup<Value> {
	case value(Value)
	case absent
	case failed
}

func safeAttribute(_ element: AXUIElement, _ attribute: String) -> SafeAXLookup<CFTypeRef> {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
	if result == .noValue || result == .attributeUnsupported {
		return .absent
	}
	guard result == .success, let value else {
		return .failed
	}
	return .value(value)
}

func safeStringAttribute(_ element: AXUIElement, _ attribute: String) -> SafeAXLookup<String> {
	switch safeAttribute(element, attribute) {
	case let .value(value):
		guard let string = value as? String else {
			return .failed
		}
		return .value(string)
	case .absent:
		return .absent
	case .failed:
		return .failed
	}
}

func safeBooleanAttribute(_ element: AXUIElement, _ attribute: String) -> SafeAXLookup<Bool> {
	switch safeAttribute(element, attribute) {
	case let .value(value):
		guard let boolean = value as? Bool else {
			return .failed
		}
		return .value(boolean)
	case .absent:
		return .absent
	case .failed:
		return .failed
	}
}

enum SafeAXParent {
	case parent(AXUIElement)
	case failed
}

func safeParentElement(_ element: AXUIElement) -> SafeAXParent {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
	guard result == .success,
		let value,
		CFGetTypeID(value) == AXUIElementGetTypeID()
	else {
		return .failed
	}
	return .parent(value as! AXUIElement)
}

func parentElement(_ element: AXUIElement) -> AXUIElement? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXParentAttribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
		return nil
	}

	return (value as! AXUIElement)
}

func roleDescription(_ element: AXUIElement) -> String? {
	var value: CFTypeRef?
	let result = AXUIElementCopyAttributeValue(element, kAXRoleDescriptionAttribute as CFString, &value)
	guard result == .success else {
		return nil
	}

	return value as? String
}

func actionNames(_ element: AXUIElement) -> [String] {
	var value: CFArray?
	let result = AXUIElementCopyActionNames(element, &value)
	guard result == .success, let value else {
		return []
	}

	return (value as NSArray).compactMap { $0 as? String }
}
func isTextInputRole(_ role: String?) -> Bool {
	role == "AXTextField" ||
		role == "AXTextArea" ||
		role == "AXTextView" ||
		role == "AXComboBox"
}

func isSecureTextInput(_ protectedContent: Bool?, role: String?, subrole: String?) -> Bool {
	if role == "AXSecureTextField" || subrole == "AXSecureTextField" {
		return true
	}
	return protectedContent == true
}

func typingTarget(startingAt focused: AXUIElement) -> TypingTarget? {
	guard AXIsProcessTrusted() else {
		return nil
	}
	var pid: pid_t = 0
	guard AXUIElementGetPid(focused, &pid) == .success else {
		return nil
	}
	let application = AXUIElementCreateApplication(pid)
	guard AXUIElementSetMessagingTimeout(application, 0.01) == .success else {
		return nil
	}

	var element = focused
	var editableTarget: AXUIElement?
	var reachedRoot = false
	for _ in 0..<8 {
		guard case let .value(role) = safeStringAttribute(element, kAXRoleAttribute) else {
			return nil
		}
		let subrole: String?
		switch safeStringAttribute(element, kAXSubroleAttribute) {
		case let .value(value): subrole = value
		case .absent: subrole = nil
		case .failed: return nil
		}
		let protectedContent: Bool?
		switch safeBooleanAttribute(element, "AXProtectedContent") {
		case let .value(value): protectedContent = value
		case .absent: protectedContent = nil
		case .failed: return nil
		}
		if isSecureTextInput(protectedContent, role: role, subrole: subrole) {
			return nil
		}
		let editable: Bool?
		switch safeBooleanAttribute(element, "AXEditable") {
		case let .value(value): editable = value
		case .absent: editable = nil
		case .failed: return nil
		}
		if editableTarget == nil && (isTextInputRole(role) || editable == true) {
			editableTarget = element
		}
		if role == "AXApplication" {
			reachedRoot = true
			break
		}
		switch safeParentElement(element) {
		case let .parent(parent):
			element = parent
		case .failed:
			return nil
		}
		if reachedRoot {
			break
		}
	}

	guard reachedRoot,
		let editableTarget,
		let bounds = elementBounds(editableTarget),
		!bounds.isNull,
		!bounds.isInfinite
	else {
		return nil
	}
	let resolvedCaret = selectedTextBounds(editableTarget)
	let caret: CGRect?
	if let resolvedCaret,
		!resolvedCaret.isNull,
		!resolvedCaret.isInfinite,
		resolvedCaret.origin.x.isFinite,
		resolvedCaret.origin.y.isFinite,
		resolvedCaret.width.isFinite,
		resolvedCaret.height.isFinite
	{
		caret = resolvedCaret
	} else {
		caret = nil
	}
	let focus = caret.map { CGPoint(x: $0.midX, y: $0.midY) }
		?? CGPoint(x: bounds.midX, y: bounds.midY)
	return TypingTarget(
		focus: focus,
		bounds: bounds,
		focusSource: caret == nil ? "target" : "caret",
		processId: pid,
		contextId: contextIdentity(for: editableTarget, processId: pid),
		targetId: opaqueElementRegistry.identity(
			prefix: "target",
			processId: pid,
			element: editableTarget
		)
	)
}

func isPointerRole(_ role: String?, _ subrole: String?, _ description: String?) -> Bool {
	if role == "AXLink" ||
		subrole?.localizedCaseInsensitiveContains("link") == true ||
		description?.contains("link") == true
	{
		return true
	}

	return role == "AXButton" ||
		role == "AXMenuButton" ||
		role == "AXPopUpButton" ||
		role == "AXCheckBox" ||
		role == "AXRadioButton" ||
		role == "AXSwitch" ||
		role == "AXDisclosureTriangle" ||
		role == "AXTab" ||
		role == "AXMenuItem"
}

func cursorTypeForElement(_ element: AXUIElement) -> String? {
	var current: AXUIElement? = element

	for _ in 0..<5 {
		guard let element = current else {
			break
		}

		let role = stringAttribute(element, kAXRoleAttribute)
		let subrole = stringAttribute(element, kAXSubroleAttribute)
		let description = roleDescription(element)?.lowercased()

		if isTextInputRole(role) {
			return "text"
		}

		if isPointerRole(role, subrole, description) {
			return "pointer"
		}

		current = parentElement(element)
	}

	return nil
}

func accessibilityPointForMouse() -> CGPoint {
	let mouse = NSEvent.mouseLocation
	let primaryHeight = NSScreen.screens.first?.frame.height ?? NSScreen.main?.frame.height ?? 0
	return CGPoint(x: mouse.x, y: primaryHeight - mouse.y)
}

struct CursorObservation {
	let cursorType: String?
	let processId: pid_t?
	let contextId: String?
}

func currentCursorObservation(
	cachedProcessId: pid_t?,
	cachedContextId: String?,
	refreshContext: Bool
) -> CursorObservation {
	guard AXIsProcessTrusted() else {
		return CursorObservation(cursorType: nil, processId: nil, contextId: nil)
	}

	let point = accessibilityPointForMouse()
	let systemWide = AXUIElementCreateSystemWide()
	var element: AXUIElement?
	let result = AXUIElementCopyElementAtPosition(
		systemWide,
		Float(point.x),
		Float(point.y),
		&element
	)

	guard result == .success, let element else {
		return CursorObservation(cursorType: nil, processId: nil, contextId: nil)
	}
	var processId: pid_t = 0
	let processResult = AXUIElementGetPid(element, &processId)

	// Returns nil for anything that is not a text/pointer affordance so the
	// renderer falls through to the natively captured cursor bitmap (this is
	// what makes default and custom cursors render as their real images).
	let canReuseContext =
		!refreshContext && cachedProcessId == processId && cachedContextId != nil
	return CursorObservation(
		cursorType: cursorTypeForElement(element),
		processId: processResult == .success && processId > 0 ? processId : nil,
		contextId: processResult == .success && processId > 0
			? (canReuseContext
				? cachedContextId
				: contextIdentity(for: element, processId: processId))
			: nil
	)
}

func currentCursorAsset() -> CapturedCursorAsset? {
	guard let cursor = NSCursor.currentSystem ?? NSCursor.current as NSCursor? else {
		return nil
	}

	let image = cursor.image
	let pointSize = image.size
	guard pointSize.width > 0, pointSize.height > 0 else {
		return nil
	}

	var proposedRect = NSRect(origin: .zero, size: pointSize)
	guard let cgImage = image.cgImage(forProposedRect: &proposedRect, context: nil, hints: nil) else {
		return nil
	}

	let bitmap = NSBitmapImageRep(cgImage: cgImage)
	guard let png = bitmap.representation(using: .png, properties: [:]) else {
		return nil
	}

	let pixelsWide = bitmap.pixelsWide
	let pixelsHigh = bitmap.pixelsHigh
	guard pixelsWide > 0, pixelsHigh > 0 else {
		return nil
	}

	// Intrinsic backing scale of the cursor image (e.g. 2.0 on Retina). The
	// renderer divides pixel dimensions/hotspot by this to recover point sizes.
	let scaleFactor = Double(pixelsWide) / Double(pointSize.width)
	let hotSpot = cursor.hotSpot

	let digest = SHA256.hash(data: png)
	let id = digest.map { String(format: "%02x", $0) }.joined()
	let imageDataUrl = "data:image/png;base64,\(png.base64EncodedString())"

	return CapturedCursorAsset(
		id: id,
		imageDataUrl: imageDataUrl,
		width: pixelsWide,
		height: pixelsHigh,
		hotspotX: hotSpot.x * scaleFactor,
		hotspotY: hotSpot.y * scaleFactor,
		scaleFactor: scaleFactor
	)
}

func timestampMs() -> Int {
	Int(Date().timeIntervalSince1970 * 1000)
}

func requestAccessibilityTrust() -> Bool {
	let options = [
		kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true
	] as CFDictionary
	return AXIsProcessTrustedWithOptions(options)
}

let request: CursorHelperRequest
if CommandLine.arguments.count >= 2,
	let data = CommandLine.arguments[1].data(using: .utf8),
	let decoded = try? JSONDecoder().decode(CursorHelperRequest.self, from: data)
{
	request = decoded
} else {
	request = CursorHelperRequest(sampleIntervalMs: nil)
}

let intervalMs = max(8, request.sampleIntervalMs ?? 33)
let accessibilityTrusted = requestAccessibilityTrust()
let mouseTracker = MouseButtonTracker()
let mouseTapReady = mouseTracker.start()
let keyboardTracker = KeyboardActivityTracker()
let keyboardTapReady = accessibilityTrusted && keyboardTracker.start()
emit([
	"type": "ready",
	"timestampMs": timestampMs(),
	"accessibilityTrusted": accessibilityTrusted,
	"mouseTapReady": mouseTapReady,
	"keyboardTapReady": keyboardTapReady,
])

// Process-wide set so each unique cursor shape is serialised at most once,
// even if the user alternates between shapes (e.g. arrow → text → arrow).
var emittedAssetIds = Set<String>()
var cachedContextProcessId: pid_t?
var cachedContextId: String?
var lastContextLookupMs = 0
while true {
	autoreleasepool {
		mouseTracker.pump()
		let mouseBatch = mouseTracker.consume()
		let keyboardActivities = keyboardTracker.consume()
		let nowMs = timestampMs()
		let asset = currentCursorAsset()
		let refreshContext = nowMs - lastContextLookupMs >= 200
		let cursorObservation = currentCursorObservation(
			cachedProcessId: cachedContextProcessId,
			cachedContextId: cachedContextId,
			refreshContext: refreshContext
		)
		if let processId = cursorObservation.processId, let contextId = cursorObservation.contextId {
			let processChanged = processId != cachedContextProcessId
			cachedContextProcessId = processId
			cachedContextId = contextId
			if refreshContext || processChanged {
				lastContextLookupMs = nowMs
			}
		}
		// Only ship the (large) base64 payload the first time a cursor shape is seen;
		// subsequent samples reference it by assetId so stdout stays small.
		var assetPayload: [String: Any]?
		if let asset, emittedAssetIds.insert(asset.id).inserted {
			assetPayload = [
				"id": asset.id,
				"imageDataUrl": asset.imageDataUrl,
				"width": asset.width,
				"height": asset.height,
				"hotspotX": asset.hotspotX,
				"hotspotY": asset.hotspotY,
				"scaleFactor": asset.scaleFactor,
			]
		}
		let fields: [String: Any?] = [
			"type": "sample",
			"timestampMs": nowMs,
			"cursorType": cursorObservation.cursorType,
			"targetProcessId": cursorObservation.processId,
			"contextIdentity": cursorObservation.contextId,
			"assetId": asset?.id,
			"asset": assetPayload,
			"leftButtonDown": mouseBatch.isLeftButtonDown,
			"mouseButtonTransitions": mouseBatch.transitions.map { transition in
				[
					"kind": transition.kind,
					"timestampMs": transition.timestampMs,
					"x": transition.point.x,
					"y": transition.point.y,
				] as [String: Any]
			},
			"keyboardActivityEvents": keyboardActivities.map { activity in
				[
					"timestampMs": activity.timestampMs,
					"focusX": activity.target.focus.x,
					"focusY": activity.target.focus.y,
					"focusSource": activity.target.focusSource,
					"targetProcessId": activity.target.processId,
					"contextIdentity": activity.target.contextId,
					"targetIdentity": activity.target.targetId,
					"targetX": activity.target.bounds.origin.x,
					"targetY": activity.target.bounds.origin.y,
					"targetWidth": activity.target.bounds.width,
					"targetHeight": activity.target.bounds.height,
				] as [String: Any]
			},
		]
		emit(fields)
		Thread.sleep(forTimeInterval: Double(intervalMs) / 1000.0)
	}
}
