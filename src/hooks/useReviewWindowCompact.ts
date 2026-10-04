import { useEffect, useState } from "react";

/** Whether this review window is the small player that opens after Stop. */
export function useReviewWindowCompact(enabled: boolean): boolean {
	const [compact, setCompact] = useState(false);
	useEffect(() => {
		if (!enabled) return;
		let active = true;
		void window.electronAPI?.isReviewWindowCompact?.().then((value) => {
			if (active) setCompact(value);
		});
		const unsubscribe = window.electronAPI?.onReviewWindowCompactChanged?.(setCompact);
		return () => {
			active = false;
			unsubscribe?.();
		};
	}, [enabled]);
	return enabled && compact;
}
