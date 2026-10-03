import { Captions } from "lucide-react";
import { useScopedT } from "@/contexts/I18nContext";
import type { CaptionCue } from "@/lib/ai-edition/captions";
import { useCaptionSelectionStore } from "@/lib/ai-edition/store/captionSelectionStore";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	playbackTimeToRawTime,
	projectRawSpanToPlaybackSpan,
	type TimelinePlaybackProjectionSegment,
} from "@/lib/ai-edition/timeline/timelineMap";
import styles from "./EditorShellV4.module.css";

export function CaptionTrack({
	cues,
	projection,
	total,
	start,
	end,
	onSelect,
}: {
	cues: CaptionCue[];
	projection: TimelinePlaybackProjectionSegment[];
	total: number;
	start: number;
	end: number;
	onSelect: (rawSec: number) => void;
}) {
	const t = useScopedT("settings");
	const document = useProjectStore((s) => s.document);
	const selection = useCaptionSelectionStore((s) => s.selection);
	const selectedId = selection?.document === document ? selection?.cue.id : null;
	if (!cues.length || total <= 0) return null;
	return (
		<div
			className={styles.captionTrack}
			role="group"
			aria-label={t("facets.captions")}
			onPointerDown={(e) => e.stopPropagation()}
		>
			<div
				className={styles.captionTrackLabel}
				style={{ left: `${(start / total) * 100}%` }}
				aria-hidden="true"
			>
				<Captions size={14} aria-hidden="true" />
				{t("facets.captions")}
				<span className={styles.captionCount}>{cues.length}</span>
			</div>
			{cues.map((cue) => {
				const span = projectRawSpanToPlaybackSpan(cue.startMs / 1000, cue.endMs / 1000, projection);
				if (!span || span.endSec <= start || span.startSec >= end) return null;
				return (
					<button
						key={cue.id}
						type="button"
						className={styles.captionCue}
						title={cue.text}
						aria-label={cue.text}
						aria-pressed={selectedId === cue.id}
						style={{
							left: `${(span.startSec / total) * 100}%`,
							width: `${((span.endSec - span.startSec) / total) * 100}%`,
						}}
						onClick={() => {
							useCaptionSelectionStore.getState().select(document, cue);
							onSelect(playbackTimeToRawTime(span.startSec, projection, "after"));
						}}
					>
						<span className={styles.captionCueText}>{cue.text}</span>
					</button>
				);
			})}
		</div>
	);
}
