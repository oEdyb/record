export interface FadeWindow {
	isDestroyed(): boolean;
	getOpacity?(): number;
	setOpacity?(opacity: number): void;
}

/** One animation per window; reversing starts at the current native opacity. */
export class WindowFade {
	private timers = new WeakMap<FadeWindow, ReturnType<typeof setTimeout>>();
	constructor(private readonly enabled: () => boolean) {}

	cancel(window: FadeWindow) {
		clearTimeout(this.timers.get(window));
		this.timers.delete(window);
	}

	to(window: FadeWindow, target: number, duration: number, done = () => undefined) {
		this.cancel(window);
		if (window.isDestroyed()) return;
		if (!this.enabled() || !window.setOpacity || !window.getOpacity) {
			window.setOpacity?.(target);
			done();
			return;
		}
		const start = window.getOpacity();
		const since = Date.now();
		const tick = () => {
			if (window.isDestroyed()) return;
			const progress = Math.min(1, (Date.now() - since) / duration);
			const eased = 1 - (1 - progress) ** 3;
			window.setOpacity?.(start + (target - start) * eased);
			if (progress === 1) {
				this.timers.delete(window);
				done();
			} else this.timers.set(window, setTimeout(tick, 16));
		};
		tick();
	}
}
