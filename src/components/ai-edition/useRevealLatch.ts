import { useEffect, useRef, useState } from "react";

/**
 * Keeps a stage revealed once it has shown `key`'s first frame. `ready` drops
 * again on every seek and clip switch, and covering the preview for those
 * makes scrubbing flash. A new `key` waits for its own first frame: the latch
 * only sets after `ready` was seen false for that key, so readiness left over
 * from the previous key never counts.
 */
export function useRevealLatch(key: string | null, ready: boolean, reset: boolean): boolean {
	const [latchedKey, setLatchedKey] = useState<string | null>(null);
	const armedKeyRef = useRef<string | null>(null);
	useEffect(() => {
		if (key === null) {
			armedKeyRef.current = null;
			setLatchedKey(null);
			return;
		}
		if (reset) {
			setLatchedKey(null);
			return;
		}
		if (!ready) {
			armedKeyRef.current = key;
			return;
		}
		if (armedKeyRef.current === key) setLatchedKey(key);
	}, [key, ready, reset]);
	return ready || (key !== null && !reset && latchedKey === key);
}
