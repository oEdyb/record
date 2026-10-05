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
	/** Moves the playhead by one frame, or by one second for the larger step. */
	onStep: (direction: -1 | 1, unit: "frame" | "second") => void;
	onClip: (direction: -1 | 1) => void;
	onEdge: (edge: "start" | "end") => void;
	onMute: () => void;
}

/** Controls that need Space, Enter or the arrows for themselves. */
const SELF_KEYED =
	"summary, select, [role='tab'], [role='switch'], [role='checkbox'], [role='combobox'], [role='radio']";

export function useRecordingReviewShortcuts(options: ReviewShortcuts): void {
	useEffect(() => {
		if (!options.enabled) return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.isComposing) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			const range = target?.closest("input[type='range']");
			if (
				target &&
				(target.isContentEditable ||
					target.closest(
						"textarea, select, [role='dialog'], [role='alertdialog'], [role='menu']",
					) ||
					(target.closest("input") && !range))
			)
				return;
			// A slider other than the playhead keeps its own arrow keys.
			const ownsArrows = Boolean(range && !range.hasAttribute("data-review-seek"));
			const ownsKeys = Boolean(target?.closest(SELF_KEYED));
			const ctrl = options.isMac
				? event.metaKey && !event.ctrlKey
				: event.ctrlKey && !event.metaKey;
			const command = ctrl && !event.shiftKey && !event.altKey;
			const unmodified = !event.ctrlKey && !event.metaKey && !event.altKey;
			const plain = unmodified && !event.shiftKey;
			const key = event.key.toLowerCase();
			let action: (() => void) | undefined;
			let repeatable = false;
			if (command && key === "s") action = options.onSave;
			else if (command && key === "n") action = options.onRecord;
			else if (command && key === "o") action = options.onRecordings;
			else if (ownsKeys) return;
			else if (plain && key === "k") action = options.onPlayPause;
			else if (matchesShortcut(event, options.playPause, options.isMac))
				action = options.onPlayPause;
			else if (plain && key === "m") action = options.onMute;
			else if (plain && (key === "j" || key === "l")) {
				action = () => options.onStep(key === "j" ? -1 : 1, "second");
				repeatable = true;
			} else if (ownsArrows) return;
			else if (unmodified && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
				const unit = event.shiftKey ? "second" : "frame";
				action = () => options.onStep(event.key === "ArrowLeft" ? -1 : 1, unit);
				repeatable = true;
			} else if (plain && (event.key === "ArrowUp" || event.key === "ArrowDown"))
				action = () => options.onClip(event.key === "ArrowUp" ? -1 : 1);
			else if (plain && (event.key === "Home" || event.key === "End"))
				action = () => options.onEdge(event.key === "Home" ? "start" : "end");
			if (action) {
				event.preventDefault();
				// A focused button would still click on Space's keyup.
				swallowSpaceUp = event.key === " ";
				if (!event.repeat || repeatable) action();
			}
		};
		let swallowSpaceUp = false;
		const onKeyUp = (event: KeyboardEvent) => {
			if (event.key !== " " || !swallowSpaceUp) return;
			swallowSpaceUp = false;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onKeyUp, true);
		return () => {
			window.removeEventListener("keydown", onKey);
			window.removeEventListener("keyup", onKeyUp, true);
		};
	}, [options]);
}
