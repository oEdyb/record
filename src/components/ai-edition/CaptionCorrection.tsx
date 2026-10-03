import { useMemo, useState } from "react";
import { InspectorSection } from "@/components/ui/inspector";
import { useScopedT } from "@/contexts/I18nContext";
import type { CaptionCue } from "@/lib/ai-edition/captions";
import { captionCorrectionWords, correctCaptionWords } from "@/lib/ai-edition/captions/correction";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useCaptionSelectionStore } from "@/lib/ai-edition/store/captionSelectionStore";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import correctionStyles from "./CaptionCorrection.module.css";
import styles from "./NewEditorShell.module.css";

export function CaptionCorrection({ language }: { language: string | null }) {
	const t = useScopedT("settings");
	const document = useProjectStore((s) => s.document);
	const selection = useCaptionSelectionStore((s) => s.selection);
	const active = document && selection?.document === document ? selection : null;
	return (
		<InspectorSection title={t("captions.correctWords")}>
			{language !== null ? (
				<p className={styles.captionFinePrint}>{t("captions.correctionOriginalOnly")}</p>
			) : active && document ? (
				<CorrectionForm key={active.token} document={document} cue={active.cue} />
			) : (
				<p className={styles.captionFinePrint}>{t("captions.selectToCorrect")}</p>
			)}
		</InspectorSection>
	);
}

function CorrectionForm({ document, cue }: { document: AxcutDocument; cue: CaptionCue }) {
	const t = useScopedT("settings");
	const words = useMemo(() => captionCorrectionWords(document, cue.id), [document, cue.id]);
	const [draft, setDraft] = useState<Record<string, string>>({});
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(false);
	const changed = words.some(
		(word) => draft[word.id] !== undefined && draft[word.id].trim() !== word.text,
	);
	const valid = words.every((word) => {
		const value = (draft[word.id] ?? word.text).trim();
		return value.length > 0 && value.length <= 100 && !/\s/u.test(value);
	});
	if (!words.length)
		return <p className={styles.captionFinePrint}>{t("captions.correctionUnavailable")}</p>;
	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				if (!changed || !valid || saving) return;
				setSaving(true);
				setError(false);
				try {
					const state = useProjectStore.getState();
					if (state.document !== document) throw new Error("stale-correction");
					const next = correctCaptionWords(document, cue, draft);
					if (!(await state.saveDocumentAsEdit(next))) throw new Error("save-failed");
				} catch {
					setError(true);
				} finally {
					setSaving(false);
				}
			}}
		>
			<p className={styles.captionFinePrint}>{t("panels.correctionHint")}</p>
			<div className={correctionStyles.words}>
				{words.map((word, index) => (
					<label key={word.id} className={correctionStyles.word}>
						<span className="sr-only">{t("captions.correctionWord", { number: index + 1 })}</span>
						<input
							value={draft[word.id] ?? word.text}
							maxLength={100}
							size={Math.max(2, (draft[word.id] ?? word.text).length)}
							disabled={saving}
							className={correctionStyles.input}
							onChange={(event) => setDraft({ ...draft, [word.id]: event.target.value })}
						/>
					</label>
				))}
			</div>
			{!valid ? (
				<p role="alert" className={styles.captionError}>
					{t("captions.correctionInvalid")}
				</p>
			) : null}
			{error ? (
				<p role="alert" className={styles.captionError}>
					{t("captions.correctionSaveFailed")}
				</p>
			) : null}
			<div style={{ display: "flex", gap: 8 }}>
				<button
					type="submit"
					className={`${styles.btn} ${styles.btnPrimary}`}
					disabled={!changed || !valid || saving}
				>
					{t("captions.saveCorrection")}
				</button>
				<button
					type="button"
					className={`${styles.btn} ${styles.btnSecondary}`}
					disabled={!changed || saving}
					onClick={() => {
						setDraft({});
						setError(false);
					}}
				>
					{t("captions.resetCorrection")}
				</button>
			</div>
		</form>
	);
}
