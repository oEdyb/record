import { RotateCcw, Scissors } from "lucide-react";
import { memo, type PointerEvent, useEffect, useMemo, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import { sourceToTimeline } from "@/lib/cleanCut/timelineMap";
import type { CleanCutRegion, CleanCutWord } from "@/lib/cleanCut/types";
import styles from "./CleanCutSheet.module.css";

const PARAGRAPH_PAUSE_SEC = 1.4;
const PARAGRAPH_MIN_WORDS = 14;
const PARAGRAPH_MAX_WORDS = 70;

interface Chunk {
	regionId: string | null;
	words: { text: string; rawSec: number; index: number }[];
}

interface Paragraph {
	rawSec: number;
	chunks: Chunk[];
}

function buildParagraphs(words: readonly CleanCutWord[], clips: readonly AxcutClip[]): Paragraph[] {
	const paragraphs: Paragraph[] = [];
	let current: Paragraph | null = null;
	let count = 0;
	let previous: CleanCutWord | null = null;
	for (const [index, word] of words.entries()) {
		const rawSec = sourceToTimeline(clips, word.assetId, word.startSec);
		if (rawSec === null) continue;
		const pause = previous ? word.startSec - previous.endSec : 0;
		const sentenceEnd = previous ? /[.?!]$/.test(previous.text) : false;
		if (
			!current ||
			previous?.assetId !== word.assetId ||
			(count >= PARAGRAPH_MIN_WORDS && pause >= PARAGRAPH_PAUSE_SEC && sentenceEnd) ||
			(count >= PARAGRAPH_MAX_WORDS && sentenceEnd)
		) {
			current = { rawSec, chunks: [] };
			paragraphs.push(current);
			count = 0;
		}
		const last = current.chunks[current.chunks.length - 1];
		if (last && last.regionId === word.regionId)
			last.words.push({ text: word.text, rawSec, index });
		else
			current.chunks.push({ regionId: word.regionId, words: [{ text: word.text, rawSec, index }] });
		count += 1;
		previous = word;
	}
	return paragraphs;
}

/** Indexes of the words a search matches: every run of words whose text holds it. */
export function matchWords(words: readonly CleanCutWord[], query: string): Set<number> {
	const needle = query.trim().toLowerCase().replace(/\s+/g, " ");
	const matches = new Set<number>();
	if (!needle) return matches;
	const span = needle.split(" ").length;
	const lower = words.map((word) => word.text.toLowerCase());
	for (let i = 0; i < lower.length; i += 1) {
		const text = lower.slice(i, i + span).join(" ");
		if (text.includes(needle)) for (let j = i; j < i + span; j += 1) matches.add(j);
	}
	return matches;
}

interface HoverAction {
	id: string;
	top: number;
	left: number;
}

interface CleanCutTranscriptProps {
	words: readonly CleanCutWord[];
	regions: readonly CleanCutRegion[];
	clips: readonly AxcutClip[];
	/** Regions cut right now; the rest read as plain text. */
	cutIds: ReadonlySet<string>;
	restoredIds: ReadonlySet<string>;
	selectedId: string | null;
	/** Words matching this are marked, and the first one scrolled into view. */
	query: string;
	label: string;
	toPlaybackSec: (rawSec: number) => number;
	onSelectRegion: (id: string) => void;
	onSeekRaw: (rawSec: number) => void;
	onToggleRestore: (id: string) => void;
}

/** The whole recording as text, cut words struck through. Click a word to hear it. */
export const CleanCutTranscript = memo(function CleanCutTranscript({
	words,
	regions,
	clips,
	cutIds,
	restoredIds,
	selectedId,
	query,
	label,
	toPlaybackSec,
	onSelectRegion,
	onSeekRaw,
	onToggleRestore,
}: CleanCutTranscriptProps) {
	const t = useScopedT("editor");
	const [action, setAction] = useState<HoverAction | null>(null);
	const matches = useMemo(() => matchWords(words, query), [words, query]);
	const paragraphs = useMemo(() => buildParagraphs(words, clips), [words, clips]);
	const unsure = useMemo(
		() => new Set(regions.filter((region) => region.risky).map((region) => region.id)),
		[regions],
	);
	const rootRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		if (!selectedId) return;
		rootRef.current
			?.querySelector(`[data-region-id="${CSS.escape(selectedId)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selectedId]);
	useEffect(() => {
		if (matches.size === 0) return;
		rootRef.current?.querySelector("[data-match]")?.scrollIntoView({ block: "center" });
	}, [matches]);
	// Hovering a cut shows a Restore (or Cut again) button just above where it ends.
	const onPointerOver = (event: PointerEvent<HTMLDivElement>) => {
		const target = event.target instanceof Element ? event.target : null;
		if (target?.closest("[data-region-action]")) return;
		const region = target?.closest<HTMLElement>("[data-region-id]");
		const root = rootRef.current;
		const id = region?.dataset.regionId;
		if (!region || !root || !id || (!cutIds.has(id) && !restoredIds.has(id))) {
			setAction(null);
			return;
		}
		if (action?.id === id) return;
		const rects = region.getClientRects();
		const end = rects[rects.length - 1] ?? region.getBoundingClientRect();
		const box = root.getBoundingClientRect();
		setAction({
			id,
			top: end.top - box.top - 26,
			left: Math.min(box.width - 96, Math.max(0, end.right - box.left - 40)),
		});
	};
	return (
		<div
			ref={rootRef}
			className={styles.transcript}
			role="document"
			aria-label={label}
			onPointerOver={onPointerOver}
			onPointerLeave={() => setAction(null)}
			onClick={(event) => {
				const target = event.target instanceof Element ? event.target : null;
				const region = target?.closest<HTMLElement>("[data-region-id]");
				if (
					region?.dataset.regionId &&
					(cutIds.has(region.dataset.regionId) || restoredIds.has(region.dataset.regionId))
				) {
					onSelectRegion(region.dataset.regionId);
					return;
				}
				const word = target?.closest<HTMLElement>("[data-raw-sec]");
				if (word?.dataset.rawSec) onSeekRaw(Number(word.dataset.rawSec));
			}}
		>
			{paragraphs.map((paragraph) => (
				<p key={paragraph.rawSec} className={styles.paragraph}>
					<span className={styles.paragraphTime}>
						{formatPlayerTime(toPlaybackSec(paragraph.rawSec))}
					</span>
					<span className={styles.paragraphText}>
						{paragraph.chunks.map((chunk) => {
							const id = chunk.regionId;
							const state = id
								? cutIds.has(id)
									? "cut"
									: restoredIds.has(id)
										? "restored"
										: null
								: null;
							const key = `${chunk.words[0].rawSec}`;
							if (!id || !state)
								return chunk.words.map((word) => (
									<span
										key={`${word.rawSec}`}
										data-raw-sec={word.rawSec}
										data-match={matches.has(word.index) || undefined}
										className={styles.word}
									>
										{word.text}{" "}
									</span>
								));
							return (
								<span
									key={key}
									className={styles.regionText}
									data-region-id={id}
									data-state={state}
									data-unsure={unsure.has(id) || undefined}
									data-selected={id === selectedId || undefined}
									data-match={chunk.words.some((word) => matches.has(word.index)) || undefined}
								>
									{chunk.words.map((word) => word.text).join(" ")}{" "}
								</span>
							);
						})}
					</span>
				</p>
			))}
			{action ? (
				<button
					type="button"
					className={styles.regionAction}
					data-region-action=""
					style={{ top: action.top, left: action.left }}
					onClick={(event) => {
						event.stopPropagation();
						onToggleRestore(action.id);
						setAction(null);
					}}
				>
					{restoredIds.has(action.id) ? (
						<Scissors size={12} aria-hidden="true" />
					) : (
						<RotateCcw size={12} aria-hidden="true" />
					)}
					{restoredIds.has(action.id) ? t("cleanCut.cutAgain") : t("cleanCut.restore")}
				</button>
			) : null}
		</div>
	);
});
