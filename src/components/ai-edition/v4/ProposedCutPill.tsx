import { Scissors } from "lucide-react";
import { type CSSProperties, type PointerEvent, useRef, useState } from "react";
import { Tooltip } from "@/components/ui/tooltip";
import { useScopedT } from "@/contexts/I18nContext";
import {
	type SelectablePauseSuggestion,
	usePauseAnalysisStore,
} from "../pauses/pauseAnalysisStore";
import styles from "./EditorShellV4.module.css";

export function ProposedCutPill({
	cut,
	style,
	widthPx,
	sourceAtOffset,
	onToggle,
}: {
	cut: SelectablePauseSuggestion;
	style: CSSProperties;
	widthPx: number;
	sourceAtOffset: (edge: "start" | "end", offsetPx: number) => number;
	onToggle?: (id: string) => void;
}) {
	const t = useScopedT("timeline");
	const drag = useRef<{
		pointerId: number;
		startX: number;
		edge: "start" | "end";
		sourceSec: number;
		map: typeof sourceAtOffset;
	} | null>(null);
	const [delta, setDelta] = useState<number | null>(null);
	const moveCutEdge = usePauseAnalysisStore((state) => state.moveCutEdge);
	const rejectCut = usePauseAnalysisStore((state) => state.rejectCut);
	const toggle = usePauseAnalysisStore((state) => state.toggleSuggestion);
	const kindStyle = {
		pause: styles.proposedPause,
		blip: styles.proposedBlip,
		agent: styles.proposedAgent,
		fix: styles.proposedFix,
	}[cut.kind];
	const label =
		delta === null
			? `−${cut.savedSec.toFixed(1)} s`
			: `${delta >= 0 ? "+" : ""}${delta.toFixed(2)} s`;
	const title = t("labels.cutDetails", {
		origin: cut.origin,
		start: cut.sourceStartSec.toFixed(2),
		end: cut.sourceEndSec.toFixed(2),
		saved: cut.savedSec.toFixed(2),
	});
	const compact = widthPx < 14;
	const showReject = widthPx >= 56;
	const showLabel = widthPx >= label.length * 7 + 46;

	const finish = (event: PointerEvent<HTMLButtonElement>) => {
		if (drag.current?.pointerId !== event.pointerId) return;
		drag.current = null;
		setDelta(null);
		if (event.currentTarget.hasPointerCapture(event.pointerId))
			event.currentTarget.releasePointerCapture(event.pointerId);
	};
	return (
		<Tooltip content={title} side="top">
			<div
				className={`${styles.lanePill} ${styles.proposedCutPill} ${kindStyle}${compact ? ` ${styles.proposedCutCompact}` : ""}`}
				style={style}
				data-selected={cut.selected}
				data-compact={compact}
				data-dragging={delta !== null}
				data-floating-delta={delta !== null && !showLabel}
				role="group"
				aria-label={title}
				data-testid={`proposed-cut-${cut.id}`}
			>
				{(["start", "end"] as const).map((edge) => (
					<button
						key={edge}
						type="button"
						className={`${styles.proposedCutHandle} ${edge === "start" ? styles.proposedCutStart : styles.proposedCutEnd}`}
						aria-label={t(edge === "start" ? "labels.cutStart" : "labels.cutEnd")}
						onClick={(event) => event.stopPropagation()}
						onPointerDown={(event) => {
							event.stopPropagation();
							if (event.button !== 0 || drag.current) return;
							event.currentTarget.setPointerCapture(event.pointerId);
							drag.current = {
								pointerId: event.pointerId,
								startX: event.clientX,
								edge,
								sourceSec: edge === "start" ? cut.sourceStartSec : cut.sourceEndSec,
								map: sourceAtOffset,
							};
							setDelta(0);
						}}
						onPointerMove={(event) => {
							const current = drag.current;
							if (!current || current.pointerId !== event.pointerId) return;
							event.stopPropagation();
							moveCutEdge(
								cut.id,
								current.edge,
								current.map(current.edge, event.clientX - current.startX),
							);
							const moved = usePauseAnalysisStore
								.getState()
								.suggestions.find((item) => item.id === cut.id);
							if (moved)
								setDelta(
									(current.edge === "start" ? moved.sourceStartSec : moved.sourceEndSec) -
										current.sourceSec,
								);
						}}
						onPointerUp={finish}
						onPointerCancel={finish}
						onLostPointerCapture={finish}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === "Delete" || event.key === "Backspace") {
								event.preventDefault();
								rejectCut(cut.id);
							}
							if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
							event.preventDefault();
							moveCutEdge(
								cut.id,
								edge,
								(edge === "start" ? cut.sourceStartSec : cut.sourceEndSec) +
									(event.key === "ArrowRight" ? 0.04 : -0.04),
							);
						}}
					/>
				))}
				<button
					type="button"
					className={styles.proposedCutBody}
					style={{ paddingRight: showReject ? 20 : 0 }}
					aria-pressed={cut.selected}
					aria-label={title}
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.stopPropagation();
						(onToggle ?? toggle)(cut.id);
					}}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (event.key === "Delete" || event.key === "Backspace") {
							event.preventDefault();
							rejectCut(cut.id);
						}
					}}
				>
					{!compact && <Scissors size={12} aria-hidden="true" />}
					{(showLabel || delta !== null) && (
						<span className={styles.proposedCutLabel}>{label}</span>
					)}
				</button>
				{showReject && (
					<button
						type="button"
						className={styles.proposedCutReject}
						aria-label={t("labels.rejectCut")}
						onPointerDown={(event) => event.stopPropagation()}
						onKeyDown={(event) => event.stopPropagation()}
						onClick={(event) => {
							event.stopPropagation();
							rejectCut(cut.id);
						}}
					>
						×
					</button>
				)}
			</div>
		</Tooltip>
	);
}
