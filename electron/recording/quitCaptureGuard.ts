import { QuitCaptureLifecycle } from "./quitCaptureLifecycle";
/** Holds an app quit until a running take has stopped, so its clips finalize
 * normally. Holding the quit during logout or shutdown makes macOS cancel it,
 * so a powering-off system quits at once and the recovery journal keeps the take. */
export function createQuitCaptureGuard(deps: {
	isCaptureRunning: () => boolean;
	stopCapture: () => Promise<void>;
	quit: () => void;
}) {
	const lifecycle = new QuitCaptureLifecycle();
	const beforeQuit = (event: { preventDefault: () => void }) => {
		if (lifecycle.state === "system-shutdown" || lifecycle.state === "completing") return;
		if (lifecycle.state === "stopping") {
			event.preventDefault();
			return;
		}
		if (!deps.isCaptureRunning()) return;
		event.preventDefault();
		if (!lifecycle.transition("stop")) return;
		void (async () => {
			try {
				await deps.stopCapture();
			} catch (error) {
				console.warn(
					"[quit-capture] Stop did not finish cleanly; recovery metadata is retained",
					error,
				);
			} finally {
				if (lifecycle.state !== "system-shutdown" && lifecycle.transition("complete")) {
					try {
						deps.quit();
					} catch (error) {
						console.warn("[quit-capture] Quit failed", error);
					} finally {
						lifecycle.transition("returned");
					}
				}
			}
		})();
	};
	return {
		systemPoweringOff() {
			lifecycle.transition("system-shutdown");
		},
		beforeQuit,
		protectWindow(window: {
			on: (event: "close", listener: (event: { preventDefault: () => void }) => void) => unknown;
		}): void {
			window.on("close", beforeQuit);
		},
	};
}
