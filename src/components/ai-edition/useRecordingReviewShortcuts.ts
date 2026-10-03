import { useEffect } from "react";
import { matchesShortcut, type ShortcutBinding } from "@/lib/shortcuts";

interface ReviewShortcuts {
	enabled: boolean;
	isMac: boolean;
	playPause: ShortcutBinding;
	onSave: () => void;
	onRecord: () => void;
	onRecordings: () => void;
	onPlayPause: () => void;
	onStep: (direction: -1 | 1) => void;
}

export function useRecordingReviewShortcuts(options: ReviewShortcuts): void {
	useEffect(() => {
		if (!options.enabled) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || target.closest("input, textarea, select"))
			)
				return;
			if (
				target instanceof HTMLElement &&
				target.closest("button, a[href], [role='button'], [role='slider'], [role='tab']") &&
				[" ", "Enter", "ArrowLeft", "ArrowRight"].includes(event.key)
			)
				return;
			const ctrl = event.ctrlKey || event.metaKey;
			let action: (() => void) | undefined;
			if (ctrl && event.key.toLowerCase() === "s") action = options.onSave;
			else if (ctrl && event.key.toLowerCase() === "n") action = options.onRecord;
			else if (ctrl && event.key.toLowerCase() === "o") action = options.onRecordings;
			else if (matchesShortcut(event, options.playPause, options.isMac))
				action = options.onPlayPause;
			else if (!ctrl && !event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight"))
				action = () => options.onStep(event.key === "ArrowLeft" ? -1 : 1);
			if (action) {
				event.preventDefault();
				action();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [options]);
}
