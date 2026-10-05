// Document-level undo and redo. Each history entry restores one complete edit.

import { clearDocumentHistory, takeRedoDocument, takeUndoDocument } from "./documentHistory";
import { isProjectTransactionBlocked, useProjectStore } from "./projectStore";

export function clearHistory(): void {
	clearDocumentHistory();
}

export function undo(): boolean {
	const state = useProjectStore.getState();
	if (!state.document || isProjectTransactionBlocked()) return false;
	const previous = takeUndoDocument(state.document);
	if (!previous) return false;
	state.restoreDocumentFromHistory(previous);
	return true;
}

export function redo(): boolean {
	const state = useProjectStore.getState();
	if (!state.document || isProjectTransactionBlocked()) return false;
	const next = takeRedoDocument(state.document);
	if (!next) return false;
	state.restoreDocumentFromHistory(next);
	return true;
}
