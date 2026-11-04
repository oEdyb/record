import { cancelPortalHudSelection, supersedePortalHudSelection } from "./portalSelectionHud";

type HudWindow = {
	isDestroyed(): boolean;
	isVisible?(): boolean;
	hide(): void;
	show(): void;
	focus(): void;
	webContents: { send(channel: string): void };
};

export class LinuxRecordingHud {
	private transitioning = false;
	private pauseRequested = false;
	private generation = 0;
	private concealed = false;
	private operation = 0;
	private recoveryRequested = false;
	private retry: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly platform: string,
		private readonly getWindow: () => HudWindow | null,
		private readonly isCapturing: () => boolean,
		private readonly shouldHide: () => boolean,
		private readonly waitForUnmap: () => Promise<void>,
		private readonly afterShow: () => void = () => undefined,
		private readonly setPreviewHidden: (hidden: boolean) => void | Promise<void> = () => undefined,
		private readonly windowIsolation?: { begin(): Promise<boolean>; end(): void },
		private readonly shouldShowControls: () => boolean = () => true,
	) {}

	async capture<T extends { success: boolean }>(operation: () => Promise<T>): Promise<T> {
		if (this.platform !== "linux") return operation();
		const previousPlacement = supersedePortalHudSelection(this.getWindow());
		const shouldHide = this.shouldHide();
		const generation = this.generation;
		const operationId = ++this.operation;
		this.transitioning = true;
		this.concealed = shouldHide;
		this.pauseRequested = false;
		this.recoveryRequested = false;
		this.clearRetry();
		try {
			if (previousPlacement) await previousPlacement;
			if (generation !== this.generation || operationId !== this.operation)
				throw new Error("Recording start cancelled.");
			const retained = shouldHide ? await this.windowIsolation?.begin() : true;
			if (generation !== this.generation || operationId !== this.operation)
				throw new Error("Recording start cancelled.");
			this.concealed = !retained;
			if (!retained) this.conceal();
			if (shouldHide) {
				await this.setPreviewHidden(true);
				await this.waitForUnmap();
			}
			if (generation !== this.generation || operationId !== this.operation)
				throw new Error("Recording start cancelled.");
			return await operation();
		} finally {
			if (operationId === this.operation) {
				this.transitioning = false;
				if (shouldHide && !this.isCapturing()) this.showControls();
				else if (this.recoveryRequested) this.requestControls();
			}
		}
	}

	cancelPending(): void {
		this.generation += 1;
		this.clearRetry();
		this.recoveryRequested = false;
		this.pauseRequested = false;
		cancelPortalHudSelection(this.getWindow());
		this.windowIsolation?.end();
	}

	conceal(): void {
		if (this.platform !== "linux") return;
		this.concealed = true;
		const window = this.getWindow();
		if (window && !window.isDestroyed()) window.hide();
	}

	dismiss(): void {
		this.recoveryRequested = false;
		this.pauseRequested = false;
		this.clearRetry();
		this.windowIsolation?.end();
		this.concealed = true;
	}

	revoke(): void {
		const window = this.getWindow();
		// Hide and Studio deliberately unmap the pill. They must not pause the take.
		if (window && !window.isDestroyed() && window.isVisible?.() === false) {
			this.dismiss();
			return;
		}
		this.recoveryRequested = true;
		this.conceal();
		this.requestControls();
	}

	requestControls(): boolean {
		if (this.platform !== "linux" || !this.concealed) return false;
		this.recoveryRequested = true;
		if (this.transitioning) {
			this.scheduleRetry();
			return true;
		}
		if (!this.isCapturing()) {
			this.showControls();
			return true;
		}
		if (!this.pauseRequested) {
			this.pauseRequested = true;
			const window = this.getWindow();
			if (window && !window.isDestroyed()) window.webContents.send("hud-toggle-recording-pause");
		}
		this.scheduleRetry();
		return true;
	}

	pauseCompleted(): void {
		if (this.platform !== "linux" || this.transitioning) return;
		this.pauseRequested = false;
		if (!this.isCapturing()) this.showControls();
		else if (this.recoveryRequested) this.scheduleRetry();
	}

	private clearRetry(): void {
		if (this.retry) clearTimeout(this.retry);
		this.retry = null;
	}

	private scheduleRetry(): void {
		if (this.retry || !this.recoveryRequested) return;
		this.retry = setTimeout(() => {
			this.retry = null;
			if (!this.recoveryRequested) return;
			this.pauseRequested = false;
			this.requestControls();
		}, 500);
		this.retry.unref?.();
	}

	private showControls(): void {
		this.clearRetry();
		this.recoveryRequested = false;
		this.pauseRequested = false;
		this.windowIsolation?.end();
		this.concealed = false;
		void this.setPreviewHidden(false);
		if (!this.shouldShowControls()) return;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.show();
		window.focus();
		this.afterShow();
	}
}
