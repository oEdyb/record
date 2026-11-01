export type ConcealableWindow = {
	isDestroyed(): boolean;
	isVisible(): boolean;
	hide(): void;
	showInactive(): void;
};

/**
 * Keeps recorder-owned utility windows (Notes, Transcript) out of a Linux take.
 *
 * macOS and Windows exclude them from capture with `setContentProtection`.
 * Electron documents that call as macOS/Windows only, so on Linux the windows
 * are captured like any other. The HUD and camera monitor already unmap for
 * monitor and unknown-source capture (`LinuxRecordingHud`); this follows the same
 * moments so Notes cannot end up baked into the footage. Window-only capture
 * never asks for concealment, so Notes stays readable there.
 *
 * Restoration uses `showInactive` so the pill keeps keyboard focus.
 */
export class LinuxCaptureConcealment<W extends ConcealableWindow = ConcealableWindow> {
	private concealed = false;
	private readonly tracked = new Set<W>();
	private readonly hiddenByUs = new Set<W>();

	constructor(private readonly platform: string) {}

	get isConcealed(): boolean {
		return this.concealed;
	}

	/** Registers a utility window. Forget it with the returned function once it closes. */
	track(window: W): () => void {
		if (this.platform !== "linux") return () => undefined;
		this.tracked.add(window);
		return () => {
			this.tracked.delete(window);
			this.hiddenByUs.delete(window);
		};
	}

	/**
	 * Called when a tracked window is ready to appear. Returns false while a take
	 * is concealing windows; the window then appears with the rest on restore.
	 */
	mayShow(window: W): boolean {
		if (this.platform !== "linux" || !this.concealed) return true;
		this.hiddenByUs.add(window);
		return false;
	}

	setConcealed(concealed: boolean): void {
		if (this.platform !== "linux" || concealed === this.concealed) return;
		this.concealed = concealed;
		if (concealed) {
			for (const window of this.tracked) {
				if (window.isDestroyed() || !window.isVisible()) continue;
				this.hiddenByUs.add(window);
				window.hide();
			}
			return;
		}
		const restore = [...this.hiddenByUs];
		this.hiddenByUs.clear();
		for (const window of restore) {
			if (!window.isDestroyed()) window.showInactive();
		}
	}
}
