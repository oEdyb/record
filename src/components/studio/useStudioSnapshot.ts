import { useEffect, useState } from "react";
import type { StudioSnapshot } from "../../../electron/studio/types";
/** A command that changes nothing within this long gets its buttons back. */

export function useStudioSnapshot(): StudioSnapshot | null {
	const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
	useEffect(() => {
		const api = window.electronAPI;
		let cancelled = false;
		const stop = api.onStudioUpdated((next) => {
			if (!cancelled) setSnapshot(next);
		});
		void api.getStudioSnapshot().then((current) => {
			if (!cancelled) setSnapshot((existing) => existing ?? current);
		});
		return () => {
			cancelled = true;
			stop();
		};
	}, []);
	return snapshot;
}

/** Take time, as the pill counts it: committed clips plus the clip running now. */
export function useElapsedSeconds(snapshot: StudioSnapshot | null): number {
	const [now, setNow] = useState(() => Date.now());
	const live = snapshot?.liveSinceMs ?? null;
	useEffect(() => {
		if (live === null) return;
		const timer = setInterval(() => setNow(Date.now()), 250);
		return () => clearInterval(timer);
	}, [live]);
	if (!snapshot) return 0;
	return Math.floor((snapshot.committedMs + (live === null ? 0 : Math.max(0, now - live))) / 1000);
}
