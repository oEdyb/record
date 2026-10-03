export type RecordingStartupOverlayWindow = {
	isDestroyed: () => boolean;
	isVisible: () => boolean;
	showInactive: () => void;
	hide: () => void;
	once(event: "ready-to-show", listener: () => void): unknown;
	once(event: "closed", listener: () => void): unknown;
	removeListener(event: "ready-to-show", listener: () => void): unknown;
	removeListener(event: "closed", listener: () => void): unknown;
	webContents: {
		isLoading: () => boolean;
		once(event: "did-finish-load", listener: () => void): unknown;
		once(event: "did-fail-load", listener: () => void): unknown;
		once(event: "destroyed", listener: () => void): unknown;
		removeListener(event: "did-finish-load", listener: () => void): unknown;
		removeListener(event: "did-fail-load", listener: () => void): unknown;
		removeListener(event: "destroyed", listener: () => void): unknown;
		send: (channel: string, ...args: unknown[]) => void;
	};
};

async function waitForOverlayReady(
	window: RecordingStartupOverlayWindow,
	signal: AbortSignal,
): Promise<boolean> {
	if (signal.aborted) return false;
	if (window.isDestroyed()) return false;
	if (!window.webContents.isLoading()) return true;
	return new Promise((resolve) => {
		let settled = false;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			window.removeListener("ready-to-show", onReady);
			window.removeListener("closed", onFailed);
			window.webContents.removeListener("did-finish-load", onReady);
			window.webContents.removeListener("did-fail-load", onFailed);
			window.webContents.removeListener("destroyed", onFailed);
			signal.removeEventListener("abort", onFailed);
			resolve(ready && !window.isDestroyed());
		};
		const onReady = () => finish(true);
		const onFailed = () => finish(false);
		const timer = setTimeout(onFailed, 300);
		window.once("ready-to-show", onReady);
		window.once("closed", onFailed);
		window.webContents.once("did-finish-load", onReady);
		window.webContents.once("did-fail-load", onFailed);
		window.webContents.once("destroyed", onFailed);
		signal.addEventListener("abort", onFailed, { once: true });
		if (signal.aborted || window.isDestroyed()) onFailed();
		else if (!window.webContents.isLoading()) onReady();
	});
}

export function createRecordingStartupOverlayController(deps: {
	getWindow: () => RecordingStartupOverlayWindow | null;
	createWindow: () => RecordingStartupOverlayWindow;
}) {
	let activeRunId: number | null = null;
	let revision = 0;
	let pendingReady: AbortController | null = null;
	return {
		async show(value: number, runId: number): Promise<void> {
			pendingReady?.abort();
			const readyController = new AbortController();
			pendingReady = readyController;
			activeRunId = runId;
			const requestRevision = ++revision;
			const window = deps.getWindow() ?? deps.createWindow();
			const ready = await waitForOverlayReady(window, readyController.signal);
			if (pendingReady === readyController) pendingReady = null;
			if (!ready || revision !== requestRevision || activeRunId !== runId) return;
			if (!window.isVisible()) window.showInactive();
			window.webContents.send("countdown-overlay-value", value, runId);
		},
		setValue(value: number, runId: number): void {
			const window = deps.getWindow();
			if (activeRunId !== runId || !window || window.isDestroyed()) return;
			window.webContents.send("countdown-overlay-value", value, runId);
		},
		hide(runId: number): void {
			if (activeRunId !== runId) return;
			activeRunId = null;
			revision++;
			pendingReady?.abort();
			pendingReady = null;
			const window = deps.getWindow();
			if (!window || window.isDestroyed()) return;
			window.webContents.send("countdown-overlay-value", null, runId);
			window.hide();
		},
	};
}
