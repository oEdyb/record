export interface PreviewPosition {
	viewId: number;
	screenPath?: string;
	playing?: boolean;
	sceneIdentity?: object;
	clipIndex: number;
	sourceTimeSec: number;
}
export interface PreviewFrameIdentity extends PreviewPosition {
	generation: number;
}

let latestAnchor: PreviewFrameIdentity | null = null;
let lastPainted: PreviewFrameIdentity | null = null;
const listeners = new Set<() => void>();
export function subscribePreviewFrames(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

const waiters = new Set<(cancel?: boolean) => void>();

export function notePreviewTransportAnchor(anchor: PreviewFrameIdentity): void {
	latestAnchor = anchor;
	for (const listener of listeners) listener();
}

export function notePreviewPaintedFrame(
	frame: PreviewPosition & { transportGeneration: number },
): void {
	lastPainted = { ...frame, generation: frame.transportGeneration };
	for (const wake of [...waiters]) wake();
	for (const listener of listeners) listener();
}

/** Identity of the pixels last painted, not the requested playhead or HTML video. */
export function getPreviewFrameEvidence() {
	if (!lastPainted) return null;
	return {
		timeBase: "source" as const,
		viewId: lastPainted.viewId,
		clipIndex: lastPainted.clipIndex,
		sourceTimeSec: lastPainted.sourceTimeSec,
		generation: lastPainted.generation,
	};
}

export function isPreviewFrameSettled(expected?: PreviewPosition): boolean {
	if (!latestAnchor || !lastPainted) return false;
	return (
		lastPainted.viewId === latestAnchor.viewId &&
		lastPainted.generation === latestAnchor.generation &&
		lastPainted.clipIndex === latestAnchor.clipIndex &&
		(!expected ||
			(latestAnchor.viewId === expected.viewId &&
				latestAnchor.clipIndex === expected.clipIndex &&
				latestAnchor.sceneIdentity === expected.sceneIdentity &&
				(expected.playing ||
					Math.abs(latestAnchor.sourceTimeSec - expected.sourceTimeSec) <= 0.001) &&
				Math.abs(lastPainted.sourceTimeSec - expected.sourceTimeSec) <= 1 / 30))
	);
}

export function waitForPreviewSettledFrame(
	budgetMs: number,
	expected?: PreviewPosition,
): Promise<boolean> {
	if (isPreviewFrameSettled(expected)) return Promise.resolve(true);
	return new Promise((resolve) => {
		const finish = (value: boolean) => {
			clearTimeout(timer);
			waiters.delete(wake);
			resolve(value);
		};
		const wake = (cancel = false) => {
			if (cancel) finish(false);
			else if (isPreviewFrameSettled(expected)) finish(true);
		};
		const timer = setTimeout(() => finish(false), budgetMs);
		waiters.add(wake);
	});
}

export function resetPreviewSettledFrames(): void {
	latestAnchor = null;
	lastPainted = null;
	for (const wake of [...waiters]) wake(true);
	for (const listener of listeners) listener();
}

export function isPreviewScreenReady(
	sceneIdentity: object,
	screenPath: string,
	clips: readonly { screenPath: string; sourceStartSec: number; sourceEndSec: number }[],
): boolean {
	if (!latestAnchor || !lastPainted || !isPreviewFrameSettled()) return false;
	const clip = clips[lastPainted.clipIndex];
	return (
		latestAnchor.generation > 0 &&
		latestAnchor.sceneIdentity === sceneIdentity &&
		latestAnchor.screenPath === screenPath &&
		clip?.screenPath === screenPath &&
		Number.isFinite(lastPainted.sourceTimeSec) &&
		lastPainted.sourceTimeSec >= clip.sourceStartSec &&
		lastPainted.sourceTimeSec < clip.sourceEndSec
	);
}
