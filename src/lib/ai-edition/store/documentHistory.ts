import type { AxcutDocument } from "../schema";

const MAX_HISTORY = 50;
const past: AxcutDocument[] = [];
const future: AxcutDocument[] = [];

function clone(document: AxcutDocument): AxcutDocument {
	return structuredClone(document);
}

/** Record the complete document before one user-visible edit. */
export function recordDocumentSnapshot(document: AxcutDocument): void {
	past.push(clone(document));
	if (past.length > MAX_HISTORY) past.shift();
	future.length = 0;
}

export function clearDocumentHistory(): void {
	past.length = 0;
	future.length = 0;
}

/**
 * Merge a non-user background enhancement into every compatible history
 * snapshot. This keeps a late recording enhancement inside the original import
 * edit instead of making the next Undo remove both the user's edit and the
 * enhancement.
 */
export function patchDocumentHistory(
	projectId: string,
	patch: (document: AxcutDocument) => AxcutDocument,
): void {
	for (const stack of [past, future]) {
		for (let index = 0; index < stack.length; index += 1) {
			if (stack[index].project.id !== projectId) continue;
			stack[index] = clone(patch(clone(stack[index])));
		}
	}
}

/** Move one snapshot from the undo stack and preserve the current document for redo. */
export function takeUndoDocument(current: AxcutDocument): AxcutDocument | null {
	const previous = past.pop();
	if (!previous) return null;
	if (previous.project.id !== current.project.id) {
		clearDocumentHistory();
		return null;
	}
	future.push(clone(current));
	return clone(previous);
}

/** Move one snapshot from the redo stack and preserve the current document for undo. */
export function takeRedoDocument(current: AxcutDocument): AxcutDocument | null {
	const next = future.pop();
	if (!next) return null;
	if (next.project.id !== current.project.id) {
		clearDocumentHistory();
		return null;
	}
	past.push(clone(current));
	return clone(next);
}
