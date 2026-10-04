import { useEffect } from "react";

export function useRecordingReviewMenu(options: {
	enabled: boolean;
	onRecord: () => void;
	onRecordings: () => void;
	onSave: () => void;
}): void {
	useEffect(() => {
		if (!options.enabled || !window.electronAPI) return;
		const api = window.electronAPI;
		const whenReviewActive = (action: () => void) => () => {
			if (
				document.querySelector(
					"[role='dialog']:not([data-state='closed']), [role='alertdialog']:not([data-state='closed'])",
				)
			)
				return;
			const focused = document.activeElement;
			if (
				focused instanceof HTMLElement &&
				(focused.isContentEditable || focused.closest("input, textarea, select"))
			)
				return;
			action();
		};
		const dispose = [
			api.onMenuNewProject?.(whenReviewActive(options.onRecord)),
			api.onMenuLoadProject?.(whenReviewActive(options.onRecordings)),
			api.onMenuSaveProject?.(whenReviewActive(options.onSave)),
			api.onMenuSaveProjectAs?.(whenReviewActive(options.onSave)),
		];
		return () => {
			for (const unsubscribe of dispose) unsubscribe?.();
		};
	}, [options]);
}
