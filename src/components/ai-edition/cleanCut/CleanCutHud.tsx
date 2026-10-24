import {
	Check,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	ChevronUp,
	CornerDownLeft,
	Download,
	Info,
	List,
	Repeat,
	TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useScopedT } from "@/contexts/I18nContext";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import type { CleanCutSnapshot } from "@/lib/cleanCut/types";
import { BasicCutNotice } from "./BasicCutNotice";
import styles from "./CleanCutHud.module.css";
import { cutContext } from "./hudContext";
import { cleanCutKindKey, formatRemoved } from "./labels";
import {
	type CutMoment,
	pauseCuts,
	removedSecOf,
	silenceSecOf,
	spokenSecByRegion,
} from "./moments";
import { PausesRow } from "./PausesRow";
import { RollingTime } from "./RollingTime";
import { StrengthSwitch } from "./StrengthSwitch";
import type { CleanCutGuide, ListenMode, PipState } from "./useCleanCutGuide";

interface CleanCutHudProps {
	snapshot: CleanCutSnapshot;
	model: CleanCutReviewModel | null;
	guide: CleanCutGuide;
	fromSec: number;
	toSec: number;
	/** Each cut's moment, so cuts that close into one seam read as one. */
	moments: ReadonlyMap<string, CutMoment>;
	/** While the full list is open the card steps aside and gives it the keys. */
	listOpen: boolean;
	/** Minimised to a pill, so the card never has to cover the video. */
	collapsed: boolean;
	onCollapse: (collapsed: boolean) => void;
	saveDisabled: boolean;
	onOpenList: () => void;
	onSave: () => void;
	onRetry: () => void;
}

/** One segment per unsure cut, like a story; each one shows its cut when clicked. */
function Pips({
	pips,
	joined,
	onJump,
}: {
	pips: PipState[];
	joined: boolean[];
	onJump: (index: number) => void;
}) {
	const t = useScopedT("editor");
	return (
		<div className={styles.pips}>
			{pips.map((state, i) => (
				<button
					key={i}
					type="button"
					tabIndex={-1}
					className={styles.pip}
					data-state={state}
					data-joined={joined[i] || undefined}
					aria-label={t("cleanCut.hud.of", { index: i + 1, total: pips.length })}
					aria-current={state === "current" || undefined}
					onClick={() => onJump(i)}
				/>
			))}
		</div>
	);
}

function Sentence({
	cut,
	words,
	cutIds,
	listen,
}: {
	listen: ListenMode;
	cut: ReviewCut;
	words: CleanCutSnapshot["words"];
	cutIds: ReadonlySet<string>;
}) {
	const t = useScopedT("editor");
	const [unfolded, setUnfolded] = useState(false);
	const context = useMemo(() => cutContext(words, cut.region, cutIds), [words, cut.region, cutIds]);
	// Words of other cuts nearby read fainter, underlined, never struck: only this cut's are.
	const plain = (list: typeof context.before) =>
		list.map((word, i) => (
			<span key={i} data-near-cut={word.cut || undefined}>
				{word.text}{" "}
			</span>
		));
	return (
		<p className={styles.sentence} data-listen={listen}>
			{context.before.length > 0 ? <span className={styles.ellipsis}>… </span> : null}
			{plain(context.before)}
			<mark
				className={styles.removed}
				data-restored={cut.restored || undefined}
				data-struck={(!cut.restored && listen === "without") || undefined}
			>
				{context.hidden > 0 && unfolded ? context.all.join(" ") : context.head.join(" ")}
				{context.hidden > 0 && !unfolded ? (
					<>
						{" "}
						<button
							type="button"
							className={styles.hidden}
							onClick={() => setUnfolded(true)}
							aria-label={t("cleanCut.hud.showAll", { count: context.all.length })}
							title={t("cleanCut.hud.showAll", { count: context.all.length })}
						>
							+{context.hidden}
						</button>{" "}
						{context.tail.join(" ")}
					</>
				) : null}
			</mark>{" "}
			{plain(context.after)}
			{context.after.length > 0 ? <span className={styles.ellipsis}>…</span> : null}
		</p>
	);
}

function ListenToggle({
	mode,
	onChange,
}: {
	mode: ListenMode;
	onChange: (mode: ListenMode) => void;
}) {
	const t = useScopedT("editor");
	return (
		<div
			className={styles.listen}
			role="group"
			aria-label={t("cleanCut.hud.listen")}
			data-mode={mode}
		>
			<span className={styles.listenThumb} aria-hidden="true" />
			{(["without", "with"] as const).map((value) => (
				<button
					key={value}
					type="button"
					aria-pressed={mode === value}
					onClick={() => onChange(value)}
					title={`${t(`cleanCut.hud.${value}Title`)} (A)`}
				>
					{t(`cleanCut.hud.${value}`)}
				</button>
			))}
		</div>
	);
}

/**
 * A quiet line under the header, only where it adds something: this cut's own time when it
 * shares its moment with others, and the silence inside it from one second up.
 */
function CutDetail({
	cut,
	inMoment,
	spoken,
}: {
	cut: ReviewCut;
	inMoment: boolean;
	spoken: ReadonlyMap<string, number>;
}) {
	const t = useScopedT("editor");
	const silence = cut.restored ? 0 : silenceSecOf(cut, spoken);
	const own = inMoment
		? t("cleanCut.hud.thisCut", {
				removed: cut.restored ? t("cleanCut.restored") : formatRemoved(cut.removedSec),
			})
		: null;
	const quiet =
		silence > 0 ? t("cleanCut.silence", { duration: formatRemoved(silence).slice(1) }) : null;
	if (!own && !quiet) return null;
	return <p className={styles.detail}>{[own, quiet].filter(Boolean).join(" · ")}</p>;
}

/**
 * The guided review: one glass card under the video that walks the unsure cuts. Its words
 * show the sentence around the cut; With and Without replay across it, Space plays it
 * again and L loops it. Keep cut moves on; Restore plays it back in and waits for Return.
 * After the last, the card is the summary.
 */
export function CleanCutHud(props: CleanCutHudProps) {
	const t = useScopedT("editor");
	const { guide, model, snapshot, moments, collapsed } = props;
	const cutIds = useMemo(
		() => new Set(model?.strip.filter((c) => !c.restored).map((c) => c.region.id) ?? []),
		[model],
	);
	const spoken = useMemo(() => spokenSecByRegion(snapshot.words), [snapshot.words]);
	const joined = guide.queue.map(
		(cut, i) => i > 0 && moments.get(cut.region.id) === moments.get(guide.queue[i - 1].region.id),
	);

	useEffect(() => {
		if (props.listOpen || snapshot.state !== "ready") return;
		const onKey = (event: KeyboardEvent) => {
			if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target instanceof HTMLElement ? event.target : null;
			if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
			if (target?.closest("[role='dialog'], [role='alertdialog'], [role='menu']")) return;
			// Return keeps the cut even after a click on the card or the play bar left a button
			// focused there; other buttons keep their own Return.
			if (
				event.key === "Enter" &&
				target?.closest("button") &&
				!target.closest("[data-clean-cut-keys]")
			)
				return;
			const key = event.key.toLowerCase();
			const card = guide.current !== null && !collapsed;
			if (event.key === "Enter" && card) {
				if (!event.repeat) guide.keep();
			} else if (event.key === "Escape" && card && guide.looping) guide.toggleLoop();
			else if (key === "a" && card) guide.setListen(guide.listen === "with" ? "without" : "with");
			else if (key === "c") props.onOpenList();
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [guide, collapsed, props.listOpen, props.onOpenList, snapshot.state]);

	if (snapshot.state === "failed")
		return (
			<div className={`${styles.hud} ${styles.slim}`} role="alert">
				<TriangleAlert size={16} aria-hidden="true" className={styles.danger} />
				<span className={styles.slimText}>{t("cleanCut.failed")}</span>
				<button type="button" className={styles.ghost} onClick={props.onRetry}>
					{t("cleanCut.retry")}
				</button>
			</div>
		);

	if (snapshot.state !== "ready" || !model) {
		const percent = snapshot.progress === null ? null : Math.round(snapshot.progress * 100);
		return (
			<div className={`${styles.hud} ${styles.slim}`} role="status" aria-live="polite">
				<span className={styles.slimText}>{t("cleanCut.finding")}</span>
				<span className={styles.slimTrack}>
					<span style={{ transform: `scaleX(${(percent ?? 6) / 100})` }} />
				</span>
				<span className={styles.mono}>{percent !== null ? `${percent}%` : ""}</span>
			</div>
		);
	}

	const cut = guide.finished ? null : guide.current;
	const counter = !cut
		? null
		: guide.index >= 0
			? t("cleanCut.hud.of", { index: guide.index + 1, total: guide.queue.length })
			: t("cleanCut.hud.picked");

	if (collapsed)
		return (
			<button
				type="button"
				className={`${styles.pill} ${styles.minimised}`}
				data-hidden={props.listOpen || undefined}
				onClick={() => props.onCollapse(false)}
				aria-label={t("cleanCut.hud.showCard")}
				title={t("cleanCut.hud.showCard")}
			>
				{cut ? (
					<>
						{cut.region.risky ? <span className={styles.unsureDot} aria-hidden="true" /> : null}
						<span>{t(cleanCutKindKey(cut.region.kind))}</span>
						<span className={styles.mono}>{counter}</span>
					</>
				) : (
					<RollingTime sec={props.toSec} className={styles.pillTime} />
				)}
				<ChevronUp size={14} aria-hidden="true" />
			</button>
		);

	const allCuts = model.cuts.length;
	const listButton = (
		<button
			type="button"
			className={styles.listButton}
			onClick={props.onOpenList}
			title={`${t("cleanCut.hud.allCuts", { count: allCuts })} (⌘K)`}
		>
			<List size={14} aria-hidden="true" />
			<span>{t("cleanCut.hud.allCuts", { count: allCuts })}</span>
		</button>
	);
	const minimise = (
		<button
			type="button"
			className={styles.iconButton}
			onClick={() => props.onCollapse(true)}
			aria-label={t("cleanCut.hud.minimise")}
			title={t("cleanCut.hud.minimise")}
		>
			<ChevronDown size={15} aria-hidden="true" />
		</button>
	);
	const pips =
		guide.pips.length > 0 && (!cut || guide.index >= 0) ? (
			<Pips pips={guide.pips} joined={joined} onJump={guide.jump} />
		) : null;

	if (!cut) {
		const keptShare = props.fromSec > 0 ? Math.min(1, props.toSec / props.fromSec) : 1;
		const wordsRemoved = removedSecOf(model.strip.filter((c) => c.region.kind !== "pause"));
		const unchecked = guide.uncheckedCount;
		const save = (
			<button
				type="button"
				className={unchecked > 0 ? styles.ghost : styles.primary}
				onClick={props.onSave}
				disabled={props.saveDisabled}
			>
				<Download size={15} aria-hidden="true" />
				{t("recordingReview.save")}
			</button>
		);
		return (
			<section
				className={styles.hud}
				aria-label={t("cleanCut.panel")}
				data-hidden={props.listOpen || undefined}
				data-clean-cut-keys=""
			>
				{pips}
				<div className={styles.card} key="done" data-dir={guide.direction}>
					<div className={styles.done}>
						<div className={styles.doneRuntime}>
							<RollingTime sec={props.toSec} fromSec={props.fromSec} className={styles.bigTime} />
							<span className={styles.fromTime}>
								{t("cleanCut.from", { duration: formatPlayerTime(props.fromSec) })}
							</span>
							<span className={styles.spacer} />
							{minimise}
						</div>
						<div className={styles.runtimeBar} aria-hidden="true">
							<span style={{ transform: `scaleX(${keptShare})` }} />
						</div>
						<p className={styles.doneLine}>
							{guide.queue.length === 0
								? t("cleanCut.hud.nothingUnsure")
								: t("cleanCut.hud.checked", {
										count: guide.checkedCount,
										restored: guide.restoredCount,
									})}
						</p>
						{snapshot.modelCheck === "unavailable" || snapshot.modelCheck === "failed" ? (
							<div className={styles.basic}>
								<BasicCutNotice modelCheck={snapshot.modelCheck} />
							</div>
						) : null}
						<div className={styles.breakdown}>
							<div className={styles.breakdownRow}>
								<span className={styles.breakdownMark} aria-hidden="true" />
								<span className={styles.breakdownLabel}>{t("cleanCut.cuts")}</span>
								<span className={styles.mono}>{allCuts}</span>
								<span className={styles.breakdownTime}>{formatRemoved(wordsRemoved)}</span>
							</div>
							<PausesRow pauses={pauseCuts(model.strip)} />
						</div>
					</div>
					<div className={styles.actions}>
						<StrengthSwitch />
						{listButton}
						<span className={styles.spacer} />
						{unchecked > 0 ? (
							<>
								{save}
								<button type="button" className={styles.primary} onClick={guide.checkNext}>
									<span className={styles.unsureDot} aria-hidden="true" />
									{t("cleanCut.hud.checkUnsure", { count: unchecked })}
								</button>
							</>
						) : (
							save
						)}
					</div>
				</div>
			</section>
		);
	}

	const moment = moments.get(cut.region.id);
	const together = moment && moment.cuts.length > 1 ? moment.cuts : null;
	const flashing = guide.flashId === cut.region.id;
	return (
		<section
			className={styles.hud}
			aria-label={t("cleanCut.panel")}
			data-hidden={props.listOpen || undefined}
			data-looping={guide.looping || undefined}
			data-clean-cut-keys=""
		>
			{pips}
			<div className={styles.card} key={cut.region.id} data-dir={guide.direction}>
				<header className={styles.meta}>
					<span className={styles.kind}>{t(cleanCutKindKey(cut.region.kind))}</span>
					{together ? (
						<span
							className={styles.moment}
							title={t("cleanCut.hud.together", { count: together.length })}
						>
							×{together.length}
							<span className={styles.momentDots} aria-hidden="true">
								{together.map((entry) => (
									<span
										key={entry.region.id}
										data-current={entry.region.id === cut.region.id || undefined}
										data-restored={entry.restored || undefined}
									/>
								))}
							</span>
						</span>
					) : null}
					<span className={styles.mono}>
						{together && moment
							? moment.removedSec > 0
								? formatRemoved(moment.removedSec)
								: t("cleanCut.restored")
							: cut.restored
								? t("cleanCut.restored")
								: formatRemoved(cut.removedSec)}
					</span>
					<span className={styles.spacer} />
					{guide.looping ? (
						<span className={styles.loopState} aria-live="polite">
							<Repeat size={12} aria-hidden="true" />
							{t("cleanCut.hud.looping")}
						</span>
					) : null}
					{guide.index >= 0 ? (
						<button
							type="button"
							className={`${styles.iconButton} ${styles.prevButton}`}
							onClick={() => guide.step(-1)}
							disabled={guide.index === 0}
							aria-label={t("cleanCut.hud.previous")}
							title={`${t("cleanCut.hud.previous")} (↑)`}
						>
							<ChevronLeft size={15} aria-hidden="true" />
						</button>
					) : null}
					<span className={styles.mono} aria-live="polite">
						{counter}
					</span>
					{minimise}
				</header>
				<CutDetail cut={cut} inMoment={together !== null} spoken={spoken} />
				<Sentence cut={cut} words={snapshot.words} cutIds={cutIds} listen={guide.listen} />
				<div className={styles.actions}>
					<ListenToggle mode={guide.listen} onChange={guide.setListen} />
					<button
						type="button"
						className={styles.loop}
						onClick={guide.toggleLoop}
						aria-pressed={guide.looping}
						aria-keyshortcuts="L"
						title={`${t("cleanCut.hud.loopTitle")} (L)`}
					>
						<Repeat size={14} aria-hidden="true" />
						<kbd>L</kbd>
					</button>
					{listButton}
					<span className={styles.spacer} />
					{flashing ? (
						<span className={styles.flash} role="status">
							<Check size={14} aria-hidden="true" />
							{t("cleanCut.restored")}
							<span aria-hidden="true">·</span>
							<button type="button" className={styles.undo} onClick={guide.undoRestore}>
								{t("cleanCut.hud.undo")}
							</button>
						</span>
					) : (
						<button
							type="button"
							className={styles.ghost}
							onClick={guide.restore}
							aria-keyshortcuts="R"
							data-on={cut.restored || undefined}
						>
							{cut.restored ? t("cleanCut.cutAgain") : t("cleanCut.restore")}
							<kbd>R</kbd>
						</button>
					)}
					<button
						type="button"
						className={styles.primary}
						onClick={guide.keep}
						aria-keyshortcuts="Enter"
					>
						{cut.restored ? t("cleanCut.hud.next") : t("cleanCut.hud.keep")}
						<kbd>
							<CornerDownLeft size={12} aria-label="Return" />
						</kbd>
					</button>
				</div>
			</div>
		</section>
	);
}

/** The small player's version: one glass pill that opens the full review. */
export function CleanCutHudPill({
	count,
	basic = false,
	onOpen,
}: {
	count: number;
	/** The AI did not check this recording: say so on the pill, with the reason on hover. */
	basic?: boolean;
	onOpen: () => void;
}) {
	const t = useScopedT("editor");
	return (
		<button
			type="button"
			className={styles.pill}
			onClick={onOpen}
			aria-description={basic ? t("cleanCut.basicNotice") : undefined}
		>
			<span className={styles.pillCount}>{count}</span>
			{t("cleanCut.hud.toCheck", { count })}
			{basic ? (
				<span className={styles.pillBasic}>
					<span aria-hidden="true">·</span>
					<Info size={12} aria-hidden="true" />
					{t("cleanCut.basic")}
					<span className={styles.pillTip} aria-hidden="true">
						{t("cleanCut.basicNotice")}
					</span>
				</span>
			) : null}
			<ChevronRight size={14} aria-hidden="true" />
		</button>
	);
}
