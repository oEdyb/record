// jsdom does not implement ResizeObserver. Radix Slider and Popover use it to
// measure browser geometry, so component tests need the browser API boundary.
if (typeof globalThis.ResizeObserver === "undefined") {
	globalThis.ResizeObserver = class ResizeObserverStub implements ResizeObserver {
		disconnect() {
			return undefined;
		}
		observe() {
			return undefined;
		}
		unobserve() {
			return undefined;
		}
	} as typeof ResizeObserver;
}

// jsdom also omits the pointer-capture methods used by Radix Slider during a
// drag. Browser behavior is covered by Playwright; these no-op boundaries let
// component tests exercise the same commit lifecycle without a DOM shim error.
if (typeof globalThis.HTMLElement !== "undefined") {
	const prototype = globalThis.HTMLElement.prototype;
	if (!prototype.hasPointerCapture) prototype.hasPointerCapture = () => false;
	if (!prototype.setPointerCapture) prototype.setPointerCapture = () => undefined;
	if (!prototype.releasePointerCapture) prototype.releasePointerCapture = () => undefined;
}
