import { useRef } from "react";
import { formatTimePadded } from "@/utils/timeUtils";
import type { buildPeekTimeline } from "../launch/HudClipPeek";
import peek from "../launch/LaunchWindow.module.css";

const KEY_STEP_SECONDS = 5;

/** The take's clips as one bar, each segment filling as the replay passes it. */
export function StudioSeekBar({
	timeline,
	total,
	position,
	label,
	onSeek,
}: {
	timeline: ReturnType<typeof buildPeekTimeline>;
	total: number;
	position: number;
	label: string;
	onSeek: (takeSec: number) => void;
}) {
	const trackRef = useRef<HTMLDivElement | null>(null);
	const seekFromPointer = (clientX: number) => {
		const rect = trackRef.current?.getBoundingClientRect();
		if (!rect || rect.width <= 0) return;
		onSeek(Math.min(total, Math.max(0, ((clientX - rect.left) / rect.width) * total)));
	};
	return (
		<>
			<div
				ref={trackRef}
				role="slider"
				tabIndex={0}
				aria-label={label}
				aria-valuemin={0}
				aria-valuemax={Math.round(total)}
				aria-valuenow={Math.round(position)}
				aria-valuetext={`${formatTimePadded(Math.floor(position))} / ${formatTimePadded(Math.round(total))}`}
				className={peek.clipPeekTrack}
				onKeyDown={(event) => {
					const target = {
						ArrowLeft: position - KEY_STEP_SECONDS,
						ArrowRight: position + KEY_STEP_SECONDS,
						Home: 0,
						End: total,
					}[event.key];
					if (target === undefined) return;
					event.preventDefault();
					event.stopPropagation();
					onSeek(Math.min(total, Math.max(0, target)));
				}}
				onPointerDown={(event) => {
					event.currentTarget.setPointerCapture(event.pointerId);
					seekFromPointer(event.clientX);
				}}
				onPointerMove={(event) => {
					if (event.currentTarget.hasPointerCapture(event.pointerId))
						seekFromPointer(event.clientX);
				}}
			>
				{timeline.map((entry) => {
					const filled =
						entry.duration > 0
							? Math.min(1, Math.max(0, (position - entry.start) / entry.duration))
							: 0;
					return (
						<span
							key={entry.clip.index}
							className={peek.clipPeekSegment}
							style={{ flexGrow: Math.max(entry.duration, 0.001) }}
						>
							<span
								className={peek.clipPeekSegmentFill}
								style={{ transform: `scaleX(${filled})` }}
							/>
						</span>
					);
				})}
			</div>
			<span className={peek.clipPeekTime}>
				{formatTimePadded(Math.floor(position))} / {formatTimePadded(Math.round(total))}
			</span>
		</>
	);
}
