import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { RecordingSessionClip } from "@/lib/recordingSession";
import styles from "./LaunchWindow.module.css";

const MAX_VISIBLE_CLIPS = 8;

export const RecordingClipHistory = memo(function RecordingClipHistory({
	clips,
	active,
	activeClipElapsedMs,
	paused,
	finalizing,
}: {
	clips: RecordingSessionClip[];
	active: boolean;
	activeClipElapsedMs: number;
	paused: boolean;
	finalizing: boolean;
}) {
	const kept = useMemo(
		() => clips.filter((clip) => !clip.removed).sort((a, b) => a.index - b.index),
		[clips],
	);
	const [displayedClips, setDisplayedClips] = useState(kept);
	const [exitingIndexes, setExitingIndexes] = useState<Set<number>>(new Set());
	const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const displayedClipsRef = useRef(displayedClips);
	displayedClipsRef.current = displayedClips;

	useEffect(() => {
		if (exitTimer.current) clearTimeout(exitTimer.current);
		const keptIndexes = new Set(kept.map((clip) => clip.index));
		const removed = displayedClipsRef.current.filter((clip) => !keptIndexes.has(clip.index));
		if (removed.length === 0) {
			setDisplayedClips(kept);
			setExitingIndexes(new Set());
			return;
		}

		setDisplayedClips([...kept, ...removed].sort((a, b) => a.index - b.index));
		setExitingIndexes(new Set(removed.map((clip) => clip.index)));
		exitTimer.current = setTimeout(() => {
			setDisplayedClips(kept);
			setExitingIndexes(new Set());
			exitTimer.current = null;
		}, 180);
		return () => {
			if (exitTimer.current) clearTimeout(exitTimer.current);
		};
	}, [kept]);
	const showActive = active && (!paused || finalizing);
	// New finalized clips must render on the same commit that removes the active
	// state. Keep displayedClips only for clips that are leaving; using it as the
	// complete render source adds one empty intermediate frame before this effect
	// can copy a new clip into local state.
	const renderedClips = useMemo(() => {
		const keptIndexes = new Set(kept.map((clip) => clip.index));
		return [...kept, ...displayedClips.filter((clip) => !keptIndexes.has(clip.index))].sort(
			(a, b) => a.index - b.index,
		);
	}, [displayedClips, kept]);
	const collapsedCount = Math.max(0, renderedClips.length - MAX_VISIBLE_CLIPS);
	const visible = renderedClips.slice(-MAX_VISIBLE_CLIPS);
	const morphFinalizedSegment = paused && !showActive;
	const segments = useMemo(
		() => [
			...visible.map((clip, position) => ({
				// Reuse the active segment's DOM node when Pause turns it into the
				// newest finalized clip. CSS can then interpolate its color and glow
				// instead of replacing red with gray in one painted frame.
				key:
					morphFinalizedSegment && position === visible.length - 1
						? "active"
						: `clip-${clip.index}`,
				index: clip.index,
				durationMs: clip.durationMs,
				active: false,
			})),
			...(showActive
				? [
						{
							key: "active",
							index: -1,
							durationMs: Math.max(120, activeClipElapsedMs),
							active: true,
						},
					]
				: []),
		],
		[activeClipElapsedMs, morphFinalizedSegment, showActive, visible],
	);
	const historyValue = `${kept.length} completed ${kept.length === 1 ? "clip" : "clips"}${
		showActive ? `, active clip ${Math.round(activeClipElapsedMs / 100) / 10} seconds` : ""
	}`;

	return (
		<div
			className={styles.recordingHistoryRow}
			role="img"
			aria-label={`Clip history: ${historyValue}`}
		>
			<div className={styles.recordingHistoryRail} aria-hidden>
				{collapsedCount > 0 && (
					<span className={styles.recordingHistoryOverflow}>+{collapsedCount}</span>
				)}
				{segments.map((segment, position) => (
					<span
						key={segment.key}
						className={`${styles.recordingHistorySegment} ${
							segment.active ? styles.recordingHistorySegmentActive : ""
						} ${!segment.active && position === segments.length - (showActive ? 2 : 1) ? styles.recordingHistorySegmentNewest : ""} ${exitingIndexes.has(segment.index) ? styles.recordingHistorySegmentExit : ""}`}
						style={{ flexGrow: Math.max(1, segment.durationMs), flexBasis: 0 }}
					/>
				))}
				{segments.length === 0 && <span className={styles.recordingHistoryEmpty} />}
			</div>
		</div>
	);
});
