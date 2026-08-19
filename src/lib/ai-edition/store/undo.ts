// Document-level undo and redo. Each history entry restores one complete edit.

import { useEffect, useRef } from "react";
import { clearDocumentHistory, takeRedoDocument, takeUndoDocument } from "./documentHistory";
import { useProjectStore } from "./projectStore";

export function clearHistory(): void {
	clearDocumentHistory();
}

export function undo(): boolean {
	const state = useProjectStore.getState();
	if (!state.document) return false;
	const previous = takeUndoDocument(state.document);
	if (!previous) return false;
	state.restoreDocumentFromHistory(previous);
	return true;
}

export function redo(): boolean {
	const state = useProjectStore.getState();
	if (!state.document) return false;
	const next = takeRedoDocument(state.document);
	if (!next) return false;
	state.restoreDocumentFromHistory(next);
	return true;
}

export function useUndoRedoShortcuts(onAfter: () => void) {
	const onAfterRef = useRef(onAfter);
	onAfterRef.current = onAfter;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;
			if (e.target instanceof HTMLElement && e.target.isContentEditable) return;
			const ctrl = e.ctrlKey || e.metaKey;
			if (ctrl && e.shiftKey && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			if (ctrl && e.key.toLowerCase() === "y") {
				e.preventDefault();
				if (redo()) onAfterRef.current();
				return;
			}
			if (ctrl && e.key.toLowerCase() === "z") {
				e.preventDefault();
				if (undo()) onAfterRef.current();
				return;
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
