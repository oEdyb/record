import type { AxcutDocument } from "../schema";

const MAX_HISTORY = 50;
// Count shared top-level branches once, including their cached JSON. Nested
// sharing across different branches remains conservative. Keep at least one edit.
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const past: AxcutDocument[] = [];
const future: AxcutDocument[] = [];
const snapshotBytes = new WeakMap<object, number>();
const branchJson = new WeakMap<object, string>();

function valueBytes(value: unknown): number {
	if (typeof value === "string") return value.length * 2 + 16;
	if (value && typeof value === "object") return snapshotBytes.get(value) ?? 0;
	return 8;
}

/** Compare without allocating replacement objects. A mutable caller graph is
 * always re-read; only our deeply frozen snapshots are safe identity shortcuts. */
function sameValue(value: unknown, previous: unknown): boolean {
	if (value === previous) return true;
	if (!value || !previous || typeof value !== "object" || typeof previous !== "object")
		return false;
	if (Array.isArray(value)) {
		if (!Array.isArray(previous) || value.length !== previous.length) return false;
		for (let index = 0; index < value.length; index += 1) {
			if (!sameValue(value[index], previous[index])) return false;
		}
		return true;
	}
	if (Array.isArray(previous)) return false;
	const record = value as Record<string, unknown>;
	const prior = previous as Record<string, unknown>;
	const keys = Object.keys(record);
	if (keys.length !== Object.keys(prior).length) return false;
	for (const key of keys) {
		// biome-ignore lint/suspicious/noPrototypeBuiltins: Object.hasOwn is outside the project's ES2020 type library.
		if (!Object.prototype.hasOwnProperty.call(prior, key) || !sameValue(record[key], prior[key]))
			return false;
	}
	return true;
}

/** Own and freeze changed JSON data; reuse matching immutable subtrees without
 * allocating intermediate arrays for every word in an unchanged transcript. */
function snapshotValue(value: unknown, previous?: unknown): unknown {
	if (!value || typeof value !== "object") return value;
	if (snapshotBytes.has(value)) return value;
	if (
		previous &&
		typeof previous === "object" &&
		snapshotBytes.has(previous) &&
		sameValue(value, previous)
	)
		return previous;
	let result: object;
	let bytes = 32;
	if (Array.isArray(value)) {
		const prior = Array.isArray(previous) ? previous : undefined;
		const entries = value.map((item, index) => {
			const next = snapshotValue(item, prior?.[index]);
			bytes += 8 + valueBytes(next);
			return next;
		});
		result = entries;
	} else {
		const record = value as Record<string, unknown>;
		const prior =
			previous && typeof previous === "object" && !Array.isArray(previous)
				? (previous as Record<string, unknown>)
				: undefined;
		const entries: Record<string, unknown> = {};
		for (const key of Object.keys(record)) {
			const next = snapshotValue(record[key], prior?.[key]);
			bytes += key.length * 2 + 16 + valueBytes(next);
			if (key === "__proto__") {
				Object.defineProperty(entries, key, { value: next, enumerable: true });
			} else {
				entries[key] = next;
			}
		}
		result = entries;
	}
	snapshotBytes.set(result, bytes);
	return Object.freeze(result);
}

// Documents are validated JSON. Compare top-level branches in native JSON code
// before recursively owning changed data. Cache text only for our frozen copies,
// never for mutable inputs: a caller can reuse and then modify the same object.
function snapshot(document: AxcutDocument, previous?: AxcutDocument): AxcutDocument {
	if (snapshotBytes.has(document)) return document;
	const result: Record<string, unknown> = {};
	let bytes = 32;
	for (const [key, value] of Object.entries(document)) {
		const prior = previous?.[key as keyof AxcutDocument];
		let next: unknown;
		if (value && typeof value === "object" && !snapshotBytes.has(value)) {
			const serialized = JSON.stringify(value);
			next =
				prior && typeof prior === "object" && branchJson.get(prior) === serialized
					? prior
					: snapshotValue(value, prior);
			branchJson.set(next as object, serialized);
		} else {
			next = snapshotValue(value, prior);
		}
		result[key] = next;
		const cachedText = next && typeof next === "object" ? branchJson.get(next) : undefined;
		bytes += key.length * 2 + 16 + valueBytes(next) + (cachedText?.length ?? 0) * 2;
	}
	snapshotBytes.set(result, bytes);
	return Object.freeze(result) as AxcutDocument;
}

function historyBytes(): number {
	const branches = new Set<object>();
	let bytes = 0;
	for (const stack of [past, future]) {
		for (const doc of stack) {
			bytes += 40; // Document object and its stack slot.
			for (const [key, value] of Object.entries(doc)) {
				bytes += key.length * 2 + 16;
				if (value && typeof value === "object") {
					bytes += 8; // This document's reference to the shared branch.
					if (branches.has(value)) continue;
					branches.add(value);
					bytes += valueBytes(value) + (branchJson.get(value)?.length ?? 0) * 2;
				} else {
					bytes += valueBytes(value);
				}
			}
		}
	}
	return bytes;
}

function trimHistory(): void {
	while (
		past.length + future.length > 1 &&
		(past.length + future.length > MAX_HISTORY || historyBytes() > MAX_HISTORY_BYTES)
	) {
		if (past.length > 1 || future.length === 0) past.shift();
		else future.shift();
	}
}

/** Record the complete document before one user-visible edit. */
export function recordDocumentSnapshot(document: AxcutDocument): void {
	past.push(snapshot(document, past.at(-1)));
	future.length = 0;
	trimHistory();
}

export function clearDocumentHistory(): void {
	past.length = 0;
	future.length = 0;
}

/** Coalesce a pure background patch into import history. Patches already receive
 * live state without cloning in projectStore; they must return immutable edits.
 * Frozen snapshots enforce that contract and unchanged owned branches are reused. */
export function patchDocumentHistory(
	projectId: string,
	patch: (document: AxcutDocument) => AxcutDocument,
): void {
	const apply = (doc: AxcutDocument) =>
		doc.project.id === projectId ? snapshot(patch(doc), doc) : doc;
	// Publish both stacks only after every patch succeeds.
	const nextPast = past.map(apply);
	const nextFuture = future.map(apply);
	past.splice(0, past.length, ...nextPast);
	future.splice(0, future.length, ...nextFuture);
	trimHistory();
}

export function takeUndoDocument(current: AxcutDocument): AxcutDocument | null {
	const previous = past.pop();
	if (!previous) return null;
	if (previous.project.id !== current.project.id) {
		clearDocumentHistory();
		return null;
	}
	future.push(snapshot(current, previous));
	trimHistory();
	return structuredClone(previous);
}

export function takeRedoDocument(current: AxcutDocument): AxcutDocument | null {
	const next = future.pop();
	if (!next) return null;
	if (next.project.id !== current.project.id) {
		clearDocumentHistory();
		return null;
	}
	past.push(snapshot(current, next));
	trimHistory();
	return structuredClone(next);
}
