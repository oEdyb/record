export const RESUME_SETTLE_MS = 15_000;

/**
 * Keeps a stored license validated while the app stays open for days: on a fixed interval, and
 * shortly after the Mac wakes, once the network has had time to return. Returns a stop function.
 */
export function startEntitlementRevalidation(options: {
	refresh: () => Promise<unknown>;
	intervalMs: number;
	onResume: (listener: () => void) => () => void;
}): () => void {
	const revalidate = () => {
		void options.refresh().catch((error) => {
			console.warn("Scheduled Klippt license check failed:", error);
		});
	};
	let pendingResume: ReturnType<typeof setTimeout> | undefined;
	const interval = setInterval(revalidate, options.intervalMs);
	interval.unref?.();
	const removeResume = options.onResume(() => {
		if (pendingResume !== undefined) clearTimeout(pendingResume);
		pendingResume = setTimeout(() => {
			pendingResume = undefined;
			revalidate();
		}, RESUME_SETTLE_MS);
		pendingResume.unref?.();
	});
	return () => {
		clearInterval(interval);
		if (pendingResume !== undefined) clearTimeout(pendingResume);
		removeResume();
	};
}
