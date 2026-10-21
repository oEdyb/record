import { ChevronRight, RotateCcw, Scissors } from "lucide-react";
import { useEffect, useRef } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import styles from "./CleanCutSheet.module.css";
import type { CutRow, CutSection } from "./cutRows";
import { cleanCutKindKey, formatRemoved } from "./labels";
import { sharedKind, silenceSecOf } from "./moments";

interface CleanCutListProps {
	id: string;
	sections: readonly CutSection[];
	activeKey: string | null;
	selectedId: string | null;
	/** Seconds of speech in each cut, so a cut that is mostly silence says so. */
	spoken: ReadonlyMap<string, number>;
	onHover: (key: string) => void;
	onActivate: (row: CutRow) => void;
	onToggleRestore: (cut: ReviewCut) => void;
}

function RestoreButton({ cut, onToggle }: { cut: ReviewCut; onToggle: (cut: ReviewCut) => void }) {
	const t = useScopedT("editor");
	const label = cut.restored ? t("cleanCut.cutAgain") : t("cleanCut.restore");
	return (
		<button
			type="button"
			className={styles.rowAction}
			tabIndex={-1}
			aria-label={label}
			title={`${label} (⇧↵)`}
			onClick={(event) => {
				event.stopPropagation();
				onToggle(cut);
			}}
		>
			{cut.restored ? (
				<Scissors size={13} aria-hidden="true" />
			) : (
				<RotateCcw size={13} aria-hidden="true" />
			)}
		</button>
	);
}

/** Every word cut, grouped by the moment it closes into; one row is active for the keys. */
export function CleanCutList(props: CleanCutListProps) {
	const t = useScopedT("editor");
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!props.activeKey) return;
		rootRef.current
			?.querySelector(`[data-row-key="${CSS.escape(props.activeKey)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [props.activeKey]);

	const row = (entry: CutRow) => {
		const active = entry.key === props.activeKey;
		const common = {
			id: `${props.id}-${entry.key}`,
			"data-row-key": entry.key,
			"data-active": active || undefined,
			role: "option" as const,
			"aria-selected": active,
			onPointerMove: () => props.onHover(entry.key),
			onClick: () => props.onActivate(entry),
		};
		if (entry.type === "moment") {
			const { moment } = entry;
			const kind = sharedKind(moment);
			return (
				<div key={entry.key} className={styles.row} {...common} aria-expanded={entry.open}>
					<span className={styles.rowHead}>
						<span className={styles.rowTime}>
							{moment.unsure ? <span className={styles.unsureDot} aria-hidden="true" /> : null}
							{formatPlayerTime(moment.atSec)}
						</span>
						<span className={styles.rowKind}>
							{kind
								? t(cleanCutKindKey(kind))
								: t("cleanCut.momentCuts", { count: moment.cuts.length })}
							{kind ? <span className={styles.times}>×{moment.cuts.length}</span> : null}
						</span>
						<span className={styles.rowRemoved}>{formatRemoved(moment.removedSec)}</span>
						<ChevronRight size={14} aria-hidden="true" className={styles.chevron} />
					</span>
					<span className={styles.segments} aria-hidden="true">
						{moment.cuts.map((cut) => (
							<span
								key={cut.region.id}
								style={{ flexGrow: Math.max(0.4, cut.removedSec) }}
								data-restored={cut.restored || undefined}
								data-selected={cut.region.id === props.selectedId || undefined}
							/>
						))}
					</span>
				</div>
			);
		}
		const { cut } = entry;
		const silence = cut.restored ? 0 : silenceSecOf(cut, props.spoken);
		// A cut inside a moment shows where it was said in the recording; its moment's row
		// already shows where the seam plays.
		const recorded = formatPlayerTime(cut.rawStartSec);
		const time = entry.nested ? recorded : formatPlayerTime(entry.moment.atSec);
		return (
			<div
				key={entry.key}
				className={styles.row}
				{...common}
				data-nested={entry.nested || undefined}
				data-selected={cut.region.id === props.selectedId || undefined}
				data-restored={cut.restored || undefined}
			>
				<span className={styles.rowHead}>
					<span
						className={styles.rowTime}
						title={entry.nested ? t("cleanCut.recordedAt", { time: recorded }) : undefined}
					>
						{cut.region.risky ? <span className={styles.unsureDot} aria-hidden="true" /> : null}
						{time}
					</span>
					<span className={styles.rowKind}>{t(cleanCutKindKey(cut.region.kind))}</span>
					<span className={styles.rowRemoved}>
						{cut.restored ? t("cleanCut.restored") : formatRemoved(cut.removedSec)}
					</span>
					<RestoreButton cut={cut} onToggle={props.onToggleRestore} />
				</span>
				<span className={styles.rowWords}>
					<span className={styles.strike} data-on={!cut.restored || undefined}>
						{cut.region.words.join(" ")}
					</span>
					{silence > 0 ? (
						<span className={styles.silence}>
							{" "}
							{t("cleanCut.silence", { duration: formatRemoved(silence).slice(1) })}
						</span>
					) : null}
				</span>
			</div>
		);
	};

	return (
		<div
			ref={rootRef}
			id={props.id}
			className={styles.list}
			role="listbox"
			aria-label={t("cleanCut.cuts")}
		>
			{props.sections.map((section) => (
				<div
					key={section.unsure ? "unsure" : "sure"}
					role="group"
					aria-label={section.unsure ? t("cleanCut.checkThese") : t("cleanCut.otherCuts")}
				>
					<h3 className={styles.groupTitle} aria-hidden="true">
						{section.unsure ? <span className={styles.unsureDot} /> : null}
						{section.unsure ? t("cleanCut.checkThese") : t("cleanCut.otherCuts")}
						<span className={styles.count}>
							{section.unsure ? t("cleanCut.unsureCount", { count: section.count }) : section.count}
						</span>
						<span className={styles.spacer} />
						<span className={styles.groupRemoved}>{formatRemoved(section.removedSec)}</span>
					</h3>
					{section.rows.map(row)}
				</div>
			))}
		</div>
	);
}
