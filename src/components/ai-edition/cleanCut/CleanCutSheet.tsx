import { AlignLeft, List, Scissors, Search, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { userCutRegion } from "@/lib/cleanCut/userCuts";
import { BasicCutNotice } from "./BasicCutNotice";
import { CleanCutRows, CutControls, CutWhy, useCutLabel } from "./CleanCutRows";
import styles from "./CleanCutSheet.module.css";
import { CleanCutTranscript } from "./CleanCutTranscript";
import { pauseCuts, spokenSecByRegion } from "./moments";
import { PausesRow } from "./PausesRow";
import { RollingTime } from "./RollingTime";
import { StrengthSwitch } from "./StrengthSwitch";
import type { CleanCutGuide } from "./useCleanCutGuide";

interface CleanCutSheetProps {
	open: boolean;
	model: CleanCutReviewModel;
	/** Plays the picked cut with or without it, once or on a loop. */
	guide: CleanCutGuide;
	clips: readonly AxcutClip[];
	fromSec: number;
	toSec: number;
	toPlaybackSec: (rawSec: number) => number;
	onClose: () => void;
	/** Picks a cut and plays it, keeping the sheet open. */
	onSelectCut: (cut: ReviewCut) => void;
	onSeekRaw: (rawSec: number) => void;
}

/** Whether a search matches a cut by its words or its kind. */
function matchesCut(cut: ReviewCut, label: string, query: string): boolean {
	const needle = query.trim().toLowerCase();
	if (!needle) return true;
	return `${label} ${cut.region.words.join(" ")}`.toLowerCase().includes(needle);
}

/**
 * Every cut, one key away (⌘K or C). Cuts lists them in recording order and opens the picked
 * one in place; Transcript reads the whole recording with cut words struck. The arrows move
 * between cuts, Space plays the picked one again, Esc closes.
 */
export function CleanCutSheet(props: CleanCutSheetProps) {
	const t = useScopedT("editor");
	const label = useCutLabel();
	const snapshot = useCleanCutStore((s) => s.snapshot);
	const strength = useCleanCutStore((s) => s.strength);
	const selectedId = useCleanCutStore((s) => s.selectedId);
	const view = useCleanCutStore((s) => s.view);
	const [query, setQuery] = useState("");
	const [sentence, setSentence] = useState<[number, number] | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!props.open) return;
		const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [props.open]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a picked cut or another view drops the sentence.
	useEffect(() => setSentence(null), [selectedId, view]);

	const cuts = useMemo(
		() =>
			props.model.strip
				.filter((cut) => cut.region.kind !== "pause")
				.filter((cut) => matchesCut(cut, label(cut), query)),
		[props.model.strip, label, query],
	);
	const spoken = useMemo(() => spokenSecByRegion(snapshot.words), [snapshot.words]);
	const pauses = useMemo(() => pauseCuts(props.model.strip), [props.model.strip]);
	const cutIds = useMemo(
		() => new Set(props.model.strip.filter((cut) => !cut.restored).map((cut) => cut.region.id)),
		[props.model.strip],
	);
	const restoredIds = useMemo(
		() => new Set(props.model.strip.filter((cut) => cut.restored).map((cut) => cut.region.id)),
		[props.model.strip],
	);
	const byId = (id: string) => props.model.strip.find((cut) => cut.region.id === id);
	const picked = props.guide.current ? byId(props.guide.current.region.id) : undefined;

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			props.onClose();
			return;
		}
		if (view !== "cuts" || cuts.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const index = cuts.findIndex((cut) => cut.region.id === selectedId);
			const next =
				index === -1
					? 0
					: Math.min(cuts.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)));
			props.onSelectCut(cuts[next]);
		}
	};

	let body: ReactNode;
	if (view === "transcript") {
		body = (
			<CleanCutTranscript
				words={snapshot.words}
				regions={snapshot.regions}
				clips={props.clips}
				cutIds={cutIds}
				restoredIds={restoredIds}
				selectedId={selectedId}
				sentence={sentence}
				query={query}
				label={t("cleanCut.transcript")}
				toPlaybackSec={props.toPlaybackSec}
				onSelectRegion={(id) => {
					const cut = byId(id);
					setSentence(null);
					if (cut) props.onSelectCut(cut);
				}}
				onSeekRaw={props.onSeekRaw}
				onPickSentence={(first, last) => setSentence([first, last])}
			/>
		);
	} else if (props.model.cuts.length === 0) {
		body = (
			<div className={styles.message}>
				<strong>{t(strength === "gentle" ? "cleanCut.noneGentle" : "cleanCut.none")}</strong>
				{strength === "gentle" ? (
					<button
						type="button"
						className={styles.secondary}
						onClick={() => useCleanCutStore.getState().setStrength("clean")}
					>
						{t("cleanCut.useClean")}
					</button>
				) : null}
			</div>
		);
	} else if (cuts.length === 0) {
		body = (
			<div className={styles.message}>
				<strong>{t("cleanCut.noMatch")}</strong>
			</div>
		);
	} else {
		body = (
			<>
				<CleanCutRows
					cuts={cuts}
					selectedId={selectedId}
					guide={props.guide}
					spoken={spoken}
					onSelect={props.onSelectCut}
				/>
				{query.trim() || pauses.length === 0 ? null : (
					<div className={styles.pauses}>
						<PausesRow pauses={pauses} />
					</div>
				)}
			</>
		);
	}

	let footer: ReactNode = null;
	if (view === "transcript" && sentence) {
		footer = (
			<div className={styles.footer}>
				<p className={styles.footerWords}>
					{snapshot.words
						.slice(sentence[0], sentence[1] + 1)
						.map((word) => word.text)
						.join(" ")}
				</p>
				<div className={styles.footerActions}>
					<button type="button" className={styles.secondary} onClick={() => setSentence(null)}>
						{t("cleanCut.hud.close")}
					</button>
					<button
						type="button"
						className={styles.cutSentence}
						onClick={() => {
							useCleanCutStore
								.getState()
								.cutSentence(
									userCutRegion(snapshot.words, snapshot.keep, sentence[0], sentence[1]),
								);
							setSentence(null);
						}}
					>
						<Scissors size={13} aria-hidden="true" />
						{t("cleanCut.cutSentence")}
					</button>
				</div>
			</div>
		);
	} else if (view === "transcript" && picked) {
		footer = (
			<div className={styles.footer}>
				<p className={styles.footerTitle}>
					<span data-unsure={(picked.region.risky && !picked.restored) || undefined}>
						{label(picked)}
					</span>
					<span className={styles.footerTime}>{formatPlayerTime(picked.rawStartSec)}</span>
				</p>
				<CutWhy cut={picked} spoken={spoken} />
				<CutControls guide={props.guide} cut={picked} />
			</div>
		);
	}

	return (
		<div
			className={styles.panel}
			role="dialog"
			aria-modal="false"
			aria-label={t("cleanCut.panel")}
			onKeyDown={onKeyDown}
		>
			<header className={styles.search}>
				<Search size={15} aria-hidden="true" className={styles.searchIcon} />
				<input
					ref={inputRef}
					className={styles.searchInput}
					value={query}
					placeholder={t(view === "transcript" ? "cleanCut.searchTranscript" : "cleanCut.search")}
					aria-label={t(view === "transcript" ? "cleanCut.searchTranscript" : "cleanCut.search")}
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<button
					type="button"
					className={styles.close}
					onClick={props.onClose}
					aria-label={t("cleanCut.hud.close")}
					title={`${t("cleanCut.hud.close")} (esc)`}
				>
					<X size={14} aria-hidden="true" />
				</button>
			</header>
			<div className={styles.runtime}>
				<span className={styles.from}>{formatPlayerTime(props.fromSec)} →</span>
				<RollingTime sec={props.toSec} className={styles.runtimeFigure} />
				<span className={styles.spacer} />
				<StrengthSwitch />
			</div>
			{snapshot.modelCheck === "unavailable" || snapshot.modelCheck === "failed" ? (
				<div className={styles.basic}>
					<BasicCutNotice modelCheck={snapshot.modelCheck} />
				</div>
			) : null}
			<div className={styles.tabs} role="tablist" aria-label={t("cleanCut.panel")}>
				{(["cuts", "transcript"] as const).map((value) => (
					<button
						key={value}
						type="button"
						role="tab"
						aria-selected={view === value}
						onClick={() => useCleanCutStore.getState().setView(value)}
					>
						{value === "cuts" ? (
							<List size={14} aria-hidden="true" />
						) : (
							<AlignLeft size={14} aria-hidden="true" />
						)}
						{value === "cuts" ? t("cleanCut.cuts") : t("cleanCut.transcript")}
						{value === "cuts" ? (
							<span className={styles.count}>{props.model.cuts.length}</span>
						) : null}
					</button>
				))}
			</div>
			<div className={styles.body}>{body}</div>
			{footer}
		</div>
	);
}
