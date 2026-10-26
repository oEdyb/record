/** Holds an app quit until a running take has stopped, so its clips finalize
 * normally. Holding the quit during logout or shutdown makes macOS cancel it,
 * so a powering-off system quits at once and the recovery journal keeps the take. */
export function createQuitCaptureGuard(deps: {
	isCaptureRunning: () => boolean;
	stopCapture: () => Promise<void>;
	quit: () => void;
}) {
	let stopping = false;
	let completingQuit = false;
	let poweringOff = false;
	const beforeQuit = (event: { preventDefault: () => void }) => {
		if (poweringOff || completingQuit) return;
		if (stopping) {
			event.preventDefault();
			return;
		}
		if (!deps.isCaptureRunning()) return;
		event.preventDefault();
		stopping = true;
		void deps.stopCapture().finally(() => {
			completingQuit = true;
			deps.quit();
			completingQuit = false;
			// A window can still cancel this quit; the next one must stop a new take again.
			stopping = false;
		});
	};
	return {
		systemPoweringOff() {
			poweringOff = true;
		},
		beforeQuit,
		protectWindow(window: {
			on: (event: "close", listener: (event: { preventDefault: () => void }) => void) => unknown;
		}): void {
			window.on("close", beforeQuit);
		},
	};
}
