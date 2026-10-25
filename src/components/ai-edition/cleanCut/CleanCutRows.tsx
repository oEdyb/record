import { AudioLines, Repeat, RotateCcw, Scissors } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import styles from "./CleanCutRows.module.css";
import { cleanCutKindKey, formatRemoved } from "./labels";
import { silenceSecOf } from "./moments";
import type { CleanCutGuide } from "./useCleanCutGuide";

/** The cut's name as review shows it: a question mark when the engine is unsure. */
export function useCutLabel() {
	const t = useScopedT("editor");
	return useCallback(
		(cut: ReviewCut) =>
			`${t(cleanCutKindKey(cut.region.kind))}${cut.region.risky && !cut.restored ? "?" : ""}`,
		[t],
	);
}

/** Why the engine cut this, with the silence inside it from one second up. */
export function CutWhy({ cut, spoken }: { cut: ReviewCut; spoken: ReadonlyMap<string, number> }) {
	const t = useScopedT("editor");
	const silence = cut.restored ? 0 : silenceSecOf(cut, spoken);
	const parts = [
		cut.region.reason,
		silence > 0 ? t("cleanCut.silence", { duration: formatRemoved(silence).slice(1) }) : "",
	].filter(Boolean);
	if (parts.length === 0) return null;
	return <p className={styles.why}>{parts.join(" · ")}</p>;
}

/** Hear the picked cut without or with it (each plays on a click), on a loop, and keep or cut it. */
export function CutControls({ guide, cut }: { guide: CleanCutGuide; cut: ReviewCut }) {
	const t = useScopedT("editor");
	return (
		<div className={styles.controls}>
			<div className={styles.listen} role="group" aria-label={t("cleanCut.hud.listen")}>
				{(["without", "with"] as const).map((mode) => (
					<button
						key={mode}
						type="button"
						aria-pressed={guide.listen === mode}
						title={t(mode === "with" ? "cleanCut.hud.withTitle" : "cleanCut.hud.withoutTitle")}
						onClick={(event) => {
							event.stopPropagation();
							guide.setListen(mode);
						}}
					>
						{mode === "without" ? (
							<Scissors size={13} aria-hidden="true" />
						) : (
							<AudioLines size={13} aria-hidden="true" />
						)}
						{t(`cleanCut.hud.${mode}`)}
					</button>
				))}
			</div>
			<button
				type="button"
				className={styles.icon}
				aria-pressed={guide.looping}
				aria-label={t("cleanCut.hud.loopTitle")}
				title={`${t("cleanCut.hud.loopTitle")} (L)`}
				onClick={(event) => {
					event.stopPropagation();
					guide.toggleLoop();
				}}
			>
				<Repeat size={13} aria-hidden="true" />
			</button>
			<button
				type="button"
				className={styles.keep}
				data-restored={cut.restored || undefined}
				onClick={(event) => {
					event.stopPropagation();
					useCleanCutStore.getState().toggleRestore(cut.region.id);
				}}
			>
				{cut.restored ? (
					<Scissors size={13} aria-hidden="true" />
				) : (
					<RotateCcw size={13} aria-hidden="true" />
				)}
				{cut.restored ? t("cleanCut.cutAgain") : t("cleanCut.restore")}
			</button>
		</div>
	);
}

interface CleanCutRowsProps {
	/** Word cuts in recording order. */
	cuts: readonly ReviewCut[];
	selectedId: string | null;
	guide: CleanCutGuide;
	spoken: ReadonlyMap<string, number>;
	onSelect: (cut: ReviewCut) => void;
}

/**
 * Every cut as one row in recording order: when, what kind, how long, and the words it
 * removes. The picked row opens in place with why it was cut and the controls to hear it
 * and keep it, so nothing about a cut lives anywhere else.
 */
export function CleanCutRows({ cuts, selectedId, guide, spoken, onSelect }: CleanCutRowsProps) {
	const t = useScopedT("editor");
	const label = useCutLabel();
	const listRef = useRef<HTMLOListElement>(null);
	useEffect(() => {
		if (!selectedId) return;
		listRef.current
			?.querySelector(`[data-cut-id="${CSS.escape(selectedId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selectedId]);
	return (
		<ol ref={listRef} className={styles.list}>
			{cuts.map((cut) => {
				const selected = cut.region.id === selectedId;
				return (
					<li
						key={cut.region.id}
						className={styles.row}
						data-cut-id={cut.region.id}
						data-selected={selected || undefined}
						data-unsure={(cut.region.risky && !cut.restored) || undefined}
						data-restored={cut.restored || undefined}
					>
						<button
							type="button"
							className={styles.head}
							aria-expanded={selected}
							onClick={() => (selected ? guide.replay() : onSelect(cut))}
						>
							<span className={styles.time}>{formatPlayerTime(cut.rawStartSec)}</span>
							<span className={styles.kind}>{label(cut)}</span>
							<span className={styles.removed}>
								{cut.restored ? t("cleanCut.restored") : formatRemoved(cut.removedSec)}
							</span>
							<span className={styles.words}>{cut.region.words.join(" ")}</span>
						</button>
						{selected ? (
							<div className={styles.detail}>
								<CutWhy cut={cut} spoken={spoken} />
								<CutControls guide={guide} cut={cut} />
							</div>
						) : null}
					</li>
				);
			})}
		</ol>
	);
}
