import { LinuxHudLifecycle } from "./linuxHudLifecycle";
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
	private readonly lifecycle = new LinuxHudLifecycle();

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
		const owner = Symbol("capture-privacy");
		this.lifecycle.transition({ type: "prepare", owner, hide: shouldHide });
		const assertCurrent = () => {
			if (!this.lifecycle.transition({ type: "admit", owner }))
				throw new Error("Recording start cancelled.");
		};
		try {
			if (previousPlacement) await previousPlacement;
			assertCurrent();
			const retained = shouldHide ? await this.windowIsolation?.begin() : true;
			assertCurrent();
			this.lifecycle.transition({ type: "proof", owner, retained: Boolean(retained) });
			if (this.lifecycle.concealed) this.conceal();
			if (shouldHide) {
				await this.setPreviewHidden(true);
				await this.waitForUnmap();
			}
			assertCurrent();
			return await operation();
		} finally {
			if (this.lifecycle.transition({ type: "finish", owner })) {
				if (shouldHide && !this.isCapturing()) this.showControls();
				else if (this.lifecycle.recovering) this.requestControls();
			}
		}
	}

	cancelPending(): void {
		this.lifecycle.transition({ type: "cancel" });
		cancelPortalHudSelection(this.getWindow());
		this.windowIsolation?.end();
	}

	conceal(): void {
		if (this.platform !== "linux") return;
		this.lifecycle.transition({ type: "conceal" });
		const window = this.getWindow();
		if (window && !window.isDestroyed()) window.hide();
	}

	dismiss(): void {
		this.lifecycle.transition({ type: "dismiss" });
		this.windowIsolation?.end();
	}

	revoke(): void {
		const window = this.getWindow();
		// Hide and Studio deliberately unmap the pill. They must not pause the take.
		if (window && !window.isDestroyed() && window.isVisible?.() === false) {
			this.dismiss();
			return;
		}
		this.conceal();
		this.requestControls();
	}

	requestControls(): boolean {
		if (this.platform !== "linux" || !this.lifecycle.transition({ type: "recover" })) return false;
		if (this.lifecycle.preparing) {
			this.scheduleRetry();
			return true;
		}
		if (!this.isCapturing()) {
			this.showControls();
			return true;
		}
		if (!this.lifecycle.pauseSent && this.lifecycle.transition({ type: "pause-sent" })) {
			const window = this.getWindow();
			if (window && !window.isDestroyed()) window.webContents.send("hud-toggle-recording-pause");
		}
		this.scheduleRetry();
		return true;
	}

	pauseCompleted(): void {
		if (this.platform !== "linux" || !this.lifecycle.transition({ type: "ack" })) return;
		if (!this.isCapturing()) this.showControls();
		else if (this.lifecycle.recovering) this.scheduleRetry();
	}

	private scheduleRetry(): void {
		if (this.lifecycle.retry || !this.lifecycle.recovering) return;
		const timer = setTimeout(() => {
			if (this.lifecycle.transition({ type: "tick", timer })) this.requestControls();
		}, 500);
		if (!this.lifecycle.transition({ type: "schedule", timer })) clearTimeout(timer);
		timer.unref?.();
	}

	private showControls(): void {
		if (!this.lifecycle.transition({ type: "show", capturing: this.isCapturing() })) return;
		this.windowIsolation?.end();
		void this.setPreviewHidden(false);
		if (!this.shouldShowControls()) return;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.show();
		window.focus();
		this.afterShow();
	}
}
