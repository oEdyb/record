import { useEffect, useMemo, useRef } from "react";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { CleanCutHud } from "./CleanCutHud";
import { CleanCutSheet } from "./CleanCutSheet";
import styles from "./CleanCutStage.module.css";
import { type CutMoment, momentsById } from "./moments";
import type { CleanCutGuide } from "./useCleanCutGuide";

interface CleanCutStageProps {
	model: CleanCutReviewModel | null;
	moments: readonly CutMoment[];
	guide: CleanCutGuide;
	clips: readonly AxcutClip[];
	fromSec: number;
	toSec: number;
	toPlaybackSec: (rawSec: number) => number;
	isMac: boolean;
	listOpen: boolean;
	/** The card folded to a pill, so it never has to cover the video. */
	collapsed: boolean;
	onCollapse: (collapsed: boolean) => void;
	saveDisabled: boolean;
	onListOpen: (open: boolean) => void;
	onSeekRaw: (rawSec: number) => void;
	onSelectCut: (cut: ReviewCut) => void;
	onSave: () => void;
}

/**
 * Everything the clean cut lays over the video: the guided card in the space under it,
 * and, one key away (⌘K or C), every cut in a searchable sheet.
 */
export function CleanCutStage(props: CleanCutStageProps) {
	const snapshot = useCleanCutStore((s) => s.snapshot);
	const { listOpen, onListOpen, isMac, collapsed, onCollapse } = props;
	const sheetRef = useRef<HTMLDivElement>(null);
	const byId = useMemo(() => momentsById(props.moments), [props.moments]);
	const ready = snapshot.state === "ready" && props.model !== null;

	useEffect(() => {
		if (sheetRef.current) sheetRef.current.inert = !listOpen;
	}, [listOpen]);

	useEffect(() => {
		if (!ready) return;
		const onKey = (event: KeyboardEvent) => {
			const target = event.target instanceof Element ? event.target : null;
			const elsewhere = target?.closest("[role='dialog'], [role='alertdialog'], [role='menu']");
			if (elsewhere && !sheetRef.current?.contains(elsewhere)) return;
			if (listOpen && event.key === "Escape" && !event.defaultPrevented) {
				event.preventDefault();
				onListOpen(false);
				return;
			}
			const command = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
			if (!command || event.shiftKey || event.altKey || event.key.toLowerCase() !== "k") return;
			event.preventDefault();
			onListOpen(!listOpen);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [ready, isMac, listOpen, onListOpen]);

	return (
		<>
			<div className={styles.hudLayer}>
				<CleanCutHud
					snapshot={snapshot}
					model={props.model}
					moments={byId}
					guide={props.guide}
					fromSec={props.fromSec}
					toSec={props.toSec}
					listOpen={listOpen}
					collapsed={collapsed}
					onCollapse={onCollapse}
					saveDisabled={props.saveDisabled}
					onOpenList={() => onListOpen(true)}
					onSave={props.onSave}
					onRetry={() => useCleanCutStore.getState().retry()}
				/>
			</div>
			<div ref={sheetRef} className={styles.sheet} data-open={listOpen || undefined}>
				{ready && props.model ? (
					<CleanCutSheet
						open={listOpen}
						model={props.model}
						guide={props.guide}
						clips={props.clips}
						fromSec={props.fromSec}
						toSec={props.toSec}
						toPlaybackSec={props.toPlaybackSec}
						onClose={() => onListOpen(false)}
						onSelectCut={props.onSelectCut}
						onSeekRaw={props.onSeekRaw}
					/>
				) : null}
			</div>
		</>
	);
}
