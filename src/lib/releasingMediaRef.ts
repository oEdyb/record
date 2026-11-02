import { type MutableRefObject, useCallback } from "react";

/**
 * A ref callback for a <video> that may unmount. A detached element keeps its decoder
 * and buffers until garbage collection; dropping its source frees them now.
 */
export function useReleasingMediaRef(ref: MutableRefObject<HTMLVideoElement | null>) {
	return useCallback(
		(element: HTMLVideoElement | null) => {
			const previous = ref.current;
			if (previous && previous !== element) {
				previous.pause();
				previous.removeAttribute("src");
				previous.load();
			}
			ref.current = element;
		},
		[ref],
	);
}
