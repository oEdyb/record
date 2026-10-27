type HudWindow = {
	isDestroyed(): boolean;
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

	constructor(
		private readonly platform: string,
		private readonly getWindow: () => HudWindow | null,
		private readonly isCapturing: () => boolean,
		private readonly shouldHide: () => boolean,
		private readonly waitForUnmap: () => Promise<void>,
		private readonly afterShow: () => void = () => undefined,
	) {}

	async capture<T extends { success: boolean }>(operation: () => Promise<T>): Promise<T> {
		if (this.platform !== "linux" || !this.shouldHide()) return operation();
		const generation = this.generation;
		const operationId = ++this.operation;
		this.transitioning = true;
		this.concealed = true;
		this.pauseRequested = false;
		const window = this.getWindow();
		if (window && !window.isDestroyed()) window.hide();
		try {
			await this.waitForUnmap();
			if (generation !== this.generation || operationId !== this.operation)
				throw new Error("Recording start cancelled.");
			return await operation();
		} finally {
			if (operationId === this.operation) {
				this.transitioning = false;
				if (!this.isCapturing()) this.showControls();
			}
		}
	}

	cancelPending(): void {
		this.generation += 1;
	}

	requestControls(): boolean {
		if (this.platform !== "linux" || !this.concealed) return false;
		if (this.transitioning) return true;
		if (!this.isCapturing()) return false;
		if (!this.pauseRequested) {
			this.pauseRequested = true;
			const window = this.getWindow();
			if (window && !window.isDestroyed()) window.webContents.send("hud-toggle-recording-pause");
		}
		return true;
	}

	pauseCompleted(): void {
		if (this.platform !== "linux" || this.transitioning) return;
		this.pauseRequested = false;
		if (!this.isCapturing()) this.showControls();
	}

	private showControls(): void {
		this.concealed = false;
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.show();
		window.focus();
		this.afterShow();
	}
}
