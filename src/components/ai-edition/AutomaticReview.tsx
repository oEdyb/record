import { ChevronLeft, ChevronRight, Play, RotateCcw } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { InspectorSection } from "@/components/ui/inspector";
import { useScopedT } from "@/contexts/I18nContext";
import { resolvePlaybackSegments } from "@/lib/ai-edition/document/timeline";
import type { AxcutDocument } from "@/lib/ai-edition/schema";
import { useProjectStore } from "@/lib/ai-edition/store/projectStore";
import {
	type AutomaticDirectionMember,
	automaticDirectionDismissalCount,
	automaticDirectionGroupsForDocument,
	clearAutomaticDirectionDismissals,
	keepAutomaticDirectionGroup,
	removeAutomaticDirectionGroup,
	reviewAutomaticDirectionGroups,
} from "@/lib/ai-edition/timeline/automatic-direction-ownership";
import {
	buildTimelinePlaybackProjection,
	playbackTimeToRawTime,
	projectRawSpanToPlaybackSpan,
} from "@/lib/ai-edition/timeline/timelineMap";
import styles from "./AutomaticReview.module.css";

const PAGE_SIZE = 4;
function timeLabel(seconds: number) {
	const tenths = Math.max(0, Math.round(seconds * 10));
	return `${Math.floor(tenths / 600)}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

export function AutomaticReview({
	busy = false,
	hideEmpty = false,
	canRegenerate = false,
	onBeforeChange,
	onRegenerate,
	onSeek,
	onAdjust,
}: {
	busy?: boolean;
	hideEmpty?: boolean;
	canRegenerate?: boolean;
	onBeforeChange: () => boolean;
	onRegenerate: () => void;
	onSeek?: (rawSec: number) => void;
	onAdjust?: (member: AutomaticDirectionMember) => void;
}) {
	const t = useScopedT("settings");
	const document = useProjectStore((s) => s.document);
	const [page, setPage] = useState(0);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState(false);
	const [savedDocument, setSavedDocument] = useState<AxcutDocument | null>(null);
	const saved = savedDocument !== null && savedDocument === document;
	useEffect(() => {
		if (savedDocument !== null && savedDocument !== document) setSavedDocument(null);
	}, [document, savedDocument]);
	const statusRef = useRef<HTMLParagraphElement>(null);
	const actionRefs = useRef(new Map<string, HTMLButtonElement>());
	const pendingFocus = useRef<{ source: Element | null; action?: string } | null>(null);
	useLayoutEffect(() => {
		if (saving || !pendingFocus.current) return;
		const { source, action } = pendingFocus.current;
		pendingFocus.current = null;
		// Do not take focus back if the user moved elsewhere while the save ran.
		if (window.document.activeElement !== window.document.body) return;
		if (source instanceof HTMLElement && source.isConnected) {
			source.focus();
			return;
		}
		const next = action
			? [...actionRefs.current.entries()].find(
					([key, node]) => key.endsWith(`:${action}`) && !node.disabled,
				)?.[1]
			: null;
		(next ?? statusRef.current)?.focus();
	}, [saving]);
	const groups = useMemo(
		() => (document ? automaticDirectionGroupsForDocument(document) : []),
		[document],
	);
	const projection = useMemo(
		() =>
			document
				? buildTimelinePlaybackProjection(
						resolvePlaybackSegments(document.timeline.clips, document.timeline.trimRanges),
						document.timeline.clips,
					)
				: [],
		[document],
	);
	const dismissed = document ? automaticDirectionDismissalCount(document) : 0;
	const lastPage = Math.max(0, Math.ceil(groups.length / PAGE_SIZE) - 1);
	const shownPage = Math.min(page, lastPage);
	const disabled = busy || saving || !document;
	const mutate = async (change: (current: AxcutDocument) => AxcutDocument, action?: string) => {
		if (disabled || !document || !onBeforeChange()) return;
		const state = useProjectStore.getState();
		const base = state.document;
		if (!base || base.project.id !== document.project.id) return;
		pendingFocus.current = { source: window.document.activeElement, action };
		setSaving(true);
		setSavedDocument(null);
		setError(false);
		try {
			const next = change(base);
			if (next !== base && !(await state.saveDocumentAsEdit(next, base)))
				throw new Error("save-failed");
			if (next !== base) setSavedDocument(useProjectStore.getState().document);
		} catch {
			setError(true);
		} finally {
			setSaving(false);
		}
	};
	if (
		hideEmpty &&
		!canRegenerate &&
		groups.length === 0 &&
		dismissed === 0 &&
		!saved &&
		!saving &&
		!error
	)
		return null;

	return (
		<InspectorSection title={t("automaticReview.title")}>
			<p className={styles.hint}>{t("automaticReview.hint")}</p>
			<p ref={statusRef} tabIndex={-1} role="status" className={styles.feedback}>
				{saving ? t("automaticReview.saving") : saved ? t("automaticReview.saved") : ""}
			</p>
			<div className={styles.toolbar}>
				<button type="button" disabled={disabled || !canRegenerate} onClick={onRegenerate}>
					<RotateCcw size={12} />
					{t("automaticReview.regenerate")}
				</button>
				{groups.length > 0 && (
					<>
						<button
							type="button"
							disabled={disabled}
							onClick={() =>
								void mutate((base) =>
									reviewAutomaticDirectionGroups(
										base,
										groups.map((group) => group.id),
										"keep",
									),
								)
							}
						>
							{t("automaticReview.keepAll")}
						</button>
						<button
							type="button"
							disabled={disabled}
							onClick={() =>
								void mutate((base) =>
									reviewAutomaticDirectionGroups(
										base,
										groups.map((group) => group.id),
										"remove",
									),
								)
							}
						>
							{t("automaticReview.removeAll")}
						</button>
					</>
				)}
			</div>
			{groups.length === 0 && <p className={styles.hint}>{t("automaticReview.empty")}</p>}
			<ol className={styles.list}>
				{groups.slice(shownPage * PAGE_SIZE, (shownPage + 1) * PAGE_SIZE).map((group) => {
					const span = projectRawSpanToPlaybackSpan(
						group.startMs / 1000,
						group.endMs / 1000,
						projection,
					);
					const member = group.members[0];
					const label = t(
						member?.kind === "cameraFullscreen" ? "automaticReview.camera" : "automaticReview.zoom",
					);
					const seek = () => {
						if (!span) return;
						useProjectStore.getState().setPlaying(false);
						onSeek?.(playbackTimeToRawTime(span.startSec, projection, "after"));
					};
					return (
						<li key={group.id} className={styles.row}>
							<button
								className={styles.jump}
								type="button"
								disabled={!span || busy || saving}
								onClick={seek}
								aria-label={t("automaticReview.jump", {
									name: label,
									time: timeLabel(span?.startSec ?? 0),
								})}
							>
								<Play size={12} />
								<strong>{label}</strong>
								<span>
									{span
										? `${timeLabel(span.startSec)}–${timeLabel(span.endSec)}`
										: t("automaticReview.trimmed")}
								</span>
							</button>
							<p className={styles.reason}>
								{group.reasons.length
									? group.reasons.map((reason) => t(`automaticReview.reason.${reason}`)).join(", ")
									: t("automaticReview.reasonUnavailable")}
							</p>
							<div className={styles.actions}>
								<button
									type="button"
									disabled={disabled || !member || !onAdjust}
									onClick={() => {
										seek();
										if (member) onAdjust?.(member);
									}}
								>
									{t("automaticReview.adjust")}
								</button>
								<button
									type="button"
									disabled={disabled}
									ref={(node) => {
										if (node) actionRefs.current.set(`${group.id}:keep`, node);
										else actionRefs.current.delete(`${group.id}:keep`);
									}}
									onClick={() =>
										void mutate((base) => keepAutomaticDirectionGroup(base, group.id), "keep")
									}
								>
									{t("automaticReview.keep")}
								</button>
								<button
									type="button"
									disabled={disabled}
									ref={(node) => {
										if (node) actionRefs.current.set(`${group.id}:remove`, node);
										else actionRefs.current.delete(`${group.id}:remove`);
									}}
									onClick={() =>
										void mutate((base) => removeAutomaticDirectionGroup(base, group.id), "remove")
									}
								>
									{t("automaticReview.remove")}
								</button>
							</div>
						</li>
					);
				})}
			</ol>
			{lastPage > 0 && (
				<div className={styles.pagination}>
					<button
						type="button"
						disabled={shownPage === 0}
						onClick={() => setPage(shownPage - 1)}
						aria-label={t("automaticReview.previous")}
					>
						<ChevronLeft size={14} />
					</button>
					<span>
						{shownPage + 1} / {lastPage + 1}
					</span>
					<button
						type="button"
						disabled={shownPage === lastPage}
						onClick={() => setPage(shownPage + 1)}
						aria-label={t("automaticReview.next")}
					>
						<ChevronRight size={14} />
					</button>
				</div>
			)}
			{dismissed > 0 && (
				<div className={styles.dismissed}>
					<p className={styles.hint}>{t("automaticReview.dismissed", { count: dismissed })}</p>
					<button
						type="button"
						disabled={disabled}
						onClick={() => void mutate(clearAutomaticDirectionDismissals)}
					>
						{t("automaticReview.restore")}
					</button>
				</div>
			)}
			{error && (
				<p role="alert" className={styles.error}>
					{t("automaticReview.saveFailed")}
				</p>
			)}
		</InspectorSection>
	);
}
