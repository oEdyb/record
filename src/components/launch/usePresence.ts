import { useEffect, useState } from "react";

/**
 * Keeps a closed panel mounted for its exit transition. `present` says whether
 * to render it; `closing` is true for the last `exitMs` before it unmounts.
 */
export function usePresence(open: boolean, exitMs: number) {
	const [present, setPresent] = useState(open);

	useEffect(() => {
		if (open) {
			setPresent(true);
			return;
		}
		const timer = window.setTimeout(() => setPresent(false), exitMs);
		return () => window.clearTimeout(timer);
	}, [exitMs, open]);

	return { present: open || present, closing: !open && present };
}
