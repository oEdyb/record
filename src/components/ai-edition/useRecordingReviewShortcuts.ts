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
			if (event.defaultPrevented || event.isComposing) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable ||
					target.closest(
						"input, textarea, select, [role='dialog'], [role='alertdialog'], [role='menu']",
					))
			)
				return;
			if (
				target instanceof HTMLElement &&
				target.closest(
					"button, a[href], [role='button'], [role='slider'], [role='tab'], [role='switch'], [role='checkbox'], [role='combobox'], [role='radio']",
				) &&
				[" ", "Enter", "ArrowLeft", "ArrowRight"].includes(event.key)
			)
				return;
			const ctrl = options.isMac
				? event.metaKey && !event.ctrlKey
				: event.ctrlKey && !event.metaKey;
			const command = ctrl && !event.shiftKey && !event.altKey;
			let action: (() => void) | undefined;
			let repeatable = false;
			if (command && event.key.toLowerCase() === "s") action = options.onSave;
			else if (command && event.key.toLowerCase() === "n") action = options.onRecord;
			else if (command && event.key.toLowerCase() === "o") action = options.onRecordings;
			else if (matchesShortcut(event, options.playPause, options.isMac))
				action = options.onPlayPause;
			else if (
				!event.ctrlKey &&
				!event.metaKey &&
				!event.altKey &&
				!event.shiftKey &&
				(event.key === "ArrowLeft" || event.key === "ArrowRight")
			) {
				action = () => options.onStep(event.key === "ArrowLeft" ? -1 : 1);
				repeatable = true;
			}
			if (action) {
				event.preventDefault();
				if (!event.repeat || repeatable) action();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [options]);
}
