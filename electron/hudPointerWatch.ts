type Point = { x: number; y: number };

export function createHudPointerWatch(options: {
	platform: NodeJS.Platform;
	isVisible: () => boolean;
	isDragging: () => boolean;
	readPoint: () => Point | null;
	onProbe: (point: Point | null) => void;
	onOutside: () => void;
}) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let lastPoint: Point | null | undefined;
	let lastSentAt = 0;
	const stop = () => {
		if (timer !== null) clearInterval(timer);
		timer = null;
		lastPoint = undefined;
	};
	const sample = (force = false) => {
		// Native visibility can change without Electron emitting hide/show events.
		if (!options.isVisible()) {
			lastPoint = undefined;
			return;
		}
		if (options.isDragging()) return;
		const point = options.readPoint();
		if (!point) options.onOutside();
		const changed =
			lastPoint === undefined || point?.x !== lastPoint?.x || point?.y !== lastPoint?.y;
		const now = Date.now();
		if (!force && !changed && now - lastSentAt < 100) return;
		lastPoint = point;
		lastSentAt = now;
		options.onProbe(point);
	};
	return {
		start() {
			if (options.platform === "linux") return;
			if (timer === null) timer = setInterval(sample, 40);
			sample(true);
		},
		stop,
	};
}
