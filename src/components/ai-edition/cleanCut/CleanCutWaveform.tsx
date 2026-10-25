import { memo, useMemo, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import type { ReviewCut } from "@/lib/cleanCut/reviewModel";
import styles from "./CleanCutWaveform.module.css";
import { layoutCutMarks, markTarget } from "./cutBlocks";
import { cleanCutKindKey, formatRemoved } from "./labels";
import { type CutMoment, sharedKind } from "./moments";
import { type SpokenSpan, speechBins } from "./speechLevels";
import { useElementWidth } from "./useElementWidth";

const PITCH = 3;
const LANE = 12;
const DOT = 3;
const WAVE = 24;

interface CleanCutWaveformProps {
	/** Word moments, grouped once for the whole review. */
	moments: readonly CutMoment[];
	pauses: readonly ReviewCut[];
	spans: readonly SpokenSpan[];
	/** Length of what plays; the bar spans it edge to edge, like the play bar under it. */
	totalSec: number;
	selectedId: string | null;
	toPlaybackSec: (rawSec: number) => number;
	onSelect: (cut: ReviewCut) => void;
	onSeek?: (playbackSec: number) => void;
	/** The small player: the cut dots alone, without the speech. */
	compact?: boolean;
}

function Playhead({
	toPlaybackSec,
	totalSec,
}: {
	toPlaybackSec: (rawSec: number) => number;
	totalSec: number;
}) {
	const rawSec = useProjectStore((s) => s.currentTimeSec);
	const at = totalSec > 0 ? Math.min(1, Math.max(0, toPlaybackSec(rawSec) / totalSec)) : 0;
	return <span className={styles.playhead} style={{ left: `${at * 100}%` }} aria-hidden="true" />;
}

/** The next cut a click on a mark shows: the first unsure one, then each in turn. */
function pickInMoment(moment: CutMoment, selectedId: string | null): ReviewCut {
	const index = moment.cuts.findIndex((cut) => cut.region.id === selectedId);
	if (index !== -1) return moment.cuts[(index + 1) % moment.cuts.length];
	return moment.cuts.find((cut) => cut.region.risky && !cut.restored) ?? moment.cuts[0];
}

/**
 * What plays, on the play bar's own clock. Every moment the clean cut closes is a dot over
 * the seam where playback jumps past it: amber while unsure, quiet once sure, a ring once
 * kept. Pauses are faint ticks. Speech sits under the dots, restored words in steel.
 */
export const CleanCutWaveform = memo(function CleanCutWaveform(props: CleanCutWaveformProps) {
	const t = useScopedT("editor");
	const ref = useRef<HTMLDivElement>(null);
	const width = useElementWidth(ref);
	const [hover, setHover] = useState<string | null>(null);
	const { compact, toPlaybackSec, totalSec } = props;
	const count = compact ? 0 : Math.max(0, Math.floor(width / PITCH));
	const bins = useMemo(
		() => speechBins(props.spans, totalSec, count),
		[props.spans, totalSec, count],
	);
	const marks = useMemo(
		() =>
			layoutCutMarks(
				props.moments,
				(moment) => {
					const live = moment.cuts.find((cut) => !cut.restored);
					return live ? toPlaybackSec(live.rawStartSec) : moment.atSec;
				},
				totalSec,
				width,
			),
		[props.moments, toPlaybackSec, totalSec, width],
	);
	const ticks = useMemo(() => {
		if (totalSec <= 0 || width <= 0) return [];
		const nearMark = (x: number) => marks.some((mark) => Math.abs(x - mark.x) < DOT + 2);
		const xs = new Set<number>();
		for (const pause of props.pauses) {
			if (pause.restored) continue;
			const x = Math.round((toPlaybackSec(pause.rawStartSec) / totalSec) * width);
			if (!nearMark(x)) xs.add(Math.min(width - 1, x));
		}
		return [...xs];
	}, [props.pauses, marks, toPlaybackSec, totalSec, width]);
	const seams = marks.filter((mark) => !mark.restored).map((mark) => mark.x);
	const nearSeam = (barX: number) =>
		seams.some((seam) => Math.abs(barX + (PITCH - 1) / 2 - seam) < 2.5);
	const label = (moment: CutMoment) => {
		const kind = sharedKind(moment);
		const name = kind
			? t(cleanCutKindKey(kind))
			: t("cleanCut.momentCuts", { count: moment.cuts.length });
		const many = kind && moment.cuts.length > 1 ? ` ×${moment.cuts.length}` : "";
		const removed =
			moment.removedSec > 0 ? formatRemoved(moment.removedSec) : t("cleanCut.restored");
		return `${name}${many} · ${removed}`;
	};
	const hovered = marks.find((mark) => mark.moment.key === hover) ?? null;
	const height = compact ? LANE : LANE + WAVE;

	return (
		<div
			className={styles.wave}
			ref={ref}
			data-compact={compact || undefined}
			data-clean-cut-keys=""
		>
			{width > 0 ? (
				<>
					<svg
						width={width}
						height={height}
						className={styles.svg}
						aria-hidden="true"
						data-seekable={props.onSeek ? "" : undefined}
						onPointerDown={(event) => {
							if (!props.onSeek) return;
							const box = event.currentTarget.getBoundingClientRect();
							props.onSeek(((event.clientX - box.left) / width) * totalSec);
						}}
					>
						{bins.map((bin, index) => {
							const barX = index * PITCH;
							if (nearSeam(barX)) return null;
							const h = Math.max(2, (0.1 + 0.9 * bin.level ** 1.5) * (WAVE - 4));
							return (
								<rect
									key={barX}
									x={barX}
									y={LANE + (WAVE - h) / 2}
									width={PITCH - 1}
									height={h}
									rx={1}
									className={styles.bar}
									data-restored={bin.restored || undefined}
								/>
							);
						})}
						{ticks.map((x) => (
							<rect key={x} x={x} y={5} width={1} height={5} className={styles.tick} />
						))}
						{marks.map((mark) => {
							const selected = mark.moment.cuts.some((cut) => cut.region.id === props.selectedId);
							return (
								<g
									key={mark.moment.key}
									className={styles.mark}
									data-unsure={mark.moment.unsure || undefined}
									data-restored={mark.restored || undefined}
									data-hover={mark.moment.key === hover || undefined}
									data-selected={selected || undefined}
								>
									{compact || mark.restored ? null : (
										<rect
											x={mark.x - 0.5}
											y={LANE}
											width={1}
											height={WAVE}
											className={styles.seam}
										/>
									)}
									<circle
										cx={mark.x}
										cy={LANE / 2}
										r={selected ? DOT + 1 : DOT}
										className={styles.dot}
									/>
								</g>
							);
						})}
					</svg>
					{marks.map((mark) => {
						const target = markTarget(mark);
						const selected = mark.moment.cuts.some((cut) => cut.region.id === props.selectedId);
						return (
							<button
								key={mark.moment.key}
								type="button"
								className={styles.target}
								style={{ left: target.left, width: target.width }}
								aria-label={label(mark.moment)}
								aria-pressed={selected}
								data-testid="clean-cut-mark"
								onPointerEnter={() => setHover(mark.moment.key)}
								onPointerLeave={() => setHover((key) => (key === mark.moment.key ? null : key))}
								onFocus={() => setHover(mark.moment.key)}
								onBlur={() => setHover((key) => (key === mark.moment.key ? null : key))}
								onClick={() => props.onSelect(pickInMoment(mark.moment, props.selectedId))}
							/>
						);
					})}
					{hovered ? (
						<span
							className={styles.tip}
							style={{ left: Math.min(width - 70, Math.max(70, hovered.x)) }}
							aria-hidden="true"
						>
							{hovered.moment.unsure ? <span className={styles.tipDot} /> : null}
							{label(hovered.moment)}
						</span>
					) : null}
					{compact ? null : <Playhead toPlaybackSec={toPlaybackSec} totalSec={totalSec} />}
				</>
			) : null}
		</div>
	);
});
