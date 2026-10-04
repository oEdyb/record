import { useEffect } from "react";
import { resolveOutputAspectRatioValue } from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";

/** Height of the review bars around the video, read from the rendered page. */
function reviewChromeHeight(): number {
	return Array.from(
		globalThis.document.querySelectorAll<HTMLElement>("[data-review-chrome]"),
	).reduce((sum, element) => sum + element.offsetHeight, 0);
}

/**
 * Sizes the small review player to the recording: the window becomes the
 * video's shape plus its bars, so playback fills it with no padding.
 */
export function useCompactReviewFit(enabled: boolean, document: AxcutDocument | null) {
	const { settings } = useEditorSettings();
	const ratio = document
		? resolveOutputAspectRatioValue(document, settings.aspectRatio, settings.outputResolution)
		: null;
	useEffect(() => {
		if (!enabled || ratio === null || !Number.isFinite(ratio) || ratio <= 0) return;
		const frame = requestAnimationFrame(() => {
			void window.electronAPI?.fitReviewWindow?.({
				aspectRatio: ratio,
				chromeHeight: reviewChromeHeight(),
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [enabled, ratio]);
}
