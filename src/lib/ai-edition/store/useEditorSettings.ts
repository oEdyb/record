// React binding over the editor-settings pure module.
//
// Usage:
//   const { settings, set, setLive } = useEditorSettings();
//   - `settings` is a typed snapshot of the document's legacy settings.
//   - `set(patch)` writes + commits to disk (use for toggles, selects, on
//     slider release).
//   - `setLive(patch)` writes only (use while dragging a slider for the
//     preview to update without round-tripping every pixel).
//
// The hook is intentionally thin: it reads from the project store, applies
// the patch through `patchEditorSettings`, and persists via the store. No
// extra state, no caches — the document is the single source of truth.

import { useCallback, useMemo, useRef } from "react";
import type { AxcutDocument } from "../schema";
import { saveEditorDefaultPreferences } from "./editingPreferences";
import {
	type EditorSettingsPatch,
	type EditorSettingsSnapshot,
	getEditorSettings,
	patchEditorSettings,
} from "./editorSettings";
import { useProjectStore } from "./projectStore";

export interface UseEditorSettingsResult {
	settings: EditorSettingsSnapshot;
	/** True when there's a project loaded — `set`/`setLive` are no-ops otherwise. */
	hasDocument: boolean;
	/** Apply a patch, persist to disk. */
	set: (patch: EditorSettingsPatch) => Promise<void>;
	/** Apply a patch, no persist. Pair with `commit` on slider release. */
	setLive: (patch: EditorSettingsPatch) => void;
	/** Force-flush the current document to disk. */
	commit: () => Promise<void>;
}

export function useEditorSettings(): UseEditorSettingsResult {
	const document = useProjectStore((s) => s.document);
	const setDocument = useProjectStore((s) => s.setDocument);
	const setDocumentLive = useProjectStore((s) => s.setDocumentLive);
	const saveDocument = useProjectStore((s) => s.saveDocument);
	const saveDocumentAsEdit = useProjectStore((s) => s.saveDocumentAsEdit);
	const liveGestureBaseRef = useRef<AxcutDocument | null>(null);

	const hasDocument = document !== null;

	const settings = useMemo(() => getEditorSettings(document), [document]);

	const set = useCallback(
		async (patch: EditorSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			const next = patchEditorSettings(doc, patch);
			setDocument(next);
			if (await saveDocument(next)) {
				saveEditorDefaultPreferences(getEditorSettings(next));
			}
		},
		[setDocument, saveDocument],
	);

	const setLive = useCallback(
		(patch: EditorSettingsPatch) => {
			const doc = useProjectStore.getState().document;
			if (!doc) return;
			liveGestureBaseRef.current ??= doc;
			setDocumentLive(patchEditorSettings(doc, patch));
		},
		[setDocumentLive],
	);

	const commit = useCallback(async () => {
		const doc = useProjectStore.getState().document;
		if (!doc) return;
		const liveGestureBase = liveGestureBaseRef.current;
		liveGestureBaseRef.current = null;
		try {
			const saved = liveGestureBase
				? await saveDocumentAsEdit(doc, liveGestureBase)
				: await saveDocument(doc);
			if (!saved) return;
			saveEditorDefaultPreferences(getEditorSettings(doc));
		} catch (error) {
			// Keep the gesture base so a later commit can save the same live change as
			// one Undo step. Do not replace a newer gesture that started meanwhile.
			liveGestureBaseRef.current ??= liveGestureBase;
			throw error;
		}
	}, [saveDocument, saveDocumentAsEdit]);

	return { settings, hasDocument, set, setLive, commit };
}
