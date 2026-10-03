import type { Span } from "./context";

export const CHECK_FRAME_SEC = 1 / 60;
export function isSubframeSpan(span: Span): boolean {
	return span.endSec - span.startSec < CHECK_FRAME_SEC - 1e-9;
}
