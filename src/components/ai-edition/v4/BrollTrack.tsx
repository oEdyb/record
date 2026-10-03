import { Film } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import { brollTimeline } from "./brollTimeline";
import styles from "./EditorShellV4.module.css";
import { videoThumbnail } from "./videoThumbnail";

function BrollThumbnail({ path, timeSec }: { path: string; timeSec: number }) {
	const [image, setImage] = useState<string | null>(null);
	useEffect(() => {
		const controller = new AbortController();
		setImage(null);
		void videoThumbnail(path, timeSec, controller.signal).then((value) => {
			if (!controller.signal.aborted) setImage(value);
		});
		return () => controller.abort();
	}, [path, timeSec]);
	return image ? (
		<img className={styles.brollThumbnail} src={image} alt="" draggable={false} />
	) : (
		<Film size={18} aria-hidden="true" />
	);
}

export function BrollTrack({
	total,
	start,
	end,
	onSeek,
}: {
	total: number;
	start: number;
	end: number;
	onSeek: (playbackSec: number) => void;
}) {
	const document = useProjectStore((state) => state.document);
	const clips = useMemo(() => (document ? brollTimeline(document) : []), [document]);
	if (!clips.length || total <= 0) return null;
	return (
		<div className={styles.brollTrack} role="group" aria-label="B-roll" data-testid="broll-track">
			{clips
				.filter((clip) => clip.end > start && clip.start < end)
				.map((clip) => (
					<button
						key={clip.key}
						type="button"
						className={styles.brollClip}
						title={clip.label}
						aria-label={`B-roll: ${clip.label}`}
						style={{
							left: `${(clip.start / total) * 100}%`,
							width: `${((clip.end - clip.start) / total) * 100}%`,
						}}
						onPointerDown={(event) => event.stopPropagation()}
						onClick={() => onSeek(Math.max(start, clip.start))}
					>
						<div
							className={styles.brollClipContent}
							style={{
								left: `${(Math.max(0, start - clip.start) / (clip.end - clip.start)) * 100}%`,
							}}
						>
							<BrollThumbnail path={clip.path} timeSec={clip.sourceOffsetSec} />
							<span className={styles.brollLabel}>{clip.label}</span>
						</div>
					</button>
				))}
		</div>
	);
}
