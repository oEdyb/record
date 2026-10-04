import { useEffect } from "react";
import {
	collectEffectiveClipDims,
	pickExtremeDims,
	resolveOutputAspectRatioValue,
} from "@/lib/ai-edition/document/outputFormat";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useEditorSettings } from "@/lib/ai-edition/store/useEditorSettings";

/** The video's frame sits this far in from the window's left, right and bottom edges. */
const REVIEW_STAGE_INSET = 12;

/** Height of the review bars around the video, read from the rendered page. */
function reviewChromeHeight(): number {
	return Array.from(
		globalThis.document.querySelectorAll<HTMLElement>("[data-review-chrome]"),
	).reduce((sum, element) => sum + element.offsetHeight, 0);
}

/**
 * Sizes the small review player to the recording: the window becomes the
 * video's shape plus its header and frame, so playback fills it with no letterbox.
 */
export function useCompactReviewFit(enabled: boolean, document: AxcutDocument | null) {
	const { settings } = useEditorSettings();
	// Until the recording's own size is known the shape is only a 16:9 guess, and
	// fitting to it would shrink the window and grow it back once the size arrives.
	const sizeKnown =
		document !== null && pickExtremeDims(collectEffectiveClipDims(document), "largest") !== null;
	const ratio =
		document && sizeKnown
			? resolveOutputAspectRatioValue(document, settings.aspectRatio, settings.outputResolution)
			: null;
	useEffect(() => {
		if (!enabled || ratio === null || !Number.isFinite(ratio) || ratio <= 0) return;
		const frame = requestAnimationFrame(() => {
			void window.electronAPI?.fitReviewWindow?.({
				aspectRatio: ratio,
				// The window is the video plus the header and a 12px frame. Main sizes the
				// window as width / ratio + chrome, so the side insets are folded in here.
				chromeHeight: reviewChromeHeight() + REVIEW_STAGE_INSET - (2 * REVIEW_STAGE_INSET) / ratio,
			});
		});
		return () => cancelAnimationFrame(frame);
	}, [enabled, ratio]);
}
