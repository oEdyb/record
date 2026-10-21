import { Search, X } from "lucide-react";
import {
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useScopedT } from "@/contexts/I18nContext";
import type { AxcutClip } from "@/lib/ai-edition/schema";
import { formatPlayerTime } from "@/lib/ai-edition/timeline/format";
import type { CleanCutReviewModel, ReviewCut } from "@/lib/cleanCut/reviewModel";
import { useCleanCutStore } from "@/lib/cleanCut/store";
import { BasicCutNotice } from "./BasicCutNotice";
import { CleanCutList } from "./CleanCutList";
import styles from "./CleanCutSheet.module.css";
import { CleanCutTranscript } from "./CleanCutTranscript";
import { buildCutRows, type CutRow } from "./cutRows";
import { formatSaved } from "./labels";
import { type CutMoment, pauseCuts, spokenSecByRegion } from "./moments";
import { PausesRow } from "./PausesRow";
import { RollingTime } from "./RollingTime";
import { StrengthSwitch } from "./StrengthSwitch";

interface CleanCutSheetProps {
	open: boolean;
	model: CleanCutReviewModel;
	moments: readonly CutMoment[];
	clips: readonly AxcutClip[];
	fromSec: number;
	toSec: number;
	toPlaybackSec: (rawSec: number) => number;
	onClose: () => void;
	/** Shows a cut on the card and closes the sheet. */
	onPick: (cut: ReviewCut) => void;
	/** Shows a cut on the card and keeps the sheet open, for reading the transcript. */
	onSelectCut: (cut: ReviewCut) => void;
	onSeekRaw: (rawSec: number) => void;
}

function Keys() {
	const t = useScopedT("editor");
	return (
		<footer className={styles.keys} aria-hidden="true">
			<span>
				<kbd>↑</kbd>
				<kbd>↓</kbd>
			</span>
			<span>
				<kbd>↵</kbd>
				{t("cleanCut.keyShow")}
			</span>
			<span>
				<kbd>⇧↵</kbd>
				{t("cleanCut.restore")}
			</span>
			<span>
				<kbd>esc</kbd>
			</span>
		</footer>
	);
}

/**
 * Every cut, one key away (⌘K or C). Search is focused on open; the arrows move through
 * the list, Return shows a cut on the card, Shift-Return restores it. The transcript tab
 * reads the whole recording with the cut words struck.
 */
export function CleanCutSheet(props: CleanCutSheetProps) {
	const t = useScopedT("editor");
	const listId = useId();
	const snapshot = useCleanCutStore((s) => s.snapshot);
	const strength = useCleanCutStore((s) => s.strength);
	const selectedId = useCleanCutStore((s) => s.selectedId);
	const view = useCleanCutStore((s) => s.view);
	const [query, setQuery] = useState("");
	const [openKeys, setOpenKeys] = useState<ReadonlySet<string>>(new Set());
	const [activeKey, setActiveKey] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);

	const sections = useMemo(
		() => buildCutRows(props.moments, query, openKeys),
		[props.moments, query, openKeys],
	);
	const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: each opening starts from the cut on the card.
	useEffect(() => {
		if (!props.open) return;
		const moment = props.moments.find((entry) =>
			entry.cuts.some((cut) => cut.region.id === selectedId),
		);
		if (moment) setOpenKeys((keys) => new Set(keys).add(moment.key));
		setActiveKey(selectedId ? `c:${selectedId}` : null);
		const frame = requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
		return () => cancelAnimationFrame(frame);
	}, [props.open]);

	const activeIndex = Math.max(
		0,
		rows.findIndex((row) => row.key === activeKey),
	);
	const active = rows[activeIndex] ?? null;

	const toggleMoment = (key: string) =>
		setOpenKeys((keys) => {
			const next = new Set(keys);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	const activate = (row: CutRow) => {
		setActiveKey(row.key);
		if (row.type === "moment") toggleMoment(row.moment.key);
		else props.onPick(row.cut);
	};
	const toggleRestore = (cut: ReviewCut) =>
		useCleanCutStore.getState().toggleRestore(cut.region.id);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			props.onClose();
			return;
		}
		if (view !== "cuts" || rows.length === 0) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			const step = event.key === "ArrowDown" ? 1 : -1;
			setActiveKey(rows[Math.min(rows.length - 1, Math.max(0, activeIndex + step))].key);
		} else if (event.key === "Enter" && active) {
			event.preventDefault();
			if (event.shiftKey && active.type === "cut") toggleRestore(active.cut);
			else if (!event.shiftKey) activate(active);
		}
	};

	const cutIds = useMemo(
		() => new Set(props.model.strip.filter((cut) => !cut.restored).map((cut) => cut.region.id)),
		[props.model.strip],
	);
	const restoredIds = useMemo(
		() => new Set(props.model.strip.filter((cut) => cut.restored).map((cut) => cut.region.id)),
		[props.model.strip],
	);
	const byId = (id: string) => props.model.strip.find((cut) => cut.region.id === id);
	const spoken = useMemo(() => spokenSecByRegion(snapshot.words), [snapshot.words]);
	const pauses = useMemo(() => pauseCuts(props.model.strip), [props.model.strip]);

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
				query={query}
				label={t("cleanCut.transcript")}
				toPlaybackSec={props.toPlaybackSec}
				onSelectRegion={(id) => {
					const cut = byId(id);
					if (!cut) return;
					if (id === selectedId) toggleRestore(cut);
					else props.onSelectCut(cut);
				}}
				onSeekRaw={props.onSeekRaw}
				onToggleRestore={(id) => {
					const cut = byId(id);
					if (cut) toggleRestore(cut);
				}}
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
	} else if (rows.length === 0) {
		body = (
			<div className={styles.message}>
				<strong>{t("cleanCut.noMatch")}</strong>
			</div>
		);
	} else {
		body = (
			<>
				<CleanCutList
					id={listId}
					sections={sections}
					activeKey={active?.key ?? null}
					selectedId={selectedId}
					spoken={spoken}
					onHover={setActiveKey}
					onActivate={activate}
					onToggleRestore={toggleRestore}
				/>
				{query.trim() ? null : (
					<div className={styles.pauses}>
						<PausesRow pauses={pauses} />
					</div>
				)}
			</>
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
					role="combobox"
					autoComplete="off"
					autoCorrect="off"
					spellCheck={false}
					aria-expanded={view === "cuts"}
					aria-controls={listId}
					aria-activedescendant={view === "cuts" && active ? `${listId}-${active.key}` : undefined}
					onChange={(event) => {
						setQuery(event.target.value);
						setActiveKey(null);
					}}
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
				<RollingTime sec={props.toSec} className={styles.runtimeFigure} />
				<span className={styles.from}>
					{t("cleanCut.from", { duration: formatPlayerTime(props.fromSec) })}
				</span>
				<span className={styles.saved}>{formatSaved(props.fromSec - props.toSec)}</span>
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
						{value === "cuts" ? t("cleanCut.cuts") : t("cleanCut.transcript")}
						{value === "cuts" ? (
							<span className={styles.count}>{props.model.cuts.length}</span>
						) : null}
					</button>
				))}
			</div>
			<div className={styles.body}>{body}</div>
			{view === "cuts" && rows.length > 0 ? <Keys /> : null}
		</div>
	);
}
