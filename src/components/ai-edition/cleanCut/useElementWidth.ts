import { type RefObject, useLayoutEffect, useState } from "react";

/** The element's content width in CSS pixels, kept current as it resizes. */
export function useElementWidth(ref: RefObject<HTMLElement | null>) {
	const [width, setWidth] = useState(0);
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		setWidth(element.clientWidth);
		const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
		observer.observe(element);
		return () => observer.disconnect();
	}, [ref]);
	return width;
}
