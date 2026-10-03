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
		const dispose = [
			api.onMenuNewProject?.(options.onRecord),
			api.onMenuLoadProject?.(options.onRecordings),
			api.onMenuSaveProject?.(options.onSave),
			api.onMenuSaveProjectAs?.(options.onSave),
		];
		return () => {
			for (const unsubscribe of dispose) unsubscribe?.();
		};
	}, [options]);
}
